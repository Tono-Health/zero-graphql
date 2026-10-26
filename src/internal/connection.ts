import type { ClientOptions, ConnectionStatus, Snapshot } from "../client.ts";
import { RelayError } from "../errors.ts";
import {
  CloseCode,
  PROTOCOL,
  type ClientMessage,
  type ServerMessage,
  type WireError,
} from "./protocol.ts";

interface Subscription {
  readonly path: string;
  readonly input: unknown;
  readonly listener: (snapshot: Snapshot<unknown>) => void;
  readonly onError: ((error: RelayError) => void) | undefined;
}

interface PendingCall {
  readonly message: string;
  sent: boolean;
  readonly resolve: (data: unknown) => void;
  readonly reject: (error: RelayError) => void;
}

const MAX_BACKOFF_MS = 30_000;

export class ClientConnection {
  status: ConnectionStatus = "closed";
  readonly #options: ClientOptions;
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #calls = new Map<string, PendingCall>();
  #socket: WebSocket | undefined;
  #nextID = 0;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  #ended: RelayError | undefined;

  constructor(options: ClientOptions) {
    this.#options = options;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => this.#onVisibilityChange());
    }
  }

  subscribe(
    path: string,
    input: unknown,
    listener: (snapshot: Snapshot<unknown>) => void,
    onError?: (error: RelayError) => void,
  ): () => void {
    if (this.#ended) {
      clearSubscription({ path, input, listener, onError }, "error", this.#ended);
      return () => {};
    }
    const id = `s${++this.#nextID}`;
    this.#subscriptions.set(id, { path, input, listener, onError });
    this.#send({ t: "sub", id, path, input });
    return () => {
      if (this.#subscriptions.delete(id)) this.#send({ t: "unsub", id });
    };
  }

  call(path: string, input: unknown): Promise<unknown> {
    if (this.#ended) return Promise.reject(disconnected());
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      // Serialize before queuing: a serialization failure must not leave a call to send later.
      const message = JSON.stringify({ t: "call", id, path, input } satisfies ClientMessage);
      const call: PendingCall = { message, sent: false, resolve, reject };
      this.#calls.set(id, call);
      try {
        if (this.#socket?.readyState === WebSocket.OPEN) this.#sendCall(this.#socket, id, call);
        else this.#ensureSocket();
      } catch (error) {
        this.#calls.delete(id);
        reject(error);
      }
    });
  }

  close(): void {
    this.#end("closed");
  }

  /** Sends now if the socket is open; otherwise it goes out with everything else on (re)connect. */
  #send(message: Extract<ClientMessage, { t: "sub" | "unsub" }>): void {
    if (this.#ended) return;
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message));
    } else if (message.t !== "unsub") {
      this.#ensureSocket();
    }
  }

  #ensureSocket(): void {
    if (this.#socket || this.#retryTimer || this.status === "hidden" || this.#ended) return;
    this.#setStatus(this.#attempt === 0 ? "connecting" : "reconnecting");
    const socket = new WebSocket(this.#url(), PROTOCOL);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket !== socket || this.#ended) return;
      this.#attempt = 0;
      this.#setStatus("open");
      for (const [id, { path, input }] of this.#subscriptions)
        socket.send(JSON.stringify({ t: "sub", id, path, input } satisfies ClientMessage));
      for (const [id, call] of this.#calls) this.#sendCall(socket, id, call);
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket === socket && !this.#ended) this.#onMessage(event.data);
    });
    socket.addEventListener("close", (event) => this.#onClose(socket, event.code));
  }

  #sendCall(socket: WebSocket, id: string, call: PendingCall): void {
    if (
      this.#socket !== socket ||
      socket.readyState !== WebSocket.OPEN ||
      this.#calls.get(id) !== call ||
      call.sent
    )
      return;
    // Once sending is attempted, the relay may execute the write. Its result cache is neither
    // durable nor permanent, so replaying even the same ID could execute a second mutation.
    call.sent = true;
    try {
      socket.send(call.message);
    } catch {
      this.#calls.delete(id);
      call.reject(outcomeUnknown());
    }
  }

  #failSentCalls(): void {
    for (const [id, call] of this.#calls) {
      if (!call.sent) continue;
      this.#calls.delete(id);
      call.reject(outcomeUnknown());
    }
  }

  #url(): string {
    const base = typeof location === "undefined" ? "http://localhost" : location.href;
    const url = new URL(this.#options.url ?? "/zero/live", base);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    for (const [name, value] of Object.entries(this.#options.params ?? {}))
      url.searchParams.set(name, value);
    return url.toString();
  }

  #onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    const message = JSON.parse(raw) as ServerMessage;
    switch (message.t) {
      case "data":
        this.#subscriptions.get(message.id)?.listener({ data: message.data, status: message.type });
        return;
      case "result": {
        const pending = this.#calls.get(message.id);
        if (!pending) return;
        this.#calls.delete(message.id);
        if (message.ok) pending.resolve(message.data);
        else pending.reject(toRelayError(message.error));
        return;
      }
      case "error": {
        if (message.id === null) {
          console.warn("zero-relay:", message.error.message);
          return;
        }
        const subscription = this.#subscriptions.get(message.id);
        this.#subscriptions.delete(message.id);
        if (subscription) clearSubscription(subscription, "error", toRelayError(message.error));
        return;
      }
      case "close":
        // Honor terminal messages immediately, even if the close frame is lost.
        if (message.reason === "revoked" || message.reason === "session-expired")
          this.#end("revoked");
        return;
    }
  }

  #onClose(socket: WebSocket, code: number): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    if (code === CloseCode.revoked || code === CloseCode.sessionExpired) {
      this.#end("revoked");
      return;
    }
    this.#failSentCalls();
    this.#clearSnapshots();
    if (this.#ended || this.status === "hidden") return;
    if (this.#subscriptions.size === 0 && this.#calls.size === 0) {
      this.#setStatus("closed");
      return;
    }
    // Reconnect with exponential backoff and full jitter. A server-requested `refresh` or
    // `restarting` reconnects at once.
    const immediate = code === CloseCode.refresh || code === CloseCode.restarting;
    const delay = immediate
      ? 0
      : Math.random() * Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.#attempt);
    this.#attempt++;
    this.#setStatus("reconnecting");
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#ensureSocket();
    }, delay);
  }

  #onVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      clearTimeout(this.#hiddenTimer);
      this.#hiddenTimer = setTimeout(
        () => {
          if (this.#ended || document.visibilityState !== "hidden") return;
          this.#setStatus("hidden");
          clearTimeout(this.#retryTimer);
          this.#retryTimer = undefined;
          const socket = this.#socket;
          this.#socket = undefined;
          socket?.close(CloseCode.normal, "hidden");
          this.#failSentCalls();
          this.#clearSnapshots();
        },
        this.#options.hiddenTabDisconnectDelay ?? 5 * 60_000,
      );
      return;
    }
    clearTimeout(this.#hiddenTimer);
    if (this.status !== "hidden") return;
    this.#attempt = 0;
    this.#setStatus("closed");
    if (this.#subscriptions.size > 0 || this.#calls.size > 0) this.#ensureSocket();
  }

  /** Stops for good: on `$close()` or revocation. Subscriptions and pending calls are dropped. */
  #end(status: "closed" | "revoked"): void {
    if (this.#ended) return;
    const error =
      status === "revoked"
        ? new RelayError("FORBIDDEN", { message: "Access revoked" })
        : disconnected();
    this.#ended = error;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#hiddenTimer);
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(CloseCode.normal, status);
    const calls = [...this.#calls.values()];
    const subscriptions = [...this.#subscriptions.values()];
    this.#calls.clear();
    this.#subscriptions.clear();
    for (const call of calls) call.reject(call.sent ? outcomeUnknown() : disconnected());
    try {
      this.#setStatus(status);
    } finally {
      for (const subscription of subscriptions) clearSubscription(subscription, "error", error);
    }
  }

  #clearSnapshots(): void {
    // Callbacks may unsubscribe, subscribe again, or close the client.
    const subscriptions = [...this.#subscriptions];
    for (const [id, subscription] of subscriptions) {
      if (this.#ended) break;
      if (this.#subscriptions.get(id) === subscription) clearSubscription(subscription, "unknown");
    }
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.#options.onStatusChange?.(status);
  }
}

/** One broken consumer must not prevent other subscribers from clearing revoked data. */
function clearSubscription(
  subscription: Subscription,
  status: "unknown" | "error",
  error?: RelayError,
): void {
  try {
    subscription.listener({ data: undefined, status });
  } catch (cause) {
    console.error("zero-relay: subscription listener failed", cause);
  }
  if (error) {
    try {
      subscription.onError?.(error);
    } catch (cause) {
      console.error("zero-relay: subscription error handler failed", cause);
    }
  }
}

function toRelayError(error: WireError): RelayError {
  return new RelayError(error.code, { message: error.message, data: error.data });
}

function disconnected(): RelayError {
  return new RelayError("DISCONNECTED", { message: "The connection closed" });
}

function outcomeUnknown(): RelayError {
  return new RelayError("OUTCOME_UNKNOWN", {
    message: "The mutation may have committed. Check the current data before retrying.",
  });
}
