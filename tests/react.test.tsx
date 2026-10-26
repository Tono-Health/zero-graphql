// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { createClient, type QueryRef, type RelayClient } from "../src/client.ts";
import { RelayError } from "../src/errors.ts";
import { CloseCode } from "../src/internal/protocol.ts";
import { useMutation, useQuery } from "../src/react.ts";
import type { MutationProcedure, QueryProcedure } from "../src/procedure.ts";
import type { Router } from "../examples/todo/router.ts";
import { FakeWebSocket } from "./helpers/fake-websocket.ts";

let container: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof createClient<Router>>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.instances = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api = createClient<Router>({ url: "https://app.example.com/zero/live" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  api.$close();
  container.remove();
  vi.unstubAllGlobals();
});

function Lists({ query = api.lists.mine }: { query?: RelayClient<Router>["lists"]["mine"] }) {
  const [lists, { status, error }] = useQuery(query);
  return (
    <output data-status={status} data-error={error?.code}>
      {lists?.map((list) => list.name).join(", ") ?? "No data"}
    </output>
  );
}

test.each([
  "revoked",
  "session-expired",
  "revoked-code",
  "session-expired-code",
  "logout",
  "forbidden",
] as const)("%s removes rendered query data", async (reason) => {
  await act(async () => root.render(<Lists />));
  const socket = FakeWebSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive({
      t: "data",
      id: "s1",
      type: "complete",
      data: [{ id: "l1", name: "Private list" }],
    });
  });
  expect(container.textContent).toBe("Private list");

  await act(async () => {
    if (reason === "logout") api.$close();
    else if (reason === "forbidden")
      socket.receive({ t: "error", id: "s1", error: { code: "FORBIDDEN", message: "Forbidden" } });
    else if (reason === "revoked-code") socket.drop(CloseCode.revoked);
    else if (reason === "session-expired-code") socket.drop(CloseCode.sessionExpired);
    else socket.receive({ t: "close", reason });
  });

  expect(container.textContent).toBe("No data");
  expect(container.querySelector("output")?.dataset.status).toBe("error");
  expect(container.querySelector("output")?.dataset.error).toBe(
    reason === "logout" ? "DISCONNECTED" : "FORBIDDEN",
  );
  await act(async () => {
    socket.receive({
      t: "data",
      id: "s1",
      type: "complete",
      data: [{ id: "l1", name: "Stale list" }],
    });
  });
  expect(container.textContent).toBe("No data");
});

test("a query ref that reports only an error still clears the hook's snapshot", async () => {
  let fail: ((error: RelayError) => void) | undefined;
  const query: QueryRef<undefined, { id: string; name: string }[]> = {
    "~kind": "query-ref",
    path: "lists.mine",
    subscribe: (_input, listener, onError) => {
      listener({ data: [{ id: "l1", name: "Private list" }], status: "complete" });
      fail = onError;
      return () => {};
    },
  };
  await act(async () => root.render(<Lists query={query} />));
  expect(container.textContent).toBe("Private list");
  await act(async () => fail!(new RelayError("FORBIDDEN")));
  expect(container.textContent).toBe("No data");
  expect(container.querySelector("output")?.dataset.error).toBe("FORBIDDEN");
});

test("useQuery resubscribes between omitted and null inputs without conflating them", async () => {
  const local = createClient<{ search: QueryProcedure<string | null | undefined, string[]> }>();
  function Search({ input }: { input?: null }) {
    const [data] = useQuery(local.search, input);
    return <output>{data?.join(",") ?? "Loading"}</output>;
  }
  await act(async () => root.render(<Search />));
  const socket = FakeWebSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive({ t: "data", id: "s1", type: "complete", data: ["omitted"] });
  });
  expect(container.textContent).toBe("omitted");
  await act(async () => root.render(<Search input={null} />));
  expect(container.textContent).toBe("Loading");
  expect(socket.sent.slice(-2)).toEqual([
    { t: "unsub", id: "s1" },
    { t: "sub", id: "s2", path: "search", input: null },
  ]);
  await act(async () => socket.receive({ t: "data", id: "s2", type: "complete", data: ["null"] }));
  expect(container.textContent).toBe("null");
  await act(async () => root.render(<Search />));
  expect(socket.sent.slice(-2)).toEqual([
    { t: "unsub", id: "s2" },
    { t: "sub", id: "s3", path: "search" },
  ]);
  await act(async () => root.render(<Search />));
  expect(socket.sent.filter(({ t }) => t === "sub")).toHaveLength(3);
  await act(async () => local.$close());
});

test.each([7, null, undefined])(
  "useMutation exposes error data %s and handles pending state without transport code",
  async (data) => {
    const schema = z.number().nullable().optional();
    const local = createClient<{
      save: MutationProcedure<undefined, void, { CONFLICT: { data: typeof schema } }>;
    }>();
    function Save() {
      const { mutate, pending, error } = useMutation(local.save);
      return (
        <>
          <button disabled={pending} onClick={() => mutate()}>
            Save
          </button>
          <output>{error ? `${error.message}: ${String(error.data)}` : "Ready"}</output>
        </>
      );
    }
    await act(async () => root.render(<Save />));
    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.disabled).toBe(true);
    const socket = FakeWebSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive({
        t: "result",
        id: socket.sent[0]!.id,
        ok: false,
        error: { code: "CONFLICT", message: "Conflict", data },
      });
    });
    expect(button.disabled).toBe(false);
    expect(container.querySelector("output")?.textContent).toBe(`Conflict: ${String(data)}`);
    local.$close();
  },
);
