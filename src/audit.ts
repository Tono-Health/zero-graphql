import type { MaybePromise } from "./types.ts";

interface BaseEvent<TUser> {
  readonly user: TUser;
  /** Procedure path, e.g. `"todos.toggle"`. */
  readonly path: string;
  /** Milliseconds since the epoch. */
  readonly at: number;
}

export type AuditEvent<TUser> =
  | (BaseEvent<TUser> & {
      readonly type: "subscribe";
      readonly subscriptionID: string;
      readonly input: unknown;
    })
  | (BaseEvent<TUser> & {
      readonly type: "deliver";
      readonly subscriptionID: string;
      /** Primary keys of the root rows in this update. */
      readonly rowIDs: readonly string[];
    })
  | (BaseEvent<TUser> & {
      readonly type: "unsubscribe";
      readonly subscriptionID: string;
      readonly durationMs: number;
    })
  | (BaseEvent<TUser> & {
      readonly type: "mutate";
      readonly mutationID: string;
      readonly input: unknown;
      readonly outcome: "pending" | "ok" | { readonly error: string };
    })
  | (BaseEvent<TUser> & {
      readonly type: "denied";
      /** The guard's name, if it was given one. */
      readonly guard: string | undefined;
    });

export interface AuditConfig<TUser, TEnv> {
  /** Called for every event. Failures are logged and don't fail the user's request. */
  readonly sink: (args: { env: TEnv; event: AuditEvent<TUser> }) => MaybePromise<void>;
  /** Emit a `deliver` event for every update sent to a browser. Default: false. */
  readonly deliveries?: boolean;
}
