import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { InferIn, InferOut, ReadonlyJSONValue } from "./types.ts";

/** Codes the framework can produce on any procedure. */
export type BuiltinErrorCode =
  /** A guard rejected the call or subscription. */
  | "FORBIDDEN"
  /** The relay's connection to zero-cache is down. */
  | "UNAVAILABLE"
  /** Unknown path, or input failed validation. */
  | "BAD_INPUT"
  /** The client ended; for mutations, the call was never sent. */
  | "DISCONNECTED"
  /** Sending was attempted, but no result arrived. The mutation may have committed. */
  | "OUTCOME_UNKNOWN"
  /** Anything undeclared. The original message is never sent to the browser. */
  | "INTERNAL";

export interface ErrorDef {
  readonly message?: string;
  /** Validates and transforms public error data before sending it. Invalid data becomes INTERNAL. */
  readonly data?: StandardSchemaV1<unknown, ReadonlyJSONValue | undefined>;
}

export type ErrorMap = Readonly<Record<string, ErrorDef>>;

type InputDataOf<E extends ErrorDef> = E["data"] extends StandardSchemaV1
  ? InferIn<E["data"]>
  : undefined;

type OutputDataOf<E extends ErrorDef> = E["data"] extends StandardSchemaV1
  ? InferOut<E["data"]>
  : undefined;

type ErrorArgs<E extends ErrorDef> = E["data"] extends StandardSchemaV1
  ? undefined extends InputDataOf<E>
    ? [data?: InputDataOf<E>, options?: { message?: string }]
    : [data: InputDataOf<E>, options?: { message?: string }]
  : [options?: { message?: string }];

export class RelayError<TCode extends string = string, TData = unknown> extends Error {
  override readonly name = "RelayError";
  readonly code: TCode;
  readonly data: TData;

  constructor(code: TCode, options: { message?: string; data?: TData } = {}) {
    super(options.message ?? code);
    this.code = code;
    this.data = options.data as TData;
  }
}

export function isRelayError(error: unknown): error is RelayError {
  return error instanceof RelayError;
}

/** `errors.NOT_FOUND()` / `errors.CONFLICT({ ... })` in mutation handlers. */
export type ErrorConstructors<E extends ErrorMap> = {
  readonly [K in keyof E & string]: (...args: ErrorArgs<E[K]>) => RelayError<K, InputDataOf<E[K]>>;
};

/** The error type a browser sees from a mutation that declared `E`. */
export type ErrorUnion<E extends ErrorMap> =
  | { [K in keyof E & string]: RelayError<K, OutputDataOf<E[K]>> }[keyof E & string]
  | RelayError<BuiltinErrorCode, undefined>;
