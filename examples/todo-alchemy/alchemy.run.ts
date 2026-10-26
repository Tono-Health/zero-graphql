import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Docker from "@alchemy.run/docker";
import * as Alchemy from "alchemy";
import { localState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { ZeroCache } from "./worker.ts";

/** Must match the `@rocicorp/zero` version the Worker is built with. */
const ZERO_VERSION = "1.11.3";

/** Host port for the local Postgres container. The wrangler example uses 5443. */
const POSTGRES_PORT = 5444;
/** Port `alchemy dev` serves the Worker on. */
const WORKER_PORT = 8799;

// zero-cache runs in a container, so it reaches Postgres through the host.
const DATABASE_URL_FROM_CONTAINER = `postgres://postgres:postgres@host.docker.internal:${POSTGRES_PORT}/todo`;

export const Site = Effect.gen(function* () {
  const { dev } = yield* Alchemy.AlchemyContext;
  if (!dev) {
    return yield* Effect.die(
      new Error(
        "examples/todo-alchemy runs on local Postgres. Start it with `alchemy dev examples/todo-alchemy/alchemy.run.ts`.",
      ),
    );
  }

  yield* Docker.Container("Postgres", {
    name: "zero-relay-alchemy-pg",
    image: "postgres:17",
    start: true,
    environment: {
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "todo",
    },
    // zero-cache follows the database through logical replication.
    command: [
      "postgres",
      "-c",
      "wal_level=logical",
      "-c",
      "max_wal_senders=10",
      "-c",
      "max_replication_slots=5",
    ],
    ports: [{ external: POSTGRES_PORT, internal: 5432 }],
    volumes: [
      {
        hostPath: `${import.meta.dirname}/migrations/0001_init.sql`,
        containerPath: "/docker-entrypoint-initdb.d/01-schema.sql",
        readOnly: true,
      },
      {
        hostPath: `${import.meta.dirname}/dev/seed.sql`,
        containerPath: "/docker-entrypoint-initdb.d/02-seed.sql",
        readOnly: true,
      },
    ],
  });

  // `dev` is what `alchemy dev` actually connects to. Without it, the local Hyperdrive
  // binding requires SSL, and this Postgres container doesn't speak it.
  const origin = {
    scheme: "postgres" as const,
    host: "127.0.0.1",
    port: POSTGRES_PORT,
    database: "todo",
    user: "postgres",
    password: Redacted.make("postgres"),
  };
  const hyperdrive = yield* Cloudflare.Hyperdrive.Connection("todo-hyperdrive", {
    origin,
    dev: { ...origin, sslmode: "disable" },
  });

  const relaySecret = yield* Alchemy.Random("ZeroRelaySecret");
  const adminPassword = yield* Alchemy.Random("ZeroAdminPassword");
  const workerURL = `http://host.docker.internal:${WORKER_PORT}`;

  return yield* Cloudflare.Website.Vite("Todo", {
    rootDir: import.meta.dirname,
    main: "./worker.ts",
    dev: { port: WORKER_PORT, strictPort: true },
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/zero/*", "/dev/*"],
    },
    env: {
      RELAY: Cloudflare.DurableObject("Relay"),
      ZERO_CACHE: Cloudflare.Container<ZeroCache>("ZeroCache", {
        image: `docker.io/rocicorp/zero:${ZERO_VERSION}`,
        instanceType: "standard-1",
        env: {
          ZERO_UPSTREAM_DB: DATABASE_URL_FROM_CONTAINER,
          ZERO_CVR_DB: DATABASE_URL_FROM_CONTAINER,
          ZERO_CHANGE_DB: DATABASE_URL_FROM_CONTAINER,
          // `/tmp` exists in the image. `/data` does not, unless a volume is mounted there.
          ZERO_REPLICA_FILE: "/tmp/replica.db",
          ZERO_ADMIN_PASSWORD: adminPassword.text,
          ZERO_QUERY_URL: `${workerURL}/zero/query`,
          ZERO_MUTATE_URL: `${workerURL}/zero/mutate`,
        },
      }),
      HYPERDRIVE: hyperdrive,
      ZERO_RELAY_SECRET: relaySecret.text,
      SESSION_SECRET: "dev-session-secret",
    },
  });
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Site>;

export default Alchemy.Stack(
  "TodoRelay",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Docker.providers()),
    // Local files under `.alchemy/`, so `alchemy dev` needs no Cloudflare account.
    state: localState(),
  },
  Effect.gen(function* () {
    const site = yield* Site;
    return { url: site.url };
  }),
);
