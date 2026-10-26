import { ApplicationError } from "@rocicorp/zero";
import { expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { createApp } from "../src/app.ts";
import {
  compileRouter,
  isDeferred,
  runMutator,
  runQuery,
  type ZeroContext,
} from "../src/internal/compile.ts";
import { fromApplicationError } from "../src/internal/wire-errors.ts";
import { schema } from "../examples/todo/schema.ts";

type User = { readonly userID: string; readonly admin: boolean };

const authorize = vi.fn(({ user, key }: { user: User; key: string }) => user.userID === key);
const app = createApp<{ user: User }>()({
  schema,
  authenticate: () => null,
  partition: {
    key: ({ user }) => user.userID,
    authorize,
    scope: ({ key }) => ({ userID: key, admin: false }),
    user: ({ scope }) => scope,
  },
});

const admin = app.guard(({ user }) => user.admin, { name: "admin" });
const seen: string[] = [];
const tag = app.middleware.query(({ query, path }) => {
  seen.push(path);
  return query;
});

const router = app.router({
  lists: {
    mine: app.query.use(tag).handler(({ zql, user }) => zql.list.where("ownerID", user.userID)),
    all: app.query.use(admin).handler(({ zql }) => zql.list),
    rename: app.mutation
      .input(z.object({ id: z.string(), name: z.string().min(1) }))
      .errors({ NOT_FOUND: { message: "List not found" } })
      .handler(async ({ tx, input, errors, afterCommit }) => {
        if (input.id === "missing") throw errors.NOT_FOUND();
        afterCommit(() => {});
        await tx.mutate.list.update(input);
        return { renamed: input.id };
      }),
  },
});

const compiled = compileRouter(app, router);
const alice: User = { userID: "alice", admin: false };

const context = (site: ZeroContext["site"], extra: Partial<ZeroContext> = {}): ZeroContext => ({
  site,
  relay: "main",
  key: "alice",
  env: undefined,
  scope: alice,
  user: alice,
  ...extra,
});

const fakeTx = (location: "client" | "server") => ({
  location,
  mutate: { list: { update: vi.fn() } },
});

test("procedures are registered under their dotted paths", () => {
  expect([...compiled.procedures.keys()]).toEqual(["lists.mine", "lists.all", "lists.rename"]);
  expect(compileRouter(app, router)).toBe(compiled);
});

test("queries run the handler and site-matched middleware", () => {
  seen.length = 0;
  expect(runQuery(compiled, "lists.mine", undefined, context("server"))).toBeDefined();
  expect(seen).toEqual(["lists.mine"]);
});

test("server query guards fail with an encoded FORBIDDEN", () => {
  const run = () => runQuery(compiled, "lists.all", undefined, context("server"));
  expect(run).toThrow(ApplicationError);
  try {
    run();
  } catch (error) {
    const { message, details } = error as ApplicationError;
    expect(fromApplicationError(message, details)).toEqual({
      code: "FORBIDDEN",
      message: "Forbidden",
      data: { guard: "admin" },
    });
  }
});

test("the relay leaves query guards to the socket check", () => {
  expect(runQuery(compiled, "lists.all", undefined, context("relay"))).toBeDefined();
});

test("mutations validate input, check the actor, and return the handler result", async () => {
  const tx = fakeTx("server");
  const attempt = { afterCommit: [], invalidations: [] };
  const result = await runMutator(
    compiled,
    "lists.rename",
    tx,
    { input: { id: "l1", name: "Groceries" }, actor: alice },
    context("server", { attempt }),
  );
  expect(result).toEqual({ renamed: "l1" });
  expect(tx.mutate.list.update).toHaveBeenCalledWith({ id: "l1", name: "Groceries" });
  expect(attempt.afterCommit).toHaveLength(1);
  expect(authorize).toHaveBeenCalledWith({ user: alice, key: "alice", env: undefined });
});

test("the relay's optimistic run skips authorize and deferred work", async () => {
  authorize.mockClear();
  await runMutator(
    compiled,
    "lists.rename",
    fakeTx("client"),
    { input: { id: "l1", name: "x" }, actor: alice },
    context("relay"),
  );
  expect(authorize).not.toHaveBeenCalled();
});

test.each(["client", "server"] as const)(
  "mutation middleware wraps the handler in registration order at %s",
  async (location) => {
    const site = location === "server" ? "server" : "relay";
    const order: string[] = [];
    const tx = fakeTx(location);
    const outer = app.middleware.mutation(async (args) => {
      expect(args).toMatchObject({
        tx,
        location: site,
        user: alice,
        path: "rename",
        input: "name",
      });
      order.push("outer:before");
      const result = await args.next();
      order.push("outer:after");
      return { result };
    });
    const serverOnly = app.middleware.mutation(
      async ({ next }) => {
        order.push("server:before");
        const result = await next();
        order.push("server:after");
        return result;
      },
      { on: "server" },
    );
    const local = compileRouter(app, {
      rename: app.mutation
        .input(z.string().trim())
        .use(outer)
        .use(serverOnly)
        .handler(async ({ input }) => {
          order.push("handler");
          return input;
        }),
    });

    const result = await runMutator(
      local,
      "rename",
      tx,
      { input: " name ", actor: alice },
      context(site),
    );

    expect(result).toEqual({ result: "name" });
    expect(order).toEqual(
      location === "server"
        ? ["outer:before", "server:before", "handler", "server:after", "outer:after"]
        : ["outer:before", "handler", "outer:after"],
    );
  },
);

test("mutation middleware can short-circuit before a write", async () => {
  const handler = vi.fn(async () => "written");
  const local = compileRouter(app, {
    write: app.mutation.use(app.middleware.mutation(async () => "cached")).handler(handler),
  });

  expect(
    await runMutator(local, "write", fakeTx("server"), { actor: alice }, context("server")),
  ).toBe("cached");
  expect(handler).not.toHaveBeenCalled();
});

test("declared errors in the relay's run defer to the server; others fail fast", async () => {
  const run = (input: unknown) =>
    runMutator(
      compiled,
      "lists.rename",
      fakeTx("client"),
      { input, actor: alice },
      context("relay"),
    );
  expect(isDeferred(await run({ id: "missing", name: "x" }))).toBe(true);
  await expect(run({ id: "l1", name: "" })).rejects.toBeInstanceOf(ApplicationError);
});

const failure = async (args: unknown, site: ZeroContext["site"] = "server") => {
  const error = await runMutator(
    compiled,
    "lists.rename",
    fakeTx("server"),
    args,
    context(site),
  ).catch((e) => e);
  expect(error).toBeInstanceOf(ApplicationError);
  return fromApplicationError(error.message, error.details);
};

test("declared errors, bad input, and foreign actors are encoded", async () => {
  expect(await failure({ input: { id: "missing", name: "x" }, actor: alice })).toEqual({
    code: "NOT_FOUND",
    message: "List not found",
  });
  expect((await failure({ input: { id: "l1", name: "" }, actor: alice })).code).toBe("BAD_INPUT");
  expect((await failure({ input: { id: "l1", name: "x" } })).code).toBe("BAD_INPUT");
  const mallory = { userID: "mallory", admin: false };
  expect((await failure({ input: { id: "l1", name: "x" }, actor: mallory })).code).toBe(
    "FORBIDDEN",
  );
});

test("undeclared errors are hidden from the browser", () => {
  expect(fromApplicationError("secret detail", { other: true })).toEqual({
    code: "INTERNAL",
    message: "Internal error",
  });
});
