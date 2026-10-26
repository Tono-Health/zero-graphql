import { handleMutateRequest, handleQueryRequest, type Database } from "@rocicorp/zero/server";
import type { App } from "./app.ts";
import {
  runMutator,
  runQuery,
  type MutationAttempt,
  type ZeroContext,
} from "./internal/compile.ts";
import { loadContext, resolveRelays, type ResolvedRelay } from "./internal/relays.ts";
import {
  bearerToken,
  MAIN_RELAY,
  verifyRelayToken,
  zeroUserID,
  type RelayClaims,
} from "./internal/token.ts";
import type { InvalidateTarget, RouterShape } from "./procedure.ts";
import type { AppDef } from "./types.ts";

/** An extra relay, with its own partition (from `app.withPartition`) and router. */
export interface RelayDef {
  readonly app: App<any>;
  readonly router: RouterShape;
}

/**
 * `TEnv` is the host's environment: the app's `env` plus whatever the host adds (database
 * bindings, the relay namespace). Annotate `database`'s parameter to widen it.
 */
export interface EndpointOptions<D extends AppDef, TEnv extends D["env"] = D["env"]> {
  readonly router: RouterShape;
  /** Zero's database provider, used to run mutations in a transaction. Called per request. */
  readonly database: (env: TEnv) => Database<unknown>;
  /** Verifies relay tokens. Must match the relay host's secret. */
  readonly secret: (env: TEnv) => string;
  readonly relays?: Readonly<Record<string, RelayDef>>;
  /**
   * Delivers `invalidate()` calls from mutation handlers to running relays, after commit.
   * `zero-relay/cloudflare` provides this; other hosts supply their own.
   */
  readonly invalidate?: (env: TEnv, target: Required<InvalidateTarget>) => Promise<void>;
}

/** Lets work outlive the response, like Cloudflare's `ctx.waitUntil`. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/** Zero's query and mutate endpoints. Point `ZERO_QUERY_URL` and `ZERO_MUTATE_URL` at them. */
export interface Endpoints<TEnv> {
  query(request: Request, env: TEnv): Promise<Response>;
  /** Pass `ctx` so `afterCommit` tasks and invalidations can finish after the response is sent. */
  mutate(request: Request, env: TEnv, ctx?: WaitUntil): Promise<Response>;
}

/** For hosts other than Cloudflare. `zero-relay/cloudflare` mounts these for you. */
export function createEndpoints<D extends AppDef, TEnv extends D["env"] = D["env"]>(
  app: App<D>,
  options: EndpointOptions<D, TEnv>,
): Endpoints<TEnv> {
  const relays = resolveRelays(app, options.router, options.relays);

  /** Who is calling: zero-cache, on behalf of the relay named in the token. */
  const identify = async (request: Request, env: TEnv) => {
    const token = bearerToken(request);
    const claims = token ? await verifyRelayToken(options.secret(env), token) : undefined;
    const relay = claims && relays.get(claims.relay);
    if (!claims || !relay) return undefined;
    // A null scope means the relay lost access. The 401 makes zero-cache put the relay's client
    // into `needs-auth`, so the relay refreshes and finds out.
    const context = await loadContext(relay.app, claims.key, env);
    if (!context) return undefined;
    const ctx: Omit<ZeroContext, "attempt"> = {
      site: "server",
      relay: relay.name,
      key: claims.key,
      env,
      scope: context.scope,
      user: context.user,
    };
    return { claims, relay, ctx };
  };

  return {
    async query(request, env) {
      const caller = await identify(request, env);
      if (!caller) return unauthorized();
      const { claims, relay, ctx } = caller;
      const response = await handleQueryRequest({
        handler: (name, args) => runQuery(relay.compiled, name, args, ctx),
        schema: relay.app.config.schema,
        request,
        userID: zeroUserID(claims),
      });
      return Response.json(response);
    },

    async mutate(request, env, waitUntil) {
      const caller = await identify(request, env);
      if (!caller) return unauthorized();
      const { claims, relay, ctx } = caller;
      const settled: MutationAttempt[] = [];
      const response = await handleMutateRequest({
        dbProvider: options.database(env),
        handler: async (transact) => {
          // Zero can run a mutator several times in one push (`tx.retryOn`), so each run gets
          // fresh buffers and only the last one counts.
          let attempt: MutationAttempt | undefined;
          const result = await transact((tx, name, args) => {
            attempt = { afterCommit: [], invalidations: [] };
            return runMutator(relay.compiled, name, tx, args, { ...ctx, attempt });
          });
          if (attempt && !("error" in result.result)) settled.push(attempt);
          return result;
        },
        request,
        userID: zeroUserID(claims),
      });
      const work = runDeferred(settled, relay, claims, env, options);
      if (waitUntil) waitUntil.waitUntil(work);
      else void work;
      return Response.json(response);
    },
  };
}

async function runDeferred<TEnv>(
  attempts: readonly MutationAttempt[],
  relay: ResolvedRelay,
  claims: RelayClaims,
  env: TEnv,
  options: Pick<EndpointOptions<any, TEnv>, "invalidate">,
): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const attempt of attempts) {
    for (const task of attempt.afterCommit) tasks.push(Promise.resolve().then(task));
    for (const target of attempt.invalidations) {
      if (!options.invalidate) {
        console.warn(
          `zero-relay: ${relay.name}/${claims.key} called invalidate(), but the host has no invalidate hook`,
        );
        continue;
      }
      tasks.push(options.invalidate(env, { relay: target.relay ?? MAIN_RELAY, key: target.key }));
    }
  }
  for (const result of await Promise.allSettled(tasks)) {
    if (result.status === "rejected")
      console.error("zero-relay: deferred task failed", result.reason);
  }
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}
