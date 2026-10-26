// The relay runtime (design section 8): one per relay instance, independent of the host.
// The host hands it sockets and messages; the runtime owns the Zero client, shared views,
// subscriptions, mutations, audit, and context refresh.

import type { TTL } from "@rocicorp/zero";
import { Cause, Effect, Exit, FiberMap, Option, RcMap, RcRef, Scope, Semaphore } from "effect";
import type { AuditEvent } from "../../audit.ts";
import { isRelayError, RelayError, type ErrorMap } from "../../errors.ts";
import {
  closeCodeFor,
  parseClientMessage,
  type CloseReason,
  type ServerMessage,
  type WireError,
} from "../protocol.ts";
import {
  isDeferred,
  mutationRequest,
  queryRequest,
  runQuery,
  type CompiledProcedure,
  type ZeroContext,
} from "../compile.ts";
import { runMiddleware } from "../middleware.ts";
import { loadContext } from "../relays.ts";
import { isActiveSession } from "../session.ts";
import { validate } from "../standard.ts";
import { signRelayToken, zeroUserID } from "../token.ts";
import {
  forbidden,
  fromApplicationError,
  prepareMutationError,
  receivedMutationError,
  toWireError,
} from "../wire-errors.ts";
import type {
  MutatorResultLike,
  Relay,
  RelayConnection,
  RelayOptions,
  RelaySocket,
  ZeroLike,
} from "./contracts.ts";
import { LivePipeline, SharedView } from "./views.ts";

/** Keeps a view briefly after its last subscriber, so a quick resubscribe (a reconnect) reuses it. */
const VIEW_GRACE_MS = 1000;
// Zero's own default is five minutes, which is right for a browser: IndexedDB keeps the
// rows so a navigation back is instant. Relays share their host's resources, so a query
// keeps rows only while a view is open unless the app opts into a longer TTL.
const DEFAULT_QUERY_TTL: TTL = "none";

class Revoked {
  readonly _tag = "Revoked";
}

interface Session {
  readonly zero: ZeroLike;
  readonly ctx: ZeroContext;
}

interface Subscription {
  readonly procedure: CompiledProcedure;
  readonly input: unknown;
}

interface Connection {
  readonly socket: RelaySocket;
  user: unknown;
  readonly scope: Scope.Closeable;
  readonly fibers: FiberMap.FiberMap<string>;
  readonly subscriptions: Map<string, Subscription>;
  readonly session: Promise<Session>;
  readonly expiresAt: number | null;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
  open: boolean;
}

interface Call {
  readonly owner: string;
  readonly result: Promise<ServerMessage>;
  settledAt: number | undefined;
}

