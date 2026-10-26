import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { createClient, type ConnectionStatus } from "../src/client.ts";
import { RelayError } from "../src/errors.ts";
import { CloseCode, PROTOCOL } from "../src/internal/protocol.ts";
import type { Router } from "../examples/todo/routers/index.ts";
import { FakeWebSocket } from "./helpers/fake-websocket.ts";

let doc: EventTarget & { visibilityState: DocumentVisibilityState };

beforeEach(() => {
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", new URL("https://app.example.com/lists"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const latest = () => FakeWebSocket.instances.at(-1)!;

function client(options: Parameters<typeof createClient>[0] = {}) {
  const statuses: ConnectionStatus[] = [];
  const api = createClient<Router>({ ...options, onStatusChange: (s) => statuses.push(s) });
  return { api, statuses };
}

test("connects lazily to /zero/live with the protocol and params", () => {
  const { api } = client({ params: { docID: "d1" } });
  expect(FakeWebSocket.instances).toHaveLength(0);
  api.lists.mine.subscribe(undefined, () => {});
  expect(latest().url).toBe("wss://app.example.com/zero/live?docID=d1");
  expect(latest().protocol).toBe(PROTOCOL);
});

test("query refs are stable, and snapshots reach the listener", () => {
  const { api } = client();
  expect(api.lists.mine).toBe(api.lists.mine);
  expect(api.lists.mine.path).toBe("lists.mine");
  const listener = vi.fn();
  api.lists.get.subscribe({ id: "l1" }, listener);
  latest().open();
  expect(latest().sent).toEqual([{ t: "sub", id: "s1", path: "lists.get", input: { id: "l1" } }]);
  latest().receive({ t: "data", id: "s1", type: "complete", data: { id: "l1" } });
  expect(listener).toHaveBeenCalledWith({ data: { id: "l1" }, status: "complete" });
});

test("reconnects with backoff and resubscribes", () => {
  const { api, statuses } = client();
  api.lists.mine.subscribe(undefined, () => {});
  latest().open();
  latest().drop(1006);
  expect(statuses).toEqual(["connecting", "open", "reconnecting"]);
  vi.advanceTimersByTime(MAX);
  expect(FakeWebSocket.instances).toHaveLength(2);
  latest().open();
  expect(latest().sent).toEqual([{ t: "sub", id: "s1", path: "lists.mine" }]);
});

const MAX = 30_000;

test.each([1006, CloseCode.restarting, CloseCode.refresh])(
  "a sent mutation reports an unknown outcome and is not replayed after close %s",
  async (code) => {
    const { api } = client();
    api.lists.mine.subscribe(undefined, () => {});
    const original = latest();
    original.open();
    const result = api.todos.toggle.safe({ id: "t1", done: true });
    expect(original.sent.filter((message) => message.t === "call")).toHaveLength(1);
    original.drop(code);
    await expect(result).resolves.toMatchObject({
      data: undefined,
      error: { code: "OUTCOME_UNKNOWN" },
    });

    // Reconnect after the relay's result cache could have expired or been lost in a restart.
    vi.advanceTimersByTime(65_000);
    latest().open();
    expect(latest()).not.toBe(original);
    expect(latest().sent).toEqual([{ t: "sub", id: "s1", path: "lists.mine" }]);
    api.$close();
  },
);

test("a call flushed on first connect is not replayed if its result is lost", async () => {
  const { api } = client();
  const result = api.todos.toggle.safe({ id: "t1", done: true });
  latest().open();
  expect(latest().sent).toHaveLength(1);
  latest().drop(CloseCode.restarting);
  await expect(result).resolves.toMatchObject({ error: { code: "OUTCOME_UNKNOWN" } });
  vi.advanceTimersByTime(MAX);
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(api.$status).toBe("closed");
});

test("a call that was never sent survives a failed connection attempt", async () => {
  const { api } = client();
  const result = api.todos.toggle({ id: "t1", done: true });
  expect(latest().sent).toEqual([]);
  latest().drop(1006);
  vi.advanceTimersByTime(MAX);
  latest().open();
  const call = latest().sent[0]!;
  expect(call).toMatchObject({ t: "call", path: "todos.toggle", input: { id: "t1", done: true } });
  expect(latest().sent).toHaveLength(1);
  latest().receive({ t: "result", id: call.id, ok: true, data: null });
  await expect(result).resolves.toBeNull();
  api.$close();
});

test("hidden-tab disconnect settles sent calls while new calls wait for visibility", async () => {
  const { api } = client({ hiddenTabDisconnectDelay: 1000 });
  const sent = api.todos.toggle.safe({ id: "t1", done: true });
  latest().open();
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(1000);
  await expect(sent).resolves.toMatchObject({ error: { code: "OUTCOME_UNKNOWN" } });

  const queued = api.todos.toggle({ id: "t2", done: true });
  expect(FakeWebSocket.instances).toHaveLength(1);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  latest().open();
  expect(latest().sent).toHaveLength(1);
  const call = latest().sent[0]!;
  expect(call).toMatchObject({ t: "call", input: { id: "t2", done: true } });
  latest().receive({ t: "result", id: call.id, ok: true, data: null });
  await expect(queued).resolves.toBeNull();
  api.$close();
});

test("logout distinguishes sent mutations from calls that never left the client", async () => {
  const { api } = client();
  const sent = api.todos.toggle.safe({ id: "t1", done: true });
  latest().open();
  // A new call arrives while the socket is closing but before the close event.
  latest().readyState = 2;
  const queued = api.todos.toggle.safe({ id: "t2", done: true });
  api.$close();
  await expect(sent).resolves.toMatchObject({ error: { code: "OUTCOME_UNKNOWN" } });
  await expect(queued).resolves.toMatchObject({ error: { code: "DISCONNECTED" } });
  vi.advanceTimersByTime(MAX);
  expect(FakeWebSocket.instances).toHaveLength(1);
});

test("a mutation started by the open status callback is sent only once", async () => {
  let result: Promise<unknown> | undefined;
  const api = createClient<Router>({
    onStatusChange: (status) => {
      if (status === "open") result = api.todos.toggle({ id: "t1", done: true });
    },
  });
  api.lists.mine.subscribe(undefined, () => {});
  latest().open();
  const calls = latest().sent.filter((message) => message.t === "call");
  expect(calls).toHaveLength(1);
  latest().receive({ t: "result", id: calls[0]!.id, ok: true, data: null });
  await expect(result).resolves.toBeNull();
  api.$close();
});

test("a send failure settles the call and does not leave it queued for replay", async () => {
  const { api } = client();
  api.lists.mine.subscribe(undefined, () => {});
  latest().open();
  vi.spyOn(latest(), "send").mockImplementationOnce(() => {
    throw new Error("Send failed");
  });
  await expect(api.todos.toggle.safe({ id: "t1", done: true })).resolves.toMatchObject({
    error: { code: "OUTCOME_UNKNOWN" },
  });
  latest().drop(CloseCode.restarting);
  vi.advanceTimersByTime(0);
  latest().open();
  expect(latest().sent).toEqual([{ t: "sub", id: "s1", path: "lists.mine" }]);
  api.$close();
});

test("serialization failures cannot leave a rejected mutation queued for a later connection", async () => {
  const { api } = client();
  const input = {
    id: "t1",
    done: true,
    toJSON() {
      throw new Error("Cannot serialize");
    },
  };
  await expect(api.todos.toggle(input)).rejects.toThrow("Cannot serialize");
  api.lists.mine.subscribe(undefined, () => {});
  latest().open();
  expect(latest().sent).toEqual([{ t: "sub", id: "s1", path: "lists.mine" }]);
  api.$close();
});

test("a failed socket setup cannot leave a rejected mutation queued for a later connection", async () => {
  const { api } = client();
  const Socket = vi.fn(function () {
    throw new Error("Cannot connect");
  });
  Object.assign(Socket, { OPEN: 1 });
  vi.stubGlobal("WebSocket", Socket);
  await expect(api.todos.toggle({ id: "t1", done: true })).rejects.toThrow("Cannot connect");
  vi.stubGlobal("WebSocket", FakeWebSocket);
  api.lists.mine.subscribe(undefined, () => {});
  latest().open();
  expect(latest().sent).toEqual([{ t: "sub", id: "s1", path: "lists.mine" }]);
  api.$close();
});

test("errors arrive as RelayErrors, and .safe never throws them", async () => {
  const { api } = client();
  const thrown = api.todos.toggle({ id: "t1", done: true });
  const safe = api.todos.toggle.safe({ id: "t2", done: true });
  latest().open();
  const [a, b] = latest().sent as { id: string }[];
  const error = { code: "NOT_FOUND", message: "Todo not found", data: null };
  latest().receive({ t: "result", id: a!.id, ok: false, error });
  latest().receive({ t: "result", id: b!.id, ok: false, error });
  await expect(thrown).rejects.toMatchObject({ code: "NOT_FOUND", message: "Todo not found" });
  const { data, error: safeError } = await safe;
  expect(data).toBeUndefined();
  expect(safeError).toBeInstanceOf(RelayError);
});

test("subscription errors end the subscription", () => {
  const { api } = client();
  const onError = vi.fn();
  const listener = vi.fn();
  api.lists.mine.subscribe(undefined, listener, onError);
  latest().open();
  latest().receive({ t: "error", id: "s1", error: { code: "FORBIDDEN", message: "Forbidden" } });
  latest().receive({ t: "data", id: "s1", type: "complete", data: [] });
  expect(onError.mock.calls[0]![0]).toMatchObject({ code: "FORBIDDEN" });
  expect(listener).toHaveBeenCalledExactlyOnceWith({ data: undefined, status: "error" });
});

test.each([CloseCode.revoked, CloseCode.sessionExpired])(
  "terminal close %s clears every subscriber and rejects new subscriptions",
  (code) => {
    const { api } = client();
    const first = vi.fn();
    const second = vi.fn();
    const onError = vi.fn();
    api.lists.mine.subscribe(undefined, first, onError);
    api.lists.mine.subscribe(undefined, second);
    latest().open();
    for (const id of ["s1", "s2"])
      latest().receive({ t: "data", id, type: "complete", data: [{ id: "l1", name: "Private" }] });

    latest().drop(code);
    for (const listener of [first, second])
      expect(listener).toHaveBeenLastCalledWith({ data: undefined, status: "error" });
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "FORBIDDEN" }));

    const late = vi.fn();
    const lateError = vi.fn();
    api.lists.mine.subscribe(undefined, late, lateError);
    expect(late).toHaveBeenCalledExactlyOnceWith({ data: undefined, status: "error" });
    expect(lateError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    api.$close();
    expect(first).toHaveBeenCalledTimes(2);
    expect(api.$status).toBe("revoked");
    vi.advanceTimersByTime(MAX);
    expect(FakeWebSocket.instances).toHaveLength(1);
  },
);

