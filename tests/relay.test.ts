import { ApplicationError } from "@rocicorp/zero";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { AuditEvent } from "../src/audit.ts";
import { createApp } from "../src/app.ts";
import { cloudflare } from "../src/cloudflare.ts";
import { compileRouter, DEFERRED, runMutator } from "../src/internal/compile.ts";
import { toApplicationError } from "../src/internal/wire-errors.ts";
import { resolveRelays } from "../src/internal/relays.ts";
import type {
  MutatorResultLike,
  Relay,
  RelaySocket,
  ViewLike,
  ZeroInit,
  ZeroLike,
} from "../src/internal/relay/contracts.ts";
import { createRelay } from "../src/internal/relay/runtime.ts";
import { RelayError } from "../src/errors.ts";
import { CloseCode, PROTOCOL, type ServerMessage } from "../src/internal/protocol.ts";
import { schema } from "../examples/todo/schema.ts";
import type { RouterShape } from "../src/procedure.ts";

type User = { readonly userID: string; readonly role: "admin" | "member" };

const people = new Map<string, User>();
const events: AuditEvent<User>[] = [];

const app = createApp<{ user: User }>()({
  schema,
  authenticate: () => null,
  partition: {
    key: ({ user }) => user.userID,
    authorize: ({ user, key }) => user.userID === key,
    scope: ({ key }) => people.get(key) ?? null,
    user: ({ scope }) => scope,
  },
  audit: { sink: ({ event }) => void events.push(event), deliveries: true },
});

const admins = app.guard(({ user }) => user.role === "admin", { name: "admins" });

const router = app.router({
  lists: {
    mine: app.query
      .output(z.object({ id: z.string(), name: z.string() }))
      .handler(({ zql, user }) => zql.list.where("ownerID", user.userID)),
    all: app.query.use(admins).handler(({ zql }) => zql.list),
    rename: app.mutation
      .input(z.object({ id: z.string(), name: z.string().min(1) }))
      .errors({ NOT_FOUND: { message: "List not found" } })
      .handler(async () => {}),
    quick: app.mutation.meta({ ack: "relay" }).handler(async () => {}),
  },
});

// ---------------------------------------------------------------------------
// Fakes

class FakeView implements ViewLike {
  listeners = new Set<(data: unknown, type: string, error?: unknown) => void>();
  destroyed = false;
  constructor(
    readonly request: { query?: { name: string } } & Record<string, unknown>,
    readonly ttl: string | number | undefined,
  ) {}
  addListener(listener: (data: unknown, type: string, error?: unknown) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(data: unknown, type: string, error?: unknown) {
    for (const listener of this.listeners) listener(data, type, error);
  }
  destroy() {
    this.destroyed = true;
  }
}

class FakeZero implements ZeroLike {
  views: FakeView[] = [];
  mutations: unknown[] = [];
  auths: (string | undefined)[] = [];
  closed = false;
  result: () => { client: MutatorResultLike; server: MutatorResultLike } = () => ({
    client: { type: "success" },
    server: { type: "success", data: "done" },
  });
  stateListeners = new Set<(state: { name: string }) => void>();
  constructor(readonly init: ZeroInit) {}
  materialize(request: never, options?: { ttl?: string | number }) {
    const view = new FakeView(request, options?.ttl);
    this.views.push(view);
    return view;
  }
  mutate(request: never) {
    this.mutations.push(request);
    const { client, server } = this.result();
    return { client: Promise.resolve(client), server: Promise.resolve(server) };
  }
  connection = {
    state: {
      subscribe: (listener: (state: { name: string }) => void) => {
        this.stateListeners.add(listener);
        return () => this.stateListeners.delete(listener);
      },
    },
    connect: async (options?: { auth?: string }) => void this.auths.push(options?.auth),
  };
  async close() {
    this.closed = true;
  }
}

class FakeSocket implements RelaySocket {
  sent: ServerMessage[] = [];
  closedWith: { code: number; reason: string } | undefined;
  user: unknown;
  send(message: string) {
    this.sent.push(JSON.parse(message));
  }
  close(code: number, reason: string) {
    this.closedWith = { code, reason };
  }
  setUser(user: unknown) {
    this.user = user;
  }
  of<T extends ServerMessage["t"]>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

const relays: Relay[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.shutdown()));
  vi.restoreAllMocks();
  people.clear();
  events.length = 0;
});

