import {
  createBuilder,
  defineMutator,
  defineMutators,
  defineQueries,
  defineQuery,
  mustGetMutator,
  mustGetQuery,
  type AnyMutatorRegistry,
  type AnyQuery,
  type AnyQueryRegistry,
  type ReadonlyJSONValue,
} from "@rocicorp/zero";
import type { App } from "../app.ts";
import { RelayError, type ErrorMap } from "../errors.ts";
import type {
  AnyProcedure,
  Guard,
  InvalidateTarget,
  MutationMiddleware,
  ProcedureDef,
  QueryMiddleware,
  RelayMiddleware,
  RouterShape,
  Site,
} from "../procedure.ts";
import type { MaybePromise } from "../types.ts";
import { runMiddleware } from "./middleware.ts";
import { validate } from "./standard.ts";
import { forbidden, prepareMutationError, toApplicationError } from "./wire-errors.ts";

/**
 * The context object Zero hands to every query and mutator. In the relay it's created once per
 * Zero client and updated in place when the context refreshes. At the endpoints it's created per
 * request.
 */
export interface ZeroContext {
  readonly site: Site;
  readonly relay: string;
  readonly key: string;
  readonly env: unknown;
  scope: unknown;
  /** `partition.user(scope)` in single-user partitions, otherwise undefined. */
  user: unknown;
  /** Server mutations only: work deferred until the transaction commits. */
  readonly attempt?: MutationAttempt;
}

export interface MutationAttempt {
  readonly afterCommit: (() => MaybePromise<void>)[];
  readonly invalidations: InvalidateTarget[];
}

/** Returned by the relay's run of a mutation whose outcome only the server can decide. */
export const DEFERRED = { "~zero-relay": "deferred" } as const;

export function isDeferred(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["~zero-relay"] === "deferred"
  );
}

/** What a mutation's args look like inside Zero (design section 5.4). */
export interface Envelope {
  readonly input: unknown;
  readonly actor: unknown;
}

export interface CompiledProcedure {
  readonly path: string;
  readonly def: ProcedureDef;
  readonly guards: readonly Guard<any, any>[];
  readonly relayMiddleware: readonly RelayMiddleware<any>[];
}

export interface CompiledRouter {
  readonly app: App<any>;
  readonly procedures: ReadonlyMap<string, CompiledProcedure>;
  readonly queries: AnyQueryRegistry;
  readonly mutators: AnyMutatorRegistry;
}

const cache = new WeakMap<object, WeakMap<object, CompiledRouter>>();

/** Compiles a router once per app, into Zero's registries plus a lookup by path. */
export function compileRouter(app: App<any>, router: RouterShape): CompiledRouter {
  let byRouter = cache.get(app);
  if (!byRouter) cache.set(app, (byRouter = new WeakMap()));
  let compiled = byRouter.get(router);
  if (!compiled) byRouter.set(router, (compiled = compile(app, router)));
  return compiled;
}

function compile(app: App<any>, router: RouterShape): CompiledRouter {
  const zql = createBuilder(app.config.schema);
  const procedures = new Map<string, CompiledProcedure>();
  const queryTree: Record<string, unknown> = {};
  const mutatorTree: Record<string, unknown> = {};

  const walk = (node: RouterShape, prefix: readonly string[]) => {
    for (const [name, child] of Object.entries(node)) {
      const segments = [...prefix, name];
      if (!isProcedure(child)) {
        walk(child, segments);
        continue;
      }
      const path = segments.join(".");
      const def = child["~def"];
      if (!def.handler) throw new Error(`zero-relay: ${path} has no handler`);
      const procedure: CompiledProcedure = {
        path,
        def,
        guards: def.uses.filter((use): use is Guard<any, any> => kindOf(use) === "guard"),
        relayMiddleware: def.uses.filter(
          (use): use is RelayMiddleware<any> => kindOf(use) === "relay-middleware",
        ),
      };
      procedures.set(path, procedure);
      const tree = def.kind === "query" ? queryTree : mutatorTree;
      setPath(
        tree,
        segments,
        def.kind === "query" ? compileQuery(procedure, zql) : compileMutation(app, procedure, zql),
      );
    }
  };
  walk(router, []);

  return {
    app,
    procedures,
    queries: defineQueries(queryTree as never) as AnyQueryRegistry,
    mutators: defineMutators(mutatorTree as never) as AnyMutatorRegistry,
  };
}

function compileQuery(procedure: CompiledProcedure, zql: unknown) {
  const { def, path, guards } = procedure;
  const middleware = def.uses.filter(
    (use): use is QueryMiddleware<any> => kindOf(use) === "query-middleware",
  );
  const run = ({ args, ctx }: { args: unknown; ctx: ZeroContext }) => {
    const { user, scope, site } = ctx;
    // The relay checks guards against the socket's user before it subscribes. The server checks
    // them here, where only single-user partitions know the user.
    if (site === "server" && user !== undefined) {
      for (const guard of guards) {
        if (!guard.check({ user, input: args })) throw toApplicationError(forbidden(guard.name));
      }
    }
    let query = def.handler!({ input: args, zql, scope, ...(user === undefined ? {} : { user }) });
    for (const mw of middleware) {
      if (mw.sites.includes(site))
        query = mw.apply({ scope, user, path, input: args, query } as never);
    }
    return query;
  };
  return def.input ? defineQuery(def.input, run as never) : defineQuery(run as never);
}

