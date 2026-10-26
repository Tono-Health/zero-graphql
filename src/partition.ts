import type { MaybePromise, PartitionKind } from "./types.ts";

/**
 * How an app splits connections across relays. The framework makes no assumptions:
 * each relay is identified by a string key, and the app supplies these functions.
 */
export interface Partition<TUser, TEnv, TScope> {
  /** Which relay serves this connection. Runs in the host router on WebSocket upgrade. Return null to reject. */
  readonly key: (args: {
    user: TUser;
    request: Request;
    url: URL;
    env: TEnv;
  }) => MaybePromise<string | null>;

  /**
   * May `user` use the relay for `key`? Runs on upgrade, and again at the endpoint for every
   * mutation's actor, where there's no request, which is why it can't be derived from `key`.
   */
  readonly authorize: (args: { user: TUser; key: string; env: TEnv }) => MaybePromise<boolean>;

  /**
   * What the relay's Zero client syncs as. Must depend only on the key: it runs in the relay
   * at startup and in the endpoints for every request, which only know the key.
   */
  readonly scope: (args: { key: string; env: TEnv }) => MaybePromise<TScope | null>;

  /**
   * Set only if each relay serves exactly one person: returns that person from the scope.
   * Then the server knows the user, so query handlers receive `user` and can filter rows by it,
   * and the server enforces query guards itself. Without it, guards run in the relay only, and
   * queries can filter by scope but not by user.
   */
  readonly user?: (args: { scope: TScope }) => TUser;
}

/** `"single-user"` when the partition defines `user` (whose return type is then not `never`). */
export type PartitionKindOf<TUserOut> = [TUserOut] extends [never] ? "shared" : "single-user";

export type { PartitionKind };