function setup(
  user: User = { userID: "alice", role: "member" },
  options: {
    idleTimeout?: number;
    onActive?: () => void;
    onIdle?: () => void;
    router?: RouterShape;
  } = {},
) {
  people.set(user.userID, user);
  const zeros: FakeZero[] = [];
  const relay = createRelay({
    relay: resolveRelays(app, options.router ?? router).get("main")!,
    key: user.userID,
    env: undefined,
    secret: "test-secret",
    createZero: (init) => {
      const zero = new FakeZero(init);
      zeros.push(zero);
      return zero;
    },
    idleTimeout: options.idleTimeout ?? 50,
    onActive: options.onActive,
    onIdle: options.onIdle,
  });
  relays.push(relay);
  const open = (expiresAt: number | null = null) => {
    const socket = new FakeSocket();
    const connection = relay.connect(socket, user, expiresAt);
    const send = (message: object) => connection.message(JSON.stringify(message));
    return { socket, connection, send };
  };
  return { relay, zeros, open, user };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// ---------------------------------------------------------------------------

test("subscribers share one view and receive projected snapshots", async () => {
  const { zeros, open } = setup();
  const a = open();
  const b = open();
  a.send({ t: "sub", id: "s1", path: "lists.mine" });
  b.send({ t: "sub", id: "s2", path: "lists.mine" });
  await vi.waitFor(() => expect(zeros).toHaveLength(1));
  expect(zeros[0]!.init.userID).toBe("main/alice");
  expect(zeros[0]!.views).toHaveLength(1);
  // No `.meta({ ttl })`: rows leave when the view does, instead of Zero's five-minute default.
  expect(zeros[0]!.views[0]!.ttl).toBe("none");
  zeros[0]!.views[0]!.emit([{ id: "l1", name: "Groceries", ownerID: "alice" }], "unknown");
  zeros[0]!.views[0]!.emit([{ id: "l1", name: "Groceries", ownerID: "alice" }], "complete");
  await tick();

  // Coalesced to the last update, and `ownerID` isn't in `.output()`.
  expect(a.socket.of("data")).toEqual([
    { t: "data", id: "s1", type: "complete", data: [{ id: "l1", name: "Groceries" }] },
  ]);
  expect(b.socket.of("data")).toHaveLength(1);
  expect(events.filter((e) => e.type === "deliver").map((e) => "rowIDs" in e && e.rowIDs)).toEqual([
    ["l1"],
    ["l1"],
  ]);
});

test("a late subscriber gets the current snapshot immediately", async () => {
  const { zeros, open } = setup();
  const a = open();
  a.send({ t: "sub", id: "s1", path: "lists.mine" });
  await tick();
  zeros[0]!.views[0]!.emit([], "complete");
  await tick();
  const b = open();
  b.send({ t: "sub", id: "s1", path: "lists.mine" });
  await tick();
  expect(b.socket.of("data")).toEqual([{ t: "data", id: "s1", type: "complete", data: [] }]);
});

test("guards, unknown paths, and malformed messages are rejected", async () => {
  const { open } = setup();
  const { socket, send } = open();
  send({ t: "sub", id: "s1", path: "lists.all" });
  send({ t: "sub", id: "s2", path: "lists.nope" });
  send({ t: "sub", id: "s3", path: "lists.rename" });
  send({ t: "bogus" });
  await tick();
  expect(socket.of("error").map((m) => [m.id, m.error.code])).toEqual([
    ["s2", "BAD_INPUT"],
    ["s3", "BAD_INPUT"],
    [null, "BAD_INPUT"],
    ["s1", "FORBIDDEN"],
  ]);
  expect(events).toContainEqual(
    expect.objectContaining({ type: "denied", path: "lists.all", guard: "admins" }),
  );
});

test("server-side query errors close the subscription with the decoded error", async () => {
  const { zeros, open } = setup();
  const { socket, send } = open();
  send({ t: "sub", id: "s1", path: "lists.mine" });
  await tick();
  const error = toApplicationError(new RelayError("FORBIDDEN", { message: "Forbidden" }))!;
  zeros[0]!.views[0]!.emit(undefined, "error", {
    error: "app",
    message: error.message,
    details: error.details,
  });
  await tick();
  expect(socket.of("error")).toEqual([
    { t: "error", id: "s1", error: { code: "FORBIDDEN", message: "Forbidden" } },
  ]);
  expect(events.map((e) => e.type)).toEqual(["subscribe", "unsubscribe"]);
});

test("unsubscribing releases the view after a grace period", async () => {
  const { zeros, open } = setup();
  const { send } = open();
  send({ t: "sub", id: "s1", path: "lists.mine" });
  await tick();
  send({ t: "unsub", id: "s1" });
  await tick();
  expect(zeros[0]!.views[0]!.destroyed).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(zeros[0]!.views[0]!.destroyed).toBe(true);
});

test("mutations wait for the server and carry the actor", async () => {
  const { zeros, open, user } = setup();
  const { socket, send } = open();
  send({ t: "call", id: "c1", path: "lists.rename", input: { id: "l1", name: "Errands" } });
  await tick();
  expect(socket.of("result")).toEqual([{ t: "result", id: "c1", ok: true, data: "done" }]);
  expect(JSON.stringify(zeros[0]!.mutations[0])).toContain(JSON.stringify(user));
  expect(events.map((e) => e.type === "mutate" && e.outcome)).toEqual(["pending", "ok"]);
});

test("a resent call replays the stored result instead of mutating twice", async () => {
  const { zeros, open } = setup();
  const first = open();
  first.send({ t: "call", id: "c1", path: "lists.rename", input: { id: "l1", name: "Errands" } });
  await tick();
  const second = open();
  second.send({ t: "call", id: "c1", path: "lists.rename", input: { id: "l1", name: "Errands" } });
  await tick();
  expect(zeros[0]!.mutations).toHaveLength(1);
  expect(second.socket.of("result")).toEqual(first.socket.of("result"));
});

test("mutation failures map to wire errors", async () => {
  const { zeros, open } = setup();
  const { socket, send } = open();
  send({ t: "call", id: "bad", path: "lists.rename", input: { id: "l1", name: "" } });
  await vi.waitFor(() => expect(zeros).toHaveLength(1));
  const declared = toApplicationError(new RelayError("NOT_FOUND", { message: "List not found" }))!;
  zeros[0]!.result = () => ({
    client: { type: "success" },
    server: {
      type: "error",
      error: { type: "app", message: declared.message, details: declared.details },
    },
  });
  send({ t: "call", id: "app", path: "lists.rename", input: { id: "l1", name: "x" } });
  await tick();
  zeros[0]!.result = () => {
    const offline = { type: "error", error: { type: "zero", message: "offline" } } as const;
    return { client: offline, server: offline };
  };
  send({ t: "call", id: "offline", path: "lists.rename", input: { id: "l1", name: "x" } });
  await tick();
  zeros[0]!.result = () => ({
    client: { type: "error", error: { type: "app", message: "db password is hunter2" } },
    server: { type: "success" },
  });
  send({ t: "call", id: "leak", path: "lists.rename", input: { id: "l1", name: "x" } });
  await tick();

  const errors = Object.fromEntries(socket.of("result").map((m) => [m.id, !m.ok && m.error]));
  expect(errors["bad"]).toMatchObject({ code: "BAD_INPUT" });
  expect(errors["app"]).toEqual({ code: "NOT_FOUND", message: "List not found" });
  expect(errors["offline"]).toMatchObject({ code: "UNAVAILABLE" });
  expect(errors["leak"]).toEqual({ code: "INTERNAL", message: "Internal error" });
});

test("ack: relay responds after the optimistic run", async () => {
  const { zeros, open } = setup();
  zeros.length = 0;
  const { socket, send } = open();
  await tick();
  zeros[0]!.result = () => ({
    client: { type: "success" },
    server: new Promise(() => {}) as never,
  });
  send({ t: "call", id: "c1", path: "lists.quick" });
  await tick();
  expect(socket.of("result")).toEqual([{ t: "result", id: "c1", ok: true, data: null }]);
});

test("ack: relay waits for the server when the relay's run deferred", async () => {
  const { zeros, open } = setup();
  const { socket, send } = open();
  await tick();
  zeros[0]!.result = () => ({
    client: { type: "success", data: DEFERRED },
    server: { type: "success", data: "from server" },
  });
  send({ t: "call", id: "c1", path: "lists.quick" });
  await tick();
  expect(socket.of("result")).toEqual([{ t: "result", id: "c1", ok: true, data: "from server" }]);
});

test("refresh updates the context and token, and re-checks guards", async () => {
  const admin: User = { userID: "alice", role: "admin" };
  const { relay, zeros, open } = setup(admin);
  const { socket, send } = open();
  send({ t: "sub", id: "s1", path: "lists.all" });
  await tick();
  expect(socket.of("error")).toEqual([]);

  people.set("alice", { userID: "alice", role: "member" });
  await relay.invalidate();
  await tick();
  expect(zeros[0]!.init.context.user).toEqual({ userID: "alice", role: "member" });
  expect(zeros[0]!.auths).toHaveLength(1);
  expect(socket.user).toEqual({ userID: "alice", role: "member" });
  expect(socket.closedWith).toBeUndefined();
  expect(socket.of("error")).toEqual([
    {
      t: "error",
      id: "s1",
      error: { code: "FORBIDDEN", message: "Forbidden", data: { guard: "admins" } },
    },
  ]);
});

test.each([
  { trigger: "interval", scopeFails: false },
  { trigger: "invalidate", scopeFails: false },
  { trigger: "interval", scopeFails: true },
])(
  "shared $trigger refresh reauthenticates users before delivering more data (scope failure: $scopeFails)",
  async ({ trigger, scopeFails }) => {
    const members = new Map([
      ["alice", { userID: "alice", teamID: "team" }],
      ["bob", { userID: "bob", teamID: "team" }],
    ]);
    const scope = vi.fn(() => ({ teamID: "team" }));
    const shared = createApp<{ user: { userID: string; teamID: string } }>()({
      schema,
      authenticate: ({ request }) => {
        const user = members.get(request.headers.get("user") ?? "");
        return user ? { user, expiresAt: null } : null;
      },
      partition: {
        key: () => "team",
        // Deliberately uses the authenticated snapshot. Calling this again with the old
        // user would miss Alice's membership change.
        authorize: ({ user, key }) => user.teamID === key,
        scope,
      },
    });
    const queries = shared.router({ all: shared.query.handler(({ zql }) => zql.list) });
    const zeros: FakeZero[] = [];
    const relay = createRelay({
      relay: resolveRelays(shared, queries).get("main")!,
      key: "team",
      env: undefined,
      secret: "test-secret",
      refreshInterval: 1000,
      createZero: (init) => {
        const zero = new FakeZero(init);
        zeros.push(zero);
        return zero;
      },
    });
    relays.push(relay);

    const sockets: FakeSocket[] = [];
    // Exercise the real Worker's authentication and routing on each upgrade. Only the
    // Durable Object transport and Zero are faked.
    const host = cloudflare(shared, {
      router: queries,
      database: () => {
        throw new Error("Unexpected database access");
      },
    });
    const env = {
      RELAY: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            const user = JSON.parse(decodeURIComponent(request.headers.get("x-zero-relay-user")!));
            const socket = new FakeSocket();
            sockets.push(socket);
            const connection = relay.connect(socket, user, null);
            connection.message(JSON.stringify({ t: "sub", id: "s1", path: "all" }));
            return new Response(null, { status: 204 });
          },
        }),
      },
    };
    const upgrade = (userID: string) =>
      host.handle(
        new Request("https://app.example.com/zero/live", {
          headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": PROTOCOL, user: userID },
        }),
        env,
        { waitUntil: () => {} },
      );

    expect((await upgrade("alice"))?.status).toBe(204);
    expect((await upgrade("bob"))?.status).toBe(204);
    await vi.waitFor(() => expect(zeros[0]?.views).toHaveLength(1));
    const [alice, bob] = sockets as [FakeSocket, FakeSocket];
    const view = zeros[0]!.views[0]!;
    view.emit([{ id: "before", name: "Before", ownerID: "bob" }], "complete");
    await tick();
    expect(alice.of("data")).toHaveLength(1);
    expect(bob.of("data")).toHaveLength(1);

    members.set("alice", { userID: "alice", teamID: "another-team" });
    if (scopeFails) {
      vi.spyOn(console, "error").mockImplementation(() => {});
      scope.mockImplementation(() => {
        throw new Error("Scope lookup unavailable");
      });
    }
    if (trigger === "invalidate") await relay.invalidate();
    else await vi.waitFor(() => expect(alice.closedWith).toBeDefined(), { timeout: 2000 });

    for (const socket of [alice, bob]) {
      expect(socket.closedWith).toEqual({ code: CloseCode.refresh, reason: "refresh" });
    }
    expect(relay.connections).toBe(0);
    expect((await upgrade("alice"))?.status).toBe(403);
    expect((await upgrade("bob"))?.status).toBe(204);
    await tick();
    view.emit([{ id: "after", name: "After", ownerID: "bob" }], "complete");
    await tick();
    expect(alice.of("data")).toHaveLength(1);
    expect(bob.of("data")).toHaveLength(1);
    expect(sockets[2]!.of("data").at(-1)?.data).toEqual([
      { id: "after", name: "After", ownerID: "bob" },
    ]);
  },
);