export function createRelay(options: RelayOptions): Relay {
  const { relay, key, env, secret } = options;
  const { app, compiled } = relay;
  const idleTimeout = options.idleTimeout ?? 30_000;
  const refreshInterval = options.refreshInterval ?? 5 * 60_000;
  const callRetention = options.callRetention ?? 60_000;
  const claims = { relay: relay.name, key };
  // Long enough to survive one failed refresh; a token that does expire puts Zero in `needs-auth`.
  const tokenTTL = refreshInterval * 2 + 60_000;
  const singleUser = app.config.partition.user !== undefined;

  const root = Effect.runSync(Scope.make());
  const refreshLock = Effect.runSync(Semaphore.make(1));
  const connections = new Set<Connection>();
  const calls = new Map<string, Call>();
  let current: Session | undefined;

  const emit = (event: AuditEvent<unknown>) => {
    const audit = app.config.audit;
    if (!audit) return;
    Promise.resolve()
      .then(() => audit.sink({ env, event }))
      .catch((cause: unknown) => console.error("zero-relay: audit sink failed", cause));
  };
  const audited = (procedure: CompiledProcedure) => procedure.def.meta.audit !== false;

  const send = (connection: Connection, message: ServerMessage) => {
    if (message.t === "close" ? !connection.open : !isOpen(connection)) return;
    try {
      connection.socket.send(JSON.stringify(message));
    } catch {
      // The socket closed under us; `closed()` will follow.
    }
  };

  // -------------------------------------------------------------------------
  // The Zero client: created on first use, closed `idleTimeout` after the last reference.

  const acquireSession = Effect.gen(function* () {
    const context = yield* Effect.tryPromise(() => loadContext(app, key, env));
    if (!context) return yield* Effect.fail(new Revoked());
    const ctx: ZeroContext = {
      site: "relay",
      relay: relay.name,
      key,
      env,
      scope: context.scope,
      user: context.user,
    };
    const auth = yield* Effect.promise(() => signRelayToken(secret, claims, tokenTTL));
    const zero = options.createZero({
      userID: zeroUserID(claims),
      auth,
      schema: app.config.schema,
      mutators: compiled.mutators,
      context: ctx,
    });
    const session: Session = { zero, ctx };
    current = session;
    const unsubscribe = zero.connection.state.subscribe((state) => {
      if (state.name === "needs-auth") void refresh("needs-auth");
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        unsubscribe();
        if (current === session) current = undefined;
        await zero
          .close()
          .catch((cause: unknown) => console.error("zero-relay: zero.close failed", cause));
        options.onIdle?.();
      }),
    );
    options.onActive?.();
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(refreshInterval).pipe(
          Effect.andThen(Effect.sync(() => void refresh("interval"))),
        ),
      ),
    );
    return session;
  });

  const zeroRef = Effect.runSync(
    RcRef.make({ acquire: acquireSession, idleTimeToLive: idleTimeout }).pipe(Scope.provide(root)),
  );

  const views = Effect.runSync(
    RcMap.make({
      lookup: (viewKey: string) =>
        Effect.gen(function* () {
          const session = yield* RcRef.get(zeroRef);
          const { path, input } = JSON.parse(viewKey) as { path: string; input?: unknown };
          const procedure = compiled.procedures.get(path)!;
          const table = (
            runQuery(compiled, path, input, session.ctx) as unknown as { ast: { table: string } }
          ).ast.table;
          const primaryKey = app.config.schema.tables[table]?.primaryKey ?? [];
          return yield* Effect.acquireRelease(
            Effect.sync(() => {
              const request = queryRequest(compiled, path, input) as never;
              const view = session.zero.materialize(request, {
                ttl: procedure.def.meta.ttl ?? DEFAULT_QUERY_TTL,
              });
              return new SharedView(view, procedure, primaryKey);
            }),
            (view) => Effect.sync(() => view.destroy()),
          );
        }),
      idleTimeToLive: VIEW_GRACE_MS,
    }).pipe(Scope.provide(root)),
  );

  // -------------------------------------------------------------------------
  // Sockets

  const connect = (
    socket: RelaySocket,
    user: unknown,
    expiresAt: number | null,
  ): RelayConnection => {
    if (!isActiveSession(expiresAt)) {
      try {
        socket.send(
          JSON.stringify({ t: "close", reason: "session-expired" } satisfies ServerMessage),
        );
      } catch {
        // Still attempt the close frame if sending the control message failed.
      }
      try {
        socket.close(closeCodeFor("session-expired"), "session-expired");
      } catch {
        // Already closed.
      }
      return { message: () => {}, closed: () => {} };
    }
    const scope = Effect.runSync(Scope.fork(root));
    const fibers = Effect.runSync(FiberMap.make<string>().pipe(Scope.provide(scope)));
    const connection: Connection = {
      socket,
      user,
      scope,
      fibers,
      expiresAt,
      expiryTimer: undefined,
      subscriptions: new Map(),
      // The socket holds a reference to the Zero client for as long as it's open.
      session: Effect.runPromiseExit(RcRef.get(zeroRef).pipe(Scope.provide(scope))).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value;
        const revoked = Exit.findErrorOption(exit).pipe(
          Option.exists((error) => error instanceof Revoked),
        );
        if (!revoked) console.error("zero-relay: relay failed to start", Cause.pretty(exit.cause));
        closeConnection(connection, revoked ? "revoked" : "restarting");
        throw new RelayError("UNAVAILABLE", { message: "The relay is unavailable" });
      }),
      open: true,
    };
    connections.add(connection);
    connection.session.catch(() => {});
    armExpiry(connection);
    return {
      message: (raw) => void handle(connection, raw),
      closed: () => void drop(connection),
    };
  };

  const drop = async (connection: Connection) => {
    if (!connections.delete(connection)) return;
    connection.open = false;
    clearTimeout(connection.expiryTimer);
    connection.subscriptions.clear();
    await Effect.runPromise(Scope.close(connection.scope, Exit.void));
  };

  const closeConnection = (connection: Connection, reason: CloseReason) => {
    if (!connection.open) return;
    send(connection, { t: "close", reason });
    try {
      connection.socket.close(closeCodeFor(reason), reason);
    } catch {
      // Already closed.
    }
    void drop(connection);
  };

  const isOpen = (connection: Connection): boolean => {
    if (!connection.open) return false;
    if (isActiveSession(connection.expiresAt)) return true;
    closeConnection(connection, "session-expired");
    return false;
  };

  const armExpiry = (connection: Connection): void => {
    if (!isOpen(connection) || connection.expiresAt === null) return;
    // Recheck the absolute deadline when the timer fires; cap long delays to avoid overflow.
    connection.expiryTimer = setTimeout(
      () => armExpiry(connection),
      Math.min(connection.expiresAt - Date.now(), 2 ** 31 - 1),
    );
  };

  const handle = async (connection: Connection, raw: string) => {
    if (!isOpen(connection)) return;
    const message = parseClientMessage(raw);
    if (!message) {
      send(connection, { t: "error", id: null, error: badInput("Invalid message") });
      return;
    }
    switch (message.t) {
      case "sub":
        return subscribe(connection, message.id, message.path, message.input);
      case "unsub":
        return unsubscribe(connection, message.id);
      case "call":
        return call(connection, message.id, message.path, message.input);
    }
  };

  // -------------------------------------------------------------------------
  // Subscriptions

  const subscribe = async (connection: Connection, id: string, path: string, rawInput: unknown) => {
    const procedure = compiled.procedures.get(path);
    if (!procedure || procedure.def.kind !== "query") {
      send(connection, { t: "error", id, error: badInput(`Unknown query: ${path}`) });
      return;
    }
    if (connection.subscriptions.has(id)) {
      send(connection, { t: "error", id, error: badInput("Duplicate subscription id") });
      return;
    }
    const subscription: Subscription = { procedure, input: undefined };
    connection.subscriptions.set(id, subscription);
    const fail = (error: unknown) => {
      if (connection.subscriptions.get(id) !== subscription) return;
      connection.subscriptions.delete(id);
      send(connection, { t: "error", id, error: toWireError(error) });
    };

    let live: LivePipeline;
    try {
      const input = await validate(procedure.def.input, rawInput);
      Object.assign(subscription, { input });
      const denied = deniedBy(procedure, connection.user, input);
      if (denied) {
        emit({ type: "denied", user: connection.user, path, at: Date.now(), guard: denied.name });
        throw forbidden(denied.name);
      }
      const session = await connection.session;
      if (!isOpen(connection)) return;
      live = (await runMiddleware(
        procedure.relayMiddleware.flatMap((mw) => (mw.subscribe ? [mw.subscribe] : [])),
        { user: connection.user, scope: session.ctx.scope, env, path, input },
        async () => new LivePipeline(),
      )) as LivePipeline;
    } catch (error) {
      fail(error);
      return;
    }
    // Unsubscribed while the checks ran.
    if (!isOpen(connection) || connection.subscriptions.get(id) !== subscription) return;

    const startedAt = Date.now();
    if (audited(procedure)) {
      emit({
        type: "subscribe",
        user: connection.user,
        path,
        at: startedAt,
        subscriptionID: id,
        input: rawInput,
      });
    }
    // Object properties preserve omitted input separately from an explicit null.
    const viewKey = JSON.stringify({ path, input: rawInput });
    const deliveries = app.config.audit?.deliveries === true && audited(procedure);

    const fiber = Effect.gen(function* () {
      const view = yield* RcMap.get(views, viewKey);
      yield* Effect.callback<void>((resume) => {
        const remove = view.listen((event) => {
          if (!isOpen(connection)) return;
          if ("error" in event) {
            fail(
              new RelayError(event.error.code, {
                message: event.error.message,
                data: event.error.data,
              }),
            );
            resume(Effect.void);
            return;
          }
          const { snapshot } = event;
          let data: unknown;
          try {
            data = live.apply(snapshot.data, snapshot.status);
          } catch (error) {
            fail(error);
            resume(Effect.void);
            return;
          }
          send(connection, { t: "data", id, type: snapshot.status, data: data ?? null });
          if (deliveries) {
            emit({
              type: "deliver",
              user: connection.user,
              path,
              at: Date.now(),
              subscriptionID: id,
              rowIDs: snapshot.rowIDs,
            });
          }
        });
        return Effect.sync(remove);
      });
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) => Effect.sync(() => fail(cause))),
      Effect.ensuring(
        Effect.sync(() => {
          if (connection.subscriptions.get(id) === subscription)
            connection.subscriptions.delete(id);
          if (audited(procedure)) {
            emit({
              type: "unsubscribe",
              user: connection.user,
              path,
              at: Date.now(),
              subscriptionID: id,
              durationMs: Date.now() - startedAt,
            });
          }
        }),
      ),
    );
    Effect.runFork(FiberMap.run(connection.fibers, id, fiber));
  };

  const unsubscribe = async (connection: Connection, id: string) => {
    connection.subscriptions.delete(id);
    await Effect.runPromise(FiberMap.remove(connection.fibers, id));
  };

  // -------------------------------------------------------------------------
  // Mutations

  const call = async (connection: Connection, id: string, path: string, rawInput: unknown) => {
    const now = Date.now();
    for (const [callID, entry] of calls) {
      if (entry.settledAt !== undefined && now - entry.settledAt > callRetention)
        calls.delete(callID);
    }
    const owner = JSON.stringify(connection.user);
    let entry = calls.get(id);
    if (entry && entry.owner !== owner) {
      send(connection, { t: "result", id, ok: false, error: badInput("Duplicate call id") });
      return;
    }
    if (!entry) {
      const created: Call = {
        owner,
        settledAt: undefined,
        result: execute(connection, id, path, rawInput).finally(() => {
          created.settledAt = Date.now();
        }),
      };
      calls.set(id, (entry = created));
    }
    send(connection, await entry.result);
  };

  const execute = async (
    connection: Connection,
    id: string,
    path: string,
    rawInput: unknown,
  ): Promise<ServerMessage> => {
    const procedure = compiled.procedures.get(path);
    if (!procedure || procedure.def.kind !== "mutation") {
      return { t: "result", id, ok: false, error: badInput(`Unknown mutation: ${path}`) };
    }
    const { user } = connection;
    const at = Date.now();
    const record = (outcome: "pending" | "ok" | { error: string }) => {
      if (audited(procedure))
        emit({ type: "mutate", user, path, at, mutationID: id, input: rawInput, outcome });
    };
    try {
      const input = await validate(procedure.def.input, rawInput);
      const denied = deniedBy(procedure, user, input);
      if (denied) {
        emit({ type: "denied", user, path, at, guard: denied.name });
        throw forbidden(denied.name);
      }
      record("pending");
      const session = await connection.session;
      if (!isOpen(connection))
        throw new RelayError("FORBIDDEN", { message: "The connection closed" });
      const data = await runMiddleware(
        procedure.relayMiddleware.flatMap((mw) => (mw.call ? [mw.call] : [])),
        { user, scope: session.ctx.scope, env, path, input },
        async () => {
          // Middleware or session loading may have outlived this socket's deadline.
          if (!isOpen(connection))
            throw new RelayError("FORBIDDEN", { message: "The connection closed" });
          const write = session.zero.mutate(
            mutationRequest(compiled, path, { input: rawInput, actor: user }) as never,
          );
          const optimistic = await write.client;
          if (optimistic.type === "error") {
            void write.server.catch(() => {});
            throw toRelayError(optimistic, procedure.def.errors);
          }
          if (procedure.def.meta.ack === "relay" && !isDeferred(optimistic.data)) {
            void write.server.catch(() => {});
            return optimistic.data;
          }
          const authoritative = await write.server;
          if (authoritative.type === "error")
            throw toRelayError(authoritative, procedure.def.errors);
          return authoritative.data;
        },
      );
      record("ok");
      return { t: "result", id, ok: true, data: data ?? null };
    } catch (error) {
      if (!isRelayError(error)) console.error(`zero-relay: ${path} failed`, error);
      const wire = toWireError(await prepareMutationError(error, procedure.def.errors));
      record({ error: wire.code });
      return { t: "result", id, ok: false, error: wire };
    }
  };

  // -------------------------------------------------------------------------
  // Context refresh (design section 6.5)

  type Trigger = "interval" | "needs-auth" | "invalidate";

  const refresh = (trigger: Trigger): Promise<void> =>
    Effect.runPromise(
      Semaphore.withPermit(
        refreshLock,
        Effect.promise(() => refreshNow(trigger)),
      ),
    );

  const refreshNow = async (trigger: Trigger) => {
    const session = current;
    if (!session) return;
    try {
      let context: Awaited<ReturnType<typeof loadContext>>;
      try {
        context = await loadContext(app, key, env);
      } catch (cause) {
        console.error("zero-relay: refreshing the relay's scope failed", cause);
        return;
      }
      if (!context) return await revoke();
      session.ctx.scope = context.scope;
      session.ctx.user = context.user;
      const auth = await signRelayToken(secret, claims, tokenTTL);
      session.zero.connection
        .connect({ auth })
        .catch((cause: unknown) =>
          console.error("zero-relay: reconnecting to zero-cache failed", cause),
        );

      if (singleUser) {
        for (const connection of connections) {
          connection.user = context.user;
          connection.socket.setUser?.(context.user);
          await recheck(connection);
        }
      }
    } finally {
      if (!singleUser && trigger !== "needs-auth") {
        // Shared users can only be reloaded by authenticating a fresh browser request.
        // Reconnect even if scope loading failed: stale socket credentials must not gain
        // an unlimited lifetime because the shared scope could not be refreshed.
        for (const connection of connections) closeConnection(connection, "refresh");
      }
    }
  };

  const recheck = async (connection: Connection) => {
    for (const [id, subscription] of connection.subscriptions) {
      const denied = deniedBy(subscription.procedure, connection.user, subscription.input);
      if (!denied) continue;
      const path = subscription.procedure.path;
      emit({ type: "denied", user: connection.user, path, at: Date.now(), guard: denied.name });
      connection.subscriptions.delete(id);
      send(connection, { t: "error", id, error: toWireError(forbidden(denied.name)) });
      await Effect.runPromise(FiberMap.remove(connection.fibers, id));
    }
  };

  const revoke = async () => {
    for (const connection of connections) closeConnection(connection, "revoked");
    await Effect.runPromise(
      Effect.gen(function* () {
        for (const viewKey of yield* RcMap.keys(views)) yield* RcMap.invalidate(views, viewKey);
        yield* RcRef.invalidate(zeroRef);
      }),
    );
  };

  return {
    connect,
    invalidate: () => refresh("invalidate"),
    get connections() {
      return connections.size;
    },
    shutdown: async () => {
      for (const connection of connections) closeConnection(connection, "restarting");
      await Effect.runPromise(Scope.close(root, Exit.void));
    },
  };
}

function deniedBy(procedure: CompiledProcedure, user: unknown, input: unknown) {
  return procedure.guards.find((guard) => !guard.check({ user, input }));
}

function toRelayError(
  result: Extract<MutatorResultLike, { type: "error" }>,
  errors: ErrorMap,
): RelayError {
  const { error } = result;
  if (error.type === "zero")
    return new RelayError("UNAVAILABLE", { message: "The relay is offline" });
  const wire = fromApplicationError(error.message, error.details);
  return receivedMutationError(wire, errors);
}

function badInput(message: string): WireError {
  return { code: "BAD_INPUT", message, data: null };
}
