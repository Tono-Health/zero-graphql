import type { HumanReadable, Query, SchemaQuery, Transaction, TTL } from "@rocicorp/zero";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ErrorConstructors, ErrorMap } from "./errors.ts";
import type {
  AppDef,
  InferIn,
  InferOut,
  InputSchema,
  MaybePromise,
  ReadonlyJSONValue,
  TableName,
  UserIfKnown,
} from "./types.ts";

/** Where query and mutation code runs. `"relay"` is the Zero client inside the relay (Zero calls it `'client'`). */
export type Site = "relay" | "server";

/** Zero's result type, as forwarded to the browser. */
export type QueryStatus = "unknown" | "complete" | "error";

// ---------------------------------------------------------------------------
// Guards

export interface Guard<D extends AppDef, TInput = unknown> {
  readonly "~kind": "guard";
  readonly name: string | undefined;
  /** Synchronous, because Zero calls query functions synchronously on the server. */
  readonly check: (args: { readonly user: D["user"]; readonly input: TInput }) => boolean;
}

// ---------------------------------------------------------------------------
// Middleware (escape hatches)

/** A live query result in the relay, before it's sent to the browser. */
export interface Live<T> {
  map<U>(fn: (data: T) => U): Live<U>;
  tap(fn: (data: T, status: QueryStatus) => void): Live<T>;
}

export interface RelayMiddlewareArgs<D extends AppDef> {
  readonly user: D["user"];
  readonly scope: D["scope"];
  readonly env: D["env"];
  readonly path: string;
  readonly input: unknown;
}

/** Runs in the relay around a browser subscription or call. Async, and sees delivered data. */
export interface RelayMiddleware<D extends AppDef> {
  readonly "~kind": "relay-middleware";
  readonly subscribe?: (
    args: RelayMiddlewareArgs<D> & { next: () => Promise<Live<unknown>> },
  ) => Promise<Live<unknown>>;
  readonly call?: (
    args: RelayMiddlewareArgs<D> & { next: () => Promise<unknown> },
  ) => Promise<unknown>;
}

/** Rewrites a query's ZQL inside the Zero query function. Synchronous. */
export interface QueryMiddleware<D extends AppDef> {
  readonly "~kind": "query-middleware";
  readonly sites: readonly Site[];
  readonly apply: <TTable extends TableName<D>, TReturn>(
    args: {
      readonly scope: D["scope"];
      readonly path: string;
      readonly input: unknown;
      readonly query: Query<TTable, D["schema"], TReturn>;
    } & UserIfKnown<D>,
  ) => Query<TTable, D["schema"], TReturn>;
}

