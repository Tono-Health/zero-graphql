import { zeroPostgresJS } from "@rocicorp/zero/server/adapters/postgresjs";
import { cloudflare, type ExecutionContextLike } from "zero-relay/cloudflare";
import { app } from "./app.ts";
import { databaseURL, type Env } from "./env.ts";
import { router } from "./router.ts";
import { schema } from "./schema.ts";

/** On a real Worker, `wrangler types` generates this from the Wrangler config. */
interface WorkerEnv extends Env {
  readonly ZERO_CACHE_URL: string;
  readonly ZERO_RELAY_SECRET: string;
  readonly ADMIN_TOKEN: string;
  readonly RELAY: unknown;
}

const relay = cloudflare(app, {
  router,
  database: (env: WorkerEnv) => zeroPostgresJS(schema, databaseURL(env)),
});

export const Relay = relay.DurableObject;

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);
    // For admin tools and identity-provider webhooks: apply a change to someone's access now.
    if (url.pathname === "/admin/invalidate" && request.method === "POST") {
      if (request.headers.get("Authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      await relay.invalidate(env, { key: url.searchParams.get("user") ?? "" });
      return new Response(null, { status: 204 });
    }
    return (await relay.handle(request, env, ctx)) ?? new Response("Not found", { status: 404 });
  },
};
