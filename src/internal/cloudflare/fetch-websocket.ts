// Zero opens its connection with `new globalThis.WebSocket(url, protocols)`. Workers can't open a
// WebSocket to a service binding or Durable Object stub that way, only `fetch()` a request with
// `Upgrade: websocket`. This shim gives Zero the subset of the WebSocket API it uses (send, close,
// binaryType, url, and open/message/close events) on top of such a fetch.
//
// `globalThis.WebSocket` is shared by every Durable Object in the isolate, but a stub belongs to
// the object that created it. So each relay registers a factory under its own hostname, and the
// shim calls it at connect time, inside the relay that's connecting. Other URLs get the native
// class.

type Fetch = (request: Request) => Promise<Response>;

const SUFFIX = ".zero-relay.internal";
const factories = new Map<string, () => Fetch>();
let installed = false;

/** Registers a relay's stub factory and returns the URL its Zero client should use as `cacheURL`. */
export function registerCacheFetcher(factory: () => Fetch): string {
  install();
  const host = `r${crypto.randomUUID().replaceAll("-", "")}${SUFFIX}`;
  factories.set(host, factory);
  return `http://${host}`;
}

function install(): void {
  if (installed) return;
  installed = true;
  const Native = globalThis.WebSocket;
  const Shim = fetchWebSocket((url) => {
    const factory = factories.get(new URL(url).host);
    if (!factory) throw new Error(`zero-relay: no relay registered for ${url}`);
    return factory();
  });
  globalThis.WebSocket = new Proxy(Native, {
    construct(target, args: [string | URL, (string | string[])?]) {
      return new URL(String(args[0])).host.endsWith(SUFFIX)
        ? new Shim(...args)
        : Reflect.construct(target, args);
    },
  });
}

export function fetchWebSocket(fetcherFor: (url: string) => Fetch): typeof WebSocket {
  class FetchWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly url: string;
    binaryType: BinaryType = "blob";
    readyState = FetchWebSocket.CONNECTING;
    #socket: WebSocket | undefined;
    #closeRequested: { code?: number; reason?: string } | undefined;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      this.url = String(url);
      void this.#connect(protocols);
    }

    async #connect(protocols: string | string[] | undefined): Promise<void> {
      const headers = new Headers({ Upgrade: "websocket" });
      if (protocols !== undefined)
        headers.set("Sec-WebSocket-Protocol", [protocols].flat().join(", "));
      const httpURL = this.url.replace(/^ws/, "http");
      let socket: WebSocket | null;
      try {
        const response = await fetcherFor(this.url)(new Request(httpURL, { headers }));
        socket = (response as Response & { webSocket?: WebSocket | null }).webSocket ?? null;
      } catch (error) {
        console.error("zero-relay: zero-cache upgrade failed", error);
        socket = null;
      }
      if (!socket) {
        this.#finish(1006, "upgrade failed", false);
        return;
      }
      (socket as WebSocket & { accept(): void }).accept();
      this.#socket = socket;
      // Binary frames from a stub arrive as Blobs, but Zero sends sync data as binary and only
      // accepts ArrayBuffers. Reading a Blob is async, so frames go through a chain to keep their
      // order, and close waits behind them.
      let frames = Promise.resolve();
      const convert = async (data: unknown): Promise<unknown> =>
        data instanceof Blob && this.binaryType === "arraybuffer" ? data.arrayBuffer() : data;
      socket.addEventListener("message", (event) => {
        frames = frames.then(async () => {
          this.dispatchEvent(new MessageEvent("message", { data: await convert(event.data) }));
        });
      });
      socket.addEventListener("close", (event) => {
        frames = frames.then(() => this.#finish(event.code, event.reason, event.wasClean));
      });
      socket.addEventListener("error", () => this.dispatchEvent(new Event("error")));
      if (this.#closeRequested) {
        socket.close(this.#closeRequested.code, this.#closeRequested.reason);
        return;
      }
      this.readyState = FetchWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    }

    send(data: string | ArrayBuffer | ArrayBufferView): void {
      if (!this.#socket || this.readyState !== FetchWebSocket.OPEN)
        throw new Error("WebSocket is not open");
      this.#socket.send(data as string);
    }

    close(code?: number, reason?: string): void {
      if (this.readyState >= FetchWebSocket.CLOSING) return;
      this.readyState = FetchWebSocket.CLOSING;
      if (this.#socket) this.#socket.close(code, reason);
      else this.#closeRequested = { code, reason };
    }

    #finish(code: number, reason: string, wasClean: boolean): void {
      if (this.readyState === FetchWebSocket.CLOSED) return;
      this.readyState = FetchWebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
    }
  }
  return FetchWebSocket as unknown as typeof WebSocket;
}
