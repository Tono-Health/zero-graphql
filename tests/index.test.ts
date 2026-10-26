import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import type { QueryRef, RelayClient, SafeResult } from "../src/client.ts";
import type { ErrorConstructors, ErrorUnion, RelayError } from "../src/errors.ts";
import { compileRouter } from "../src/internal/compile.ts";
import { app } from "../examples/todo/app.ts";
import { router, type Router } from "../examples/todo/routers/index.ts";
import { listsRouter } from "../examples/todo/routers/lists.ts";
import { todosRouter } from "../examples/todo/routers/todos.ts";

type Api = RelayClient<Router>;
type Snapshot<R> = R extends QueryRef<any, infer D> ? { data: D } : never;

test("feature routers compose into the root's Zero and client paths", () => {
  expect(router.lists).toBe(listsRouter);
  expect(router.todos).toBe(todosRouter);

  const compiled = compileRouter(app, router);
  expect([...compiled.procedures.keys()]).toEqual([
    "lists.mine",
    "lists.get",
    "lists.share",
    "todos.add",
    "todos.toggle",
  ]);
  expect(compiled.procedures.get("todos.toggle")?.def).toBe(todosRouter.toggle["~def"]);
});

test("procedures record their definition", () => {
  const { mine } = router.lists;
  const { toggle } = router.todos;
  expect(mine["~kind"]).toBe("query");
  expect(mine["~def"].output).toBeDefined();
  expect(toggle["~kind"]).toBe("mutation");
  expect(Object.keys(toggle["~def"].errors)).toEqual(["NOT_FOUND"]);
});

test("browser types come from .output() and .one()", () => {
  type Mine = Snapshot<Api["lists"]["mine"]>["data"];
  expectTypeOf<Mine>().toEqualTypeOf<{ id: string; name: string }[]>();

  type List = Snapshot<Api["lists"]["get"]>["data"];
  expectTypeOf<NonNullable<List>["todos"][number]["done"]>().toEqualTypeOf<boolean>();
  expectTypeOf<undefined>().toExtend<List>();

  type Delivered = Parameters<Parameters<Api["lists"]["mine"]["subscribe"]>[1]>[0];
  expectTypeOf<Delivered["data"]>().toEqualTypeOf<Mine | undefined>();
});

test("mutation callers are typed by input, result, and declared errors", () => {
  type Toggle = Api["todos"]["toggle"];
  expectTypeOf<Parameters<Toggle>>().toEqualTypeOf<[input: { id: string; done: boolean }]>();
  type Result = Awaited<ReturnType<Toggle["safe"]>>;
  expectTypeOf<Result>().toExtend<SafeResult<void, RelayError>>();
  expectTypeOf<NonNullable<Result["error"]>["code"]>().toEqualTypeOf<
    | "NOT_FOUND"
    | "FORBIDDEN"
    | "UNAVAILABLE"
    | "BAD_INPUT"
    | "DISCONNECTED"
    | "OUTCOME_UNKNOWN"
    | "INTERNAL"
  >();
});

test("error constructors accept schema input while clients receive schema output", () => {
  const data = z
    .object({ version: z.string() })
    .transform(({ version }) => ({ version: Number(version) }));
  const defaulted = z.string().default("default");
  type Definitions = {
    CONFLICT: { data: typeof data };
    DEFAULTED: { data: typeof defaulted };
    NOT_FOUND: {};
  };
  type Constructors = ErrorConstructors<Definitions>;
  expectTypeOf<Parameters<Constructors["CONFLICT"]>[0]>().toEqualTypeOf<{ version: string }>();
  expectTypeOf<Extract<ErrorUnion<Definitions>, { code: "CONFLICT" }>["data"]>().toEqualTypeOf<{
    version: number;
  }>();
  expectTypeOf<Parameters<Constructors["DEFAULTED"]>>().toEqualTypeOf<
    [data?: string, options?: { message?: string }]
  >();
  expectTypeOf<
    Extract<ErrorUnion<Definitions>, { code: "DEFAULTED" }>["data"]
  >().toEqualTypeOf<string>();
  expectTypeOf<
    Extract<ErrorUnion<Definitions>, { code: "NOT_FOUND" }>["data"]
  >().toEqualTypeOf<undefined>();
});