test("a scope that reloads as null revokes every socket and closes Zero", async () => {
  const { relay, zeros, open } = setup();
  const { socket, send } = open();
  send({ t: "sub", id: "s1", path: "lists.mine" });
  await tick();
  people.delete("alice");
  await relay.invalidate();
  await tick();
  expect(socket.of("close")).toEqual([{ t: "close", reason: "revoked" }]);
  expect(socket.closedWith).toEqual({ code: 4001, reason: "revoked" });
  expect(zeros[0]!.closed).toBe(true);
  expect(relay.connections).toBe(0);
});

test("a relay whose scope is null at startup revokes the socket", async () => {
  const { open } = setup();
  people.clear();
  const { socket } = open();
  await tick();
  expect(socket.closedWith?.reason).toBe("revoked");
});

test("needs-auth triggers a token refresh", async () => {
  const { zeros, open } = setup();
  open();
  await tick();
  for (const listener of zeros[0]!.stateListeners) listener({ name: "needs-auth" });
  await tick();
  expect(zeros[0]!.auths).toHaveLength(1);
});

test("Zero closes after the idle timeout once every socket is gone", async () => {
  const events: string[] = [];
  const { zeros, open } = setup(undefined, {
    idleTimeout: 20,
    onActive: () => events.push("active"),
    onIdle: () => events.push("idle"),
  });
  const { connection } = open();
  await tick();
  expect(zeros[0]!.closed).toBe(false);
  expect(events).toEqual(["active"]);
  connection.closed();
  await tick();
  expect(zeros[0]!.closed).toBe(false);
  await vi.waitFor(() => expect(zeros[0]!.closed).toBe(true));
  expect(events).toEqual(["active", "idle"]);
});

