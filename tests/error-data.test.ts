import { ApplicationError } from "@rocicorp/zero";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createApp } from "../src/app.ts";
import { RelayError, type ErrorDef } from "../src/errors.ts";
import { compileRouter, runMutator } from "../src/internal/compile.ts";
import { fromApplicationError } from "../src/internal/wire-errors.ts";
import { schema } from "../examples/todo/schema.ts";

const app = createApp<{ user: { userID: string } }>()({
  schema,
  authenticate: () => null,
  partition: {
    key: ({ user }) => user.userID,
    authorize: () => true,
    scope: ({ key }) => ({ userID: key }),
  },
});
const user = { userID: "alice" };

async function fail(
  data: unknown,
  definition: ErrorDef = {},
  code = "CONFLICT",
  constructor = false,
) {
  const router = app.router({
    save: app.mutation.errors({ CONFLICT: definition }).handler(async ({ errors }) => {
      if (constructor) throw errors.CONFLICT(data as never);
      throw new RelayError(code, { message: "Public conflict", data });
    }),
  });
  const compiled = compileRouter(app, router);
  const error = await runMutator(
    compiled,
    "save",
    { location: "server" },
    { actor: user },
    {
      site: "server",
      relay: "main",
      key: "alice",
      env: undefined,
      user,
      scope: user,
    },
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ApplicationError);
  const { message, details } = error as ApplicationError;
  // Include the actual JSON hop; omission and null must remain distinct.
  return fromApplicationError(message, JSON.parse(JSON.stringify(details)));
}

test("declared data is validated and extra fields are stripped before leaving the server", async () => {
  expect(
    await fail({ version: 2, secret: "private" }, { data: z.object({ version: z.number() }) }),
  ).toEqual({
    code: "CONFLICT",
    message: "Public conflict",
    data: { version: 2 },
  });
});

test("throw errors.CODE(data) supports async transformations without an await at the call site", async () => {
  const data = z
    .object({ version: z.string() })
    .transform(async ({ version }) => ({ version: Number(version) }));
  expect(
    await fail(
      { version: "2", secret: "private" },
      { message: "Conflict", data },
      "CONFLICT",
      true,
    ),
  ).toEqual({
    code: "CONFLICT",
    message: "Conflict",
    data: { version: 2 },
  });
});

test("invalid declared error data becomes a generic INTERNAL error", async () => {
  expect(await fail({ version: "private" }, { data: z.object({ version: z.number() }) })).toEqual({
    code: "INTERNAL",
    message: "Internal error",
  });
});

test("exceptions and rejected promises from validators cannot expose their private messages", async () => {
  const data: StandardSchemaV1 = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: async () => {
        throw new Error("private");
      },
    },
  };
  expect(await fail("private", { data: data as ErrorDef["data"] })).toEqual({
    code: "INTERNAL",
    message: "Internal error",
  });
});

test("errors with no data schema cannot carry accidental data, and undeclared codes are hidden", async () => {
  expect(await fail({ secret: "private" })).toEqual({
    code: "CONFLICT",
    message: "Public conflict",
  });
  expect(await fail({ secret: "private" }, {}, "PRIVATE_DATABASE_ERROR")).toEqual({
    code: "INTERNAL",
    message: "Internal error",
  });
});

test("null and absent data preserve the schema's output", async () => {
  expect(await fail(null, { data: z.null() })).toHaveProperty("data", null);
  expect(await fail(undefined, { data: z.string().optional() })).not.toHaveProperty("data");
});

test.each([BigInt(1), NaN, Infinity, new Date(), () => "private", [undefined]])(
  "non-JSON schema output %s is hidden",
  async (value) => {
    expect(await fail(value, { data: z.any() })).toEqual({
      code: "INTERNAL",
      message: "Internal error",
    });
  },
);

test("circular error data is hidden instead of leaving the call unresolved", async () => {
  const data: Record<string, unknown> = {};
  data.self = data;
  expect(await fail(data, { data: z.any() })).toEqual({
    code: "INTERNAL",
    message: "Internal error",
  });
});
