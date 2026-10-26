// Stand-ins for code an app already has: session verification and user lookup.
// Sessions are a signed cookie containing a user ID and expiry; users live in Postgres.
import postgres from "postgres";
import type { User } from "./app.ts";
import { databaseURL, type Env } from "./env.ts";

export async function getSession(
  request: Request,
  env: Env,
): Promise<{ readonly userID: string; readonly expiresAt: number } | null> {
  const cookie = request.headers.get("Cookie") ?? "";
  const value = /(?:^|;\s*)session=([^;]+)/.exec(cookie)?.[1];
  if (!value) return null;
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const verified = await crypto.subtle.verify(
      "HMAC",
      await sessionKey(env),
      unbase64url(signature),
      new TextEncoder().encode(payload),
    );
    if (!verified) return null;
    const session = JSON.parse(new TextDecoder().decode(unbase64url(payload)));
    if (
      typeof session?.userID !== "string" ||
      !session.userID ||
      typeof session.expiresAt !== "number" ||
      !Number.isFinite(session.expiresAt) ||
      session.expiresAt <= Date.now()
    )
      return null;
    return { userID: session.userID, expiresAt: session.expiresAt };
  } catch {
    return null;
  }
}

export async function signSession(
  env: Pick<Env, "SESSION_SECRET">,
  userID: string,
  expiresAt = Date.now() + 60 * 60_000,
): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ userID, expiresAt })));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await sessionKey(env),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

function sessionKey(env: Pick<Env, "SESSION_SECRET">): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  );
}

export async function loadUser(env: Env, userID: string): Promise<User | null> {
  // A postgres.js client can't be shared across Worker requests.
  const sql = postgres(databaseURL(env), { max: 1, fetch_types: false });
  try {
    const [row] = await sql<
      { id: string; name: string }[]
    >`SELECT id, name FROM app_user WHERE id = ${userID}`;
    return row ? { userID: row.id, name: row.name } : null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
