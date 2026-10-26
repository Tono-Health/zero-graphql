// Zero's client store, on a Durable Object's SQLite database. The replica is one row per
// entry in Zero's key-value map, not the app's tables and not one blob for the whole file.
// Named stores share the database and not their keys. Zero's `Read` and `Write` interfaces
// are experimental and this is pinned to the 1.11.3 shape.

import { StorageFailureError, type ReadonlyJSONValue } from "@rocicorp/zero";

/** Workers Paid: a SQLite row, string, or blob is at most 2 MB. */
const MAX_ROW_BYTES = 2 * 1024 * 1024;
/** Three bindings per put, and a statement may bind at most 100 parameters. */
const PUT_BATCH = 32;
const DELETE_BATCH = 32;

const encoder = new TextEncoder();

export type SqlBinding = string | number | null | ArrayBuffer;

export interface SqlCursorLike {
  toArray(): ReadonlyArray<Record<string, SqlBinding>>;
}

/** The slice of Durable Object SQL this store uses. */
export interface SqlStorageLike {
  exec(query: string, ...bindings: SqlBinding[]): SqlCursorLike;
}

export interface DurableObjectSqlite {
  readonly sql: SqlStorageLike;
  transactionSync<T>(closure: () => T): T;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS zero_relay_kv (
  store TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (store, key)
)`;

export function ensureReplicaTable(storage: DurableObjectSqlite): void {
  storage.sql.exec(SCHEMA);
}

/** Deletes every store in this object's replica. Reads and deletes still work when the file is full. */
export function wipeReplica(storage: DurableObjectSqlite): void {
  ensureReplicaTable(storage);
  storage.transactionSync(() => {
    storage.sql.exec("DELETE FROM zero_relay_kv");
  });
}

export function sqliteStoreProvider(storage: DurableObjectSqlite): {
  create: (name: string) => SqliteStore;
  drop: (name: string) => Promise<void>;
} {
  ensureReplicaTable(storage);
  return {
    create: (name) => new SqliteStore(storage, name),
    drop: async (name) => {
      ensureReplicaTable(storage);
      storage.transactionSync(() => {
        storage.sql.exec("DELETE FROM zero_relay_kv WHERE store = ?", name);
      });
    },
  };
}

class Lock {
  #held = false;
  readonly #waiters: (() => void)[] = [];

  async acquire(): Promise<void> {
    if (!this.#held) {
      this.#held = true;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#held = false;
  }
}

class SqliteStore {
  readonly #storage: DurableObjectSqlite;
  readonly #name: string;
  readonly #lock = new Lock();
  #closed = false;

  constructor(storage: DurableObjectSqlite, name: string) {
    this.#storage = storage;
    this.#name = name;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async read(): Promise<Read> {
    this.#assertOpen();
    await this.#lock.acquire();
    return new Read(this.#storage, this.#name, () => this.#lock.release());
  }

  async write(): Promise<Write> {
    this.#assertOpen();
    await this.#lock.acquire();
    return new Write(this.#storage, this.#name, () => this.#lock.release());
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("zero-relay: store is closed");
  }
}

class Read {
  #closed = false;

  constructor(
    readonly storage: DurableObjectSqlite,
    readonly store: string,
    readonly releaseLock: () => void,
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  has(key: string): Promise<boolean> {
    this.#assertOpen();
    const rows = this.storage.sql
      .exec(
        "SELECT 1 AS hit FROM zero_relay_kv WHERE store = ? AND key = ? LIMIT 1",
        this.store,
        key,
      )
      .toArray();
    return Promise.resolve(rows.length > 0);
  }

  get(key: string): Promise<ReadonlyJSONValue | undefined> {
    this.#assertOpen();
    const rows = this.storage.sql
      .exec("SELECT value FROM zero_relay_kv WHERE store = ? AND key = ? LIMIT 1", this.store, key)
      .toArray();
    const raw = rows[0]?.value;
    if (typeof raw !== "string") return Promise.resolve(undefined);
    return Promise.resolve(freeze(JSON.parse(raw) as ReadonlyJSONValue));
  }

  release(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.releaseLock();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("zero-relay: transaction is closed");
  }
}

const removed = Symbol("removed");

class Write extends Read {
  readonly #pending = new Map<string, ReadonlyJSONValue | typeof removed>();
  #committed = false;

  constructor(storage: DurableObjectSqlite, store: string, releaseLock: () => void) {
    super(storage, store, releaseLock);
  }

  override has(key: string): Promise<boolean> {
    const pending = this.#pending.get(key);
    if (pending === removed) return Promise.resolve(false);
    if (pending !== undefined) return Promise.resolve(true);
    return super.has(key);
  }

  override get(key: string): Promise<ReadonlyJSONValue | undefined> {
    const pending = this.#pending.get(key);
    if (pending === removed) return Promise.resolve(undefined);
    if (pending !== undefined) return Promise.resolve(pending);
    return super.get(key);
  }

  put(key: string, value: ReadonlyJSONValue): Promise<void> {
    if (this.closed) return Promise.reject(new Error("zero-relay: transaction is closed"));
    this.#pending.set(key, freeze(value));
    return Promise.resolve();
  }

  del(key: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("zero-relay: transaction is closed"));
    this.#pending.set(key, removed);
    return Promise.resolve();
  }

  async commit(): Promise<void> {
    if (this.closed) throw new Error("zero-relay: transaction is closed");
    if (this.#committed) throw new Error("zero-relay: transaction is already committed");
    const puts: [string, string][] = [];
    const deletes: string[] = [];
    for (const [key, value] of this.#pending) {
      if (value === removed) deletes.push(key);
      else puts.push([key, JSON.stringify(value)]);
    }
    for (const [key, json] of puts) assertRowFits(this.store, key, json);
    try {
      this.storage.transactionSync(() => {
        for (let i = 0; i < puts.length; i += PUT_BATCH) {
          const batch = puts.slice(i, i + PUT_BATCH);
          const bindings: SqlBinding[] = [];
          for (const [key, json] of batch) bindings.push(this.store, key, json);
          this.storage.sql.exec(insertSql(batch.length), ...bindings);
        }
        for (let i = 0; i < deletes.length; i += DELETE_BATCH) {
          const batch = deletes.slice(i, i + DELETE_BATCH);
          this.storage.sql.exec(
            `DELETE FROM zero_relay_kv WHERE store = ? AND key IN (${placeholders(batch.length)})`,
            this.store,
            ...batch,
          );
        }
      });
    } catch (error) {
      rethrowStorage(error);
    }
    this.#pending.clear();
    this.#committed = true;
  }
}

function insertSql(rows: number): string {
  const values = Array.from({ length: rows }, () => "(?,?,?)").join(",");
  return `INSERT OR REPLACE INTO zero_relay_kv (store, key, value) VALUES ${values}`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function assertRowFits(store: string, key: string, json: string): void {
  const bytes =
    encoder.encode(store).length + encoder.encode(key).length + encoder.encode(json).length;
  if (bytes <= MAX_ROW_BYTES) return;
  throw new StorageFailureError(
    "io-error",
    `zero-relay: store entry is ${bytes} bytes, over the 2MB Durable Object row limit`,
  );
}

function rethrowStorage(error: unknown): never {
  if (error instanceof StorageFailureError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/SQLITE_FULL|disk is full/i.test(message)) {
    throw new StorageFailureError("full", message, { cause: error });
  }
  if (/too big|SQLITE_TOOBIG|string or blob too big/i.test(message)) {
    throw new StorageFailureError("io-error", message, { cause: error });
  }
  throw error instanceof Error ? error : new Error(message);
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freeze(item);
  } else {
    for (const item of Object.values(value)) freeze(item);
  }
  return Object.freeze(value);
}
