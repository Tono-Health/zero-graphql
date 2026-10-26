import type { Live, QueryStatus } from "../../procedure.ts";
import type { WireError, WireStatus } from "../protocol.ts";
import type { CompiledProcedure } from "../compile.ts";
import { validateSync } from "../standard.ts";
import { fromApplicationError, internal } from "../wire-errors.ts";
import type { ViewLike } from "./contracts.ts";

interface Snapshot {
  readonly data: unknown;
  readonly status: WireStatus;
  readonly rowIDs: readonly string[];
}

type ViewEvent = { readonly snapshot: Snapshot } | { readonly error: WireError };

/** One Zero view shared by every subscriber to the same path and input. */
export class SharedView {
  #latest: ViewEvent | undefined;
  #pending: { data: unknown; type: string; error?: unknown } | undefined;
  readonly #listeners = new Set<(event: ViewEvent) => void>();
  readonly #remove: () => void;

  constructor(
    readonly view: ViewLike,
    readonly procedure: CompiledProcedure,
    readonly primaryKey: readonly string[],
  ) {
    this.#remove = view.addListener((data, type, error) => {
      const scheduled = this.#pending !== undefined;
      this.#pending = { data, type, error };
      // A replication batch can fire many updates in a row. Send the last one.
      if (!scheduled) queueMicrotask(() => this.#flush());
    });
  }

  listen(listener: (event: ViewEvent) => void): () => void {
    this.#listeners.add(listener);
    if (this.#latest) listener(this.#latest);
    return () => this.#listeners.delete(listener);
  }

  destroy(): void {
    this.#remove();
    this.view.destroy();
  }

  #flush(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (!pending) return;
    this.#latest = this.#toEvent(pending);
    for (const listener of this.#listeners) listener(this.#latest);
  }

  #toEvent({ data, type, error }: { data: unknown; type: string; error?: unknown }): ViewEvent {
    if (type === "error") {
      const e = error as { error?: string; message?: string; details?: unknown } | undefined;
      return {
        error: e?.error === "app" ? fromApplicationError(e.message, e.details) : internal(),
      };
    }
    try {
      return {
        snapshot: {
          data: project(this.procedure, data),
          status: type === "complete" ? "complete" : "unknown",
          rowIDs: rowIDs(data, this.primaryKey),
        },
      };
    } catch (cause) {
      console.error(`zero-relay: ${this.procedure.path} output didn't match its schema`, cause);
      return { error: internal() };
    }
  }
}

/** Applies `.output()` to each row. Without it, rows go out as Zero returns them. */
function project(procedure: CompiledProcedure, data: unknown): unknown {
  const output = procedure.def.output;
  if (data === undefined || data === null) return null;
  if (!output) return data;
  return Array.isArray(data)
    ? data.map((row) => validateSync(output, row))
    : validateSync(output, data);
}

function rowIDs(data: unknown, primaryKey: readonly string[]): string[] {
  const rows = Array.isArray(data) ? data : data == null ? [] : [data];
  return rows.map((row: Record<string, unknown>) =>
    primaryKey.map((column) => String(row[column])).join("/"),
  );
}

export class LivePipeline implements Live<unknown> {
  constructor(readonly steps: readonly ((data: unknown, status: QueryStatus) => unknown)[] = []) {}
  map<U>(fn: (data: unknown) => U): Live<U> {
    return new LivePipeline([...this.steps, (data) => fn(data)]) as Live<U>;
  }
  tap(fn: (data: unknown, status: QueryStatus) => void): Live<unknown> {
    return new LivePipeline([
      ...this.steps,
      (data, status) => {
        fn(data, status);
        return data;
      },
    ]);
  }
  apply(data: unknown, status: QueryStatus): unknown {
    return this.steps.reduce((value, step) => step(value, status), data);
  }
}