test("logout clears all subscribers even if one callback throws", () => {
  const { api } = client();
  const broken = vi.fn(() => {
    throw new Error("Broken listener");
  });
  const firstError = vi.fn(() => {
    throw new Error("Broken error handler");
  });
  const second = vi.fn();
  const secondError = vi.fn();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  api.lists.mine.subscribe(undefined, broken, firstError);
  api.lists.mine.subscribe(undefined, second, secondError);
  latest().open();
  expect(() => api.$close()).not.toThrow();
  expect(firstError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ code: "DISCONNECTED" }),
  );
  expect(second).toHaveBeenCalledExactlyOnceWith({ data: undefined, status: "error" });
  expect(secondError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ code: "DISCONNECTED" }),
  );
  expect(logged).toHaveBeenCalledTimes(2);
  expect(api.$status).toBe("closed");
});

test("reauthentication clears snapshots and ignores messages from the previous socket", () => {
  const { api } = client();
  const listener = vi.fn();
  const onError = vi.fn();
  api.lists.mine.subscribe(undefined, listener, onError);
  const previous = latest();
  previous.open();
  previous.receive({ t: "data", id: "s1", type: "complete", data: [{ id: "l1", name: "Old" }] });
  previous.drop(CloseCode.refresh);
  expect(listener).toHaveBeenLastCalledWith({ data: undefined, status: "unknown" });
  vi.advanceTimersByTime(0);
  latest().open();
  previous.receive({ t: "data", id: "s1", type: "complete", data: [{ id: "l1", name: "Old" }] });
  previous.receive({ t: "close", reason: "revoked" });
  expect(listener).toHaveBeenCalledTimes(2);
  expect(api.$status).toBe("open");
  expect(onError).not.toHaveBeenCalled();
  latest().receive({ t: "data", id: "s1", type: "complete", data: [] });
  expect(listener).toHaveBeenLastCalledWith({ data: [], status: "complete" });
});

