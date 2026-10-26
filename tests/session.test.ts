import { afterEach, expect, test, vi } from "vite-plus/test";
import { getSession, signSession } from "../examples/todo/users.ts";

const env = { SESSION_SECRET: "test-session-secret" };
const request = (cookie: string) =>
  new Request("https://app.example.com", { headers: { Cookie: `session=${cookie}` } });
afterEach(() => vi.restoreAllMocks());

test("signed sessions carry their fixed expiry and reject at the deadline", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const cookie = await signSession(env, "alice");
  expect(await getSession(request(cookie), env)).toEqual({
    userID: "alice",
    expiresAt: now + 3_600_000,
  });
  clock.mockReturnValue(now + 3_600_000);
  expect(await getSession(request(cookie), env)).toBeNull();
});

test("changing the signed expiry cannot extend a session", async () => {
  const expiresAt = Date.now() + 1000;
  const cookie = await signSession(env, "alice", expiresAt);
  const payload = btoa(
    JSON.stringify({ userID: "alice", expiresAt: expiresAt + 3_600_000 }),
  ).replace(/=+$/, "");
  const forged = `${payload}.${cookie.split(".")[1]}`;
  expect(await getSession(request(forged), env)).toBeNull();
  expect(await getSession(request(cookie), { SESSION_SECRET: "wrong-key" })).toBeNull();
});

test.each(["not-a-session", "%.bad", "a.b.c", "alice.old-signature"])(
  "malformed or legacy cookie %s is rejected",
  async (cookie) => {
    expect(await getSession(request(cookie), env)).toBeNull();
  },
);
