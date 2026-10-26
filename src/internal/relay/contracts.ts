import type { AnyMutatorRegistry, Schema, TTL } from "@rocicorp/zero";
import type { ZeroContext } from "../compile.ts";
import type { ResolvedRelay } from "../relays.ts";

// ---------------------------------------------------------------------------
// The parts of Zero the runtime uses, so tests can supply a fake.

export interface ViewLike {
  addListener(listener: (data: unknown, resultType: string, error?: unknown) => void): () => void;
  destroy(): void;
}

export type MutatorResultLike =
  | { readonly type: "success"; readonly data?: unknown }
  | {
      readonly type: "error";
      readonly error:
        | { readonly type: "app"; readonly message?: string; readonly details?: unknown }
        | { readonly type: "zero"; readonly message: string };
    };

export interface ZeroLike {
  materialize(query: never, options?: { ttl?: TTL }): ViewLike;
  mutate(request: never): {
    client: Promise<MutatorResultLike>;
    server: Promise<MutatorResultLike>;
  };
  readonly connection: {
    readonly state: { subscribe(listener: (state: { readonly name: string }) => void): () => void };
    connect(options?: { auth?: string }): Promise<void>;
  };
  close(): Promise<void>;
}

export interface ZeroInit {
  readonly userID: string;
  readonly auth: string;
  readonly schema: Schema;
  readonly mutators: AnyMutatorRegistry;
  /** Updated in place when the relay refreshes. */
  readonly context: ZeroContext;
}

// ---------------------------------------------------------------------------
// Host interface

export interface RelaySocket {
  send(message: string): void;
  close(code: number, reason: string): void;
  /** Persists a refreshed user (on Cloudflare, in the socket attachment). */
  setUser?(user: unknown): void;
}

export interface RelayConnection {
  message(raw: string): void;
  /** The socket closed or errored. */
  closed(): void;
}

export interface RelayOptions {
  readonly relay: ResolvedRelay;
  readonly key: string;
  readonly env: unknown;
  readonly secret: string;
  readonly createZero: (init: ZeroInit) => ZeroLike;
  /** How long the Zero client outlives the last browser, in ms. Default: 30s. */
  readonly idleTimeout?: number;
  /**
   * How often the context refreshes without an invalidation, in ms. Default: 5 minutes.
   * Shared sockets reconnect on this interval to authenticate and authorize with a fresh user.
   */
  readonly refreshInterval?: number;
  /**
   * How long mutation results are kept in memory to deduplicate repeated messages, in ms.
   * Default: 60s. This cache is lost on restart and does not make browser retries safe.
   */
  readonly callRetention?: number;
  /** Called when the Zero client is created. The host drops a pending retention alarm here. */
  readonly onActive?: () => void;
  /** Called after the Zero client closes, so the host can let the relay hibernate or exit. */
  readonly onIdle?: () => void;
}

export interface Relay {
  /** The expiry is fixed for this socket; refreshing its user never renews the session. */
  connect(socket: RelaySocket, user: unknown, expiresAt: number | null): RelayConnection;
  /** Reloads the scope now. Resolves once it's reloaded; a no-op if the Zero client isn't running. */
  invalidate(): Promise<void>;
  readonly connections: number;
  shutdown(): Promise<void>;
}
