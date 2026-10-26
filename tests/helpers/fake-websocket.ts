import type { ClientMessage, ServerMessage } from "../../src/internal/protocol.ts";

export class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: ClientMessage[] = [];
  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {
    super();
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(message: ServerMessage) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.drop(code);
  }
  drop(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}
