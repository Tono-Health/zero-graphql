// Relay tokens: what a relay's Zero client sends to zero-cache, and what
// zero-cache forwards to the endpoints as a bearer token. They name the relay
// and its partition key, and nothing about any user.
//
// Format: `zr1.<base64url JSON { r, k, e }>.<base64url HMAC-SHA256>`.

const VERSION = "zr1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RelayClaims {
  /** Relay name: `"main"` or a key of the host's `relays` option. */
  readonly relay: string;
  /** Partition key. */
  readonly key: string;
}

export async function signRelayToken(
  secret: string,
  claims: RelayClaims,
  ttlMs: number,
  now = Date.now(),
): Promise<string> {
  const payload = base64url(
    encoder.encode(JSON.stringify({ r: claims.relay, k: claims.key, e: now + ttlMs })),
  );
  const body = `${VERSION}.${payload}`;
  return `${body}.${base64url(await hmac(secret, body))}`;
}

export async function verifyRelayToken(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<RelayClaims | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return undefined;
  const [, payload, signature] = parts as [string, string, string];
  const expected = base64url(await hmac(secret, `${VERSION}.${payload}`));
  if (!constantTimeEqual(signature, expected)) return undefined;
  let claims: unknown;
  try {
    claims = JSON.parse(decoder.decode(fromBase64url(payload)));
  } catch {
    return undefined;
  }
  if (
    typeof claims !== "object" ||
    claims === null ||
    typeof (claims as { r?: unknown }).r !== "string" ||
    typeof (claims as { k?: unknown }).k !== "string" ||
    typeof (claims as { e?: unknown }).e !== "number"
  ) {
    return undefined;
  }
  const { r, k, e } = claims as { r: string; k: string; e: number };
  return e > now ? { relay: r, key: k } : undefined;
}

/** The relay that `/live` serves; others are keyed by name in the host's `relays` option. */
export const MAIN_RELAY = "main";

/** The user ID a relay's Zero client connects as, so zero-cache keeps relays' state apart. */
export function zeroUserID(claims: RelayClaims): string {
  return `${claims.relay}/${claims.key}`;
}

export function bearerToken(request: Request): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
}

const keys = new Map<string, Promise<CryptoKey>>();

async function hmac(secret: string, body: string): Promise<Uint8Array> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keys.set(secret, key);
  }
  return new Uint8Array(await crypto.subtle.sign("HMAC", await key, encoder.encode(body)));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}
