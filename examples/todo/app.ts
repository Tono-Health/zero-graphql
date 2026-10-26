import { createApp } from "zero-relay";
import type { Env } from "./env.ts";
import { schema } from "./schema.ts";
import { getSession, loadUser } from "./users.ts";

export type User = {
  readonly userID: string;
  readonly name: string;
};

export const app = createApp<{ user: User; env: Env }>()({
  schema,

  // Who is making this request? Return null to reject it.
  authenticate: async ({ request, env }) => {
    const session = await getSession(request, env);
    if (!session) return null;
    const user = await loadUser(env, session.userID);
    return user ? { user, expiresAt: session.expiresAt } : null;
  },

  // Each user gets their own relay, which syncs as that user.
  partition: {
    key: ({ user }) => user.userID,
    authorize: ({ user, key }) => user.userID === key,
    scope: ({ key, env }) => loadUser(env, key),
    user: ({ scope }) => scope,
  },
});