function compileMutation(app: App<any>, procedure: CompiledProcedure, zql: unknown) {
  const { def, path, guards } = procedure;
  const middleware = def.uses.filter(
    (use): use is MutationMiddleware<any> => kindOf(use) === "mutation-middleware",
  );
  const errors = errorConstructors(def.errors);

  return defineMutator(async ({ tx, args, ctx }: { tx: any; args: unknown; ctx: ZeroContext }) => {
    const location: Site = tx.location === "server" ? "server" : "relay";
    try {
      const { input: rawInput, actor } = parseEnvelope(args);
      const input = await validate(def.input, rawInput);
      for (const guard of guards) {
        if (!guard.check({ user: actor, input })) throw forbidden(guard.name);
      }
      if (location === "server") {
        const allowed = await app.config.partition.authorize({
          user: actor,
          key: ctx.key,
          env: ctx.env,
        });
        if (!allowed) throw forbidden(undefined);
      }
      const handlerArgs = {
        input,
        tx,
        zql,
        user: actor,
        scope: ctx.scope,
        location,
        errors,
        afterCommit: (task: () => MaybePromise<void>) => ctx.attempt?.afterCommit.push(task),
        invalidate: (target: InvalidateTarget) => ctx.attempt?.invalidations.push(target),
      };
      const active = middleware.filter((mw) => mw.sites.includes(location));
      return (await runMiddleware(
        active.map((mw) => mw.apply.bind(mw)),
        { tx, location, user: actor, scope: ctx.scope, path, input },
        () => Promise.resolve(def.handler!(handlerArgs)),
      )) as never;
    } catch (error) {
      const prepared = await prepareMutationError(error, def.errors);
      // The relay's replica holds only what its browsers subscribe to, so a declared error from a
      // lookup there may just mean the row isn't synced. Zero drops a mutation whose client run
      // throws, so defer to the server instead.
      if (
        location === "relay" &&
        Object.hasOwn(def.errors, prepared.code) &&
        prepared.code !== "INTERNAL"
      ) {
        return DEFERRED as never;
      }
      throw toApplicationError(prepared);
    }
  });
}

/** Builds the named query's ZQL, as Zero's query endpoint does. */
export function runQuery(
  compiled: CompiledRouter,
  name: string,
  args: unknown,
  ctx: ZeroContext,
): AnyQuery {
  const query = mustGetQuery(compiled.queries as never, name) as unknown as {
    fn(options: { args: unknown; ctx: ZeroContext }): AnyQuery;
  };
  return query.fn({ args, ctx });
}

/** Runs the named mutator in `tx`, as Zero's mutate endpoint does. */
export function runMutator(
  compiled: CompiledRouter,
  name: string,
  tx: unknown,
  args: unknown,
  ctx: ZeroContext,
): Promise<ReadonlyJSONValue | void> {
  const mutator = mustGetMutator(compiled.mutators as never, name) as unknown as {
    fn(options: {
      tx: unknown;
      args: unknown;
      ctx: ZeroContext;
    }): Promise<ReadonlyJSONValue | void>;
  };
  return mutator.fn({ tx, args, ctx });
}

/** What the relay hands to `zero.materialize`: the named query applied to raw args. */
export function queryRequest(compiled: CompiledRouter, name: string, args: unknown): unknown {
  return (mustGetQuery(compiled.queries as never, name) as unknown as (args: unknown) => unknown)(
    args,
  );
}

/** What the relay hands to `zero.mutate`. */
export function mutationRequest(
  compiled: CompiledRouter,
  name: string,
  envelope: Envelope,
): unknown {
  return (
    mustGetMutator(compiled.mutators as never, name) as unknown as (args: unknown) => unknown
  )(envelope);
}

function parseEnvelope(args: unknown): Envelope {
  if (typeof args !== "object" || args === null || !("actor" in args)) {
    throw new RelayError("BAD_INPUT", { message: "Mutation is missing its actor" });
  }
  return args as Envelope;
}

function errorConstructors(errors: ErrorMap) {
  return Object.fromEntries(
    Object.entries(errors).map(([code, def]) => [
      code,
      (...args: unknown[]) => {
        const data = def.data ? args[0] : undefined;
        const options = (def.data ? args[1] : args[0]) as { message?: string } | undefined;
        return new RelayError(code, { message: options?.message ?? def.message ?? code, data });
      },
    ]),
  );
}

function setPath(tree: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let node = tree;
  for (const segment of segments.slice(0, -1)) {
    node = (node[segment] ??= {}) as Record<string, unknown>;
  }
  node[segments.at(-1)!] = value;
}

function isProcedure(value: unknown): value is AnyProcedure {
  return typeof value === "object" && value !== null && "~def" in value;
}

function kindOf(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as { "~kind"?: unknown })["~kind"]
    : undefined;
}
