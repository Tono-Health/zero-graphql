import { z } from "zod";
import { app } from "./app.ts";
import { canSeeList } from "./permissions.ts";

export const router = app.router({
  lists: {
    mine: app.query
      .output(z.object({ id: z.string(), name: z.string() }))
      .handler(({ zql, user }) => zql.list.where(canSeeList(user)).orderBy("name", "asc")),

    get: app.query.input(z.object({ id: z.string() })).handler(({ zql, input, user }) =>
      zql.list
        .where("id", input.id)
        .where(canSeeList(user))
        .related("todos", (todos) => todos.orderBy("createdAt", "asc"))
        .one(),
    ),

    share: app.mutation
      .input(z.object({ listID: z.string(), userID: z.string() }))
      .errors({ NOT_FOUND: { message: "List not found" } })
      .handler(async ({ tx, zql, input, user, errors }) => {
        const list = await tx.run(
          zql.list.where("id", input.listID).where("ownerID", user.userID).one(),
        );
        if (!list) throw errors.NOT_FOUND();
        await tx.mutate.listMember.insert({ listID: input.listID, userID: input.userID });
      }),
  },

  todos: {
    add: app.mutation
      .input(z.object({ id: z.string(), listID: z.string(), title: z.string().min(1) }))
      .errors({ NOT_FOUND: { message: "List not found" } })
      .handler(async ({ tx, zql, input, user, errors }) => {
        const list = await tx.run(zql.list.where("id", input.listID).where(canSeeList(user)).one());
        if (!list) throw errors.NOT_FOUND();
        await tx.mutate.todo.insert({ ...input, done: false, createdAt: Date.now() });
      }),

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
        await tx.mutate.todo.update({ id: input.id, done: input.done });
      }),
  },
});

export type Router = typeof router;
