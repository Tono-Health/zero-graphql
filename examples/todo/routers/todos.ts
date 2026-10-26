import { z } from "zod";
import { app } from "../app.ts";
import { canSeeList } from "../permissions.ts";

export const todosRouter = app.router({
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
});
