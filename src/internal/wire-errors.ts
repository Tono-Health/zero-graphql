import { ApplicationError, type ReadonlyJSONValue } from "@rocicorp/zero";
import { isRelayError, RelayError, type BuiltinErrorCode, type ErrorMap } from "../errors.ts";
import type { WireError } from "./protocol.ts";
import { validate } from "./standard.ts";

const NAMESPACE = "zero-relay";
const BUILTIN_CODES = new Set<string>([
  "FORBIDDEN",
  "UNAVAILABLE",
  "BAD_INPUT",
  "DISCONNECTED",
  "OUTCOME_UNKNOWN",
  "INTERNAL",
] satisfies BuiltinErrorCode[]);
// Errors decoded from Zero already contain schema output, not schema input. In particular,
// transformations must not run a second time when forwarding these to the browser.
const received = new WeakSet<RelayError>();

/** Keeps `throw errors.CODE(data)` synchronous while supporting async error-data validators. */
export async function prepareMutationError(error: unknown, errors: ErrorMap): Promise<RelayError> {
  if (!isRelayError(error)) return hiddenError();
  if (received.has(error)) return error;
  if (error.code === "INTERNAL") return hiddenError();
  try {
    if (Object.hasOwn(errors, error.code)) {
      const schema = errors[error.code]!.data;
      const data = schema ? await validate(schema, error.data) : undefined;
      if (!isJSONData(data)) return hiddenError();
      return new RelayError(error.code, { message: error.message, data });
    }
    if (BUILTIN_CODES.has(error.code) && isJSONData(error.data)) return error;
  } catch {
    // Validator issues and exceptions may contain private values. None are public error data.
  }
  return hiddenError();
}

/** A trusted Zero result has already passed the procedure's validation at its origin. */
export function receivedMutationError(error: WireError, errors: ErrorMap): RelayError {
  const wire =
    (Object.hasOwn(errors, error.code) || BUILTIN_CODES.has(error.code)) && isJSONData(error.data)
      ? error
      : internal();
  const result = new RelayError(wire.code, { message: wire.message, data: wire.data });
  received.add(result);
  return result;
}

function hiddenError(): RelayError {
  return new RelayError("INTERNAL", { message: "Internal error" });
}

/** Reject lossy/non-JSON schema output rather than changing its inferred type on the wire. */
function isJSONData(value: unknown, ancestors = new Set<object>()): boolean {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from(value).every((item) => item !== undefined && isJSONData(item, ancestors))
    : Object.values(value).every((item) => isJSONData(item, ancestors));
  ancestors.delete(value);
  return valid;
}

/**
 * Zero carries mutation and query failures between hops as `ApplicationError`s with JSON
 * `details`. A `RelayError` travels inside them under a namespace, so errors thrown by other code
 * aren't mistaken for declared ones.
 */
export function toApplicationError(error: unknown): ApplicationError | undefined {
  if (!isRelayError(error)) return undefined;
  return new ApplicationError(error.message, {
    details: {
      [NAMESPACE]: {
        code: error.code,
        ...(error.data === undefined ? {} : { data: error.data as ReadonlyJSONValue }),
      },
    },
  });
}

/** Turns an error from Zero (`{ message, details }`) back into what the browser receives. */
export function fromApplicationError(message: string | undefined, details: unknown): WireError {
  const encoded =
    details && typeof details === "object" && NAMESPACE in details
      ? (details as Record<typeof NAMESPACE, unknown>)[NAMESPACE]
      : undefined;
  if (
    encoded &&
    typeof encoded === "object" &&
    typeof (encoded as { code?: unknown }).code === "string"
  ) {
    const { code, data } = encoded as { code: string; data: unknown };
    return { code, message: message ?? code, ...(data === undefined ? {} : { data }) };
  }
  return internal();
}

/** For errors raised in the relay itself. */
export function toWireError(error: unknown): WireError {
  if (isRelayError(error))
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  return internal();
}

export function internal(): WireError {
  return { code: "INTERNAL", message: "Internal error" };
}

export function forbidden(
  guard: string | undefined,
): RelayError<"FORBIDDEN", { guard: string } | undefined> {
  return new RelayError("FORBIDDEN", {
    message: "Forbidden",
    data: guard === undefined ? undefined : { guard },
  });
}
