import { expect, expectTypeOf, test } from "vite-plus/test";
import { createApp } from "zero-relay";
import { createClient } from "zero-relay/client";
import { z } from "zod";
import { app, type User } from "../examples/todo/app.ts";
import { canSeeList } from "../examples/todo/permissions.ts";
import type { Router } from "../examples/todo/routers/index.ts";
import { schema } from "../examples/todo/schema.ts";

// A partition this library knows nothing about: one relay per list, shared by everyone viewing it.
const listApp = createApp<{ user: User }>()({
  schema,
  authenticate: () => null,
  partition: {
    key: ({ url }) => url.searchParams.get("listID"),
    authorize: () => true,
    scope: ({ key }) => ({ listID: key }),
  },
});

test("partition facts flow into handler types", () => {
  const neverRun = () => {
    // The scope's type comes from the partition's `scope` function.
    listApp.query.handler(({ zql, scope }) => {
      expectTypeOf(scope).toEqualTypeOf<{ listID: string }>();
      return zql.todo.where("listID", scope.listID);
    });

    // Single-user partitions also give query handlers the user.
    app.query.handler(({ zql, user }) => zql.list.where("ownerID", user.userID));
  };
  expect(neverRun).toBeTypeOf("function");
});

test("rejected at compile time", () => {
  // Only the type checker runs these; the bodies never execute.
  const neverRun = () => {
    // Without `partition.user`, the server doesn't know the user, so query handlers don't get one.
    listApp.query.handler(
      // @ts-expect-error `user` is not available to query handlers in shared partitions
      ({ zql, user }) => zql.list.where("ownerID", user.userID),
    );

    // Authentication must return an explicit session deadline with the user.
    createApp<{ user: User }>()({
      ...app.config,
      // @ts-expect-error a bare user omits session expiry
      authenticate: () => ({ userID: "alice", name: "Alice" }),
    });
    createApp<{ user: User }>()({
      ...app.config,
      // @ts-expect-error missing expiry must not silently create a non-expiring session
      authenticate: () => ({ user: { userID: "alice", name: "Alice" } }),
    });

    // `partition.user` must return the app's User.
    createApp<{ user: User }>()({
      schema,
      authenticate: () => null,
      partition: {
        key: ({ url }) => url.searchParams.get("listID"),
        authorize: () => true,
        scope: ({ key }) => ({ listID: key }),
        // @ts-expect-error a list scope isn't a User
        user: ({ scope }) => scope,
      },
    });

    // Partition functions are typed against the app's user.
    createApp<{ user: User }>()({
      schema,
      authenticate: () => null,
      partition: {
        // @ts-expect-error `teamID` isn't a field of User
        key: ({ user }) => user.teamID,
        authorize: () => true,
        scope: ({ key }) => ({ key }),
      },
    });

    // A condition on `list` can't filter another table.
    app.query.handler(({ zql, user }) =>
      // @ts-expect-error `canSeeList` is a condition on `list`, not `todo`
      zql.todo.where(canSeeList(user)),
    );

    // A guard that reads input needs an input of that shape.
    const ownList = app.guard<{ listID: string }>(({ input }) => input.listID !== "");
    app.query
      .input(z.object({ id: z.string() }))
      // @ts-expect-error input has no `listID`
      .use(ownList);

    // Mutation results must be JSON, because Zero sends them back to the relay.
    app.mutation.errors({
      // @ts-expect-error error data must also produce JSON, not a Date
      INVALID: { data: z.date() },
    });
    app.mutation.handler(
      // @ts-expect-error a Date isn't JSON
      async () => new Date(),
    );

    // The browser client is typed from the router.
    const api = createClient<Router>();
    // @ts-expect-error `id` is required
    api.lists.get.subscribe({}, () => {});
    // @ts-expect-error `done` must be a boolean
    void api.todos.toggle({ id: "t1", done: "yes" });
    // @ts-expect-error no such procedure
    void api.todos.delete;

    // Declared error codes narrow; undeclared ones don't exist.
    void api.todos.toggle.safe({ id: "t1", done: true }).then(({ error }) => {
      if (error?.code === "NOT_FOUND") return;
      // @ts-expect-error "CONFLICT" was never declared
      if (error?.code === "CONFLICT") return;
    });
  };
  expect(neverRun).toBeTypeOf("function");
});