test.each(["revoked", "session-expired"] as const)(
  "%s stops reconnecting and settles pending calls",
  async (reason) => {
    const { api, statuses } = client();
    const call = api.todos.toggle({ id: "t1", done: true });
    latest().open();
    latest().receive({ t: "close", reason });
    latest().drop(reason === "revoked" ? CloseCode.revoked : CloseCode.sessionExpired);
    await expect(call).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    vi.advanceTimersByTime(MAX);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe("revoked");
    expect(api.$status).toBe("revoked");
  },
);

test("hidden tabs disconnect after the delay and resubscribe when visible", () => {
  const { api, statuses } = client({ hiddenTabDisconnectDelay: 1000 });
  const listener = vi.fn();
  api.lists.mine.subscribe(undefined, listener);
  latest().open();
  latest().receive({ t: "data", id: "s1", type: "complete", data: [] });
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(1000);
  expect(statuses.at(-1)).toBe("hidden");
  expect(latest().readyState).toBe(3);
  expect(listener).toHaveBeenLastCalledWith({ data: undefined, status: "unknown" });

  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(FakeWebSocket.instances).toHaveLength(2);
  latest().open();
  expect(latest().sent).toEqual([{ t: "sub", id: "s1", path: "lists.mine" }]);
});

test("$close drops everything and unsubscribes go nowhere", () => {
  const { api } = client();
  const stop = api.lists.mine.subscribe(undefined, () => {});
  latest().open();
  stop();
  expect(latest().sent.at(-1)).toEqual({ t: "unsub", id: "s1" });
  api.$close();
  expect(api.$status).toBe("closed");
  expect(latest().readyState).toBe(3);
});

test("the client isn't thenable", async () => {
  const { api } = client();
  const resolved = await Promise.resolve(api.lists);
  expect(resolved).toBe(api.lists);
  expect(FakeWebSocket.instances).toHaveLength(0);
});
