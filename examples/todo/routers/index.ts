import { app } from "../app.ts";
import { listsRouter } from "./lists.ts";
import { todosRouter } from "./todos.ts";

export const router = app.router({
  lists: listsRouter,
  todos: todosRouter,
});

export type Router = typeof router;
