import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { createApp, type AuthSession } from "../src/app.ts";
import { cloudflare } from "../src/cloudflare.ts";
import { createRelay } from "../src/internal/relay/runtime.ts";
import { PROTOCOL } from "../src/internal/protocol.ts";
import { schema } from "../examples/todo/schema.ts";

// Test the real Worker and DO adapter, substituting the relay runtime and platform transport.
// Runtime expiry and data delivery are covered in relay.test.ts.
vi.mock("../src/internal/relay/runtime.ts", () => ({ createRelay: vi.fn() }));

const NOW = 1_800_000_000_000;
const user = { userID: "alice" };
const EXPIRY = "x-zero-relay-session-expires-at";

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  // Node's Response rejects 101; preserve that status for this transport stand-in.
  vi.stubGlobal(
    "Response",
    class extends Response {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init);
        if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
      }
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(expiresAt: unknown = NOW + 1000) {
  // Include malformed runtime values from an incorrectly implemented authentication callback.
  const authenticate = vi.fn((): AuthSession<typeof user> | null => ({
    user,
    expiresAt: expiresAt as number | null,
  }));
  const authorize = vi.fn(() => true);
  const app = createApp<{ user: typeof user }>()({
    schema,
    authenticate,
    partition: {
      key: ({ user }) => user.userID,
      authorize,
      scope: ({ key }) => ({ userID: key }),
      user: ({ scope }) => scope,
    },
  });
  const connect = vi.fn<ReturnType<typeof createRelay>["connect"]>(() => ({
    message: () => {},
    closed: () => {},
  }));
  vi.mocked(createRelay).mockReturnValue({
    connect,
    connections: 0,
    invalidate: async () => {},
    shutdown: async () => {},
  });
  const host = cloudflare(app, {
    router: app.router({}),
    database: () => {
      throw new Error("Unexpected database access");
    },
  });
  const forward = vi.fn<(request: Request) => Promise<Response>>();
  const env = {
    ZERO_CACHE_URL: "https://cache.example.com",
    ZERO_RELAY_SECRET: "test-secret",
    RELAY: { idFromName: (name: string) => name, get: () => ({ fetch: forward }) },
  };
  const server = { send: vi.fn(), close: vi.fn(), serializeAttachment: vi.fn() };
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = {};
      1 = server;
    },
  );
  const acceptWebSocket = vi.fn();
  const object = new host.DurableObject(
    {
      id: { toString: () => "main/alice" },
      acceptWebSocket,
      getWebSockets: () => [],
    },
    env,
  );
  forward.mockImplementation((request) => object.fetch(request));
  const upgrade = () =>
    host.worker.fetch(
      new Request("https://app.example.com/zero/live", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": PROTOCOL,
          [EXPIRY]: "null",
          "x-zero-relay-user": encodeURIComponent(JSON.stringify({ userID: "mallory" })),
        },
      }),
      env,
      { waitUntil: () => {} },
    );
  return { authenticate, authorize, forward, object, upgrade, connect, server, acceptWebSocket };
}

test.each([NOW + 1000, null])(
  "only the verified user and expiry %s reach the relay",
  async (expiresAt) => {
    const { upgrade, connect, server } = setup(expiresAt);
    expect((await upgrade()).status).toBe(101);
    expect(connect).toHaveBeenCalledExactlyOnceWith(expect.anything(), user, expiresAt);
    expect(server.serializeAttachment).toHaveBeenLastCalledWith({ user, expiresAt });
    connect.mock.calls[0]![0].setUser?.({ userID: "alice", role: "admin" });
    expect(server.serializeAttachment).toHaveBeenLastCalledWith({
      user: { userID: "alice", role: "admin" },
      expiresAt,
    });
  },
);

test.each([NOW - 1, NOW, NaN, Infinity, "later"])(
  "the Worker rejects invalid or expired deadline %s",
  async (expiresAt) => {
    const { upgrade, forward } = setup(expiresAt);
    expect((await upgrade()).status).toBe(401);
    expect(forward).not.toHaveBeenCalled();
  },
);

test("authentication must supply an explicit expiry even when the user is valid", async () => {
  const { upgrade, authenticate, forward } = setup();
  authenticate.mockReturnValue({ user } as AuthSession<typeof user>);
  expect((await upgrade()).status).toBe(401);
  authenticate.mockReturnValue(null);
  expect((await upgrade()).status).toBe(401);
  expect(forward).not.toHaveBeenCalled();
});

test("expiry during partition authorization prevents forwarding the upgrade", async () => {
  const { upgrade, authorize, forward } = setup();
  authorize.mockImplementation(() => {
    vi.mocked(Date.now).mockReturnValue(NOW + 1000);
    return true;
  });
  expect((await upgrade()).status).toBe(401);
  expect(forward).not.toHaveBeenCalled();
});

test("the Durable Object rechecks expiry after transport delay", async () => {
  const { upgrade, forward, object, connect, acceptWebSocket } = setup();
  forward.mockImplementation((request) => {
    vi.mocked(Date.now).mockReturnValue(NOW + 1000);
    return object.fetch(request);
  });
  expect((await upgrade()).status).toBe(401);
  expect(connect).not.toHaveBeenCalled();
  expect(acceptWebSocket).not.toHaveBeenCalled();
});

test.each([undefined, "NaN", "Infinity", "", String(NOW)])(
  "the Durable Object rejects missing or invalid expiry header %s",
  async (expiry) => {
    const { object, connect } = setup();
    const headers = new Headers({
      "x-zero-relay-name": "main",
      "x-zero-relay-key": "alice",
      "x-zero-relay-user": encodeURIComponent(JSON.stringify(user)),
    });
    if (expiry !== undefined) headers.set(EXPIRY, expiry);
    expect(
      (await object.fetch(new Request("https://app.example.com/zero/live", { headers }))).status,
    ).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  },
);
