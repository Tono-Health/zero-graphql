// Drives the todo example end to end with the real browser client:
// Postgres → zero-cache → relay (Durable Object) → browser client, and back through the endpoints.
//
//   docker compose -f examples/todo/dev/docker-compose.yml up -d --wait
//   node_modules/.bin/wrangler dev -c examples/todo/wrangler.jsonc
//   node examples/todo/dev/e2e.ts

import postgres from "postgres";
import { createClient, type ConnectionStatus, type QueryRef } from "../../../src/client.ts";
import type { Router } from "../router.ts";
import { signSession } from "../users.ts";

const BASE = "http://localhost:8798";
const DATABASE_URL = "postgres://postgres:postgres@localhost:5443/todo";
const sql = postgres(DATABASE_URL, { max: 1 });

// Browsers send the session cookie themselves. Node's WebSocket takes headers instead, so pick the
// cookie by the `as` parameter each test client adds to its URL.
const cookies = new Map<string, string>();
const NativeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const as = new URL(url).searchParams.get("as") ?? "";
    super(url, { protocols, headers: { cookie: cookies.get(as) ?? "" } } as never);
  }
} as typeof WebSocket;

async function clientFor(userID: string) {
  cookies.set(
    userID,
    `session=${await signSession({ SESSION_SECRET: "dev-session-secret" }, userID)}`,
  );
  const statuses: ConnectionStatus[] = [];
  const api = createClient<Router>({
    url: `${BASE}/zero/live`,
    params: { as: userID },
    onStatusChange: (status) => statuses.push(status),
  });
  return { api, statuses };
}

/** Subscribes and keeps the latest snapshot, so steps can wait for a condition on it. */
function watch<I, D>(ref: QueryRef<I, D>, input: I) {
  const state = {
    data: undefined as D | undefined,
    status: "unknown" as string,
    error: undefined as unknown,
  };
  const stop = ref.subscribe(
    input,
    ({ data, status }) => Object.assign(state, { data, status }),
    (error) => Object.assign(state, { error }),
  );
  return { state, stop };
}

async function until(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<number> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Math.round(performance.now() - started);
}

const results: [string, string][] = [];
async function step(name: string, run: () => Promise<string | void>) {
  try {
    const detail = (await run()) ?? "";
    results.push([`ok   ${name}`, detail]);
  } catch (error) {
    results.push([`FAIL ${name}`, String(error)]);
  }
}

await sql`DELETE FROM todo WHERE id LIKE 'e2e-%'`;
await sql`DELETE FROM list_member WHERE list_id = 'work' AND user_id = 'alice'`;
await sql`INSERT INTO app_user (id, name) VALUES ('alice', 'Alice') ON CONFLICT DO NOTHING`;

const alice = await clientFor("alice");
const bob = await clientFor("bob");
const mine = watch(alice.api.lists.mine, undefined);
const groceries = watch(alice.api.lists.get, { id: "groceries" });
const work = watch(alice.api.lists.get, { id: "work" });

await step("alice's lists load, projected through .output()", async () => {
  const ms = await until("lists.mine complete", () => mine.state.status === "complete");
  const names = (mine.state.data ?? []).map((l) => l.name).sort();
  if (names.join() !== "Groceries,Trip") throw new Error(`got ${names.join()}`);
  if (mine.state.data!.some((l) => "ownerID" in l))
    throw new Error("ownerID leaked past .output()");
  return `${ms} ms`;
});

await step("bob's work list is invisible to alice", async () => {
  await until("lists.get(work) complete", () => work.state.status === "complete");
  if (work.state.data !== null) throw new Error(`got ${JSON.stringify(work.state.data)}`);
});

await step("a mutation commits and the change syncs back", async () => {
  await until("groceries complete", () => groceries.state.status === "complete");
  const started = performance.now();
  await alice.api.todos.add({ id: "e2e-1", listID: "groceries", title: "Coffee" });
  const committed = Math.round(performance.now() - started);
  await until(
    "new todo visible",
    () => !!groceries.state.data?.todos.some((t) => t.id === "e2e-1"),
  );
  return `server ack in ${committed} ms`;
});

await step("declared errors reach the browser typed", async () => {
  const { error } = await alice.api.todos.toggle.safe({ id: "w1", done: true });
  if (error?.code !== "NOT_FOUND") throw new Error(`got ${JSON.stringify(error)}`);
});

await step("invalid input is rejected before any handler runs", async () => {
  const { error } = await alice.api.todos.add.safe({ id: "e2e-2", listID: "groceries", title: "" });
  if (error?.code !== "BAD_INPUT") throw new Error(`got ${JSON.stringify(error)}`);
});

await step("bob shares his work list and alice sees it live", async () => {
  await bob.api.lists.share({ listID: "work", userID: "alice" });
  const ms = await until(
    "work list appears for alice",
    () => !!mine.state.data?.some((l) => l.id === "work"),
  );
  await until("lists.get(work) resolves", () => work.state.data?.id === "work");
  return `${ms} ms after bob's call resolved`;
});

await step("a direct database write reaches alice", async () => {
  const started = performance.now();
  await sql`UPDATE list SET name = 'Groceries (edited)' WHERE id = 'groceries'`;
  await until(
    "rename visible",
    () => !!mine.state.data?.some((l) => l.name === "Groceries (edited)"),
  );
  await sql`UPDATE list SET name = 'Groceries' WHERE id = 'groceries'`;
  return `${Math.round(performance.now() - started)} ms`;
});

await step("deleting alice and invalidating revokes her session", async () => {
  await sql`DELETE FROM app_user WHERE id = 'alice'`;
  const response = await fetch(`${BASE}/admin/invalidate?user=alice`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-admin-token" },
  });
  if (response.status !== 204) throw new Error(`invalidate returned ${response.status}`);
  await until("alice revoked", () => alice.statuses.at(-1) === "revoked");
  const { error } = await alice.api.todos.add.safe({
    id: "e2e-3",
    listID: "groceries",
    title: "x",
  });
  if (error?.code !== "DISCONNECTED") throw new Error(`got ${JSON.stringify(error)}`);
  return alice.statuses.join(" → ");
});

await sql`INSERT INTO app_user (id, name) VALUES ('alice', 'Alice') ON CONFLICT DO NOTHING`;
await sql`DELETE FROM list_member WHERE list_id = 'work' AND user_id = 'alice'`;
await sql`DELETE FROM todo WHERE id LIKE 'e2e-%'`;
bob.api.$close();
await sql.end();

for (const [name, detail] of results) console.log(name.padEnd(64), detail);
process.exit(results.some(([name]) => name.startsWith("FAIL")) ? 1 : 0);
