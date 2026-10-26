import type { StandardSchemaV1 } from "@standard-schema/spec";
import { RelayError } from "../errors.ts";

/** Validates with any Standard Schema validator. Async validators are awaited. */
export async function validate(
  schema: StandardSchemaV1 | undefined,
  value: unknown,
): Promise<unknown> {
  if (!schema) return value;
  return unwrap(await schema["~standard"].validate(value));
}

/**
 * For places that must stay synchronous (Zero query functions, output projection). An async
 * validator there is a programming error, reported as INTERNAL.
 */
export function validateSync(schema: StandardSchemaV1 | undefined, value: unknown): unknown {
  if (!schema) return value;
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new Error("zero-relay: this schema must validate synchronously");
  }
  return unwrap(result);
}

function unwrap(result: StandardSchemaV1.Result<unknown>): unknown {
  if (result.issues) {
    throw new RelayError("BAD_INPUT", {
      message: result.issues.map((issue) => issue.message).join("; "),
    });
  }
  return result.value;
}
