import { PluginMessage } from "../types";

type Handler = (msg: PluginMessage) => void | Promise<void>;

// Maps msg.type -> handler. Adding a new feature = one .on(...) entry in
// main.ts, instead of a growing if-ladder (OCP).
export class MessageRouter {
  private handlers = new Map<string, Handler>();

  on(type: string, handler: Handler): this {
    this.handlers.set(type, handler);
    return this;
  }

  async dispatch(msg: PluginMessage): Promise<void> {
    if (!msg || typeof msg.type !== "string") return;
    const handler = this.handlers.get(msg.type);
    if (handler) await handler(msg);
  }
}
