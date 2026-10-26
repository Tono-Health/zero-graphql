import { useCallback, useEffect, useState } from "react";
import type { MutationCaller, QueryRef, SafeResult } from "./client.ts";
import type { ErrorMap, ErrorUnion, RelayError } from "./errors.ts";
import type { QueryStatus } from "./procedure.ts";
import type { InputArgs } from "./types.ts";

export interface QueryDetails {
  /** `unknown` while loading or disconnected, `complete` once results arrive, `error` on failure. */
  readonly status: QueryStatus;
  readonly error: RelayError | undefined;
}

/**
 * Returns `[data, { status, error }]`. `data` is undefined until the first snapshot and
 * cleared when the subscription disconnects or ends, including logout and access revocation.
 */
export function useQuery<TInput, TData>(
  ref: QueryRef<TInput, TData>,
  ...args: InputArgs<TInput>
): [data: TData | undefined, details: QueryDetails] {
  const input = args[0] as TInput;
  const inputKey = JSON.stringify(input);
  const [state, setState] = useState<{ data: TData | undefined; details: QueryDetails }>({
    data: undefined,
    details: { status: "unknown", error: undefined },
  });

  useEffect(() => {
    setState({ data: undefined, details: { status: "unknown", error: undefined } });
    return ref.subscribe(
      input,
      ({ data, status }) => setState({ data, details: { status, error: undefined } }),
      (error) => setState({ data: undefined, details: { status: "error", error } }),
    );
    // `inputKey` stands in for `input`, so a new object with the same contents doesn't resubscribe.
  }, [ref, inputKey]);

  return [state.data, state.details];
}

export interface MutationState<TInput, TResult, TErrors extends ErrorMap> {
  readonly mutate: (
    ...args: InputArgs<TInput>
  ) => Promise<SafeResult<TResult, ErrorUnion<TErrors>>>;
  readonly pending: boolean;
  readonly error: ErrorUnion<TErrors> | undefined;
}

export function useMutation<TInput, TResult, TErrors extends ErrorMap>(
  caller: MutationCaller<TInput, TResult, TErrors>,
): MutationState<TInput, TResult, TErrors> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorUnion<TErrors> | undefined>(undefined);

  const mutate = useCallback(
    async (...args: InputArgs<TInput>) => {
      setPending(true);
      try {
        const result = await caller.safe(...args);
        setError(result.error ?? undefined);
        return result;
      } finally {
        setPending(false);
      }
    },
    [caller],
  );

  return { mutate, pending, error };
}
