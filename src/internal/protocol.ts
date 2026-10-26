// The browser ⇄ relay protocol (design section 9). Plain JSON over one WebSocket.
// Shared by the browser client and the relay, so it has no dependencies.

/** Negotiated as the WebSocket subprotocol. */
export const PROTOCOL = "zero-relay.v1";

/** Largest message the relay accepts from a browser, in bytes. */
export const MAX_CLIENT_MESSAGE_BYTES = 256 * 1024;

export type ClientMessage =
  | { readonly t: "sub"; readonly id: string; readonly path: string; readonly input?: unknown }
  | { readonly t: "unsub"; readonly id: string }
  | { readonly t: "call"; readonly id: string; readonly path: string; readonly input?: unknown };

export interface WireError {
  readonly code: string;
  readonly message: string;
  readonly data?: unknown;
}

/** Zero's result type: `unknown` while loading, `complete` once the server has answered. */
export type WireStatus = "unknown" | "complete";

/**
 * - `refresh`, `restarting`: reconnect and resubscribe.
 * - `revoked`, `session-expired`: don't reconnect.
 */
export type CloseReason = "refresh" | "restarting" | "revoked" | "session-expired";

export type ServerMessage =
  | { readonly t: "data"; readonly id: string; readonly type: WireStatus; readonly data: unknown }
  | { readonly t: "result"; readonly id: string; readonly ok: true; readonly data: unknown }
  | { readonly t: "result"; readonly id: string; readonly ok: false; readonly error: WireError }
  | { readonly t: "error"; readonly id: string | null; readonly error: WireError }
  | { readonly t: "close"; readonly reason: CloseReason };

/** WebSocket close codes the relay uses. 4000-4999 are reserved for applications. */
export const CloseCode = {
  normal: 1000,
  restarting: 1012,
  refresh: 4000,
  revoked: 4001,
  sessionExpired: 4002,
  protocolError: 4400,
} as const;

const ID = /^[\w-]{1,128}$/;
const PATH = /^[\w$]+(\.[\w$]+)*$/;

/** Validates a browser message. Returns undefined for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | undefined {
  if (raw.length > MAX_CLIENT_MESSAGE_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (typeof message["id"] !== "string" || !ID.test(message["id"])) return undefined;
  switch (message["t"]) {
    case "unsub":
      return { t: "unsub", id: message["id"] };
    case "sub":
    case "call":
      if (typeof message["path"] !== "string" || !PATH.test(message["path"])) return undefined;
      return { t: message["t"], id: message["id"], path: message["path"], input: message["input"] };
  }
  return undefined;
}

export function closeCodeFor(reason: CloseReason): number {
  switch (reason) {
    case "refresh":
      return CloseCode.refresh;
    case "restarting":
      return CloseCode.restarting;
    case "revoked":
      return CloseCode.revoked;
    case "session-expired":
      return CloseCode.sessionExpired;
  }
}
