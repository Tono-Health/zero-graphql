import { Container, getContainer } from "@cloudflare/containers";
import { zeroPostgresJS } from "@rocicorp/zero/server/adapters/postgresjs";
import { cloudflare, type ExecutionContextLike } from "zero-relay/cloudflare";
import { app } from "../todo/app.ts";
import { router } from "../todo/router.ts";
import { schema } from "../todo/schema.ts";
import { signSession } from "../todo/users.ts";
import type { WorkerEnv } from "./alchemy.run.ts";

const relay = cloudflare(app, {
  router,
  database: (env: WorkerEnv) => zeroPostgresJS(schema, env.HYPERDRIVE.connectionString),
  cache: (env: WorkerEnv) => getContainer(env.ZERO_CACHE),
});

export const Relay = relay.DurableObject;

/** zero-cache. Every relay syncs from this one instance, which holds the replica. */
export class ZeroCache extends Container {
  override defaultPort = 4848;
  override sleepAfter = "1h";
}

// The local runtime looks the container class up under the binding's name.
export { ZeroCache as ZERO_CACHE };

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);
    // Local sign-in. The browser has no session until it hits this. Open
    // /dev/login?as=alice (or bob).
    if (url.pathname === "/dev/login") {
      const userID = url.searchParams.get("as") ?? "alice";
      const session = await signSession(env, userID);
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `session=${session}; Path=/; HttpOnly; SameSite=Lax`,
        },
      });
    }
    return (await relay.handle(request, env, ctx)) ?? new Response("Not found", { status: 404 });
  },
};
