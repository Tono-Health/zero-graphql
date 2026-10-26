/** Missing or malformed deadlines fail closed; only an explicit null disables expiry. */
export function isActiveSession(expiresAt: unknown): expiresAt is number | null {
  return (
    expiresAt === null ||
    (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > Date.now())
  );
}