test("ApplicationError is what crosses the hop", () => {
  expect(toApplicationError(new RelayError("X"))).toBeInstanceOf(ApplicationError);
});

test("an idle socket expires without traffic while another session stays connected", async () => {
  const { relay, open } = setup();
  const expired = open(Date.now() + 30);
  const active = open(null);
  await vi.waitFor(() =>
    expect(expired.socket.closedWith).toEqual({
      code: CloseCode.sessionExpired,
      reason: "session-expired",
    }),
  );
  expect(expired.socket.of("close")).toEqual([{ t: "close", reason: "session-expired" }]);
  expect(active.socket.closedWith).toBeUndefined();
  expect(relay.connections).toBe(1);
});

test("user refresh preserves each session deadline and late timers cannot leak data or accept writes", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const { relay, zeros, open } = setup();
  const a = open(now + 10_000);
  const b = open(now + 20_000);
  a.send({ t: "sub", id: "a", path: "lists.mine" });
  b.send({ t: "sub", id: "b", path: "lists.mine" });
  await vi.waitFor(() => expect(zeros[0]?.views).toHaveLength(1));
  const view = zeros[0]!.views[0]!;
  view.emit([], "complete");
  await tick();
  people.set("alice", { userID: "alice", role: "admin" });
  await relay.invalidate();
  expect(a.socket.user).toEqual({ userID: "alice", role: "admin" });

  // Jump the clock without running the expiry timer: delivery must check the deadline itself.
  clock.mockReturnValue(now + 10_000);
  view.emit([{ id: "new", name: "New" }], "complete");
  await tick();
  expect(a.socket.of("data")).toHaveLength(1);
  expect(a.socket.closedWith?.reason).toBe("session-expired");
  expect(b.socket.of("data")).toHaveLength(2);
  expect(b.socket.closedWith).toBeUndefined();
  a.send({ t: "call", id: "late", path: "lists.quick" });
  a.send({ t: "sub", id: "late", path: "lists.mine" });
  await tick();
  expect(zeros[0]!.mutations).toHaveLength(0);
  expect(relay.connections).toBe(1);
});

