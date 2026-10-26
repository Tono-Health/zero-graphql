import { Zero } from "@rocicorp/zero";
import type { App } from "./app.ts";
import { registerCacheFetcher } from "./internal/cloudflare/fetch-websocket.ts";
import {
  ensureReplicaTable,
  sqliteStoreProvider,
  wipeReplica,
  type DurableObjectSqlite,
} from "./internal/cloudflare/sqlite-store.ts";
import type { Relay, RelayConnection, ZeroInit, ZeroLike } from "./internal/relay/contracts.ts";
import { createRelay } from "./internal/relay/runtime.ts";
import { resolveRelays, type ResolvedRelay } from "./internal/relays.ts";
import { MAIN_RELAY } from "./internal/token.ts";
import { isActiveSession } from "./internal/session.ts";
import type { InvalidateTarget } from "./procedure.ts";
import { CloseCode, PROTOCOL, type ServerMessage } from "./internal/protocol.ts";
import { createEndpoints, type EndpointOptions } from "./server.ts";
import type { AppDef } from "./types.ts";

export interface CloudflareOptions<D extends AppDef, TEnv extends D["env"] = D["env"]> extends Omit<
  EndpointOptions<D, TEnv>,
  "secret" | "invalidate"
> {
  /** Durable Object binding for relays. Default: `"RELAY"`. */
  readonly binding?: string;
  /**
   * Where relays reach zero-cache: a URL, or a binding whose `fetch` accepts WebSocket upgrades
   * (a service binding, or a container's Durable Object stub), which keeps zero-cache off the
   * public internet. Called inside the relay each time it connects, so create stubs here.
   * Default: `env.ZERO_CACHE_URL`.
   */
  readonly cache?: (env: TEnv) => string | FetcherLike;
  /** Signs relay tokens. Default: `env.ZERO_RELAY_SECRET`. */
  readonly secret?: (env: TEnv) => string;
  /** Prefix for `/live`, `/query`, and `/mutate`. Default: `"/zero"`. */
  readonly basePath?: string;
  /**
   * Where a relay keeps its Zero replica. `"memory"` keeps it in the isolate heap.
   * `sqlite` keeps it in the Durable Object's SQLite file (10 GB per object on Workers
   * Paid, 2 MB per entry) and deletes it `retainFor` milliseconds after the Zero client
   * goes idle. The class must be created with `new_sqlite_classes`.
   */
  readonly storage?: "memory" | { readonly sqlite: { readonly retainFor: number } };
  /** How long a relay keeps its Zero connection after the last browser leaves, in ms. Default: 30s. */
  readonly idleTimeout?: number;
  /**
   * How often an active relay refreshes its context without being invalidated, in ms. Bounds how
   * long changes made outside the app (a direct database edit, an identity-provider sync) take to
   * apply. Default: 5 minutes, matching zero-cache's `ZERO_AUTH_RETRANSFORM_INTERVAL_SECONDS`.
   * Shared sockets reconnect on this interval to re-run authentication and partition authorization.
   */
  readonly refreshInterval?: number;
}

/** Structural stand-ins, so the package doesn't depend on `@cloudflare/workers-types`. */
export interface HibernatableWebSocketLike {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
}
export interface DurableObjectStateLike {
  readonly id: { toString(): string; readonly name?: string };
  acceptWebSocket(socket: HibernatableWebSocketLike): void;
  getWebSockets(): HibernatableWebSocketLike[];
  setWebSocketAutoResponse?(pair: unknown): void;
  /** Present on a SQLite-backed Durable Object. Required when `storage` is `sqlite`. */
  readonly storage?: DurableObjectSqlite & {
    setAlarm(scheduledTime: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
}
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
export interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}
interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): FetcherLike;
}

