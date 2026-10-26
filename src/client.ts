import { RelayError, type ErrorMap, type ErrorUnion } from "./errors.ts";
import type { MutationProcedure, QueryProcedure, QueryStatus, RouterShape } from "./procedure.ts";
import { ClientConnection } from "./internal/connection.ts";
import type { InputArgs } from "./types.ts";

export { isRelayError, RelayError } from "./errors.ts";
export type { QueryStatus } from "./procedure.ts";

/**
 * `"hidden"`: the tab was hidden for `hiddenTabDisconnectDelay`, so the client disconnected to let
 * the relay idle out. It reconnects and resubscribes when the tab is visible again.
 *
 * `"revoked"`: the relay ended the session because the user no longer has access (their scope
 * reloaded as null, a re-check failed, or the session expired). The client doesn't reconnect; all
 * data is dropped.
 */
export type ConnectionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "hidden"
  | "closed"
  | "revoked";

export interface ClientOptions {
  /** Default: `/zero/live` on the current origin. */
  readonly url?: string;
  /** Sent as URL search parameters, e.g. `{ docID }` for a relay keyed by a resource. */
  readonly params?: Readonly<Record<string, string>>;
  readonly onStatusChange?: (status: ConnectionStatus) => void;
  /**
   * How long a tab can stay hidden before the client disconnects, in ms. An open relay can't
   * hibernate, so this stops forgotten tabs from keeping relays running. Default: 5 minutes,
   * matching Zero's `hiddenTabDisconnectDelay`.
   */
  readonly hiddenTabDisconnectDelay?: number;
}

export interface Snapshot<TData> {
  /** Undefined when the subscription is cleared after a disconnect or terminal error. */
  readonly data: TData | undefined;
  readonly status: QueryStatus;
}

export interface QueryRef<TInput, TData> {
  readonly "~kind": "query-ref";
  readonly path: string;
  /**
   * Starts a live query. Disconnects clear data with status `unknown`; terminal errors clear it
   * with status `error`, then call `onError` if supplied. The returned function unsubscribes.
   */
  subscribe(
    input: TInput,
    listener: (snapshot: Snapshot<TData>) => void,
    onError?: (error: RelayError) => void,
  ): () => void;
}

export type SafeResult<TResult, TError> =
  | { readonly data: TResult; readonly error: null }
  | { readonly data: undefined; readonly error: TError };

export interface MutationCaller<TInput, TResult, TErrors extends ErrorMap> {
  /**
   * Resolves with the result, or throws a `RelayError`. Sent calls are never replayed after a
   * disconnect: `OUTCOME_UNKNOWN` means the mutation may have committed. Reconcile before retrying.
   */
  (...args: InputArgs<TInput>): Promise<TResult>;
  /** Never throws for relay errors: returns `{ data, error }`. */
  safe(...args: InputArgs<TInput>): Promise<SafeResult<TResult, ErrorUnion<TErrors>>>;
  readonly path: string;
}

export type RelayClient<R extends RouterShape> = {
  readonly [K in keyof R]: R[K] extends QueryProcedure<infer I, infer D>
    ? QueryRef<I, D>
    : R[K] extends MutationProcedure<infer I, infer Res, infer E>
      ? MutationCaller<I, Res, E>
      : R[K] extends RouterShape
        ? RelayClient<R[K]>
        : never;
};

export interface ClientControls {
  readonly $status: ConnectionStatus;
  /** Closes the socket and drops all subscriptions. Call on logout. */
  $close(): void;
}

/**
 * Takes the router's type only (`import type`), so no server code reaches the browser.
 * Connects lazily on the first subscription or call. Holds data in memory only.
 */
export function createClient<R extends RouterShape>(
  options: ClientOptions = {},
): RelayClient<R> & ClientControls {
  const connection = new ClientConnection(options);
  const nodes = new Map<string, unknown>();

  const node = (path: string): unknown => {
    let existing = nodes.get(path);
    if (existing) return existing;
    const call = (input?: unknown) => connection.call(path, input);
    const members: Record<PropertyKey, unknown> = {
      "~kind": "query-ref",
      path,
      subscribe: (
        input: unknown,
        listener: (snapshot: Snapshot<unknown>) => void,
        onError?: (error: RelayError) => void,
      ) => connection.subscribe(path, input, listener, onError),
      safe: async (input?: unknown) => {
        try {
          return { data: await call(input), error: null };
        } catch (error) {
          if (error instanceof RelayError) return { data: undefined, error };
          throw error;
        }
      },
    };
    existing = new Proxy(call, {
      get: (_target, prop) =>
        Object.hasOwn(members, prop)
          ? members[prop]
          : isPath(prop)
            ? node(`${path}.${prop}`)
            : undefined,
    });
    nodes.set(path, existing);
    return existing;
  };

  return new Proxy({} as RelayClient<R> & ClientControls, {
    get: (_target, prop) => {
      if (prop === "$status") return connection.status;
      if (prop === "$close") return () => connection.close();
      return isPath(prop) ? node(prop) : undefined;
    },
  });
}

/** `then` excluded, so the client isn't mistaken for a promise when returned from an async function. */
function isPath(prop: string | symbol): prop is string {
  return typeof prop === "string" && prop !== "then";
}