test("a message at the deadline is rejected even before the expiry timer runs", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const { open, zeros } = setup();
  const { socket, send } = open(now + 10_000);
  await tick();
  clock.mockReturnValue(now + 10_000);
  send({ t: "call", id: "expired", path: "lists.quick" });
  await tick();
  expect(zeros[0]!.mutations).toHaveLength(0);
  expect(socket.closedWith?.reason).toBe("session-expired");
});

test.each(["query", "mutation"] as const)(
  "a %s waiting in middleware cannot start after session expiry",
  async (kind) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const pause = async () => {
      entered = true;
      await wait;
    };
    const middleware = app.middleware.relay({
      subscribe: async ({ next }) => {
        await pause();
        return next();
      },
      call: async ({ next }) => {
        await pause();
        return next();
      },
    });
    const { open, zeros } = setup(undefined, {
      router: app.router({
        query: app.query.use(middleware).handler(({ zql }) => zql.list),
        mutation: app.mutation.use(middleware).handler(async () => {}),
      }),
    });
    const { socket, send } = open(now + 10_000);
    send({ t: kind === "query" ? "sub" : "call", id: "slow", path: kind });
    await vi.waitFor(() => expect(entered).toBe(true));
    clock.mockReturnValue(now + 10_000);
    release();
    await tick();
    expect(socket.closedWith?.reason).toBe("session-expired");
    expect(zeros[0]!.views).toHaveLength(0);
    expect(zeros[0]!.mutations).toHaveLength(0);
  },
);