/** Wraps a mutation inside the Zero mutator, in the same transaction. */
export interface MutationMiddleware<D extends AppDef> {
  readonly "~kind": "mutation-middleware";
  readonly sites: readonly Site[];
  readonly apply: (args: {
    readonly tx: Transaction<D["schema"]>;
    readonly location: Site;
    readonly user: D["user"];
    readonly scope: D["scope"];
    readonly path: string;
    readonly input: unknown;
    readonly next: () => Promise<unknown>;
  }) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Procedures

declare const unset: unique symbol;
/** Marks "no `.output()` given" in builder types. */
export type Unset = typeof unset;

/** Rows as the browser receives them: projected through `.output()` if one was given. */
export type QueryData<TReturn, TOutput> = [TOutput] extends [Unset]
  ? HumanReadable<TReturn>
  : undefined extends TReturn
    ? TOutput | undefined
    : TOutput[];

export interface QueryMeta {
  /**
   * How long Zero keeps this query's rows after the last view is destroyed.
   * Default `none`: they leave with the view (after its one-second reconnect grace).
   * Zero clamps anything above 10 minutes. This does not keep the view itself alive.
   */
  readonly ttl?: TTL;
  /** Set to false to skip audit events for this query. */
  readonly audit?: boolean;
}

export interface MutationMeta {
  /** When the browser's call resolves: after the relay's optimistic run, or after the server commits (default). */
  readonly ack?: Site;
  readonly audit?: boolean;
}

/** Runtime description of a procedure. Read by the relay, endpoints, and tests. */
export interface ProcedureDef {
  readonly kind: "query" | "mutation";
  readonly input: InputSchema | undefined;
  readonly uses: readonly unknown[];
  readonly output: StandardSchemaV1 | undefined;
  readonly errors: ErrorMap;
  readonly meta: QueryMeta & MutationMeta;
  readonly handler: ((args: any) => unknown) | undefined;
}

export interface QueryProcedure<TInputIn, TData> {
  readonly "~kind": "query";
  readonly "~types"?: { readonly input: TInputIn; readonly data: TData };
  readonly "~def": ProcedureDef;
}

export interface MutationProcedure<TInputIn, TResult, TErrors extends ErrorMap> {
  readonly "~kind": "mutation";
  readonly "~types"?: {
    readonly input: TInputIn;
    readonly result: TResult;
    readonly errors: TErrors;
  };
  readonly "~def": ProcedureDef;
}

export type AnyProcedure = QueryProcedure<any, any> | MutationProcedure<any, any, any>;

export type RouterShape = { readonly [key: string]: AnyProcedure | RouterShape };

// ---------------------------------------------------------------------------
// Builders

export type QueryHandlerArgs<D extends AppDef, TInput> = {
  readonly input: TInput;
  readonly zql: SchemaQuery<D["schema"]>;
  readonly scope: D["scope"];
} & UserIfKnown<D>;

export interface MutationHandlerArgs<D extends AppDef, TInput, TErrors extends ErrorMap> {
  readonly input: TInput;
  readonly tx: Transaction<D["schema"]>;
  readonly zql: SchemaQuery<D["schema"]>;
  /** The acting user (the actor), verified by the relay. */
  readonly user: D["user"];
  readonly scope: D["scope"];
  readonly location: Site;
  readonly errors: ErrorConstructors<TErrors>;
  /** Server only: runs after this mutation's transaction commits. Ignored in the relay. */
  readonly afterCommit: (task: () => MaybePromise<void>) => void;
  /**
   * Server only: refreshes a relay's context after this transaction commits (section 6.5 of the
   * design doc). Call it when a mutation changes something `scope` or `authenticate` loads, such as
   * a role. Discarded if the mutation fails or is retried. Ignored in the relay.
   */
  readonly invalidate: (target: InvalidateTarget) => void;
}

export interface InvalidateTarget {
  /** The partition key of the relay to refresh. */
  readonly key: string;
  /** Which relay, for apps hosting several (`relays` in the host options). Default: the main relay. */
  readonly relay?: string;
}

export interface QueryBuilder<D extends AppDef, TInputIn, TInput, TOutput> {
  input<S extends InputSchema>(schema: S): QueryBuilder<D, InferIn<S>, InferOut<S>, TOutput>;
  use(
    middleware: Guard<D, TInput> | QueryMiddleware<D> | RelayMiddleware<D>,
  ): QueryBuilder<D, TInputIn, TInput, TOutput>;
  /** Per-row schema for what leaves the relay. Fields it doesn't list are never sent. */
  output<S extends StandardSchemaV1>(schema: S): QueryBuilder<D, TInputIn, TInput, InferOut<S>>;
  meta(meta: QueryMeta): QueryBuilder<D, TInputIn, TInput, TOutput>;
  handler<TTable extends TableName<D>, TReturn>(
    fn: (args: QueryHandlerArgs<D, TInput>) => Query<TTable, D["schema"], TReturn>,
  ): QueryProcedure<TInputIn, QueryData<TReturn, TOutput>>;
}

export interface MutationBuilder<D extends AppDef, TInputIn, TInput, TErrors extends ErrorMap> {
  input<S extends InputSchema>(schema: S): MutationBuilder<D, InferIn<S>, InferOut<S>, TErrors>;
  use(
    middleware: Guard<D, TInput> | MutationMiddleware<D> | RelayMiddleware<D>,
  ): MutationBuilder<D, TInputIn, TInput, TErrors>;
  errors<E extends ErrorMap>(errors: E): MutationBuilder<D, TInputIn, TInput, TErrors & E>;
  meta(meta: MutationMeta): MutationBuilder<D, TInputIn, TInput, TErrors>;
  handler<TResult extends ReadonlyJSONValue | void>(
    fn: (args: MutationHandlerArgs<D, TInput, TErrors>) => Promise<TResult>,
  ): MutationProcedure<TInputIn, TResult, TErrors>;
}

const emptyDef = (kind: ProcedureDef["kind"]): ProcedureDef => ({
  kind,
  input: undefined,
  uses: [],
  output: undefined,
  errors: {},
  meta: {},
  handler: undefined,
});

function builder(def: ProcedureDef): any {
  const next = (patch: Partial<ProcedureDef>) => builder({ ...def, ...patch });
  return {
    input: (input: InputSchema) => next({ input }),
    use: (middleware: unknown) => next({ uses: [...def.uses, middleware] }),
    output: (output: StandardSchemaV1) => next({ output }),
    errors: (errors: ErrorMap) => next({ errors: { ...def.errors, ...errors } }),
    meta: (meta: QueryMeta & MutationMeta) => next({ meta: { ...def.meta, ...meta } }),
    handler: (handler: (args: any) => unknown) => ({
      "~kind": def.kind,
      "~def": { ...def, handler },
    }),
  };
}

export function queryBuilder<D extends AppDef>(): QueryBuilder<D, undefined, undefined, Unset> {
  return builder(emptyDef("query"));
}

export function mutationBuilder<D extends AppDef>(): MutationBuilder<D, undefined, undefined, {}> {
  return builder(emptyDef("mutation"));
}
