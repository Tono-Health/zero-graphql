# zero-relay

Typed endpoints and live React hooks, powered by server-side [Zero](https://zero.rocicorp.dev).

Define queries, mutations, input schemas, and business errors. Import your router's type into the browser and call `useQuery` and `useMutation`. The framework manages live subscriptions, connections, error serialization, and cleanup. Synced data stays on the server; the browser holds only the current query results in memory.

## Define endpoints

Configure your schema, authentication, and access scope once in [`app.ts`](examples/todo/app.ts). Each feature can define its own router; the root router composes them:

```ts
// src/routers/todos.ts
import { z } from "zod";
import { app } from "../app.ts";
import { canSeeList } from "../permissions.ts";

export const todosRouter = app.router({
  toggle: app.mutation
    .input(z.object({ id: z.string(), done: z.boolean() }))
    .errors({ NOT_FOUND: { message: "Todo not found" } })
    .handler(async ({ tx, zql, input, user, errors }) => {
      const todo = await tx.run(
        zql.todo
          .where("id", input.id)
          .whereExists("list", (list) => list.where(canSeeList(user)))
          .one(),
      );
      if (!todo) throw errors.NOT_FOUND();
      await tx.mutate.todo.update(input);
    }),
});
```

```ts
// src/routers/index.ts
import { app } from "../app.ts";
import { listsRouter } from "./lists.ts";
import { todosRouter } from "./todos.ts";

export const router = app.router({ lists: listsRouter, todos: todosRouter });
export type Router = typeof router;
```

The `listsRouter` module follows the same pattern. Nest routers as objects to produce paths such as `lists.get` and `todos.toggle`; the browser infers both from `Router`. See the [complete example](examples/todo/routers/index.ts). Composition needs no merge helper or registration step. Unlike oRPC, `app.router()` currently does not add router-wide middleware or lazy routes; attach guards and middleware to procedures.

Optional inputs and schema defaults work normally: `.input(z.object({ done: z.boolean() }).optional())` lets callers omit the argument. A declared error can also include a `data` schema; the framework validates and transforms its data before sending it, and the client infers the schema's output type.

## Use them in React

Create the client once for the signed-in session:

```ts
// web/api.ts
import { createClient } from "zero-relay/client";
import type { Router } from "../routers/index.ts";

export const api = createClient<Router>();
```

Components work with typed data, loading state, and errors:

```tsx
import { useQuery, useMutation } from "zero-relay/react";
import { api } from "./api.ts";

export function Todos({ listID }: { listID: string }) {
  const [list, { status, error }] = useQuery(api.lists.get, { id: listID });
  const { mutate: toggle, pending, error: saveError } = useMutation(api.todos.toggle);

  if (error) return <p role="alert">{error.message}</p>;
  if (!list) return <p>{status === "complete" ? "List not found" : "Loading…"}</p>;

  return (
    <section>
      <h1>{list.name}</h1>
      {saveError && <p role="alert">{saveError.message}</p>}
      {list.todos.map((todo) => (
        <button
          key={todo.id}
          disabled={pending}
          onClick={() => toggle({ id: todo.id, done: !todo.done })}
        >
          {todo.done ? "Undo" : "Complete"}: {todo.title}
        </button>
      ))}
    </section>
  );
}
```

Queries update live after mutations. `mutate(input)` returns `{ data, error }` and updates the hook's `pending` and `error` state. Components can display `error.message` or branch on declared business error codes. Errors whose data fails validation become a generic `INTERNAL` error.

Call `api.$close()` in your logout handler; create a fresh client for the next session. If a mutation's result is lost, its error explains that the write may have committed and current data should be checked before retrying.

## Host the app

**Cloudflare is currently the only recommended hosting platform. For every other host, the planned path is Node.js + Rivet.** The Cloudflare adapter supplies the endpoints and Durable Object implementation, with one Durable Object owning each relay partition. See [hosting](docs/hosting.md) for implementation status and requirements.

Hosting is configured separately in [`worker.ts`](examples/todo/worker.ts). Feature routers and React components stay independent of the adapter. The Node.js + Rivet adapter is next and is not implemented yet.

See [`examples/todo`](examples/todo) for the complete app, [`examples/todo-alchemy`](examples/todo-alchemy) for local infrastructure setup, and [`docs/design.md`](docs/design.md) for internals and advanced configuration.

## Status

Pre-release. The framework core, relay runtime, endpoints, Cloudflare adapter, and browser client are implemented and tested locally. A production deployment is still pending. The current priority is validating the Cloudflare deployment; the Node.js + Rivet adapter for non-Cloudflare hosts is next.

## Development

See the [source map](src/README.md) for module responsibilities and internal boundaries.

```bash
vp install
vp check   # format, lint, and typecheck
vp test    # unit tests
vp pack    # build
```

## Run the examples locally

Both examples use Postgres on your local machine.

**Browser app** (`examples/todo-alchemy`). Alchemy starts Postgres, zero-cache, and the Worker. Then open the app signed in as Alice:

```bash
node_modules/.bin/alchemy dev examples/todo-alchemy/alchemy.run.ts
# http://localhost:8799/dev/login?as=alice
```

Postgres is on port `5444` (`postgres` / `postgres`, database `todo`). `?as=bob` signs in as Bob. The container is `zero-relay-alchemy-pg`; remove it to reseed from `dev/seed.sql`.

**Worker only** (`examples/todo`). Postgres and zero-cache come from Docker Compose, and the Worker from wrangler. This is what the end-to-end script drives. It does not serve the React app.

```bash
docker compose -f examples/todo/dev/docker-compose.yml up -d --wait
node_modules/.bin/wrangler dev -c examples/todo/wrangler.jsonc
node examples/todo/dev/e2e.ts
```