test("a mutation already submitted may finish but cannot deliver a result after expiry", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const { open, zeros } = setup();
  const { socket, send } = open(now + 10_000);
  await vi.waitFor(() => expect(zeros).toHaveLength(1));
  let finish!: (result: MutatorResultLike) => void;
  const server = new Promise<MutatorResultLike>((resolve) => {
    finish = resolve;
  });
  const mutate = vi.spyOn(zeros[0]!, "mutate").mockReturnValue({
    client: Promise.resolve({ type: "success" }),
    server,
  });
  send({ t: "call", id: "write", path: "lists.rename", input: { id: "l1", name: "Renamed" } });
  await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  clock.mockReturnValue(now + 10_000);
  finish({ type: "success", data: "committed" });
  await tick();
  expect(socket.of("result")).toHaveLength(0);
  expect(socket.closedWith?.reason).toBe("session-expired");
});

test.each([0, NaN, Infinity])(
  "a rejected session deadline %s cannot create a Zero client",
  async (expiresAt) => {
    const { open, relay, zeros } = setup();
    const { socket, send } = open(expiresAt);
    send({ t: "call", id: "write", path: "lists.quick" });
    await tick();
    expect(socket.closedWith?.reason).toBe("session-expired");
    expect(relay.connections).toBe(0);
    expect(zeros).toHaveLength(0);
  },
);

test("closing a socket cancels its expiry timer", async () => {
  const { open } = setup();
  const { socket, connection } = open(Date.now() + 30);
  connection.closed();
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(socket.of("close")).toHaveLength(0);
  expect(socket.closedWith).toBeUndefined();
});

test("an expired socket closes even if sending its control message fails", () => {
  const { relay, user } = setup();
  const socket = new FakeSocket();
  vi.spyOn(socket, "send").mockImplementation(() => {
    throw new Error("Send failed");
  });
  relay.connect(socket, user, 0);
  expect(socket.closedWith).toEqual({ code: CloseCode.sessionExpired, reason: "session-expired" });
  expect(relay.connections).toBe(0);
});

test.each([false, true])(
  "relay middleware error data is validated before delivery (invalid: %s)",
  async (invalid) => {
    const custom = app.router({
      save: app.mutation
        .errors({ CONFLICT: { data: z.object({ version: z.number() }) } })
        .use(
          app.middleware.relay({
            call: async () => {
              throw new RelayError("CONFLICT", {
                message: "Conflict",
                data: { version: invalid ? "private" : 2, secret: "private" },
              });
            },
          }),
        )
        .handler(async () => {}),
    });
    const { open, zeros } = setup(undefined, { router: custom });
    const { socket, send } = open();
    send({ t: "call", id: "save", path: "save" });
    await vi.waitFor(() => expect(socket.of("result")).toHaveLength(1));
    expect(socket.of("result")[0]).toEqual({
      t: "result",
      id: "save",
      ok: false,
      error: invalid
        ? { code: "INTERNAL", message: "Internal error" }
        : { code: "CONFLICT", message: "Conflict", data: { version: 2 } },
    });
    expect(zeros[0]!.mutations).toHaveLength(0);
  },
);

