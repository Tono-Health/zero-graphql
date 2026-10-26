import type { Schema } from "@rocicorp/zero";
import type { AuditConfig } from "./audit.ts";
import type { Partition, PartitionKindOf } from "./partition.ts";
import {
  mutationBuilder,
  queryBuilder,
  type Guard,
  type MutationBuilder,
  type MutationMiddleware,
  type QueryBuilder,
  type QueryMiddleware,
  type RelayMiddleware,
  type RouterShape,
  type Site,
  type Unset,
} from "./procedure.ts";
import type { AppDef, MaybePromise } from "./types.ts";

export interface AppTypes {
  readonly user: AppDef["user"];
  readonly env?: unknown;
}

export interface AuthSession<TUser> {
  readonly user: TUser;
  /** Absolute Unix timestamp in milliseconds, from the verified session. Null explicitly disables expiry. */
  readonly expiresAt: number | null;
}

type EnvOf<T extends AppTypes> = T extends { readonly env: infer E } ? E : unknown;

/**
 * `user`'s return type is inferred separately (`never` when `user` is omitted), so the app's
 * type records whether the partition is single-user.
 */
export type PartitionInput<TUser, TEnv, TScope, TUserOut> = Omit<
  Partition<TUser, TEnv, TScope>,
  "user"
> & { readonly user?: (args: { scope: TScope }) => TUserOut };

export interface AppConfig<S extends Schema, TUser, TEnv, TScope, TUserOut> {
  readonly schema: S;
  /** Verifies the session on WebSocket upgrade. Return its user and expiry, or null to reject. */
  readonly authenticate: (args: {
    request: Request;
    env: TEnv;
  }) => MaybePromise<AuthSession<TUser> | null>;
  /** How connections are split across relays. Entirely app-defined. */
  readonly partition: PartitionInput<TUser, TEnv, TScope, TUserOut>;
  readonly audit?: AuditConfig<TUser, TEnv>;
}

type DefOf<TUser, TEnv, S extends Schema, TScope, TUserOut> = {
  readonly schema: S;
  readonly user: TUser;
  readonly env: TEnv;
  readonly scope: TScope;
  readonly kind: PartitionKindOf<TUserOut>;
};

export interface App<D extends AppDef> {
  readonly "~types"?: D;
  readonly config: AppConfig<D["schema"], D["user"], D["env"], D["scope"], unknown>;

  readonly query: QueryBuilder<D, undefined, undefined, Unset>;
  readonly mutation: MutationBuilder<D, undefined, undefined, {}>;

  /** A synchronous yes/no check on the user (and optionally the input). */
  guard<TInput = unknown>(
    check: Guard<D, TInput>["check"],
    options?: { name?: string },
  ): Guard<D, TInput>;

  /** Groups procedures. Paths become Zero names (`lists.get`) and client paths. */
  router<const R extends RouterShape>(router: R): R;

  /** The same app with another partition, for hosting a second relay (e.g. per document). */
  withPartition<TScope, TUserOut extends D["user"] = never>(
    partition: PartitionInput<D["user"], D["env"], TScope, TUserOut>,
  ): App<DefOf<D["user"], D["env"], D["schema"], TScope, TUserOut>>;

  readonly middleware: {
    relay(hooks: Omit<RelayMiddleware<D>, "~kind">): RelayMiddleware<D>;
    query(apply: QueryMiddleware<D>["apply"], options?: { on?: Site }): QueryMiddleware<D>;
    mutation(apply: MutationMiddleware<D>["apply"], options?: { on?: Site }): MutationMiddleware<D>;
  };
}

/**
 * ```ts
 * export const app = createApp<{ user: User; env: Env }>()({ schema, authenticate, partition })
 * ```
 * The first call fixes the user and env types; the second infers everything else.
 */
export function createApp<T extends AppTypes>() {
  return <S extends Schema, TScope, TUserOut extends T["user"] = never>(
    config: AppConfig<S, T["user"], EnvOf<T>, TScope, TUserOut>,
  ): App<DefOf<T["user"], EnvOf<T>, S, TScope, TUserOut>> => makeApp(config);
}

const sites = (on: Site | undefined): readonly Site[] => (on ? [on] : ["relay", "server"]);

function makeApp(config: AppConfig<any, any, any, any, any>): any {
  const app: App<any> = {
    config,
    query: queryBuilder(),
    mutation: mutationBuilder(),
    guard: (check, options) => ({ "~kind": "guard", name: options?.name, check }),
    router: (router) => router,
    withPartition: (partition) => makeApp({ ...config, partition }),
    middleware: {
      relay: (hooks) => ({ "~kind": "relay-middleware", ...hooks }),
      query: (apply, options) => ({
        "~kind": "query-middleware",
        sites: sites(options?.on),
        apply,
      }),
      mutation: (apply, options) => ({
        "~kind": "mutation-middleware",
        sites: sites(options?.on),
        apply,
      }),
    },
  };
  return app;
}

export type AnyApp = App<any>;
