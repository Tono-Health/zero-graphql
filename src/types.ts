import type { ReadonlyJSONObject, ReadonlyJSONValue, Schema } from "@rocicorp/zero";
import type { StandardSchemaV1 } from "@standard-schema/spec";

export type MaybePromise<T> = T | Promise<T>;

/** Users travel inside mutation args (the actor envelope), so they must be JSON. */
export type JSONObject = ReadonlyJSONObject;
export type { ReadonlyJSONValue };

/** JSON procedure inputs, including omitted arguments and schema defaults. */
export type InputSchema = StandardSchemaV1<
  ReadonlyJSONValue | undefined,
  ReadonlyJSONValue | undefined
>;
export type InferIn<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;
export type InferOut<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

/** `"single-user"`: each relay serves one person, so the server can know the user. */
export type PartitionKind = "single-user" | "shared";

/** Everything an app is parameterized by, collected so other types take one parameter. */
export interface AppDef {
  readonly schema: Schema;
  /** The authenticated session's user: the person on a socket. */
  readonly user: JSONObject;
  /** Host bindings and variables (on Cloudflare, the Worker `Env`). */
  readonly env: unknown;
  /** The identity the relay's Zero client syncs under. Depends only on the partition key. */
  readonly scope: unknown;
  readonly kind: PartitionKind;
}

export type TableName<D extends AppDef> = keyof D["schema"]["tables"] & string;

/** Spreads `user` into handler args only where the server can know it. */
export type UserIfKnown<D extends AppDef> = D["kind"] extends "single-user"
  ? { readonly user: D["user"] }
  : {};

export type InputArgs<TInput> = undefined extends TInput ? [input?: TInput] : [input: TInput];
