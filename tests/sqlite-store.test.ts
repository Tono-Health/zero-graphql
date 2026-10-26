import { StorageFailureError } from "@rocicorp/zero";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { createApp } from "../src/app.ts";
import { cloudflare } from "../src/cloudflare.ts";
import {
  sqliteStoreProvider,
  type DurableObjectSqlite,
  type SqlBinding,
  type SqlCursorLike,
} from "../src/internal/cloudflare/sqlite-store.ts";
import { schema } from "../examples/todo/schema.ts";

function nodeSqlite(): DurableObjectSqlite {
  const db = new DatabaseSync(":memory:");
  return {
    sql: {
      exec(query: string, ...bindings: SqlBinding[]): SqlCursorLike {
        if (bindings.length === 0 && !/^\s*select/i.test(query)) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const statement = db.prepare(query);
        const params = bindings as never[];
        if (/^\s*select/i.test(query)) {
          const rows = statement.all(...params) as Record<string, SqlBinding>[];
          return { toArray: () => rows };
        }
        statement.run(...params);
        return { toArray: () => [] };
      },
    },
    transactionSync<T>(closure: () => T): T {
      db.exec("BEGIN");
      try {
        const result = closure();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

test("a committed entry round-trips, and an uncommitted one does not", async () => {
  const store = sqliteStoreProvider(nodeSqlite()).create("replica");
  const write = await store.write();
  await write.put("a", { n: 1, tags: ["x"] });
  expect(await write.get("a")).toEqual({ n: 1, tags: ["x"] });
  write.release();

  const missed = await store.read();
  expect(await missed.get("a")).toBeUndefined();
  missed.release();

  const again = await store.write();
  await again.put("a", { n: 1, tags: ["x"] });
  await again.del("b");
  await again.commit();
  again.release();

  const read = await store.read();
  expect(await read.get("a")).toEqual({ n: 1, tags: ["x"] });
  expect(await read.has("b")).toBe(false);
  read.release();
});

test("named stores do not share keys, and drop removes one of them", async () => {
  const provider = sqliteStoreProvider(nodeSqlite());
  const first = provider.create("one");
  const second = provider.create("two");
  const left = await first.write();
  await left.put("k", "left");
  await left.commit();
  left.release();
  const right = await second.write();
  await right.put("k", "right");
  await right.commit();
  right.release();

  await provider.drop("one");
  const readLeft = await first.read();
  const readRight = await second.read();
  expect(await readLeft.get("k")).toBeUndefined();
  expect(await readRight.get("k")).toBe("right");
  readLeft.release();
  readRight.release();
});

test("a delete in a commit removes the entry", async () => {
  const store = sqliteStoreProvider(nodeSqlite()).create("replica");
  const write = await store.write();
  await write.put("a", 1);
  await write.commit();
  write.release();
  const remove = await store.write();
  await remove.del("a");
  await remove.commit();
  remove.release();
  const read = await store.read();
  expect(await read.has("a")).toBe(false);
  read.release();
});

test("an entry over 2MB fails before it is written", async () => {
  const store = sqliteStoreProvider(nodeSqlite()).create("replica");
  const write = await store.write();
  await write.put("a", "x".repeat(2 * 1024 * 1024));
  await expect(write.commit()).rejects.toBeInstanceOf(StorageFailureError);
  write.release();
  const read = await store.read();
  expect(await read.get("a")).toBeUndefined();
  read.release();
});

test("a full database is Zero's storage-full failure", async () => {
  const storage = nodeSqlite();
  const provider = sqliteStoreProvider(storage);
  storage.sql.exec = () => {
    throw new Error("database or disk is full: SQLITE_FULL");
  };
  const write = await provider.create("replica").write();
  await write.put("a", 1);
  await expect(write.commit()).rejects.toMatchObject({ kind: "full" });
  write.release();
});

test("the retention alarm deletes an idle replica", async () => {
  const storage = {
    ...nodeSqlite(),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
  };
  const app = createApp<{ user: { userID: string } }>()({
    schema,
    authenticate: () => null,
    partition: {
      key: ({ user }) => user.userID,
      authorize: () => true,
      scope: ({ key }) => ({ userID: key }),
      user: ({ scope }) => scope,
    },
  });
  const relay = cloudflare(app, {
    router: app.router({}),
    database: () => {
      throw new Error("unused");
    },
    secret: () => "secret",
    storage: { sqlite: { retainFor: 60_000 } },
  });
  const object = new relay.DurableObject(
    {
      id: { toString: () => "relay" },
      acceptWebSocket: () => undefined,
      getWebSockets: () => [],
      storage,
    },
    {},
  );

  const store = sqliteStoreProvider(storage).create("replica");
  const write = await store.write();
  await write.put("a", 1);
  await write.commit();
  write.release();

  // A freshly constructed object is idle, which is also how an alarm wakes one.
  await object.alarm();
  const read = await store.read();
  expect(await read.get("a")).toBeUndefined();
  read.release();
});