export interface RelayDurableObject {
  fetch(request: Request): Promise<Response>;
  webSocketMessage(ws: HibernatableWebSocketLike, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(
    ws: HibernatableWebSocketLike,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
  webSocketError(ws: HibernatableWebSocketLike, error: unknown): Promise<void>;
  alarm(): Promise<void>;
}

export interface CloudflareRelay<TEnv> {
  /** Export as the Worker's default if zero-relay owns the whole Worker. */
  readonly worker: {
    fetch(request: Request, env: TEnv, ctx: ExecutionContextLike): Promise<Response>;
  };
  /** For composing with your own router: a response for zero-relay's paths, `undefined` otherwise. */
  handle(request: Request, env: TEnv, ctx: ExecutionContextLike): Promise<Response | undefined>;
  /** Export under the class name in your Wrangler config's Durable Object binding. */
  readonly DurableObject: new (state: DurableObjectStateLike, env: TEnv) => RelayDurableObject;
  /**
   * Refreshes a relay's context now, from outside a mutation: admin tools, webhooks, SCIM sync.
   * Resolves once the relay has reloaded its scope. A relay that isn't running is a no-op.
   */
  invalidate(env: TEnv, target: InvalidateTarget): Promise<void>;
}

declare const WebSocketPair: new () => { 0: WebSocket; 1: HibernatableWebSocketLike };
declare const WebSocketRequestResponsePair: new (request: string, response: string) => unknown;

// Set by the Worker on requests to a relay. Durable Objects aren't publicly addressable, and the
// Worker overwrites these on every request, so the relay can trust them.
const RELAY_HEADER = "x-zero-relay-name";
const KEY_HEADER = "x-zero-relay-key";
const USER_HEADER = "x-zero-relay-user";
const EXPIRY_HEADER = "x-zero-relay-session-expires-at";
const INVALIDATE_URL = "https://relay.zero-relay.internal/invalidate";

export function cloudflare<D extends AppDef, TEnv extends D["env"] = D["env"]>(
  app: App<D>,
  options: CloudflareOptions<D, TEnv>,
): CloudflareRelay<TEnv> {
  const sqlite =
    options.storage !== undefined && options.storage !== "memory"
      ? options.storage.sqlite
      : undefined;
  if (sqlite !== undefined && (!Number.isFinite(sqlite.retainFor) || sqlite.retainFor < 0)) {
    throw new Error(
      "zero-relay: storage.sqlite.retainFor must be a non-negative number of milliseconds",
    );
  }
  const basePath = (options.basePath ?? "/zero").replace(/\/$/, "");
  const relays = resolveRelays(app, options.router, options.relays);
  const variable = (env: TEnv, name: string): string => {
    const value = (env as Record<string, unknown>)[name];
    if (typeof value !== "string" || !value) throw new Error(`zero-relay: env.${name} isn't set`);
    return value;
  };
  const secret = options.secret ?? ((env: TEnv) => variable(env, "ZERO_RELAY_SECRET"));
  const namespace = (env: TEnv): DurableObjectNamespaceLike => {
    const binding = (env as Record<string, unknown>)[options.binding ?? "RELAY"];
    if (!binding) throw new Error(`zero-relay: env.${options.binding ?? "RELAY"} isn't bound`);
    return binding as DurableObjectNamespaceLike;
  };
  const stubFor = (env: TEnv, relay: string, key: string) => {
    const ns = namespace(env);
    return ns.get(ns.idFromName(`${relay}/${key}`));
  };

  const invalidate = async (env: TEnv, target: InvalidateTarget) => {
    const relay = target.relay ?? MAIN_RELAY;
    const headers = new Headers({ [RELAY_HEADER]: relay, [KEY_HEADER]: target.key });
    const response = await stubFor(env, relay, target.key).fetch(
      new Request(INVALIDATE_URL, { method: "POST", headers }),
    );
    if (!response.ok)
      throw new Error(
        `zero-relay: invalidating ${relay}/${target.key} failed (${response.status})`,
      );
  };

  const endpoints = createEndpoints<D, TEnv>(app, { ...options, secret, invalidate });

  const live = async (request: Request, env: TEnv, relay: ResolvedRelay): Promise<Response> => {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    if (!offeredProtocols(request).includes(PROTOCOL)) {
      return new Response(`Expected subprotocol ${PROTOCOL}`, { status: 400 });
    }
    const { config } = relay.app;
    const session = await config.authenticate({ request, env });
    if (!session?.user || !isActiveSession(session.expiresAt))
      return new Response("Unauthorized", { status: 401 });
    const { user, expiresAt } = session;
    const url = new URL(request.url);
    const key = await config.partition.key({ user, request, url, env });
    if (key === null || !(await config.partition.authorize({ user, key, env }))) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!isActiveSession(expiresAt)) return new Response("Unauthorized", { status: 401 });
    const headers = new Headers(request.headers);
    headers.set(RELAY_HEADER, relay.name);
    headers.set(KEY_HEADER, key);
    headers.set(USER_HEADER, encodeURIComponent(JSON.stringify(user)));
    headers.set(EXPIRY_HEADER, JSON.stringify(expiresAt));
    return stubFor(env, relay.name, key).fetch(new Request(request.url, { headers }));
  };

  const handle = async (request: Request, env: TEnv, ctx: ExecutionContextLike) => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(`${basePath}/`)) return undefined;
    const rest = pathname.slice(basePath.length);
    if (rest === "/query" && request.method === "POST") return endpoints.query(request, env);
    if (rest === "/mutate" && request.method === "POST") return endpoints.mutate(request, env, ctx);
    const match = /^\/live(?:\/([^/]+))?\/?$/.exec(rest);
    if (!match) return undefined;
    const name = match[1] ?? MAIN_RELAY;
    const relay = name === MAIN_RELAY && match[1] !== undefined ? undefined : relays.get(name);
    if (!relay) return new Response("Not found", { status: 404 });
    return live(request, env, relay);
  };

  class RelayObject implements RelayDurableObject {
    #relay: Relay | undefined;
    /** True once the Zero client has closed, until the next one is created. A fresh object is idle. */
    #replicaIdle = true;
    readonly #connections = new Map<HibernatableWebSocketLike, RelayConnection>();

    constructor(
      readonly state: DurableObjectStateLike,
      readonly env: TEnv,
    ) {
      state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"));
      // Sockets that outlived the previous instance (after hibernation or a deploy) have no
      // subscriptions here. The client reconnects and resubscribes.
      for (const socket of state.getWebSockets()) closeOrphan(socket);
      if (sqlite) {
        if (!state.storage) {
          throw new Error(
            "zero-relay: SQLite storage requires a SQLite-backed Durable Object (new_sqlite_classes)",
          );
        }
        ensureReplicaTable(state.storage);
      }
    }

    async fetch(request: Request): Promise<Response> {
      const name = request.headers.get(RELAY_HEADER);
      const key = request.headers.get(KEY_HEADER);
      const resolved = name === null ? undefined : relays.get(name);
      if (!resolved || key === null) return new Response("Not found", { status: 404 });

      if (request.url === INVALIDATE_URL) {
        await this.#relay?.invalidate();
        return new Response(null, { status: 204 });
      }

      const user = JSON.parse(
        decodeURIComponent(request.headers.get(USER_HEADER) ?? "null"),
      ) as unknown;
      if (!user) return new Response("Unauthorized", { status: 401 });
      const expiry = request.headers.get(EXPIRY_HEADER);
      const expiresAt = expiry === "null" ? null : expiry === null ? undefined : Number(expiry);
      if (!isActiveSession(expiresAt)) return new Response("Unauthorized", { status: 401 });
      const relay = (this.#relay ??= this.#start(resolved, key));
      const { 0: client, 1: server } = new WebSocketPair();
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ user, expiresAt });
      this.#connections.set(
        server,
        relay.connect(
          {
            send: (message) => server.send(message),
            close: (code, reason) => server.close(code, reason),
            setUser: (next) => server.serializeAttachment({ user: next, expiresAt }),
          },
          user,
          expiresAt,
        ),
      );
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { "Sec-WebSocket-Protocol": PROTOCOL },
      } as ResponseInit);
    }

    async webSocketMessage(
      socket: HibernatableWebSocketLike,
      message: string | ArrayBuffer,
    ): Promise<void> {
      const connection = this.#connections.get(socket);
      if (!connection) return closeOrphan(socket);
      connection.message(typeof message === "string" ? message : new TextDecoder().decode(message));
    }

    async webSocketClose(
      socket: HibernatableWebSocketLike,
      code: number,
      reason: string,
    ): Promise<void> {
      try {
        // 1005 ("no status") and 1006 are reserved and can't be sent back.
        socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
      } catch {
        // Already closed.
      }
      this.#drop(socket);
    }

    async webSocketError(socket: HibernatableWebSocketLike): Promise<void> {
      this.#drop(socket);
    }

    async alarm(): Promise<void> {
      // An alarm wakes a fresh object, whose replica is idle. One that already started a
      // session has cleared this and deleted the alarm; ignore a delivery that raced it.
      if (!sqlite || !this.#replicaIdle || !this.state.storage) return;
      wipeReplica(this.state.storage);
    }

    #armRetention(): void {
      const storage = this.state.storage;
      if (!sqlite || !storage) return;
      this.#replicaIdle = true;
      if (sqlite.retainFor === 0) {
        wipeReplica(storage);
        return;
      }
      void storage.setAlarm(Date.now() + sqlite.retainFor);
    }

    #clearRetention(): void {
      this.#replicaIdle = false;
      void this.state.storage?.deleteAlarm();
    }

    #drop(socket: HibernatableWebSocketLike): void {
      this.#connections.get(socket)?.closed();
      this.#connections.delete(socket);
    }

    #start(relay: ResolvedRelay, key: string): Relay {
      const env = this.env;
      const cache = options.cache?.(env) ?? variable(env, "ZERO_CACHE_URL");
      const cacheURL =
        typeof cache === "string"
          ? cache
          : registerCacheFetcher(() => {
              const fetcher = options.cache!(env) as FetcherLike;
              return (request) => fetcher.fetch(request);
            });
      return createRelay({
        relay,
        key,
        env,
        secret: secret(env),
        idleTimeout: options.idleTimeout,
        refreshInterval: options.refreshInterval,
        createZero: (init: ZeroInit) =>
          new Zero({
            cacheURL,
            userID: init.userID,
            auth: init.auth,
            schema: init.schema,
            mutators: init.mutators,
            context: init.context,
            kvStore: sqlite && this.state.storage ? sqliteStoreProvider(this.state.storage) : "mem",
            logLevel: "error",
          }) as unknown as ZeroLike,
        ...(sqlite
          ? { onActive: () => this.#clearRetention(), onIdle: () => this.#armRetention() }
          : {}),
      });
    }
  }

  return {
    worker: {
      fetch: async (request, env, ctx) =>
        (await handle(request, env, ctx)) ?? new Response("Not found", { status: 404 }),
    },
    handle,
    DurableObject: RelayObject,
    invalidate,
  };
}

function offeredProtocols(request: Request): string[] {
  return (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
}

function closeOrphan(socket: HibernatableWebSocketLike): void {
  const message: ServerMessage = { t: "close", reason: "restarting" };
  try {
    socket.send(JSON.stringify(message));
    socket.close(CloseCode.restarting, "restarting");
  } catch {
    // Already closed.
  }
}