test("a server error's schema transformation runs once before the result reaches the browser", async () => {
  const validate = vi.fn(async (value: unknown) =>
    typeof value === "string"
      ? { value: Number(value) }
      : { issues: [{ message: "Expected a string" }] },
  );
  const data: StandardSchemaV1<string, number> = {
    "~standard": { version: 1, vendor: "test", validate },
  };
  const custom = app.router({
    save: app.mutation
      .errors({ CONFLICT: { message: "Conflict", data } })
      .handler(async ({ errors }) => {
        throw errors.CONFLICT("7");
      }),
  });
  const { open, zeros } = setup(undefined, { router: custom });
  const { socket, send } = open();
  await vi.waitFor(() => expect(zeros).toHaveLength(1));
  const error = (await runMutator(
    compileRouter(app, custom),
    "save",
    { location: "server" },
    { actor: people.get("alice") },
    {
      ...zeros[0]!.init.context,
      site: "server",
    },
  ).catch((e) => e)) as ApplicationError;
  expect(error).toBeInstanceOf(ApplicationError);
  zeros[0]!.result = () => ({
    client: { type: "success" },
    server: {
      type: "error",
      error: {
        type: "app",
        message: error.message,
        details: JSON.parse(JSON.stringify(error.details)),
      },
    },
  });
  send({ t: "call", id: "save", path: "save" });
  await vi.waitFor(() => expect(socket.of("result")).toHaveLength(1));
  expect(socket.of("result")[0]).toEqual({
    t: "result",
    id: "save",
    ok: false,
    error: { code: "CONFLICT", message: "Conflict", data: 7 },
  });
  expect(validate).toHaveBeenCalledExactlyOnceWith("7");
});

test("omitted query inputs remain undefined and use schema defaults during materialization", async () => {
  const observed: unknown[] = [];
  const custom = app.router({
    optional: app.query.input(z.object({ id: z.string() }).optional()).handler(({ zql, input }) => {
      observed.push(input);
      return zql.list;
    }),
    defaulted: app.query
      .input(z.object({ id: z.string() }).default({ id: "default" }))
      .handler(({ zql, input }) => {
        observed.push(input);
        return zql.list.where("id", input.id);
      }),
  });
  const { open, zeros } = setup(undefined, { router: custom });
  const { socket, send } = open();
  send({ t: "sub", id: "optional", path: "optional" });
  send({ t: "sub", id: "defaulted", path: "defaulted" });
  await vi.waitFor(() => expect(zeros[0]?.views).toHaveLength(2));
  expect(observed).toContain(undefined);
  expect(observed).toContainEqual({ id: "default" });
  for (const view of zeros[0]!.views) {
    expect(view.request.args).toBeUndefined();
    view.emit([], "complete");
  }
  await tick();
  expect(socket.of("error")).toHaveLength(0);
  expect(socket.of("data")).toHaveLength(2);
});

test("null and omitted query input have separate views, while identical omitted inputs share", async () => {
  const observed: unknown[] = [];
  const custom = app.router({
    all: app.query.input(z.string().nullish()).handler(({ zql, input }) => {
      observed.push(input);
      return zql.list.where(
        "name",
        input === undefined ? "omitted" : input === null ? "null" : input,
      );
    }),
  });
  const { open, zeros } = setup(undefined, { router: custom });
  const { socket, send } = open();
  send({ t: "sub", id: "a", path: "all" });
  send({ t: "sub", id: "b", path: "all", input: undefined });
  send({ t: "sub", id: "c", path: "all", input: null });
  await vi.waitFor(() => expect(zeros[0]?.views).toHaveLength(2));
  expect(observed).toEqual(expect.arrayContaining([undefined, null]));
  for (const view of zeros[0]!.views)
    view.emit([{ name: view.request.args === undefined ? "omitted" : "null" }], "complete");
  await tick();
  const results = Object.fromEntries(socket.of("data").map(({ id, data }) => [id, data]));
  expect(results).toEqual({
    a: [{ name: "omitted" }],
    b: [{ name: "omitted" }],
    c: [{ name: "null" }],
  });
});
