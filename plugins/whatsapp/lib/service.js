import { Ledger } from "./ledger.js";
import { fail } from "./errors.js";
import path from "node:path";
export class Service {
  constructor(ctx, pool) {
    this.ctx = ctx;
    this.pool = pool;
    this.ledgers = new Map();
  }
  ledger(conn) {
    const key = conn.credentials.profile + ":" + conn.credentials.account;
    if (!this.ledgers.has(key))
      this.ledgers.set(
        key,
        new Ledger(path.join(this.ctx.dataDir, "writes"), key),
      );
    return this.ledgers.get(key);
  }
  async invoke(op, input, conn) {
    // Canonicalize before both fingerprinting and dispatch: empty means no quote.
    if (op.id === "sendWhatsAppMessage" && input.replyTo === "") {
      input = { ...input };
      delete input.replyTo;
    }
    if (op.write && conn.config.access !== "write")
      throw fail("permission_denied", 403);
    const call = (method, args = input) =>
      this.pool.call(conn.credentials.profile, method, args);
    if (op.id === "getWhatsAppCapabilities")
      return {
        access: conn.config.access,
        features: {
          chats: true,
          history: true,
          send: conn.config.access === "write",
          reply: conn.config.access === "write",
          reactions: conn.config.access === "write",
          pollVotes: conn.config.access === "write",
          pollResults: false,
          mediaDownload: false,
        },
        historyCoverage: "synced_cache_only",
        automaticReadMarkers: false,
        sessionTransfer: false,
      };
    if (op.id === "getWhatsAppStatus") return call("status", {});
    if (op.id === "listWhatsAppChats") return call("chats");
    if (op.id === "listWhatsAppMessages") return call("messages");
    if (op.id === "getWhatsAppMessage") return call("message");
    if (op.id === "requestWhatsAppHistory") return call("history");
    if (op.id === "getWhatsAppWriteStatus")
      return this.ledger(conn).inspect(input.idempotencyKey);
    const method = {
      sendWhatsAppMessage: "send",
      reactWhatsAppMessage: "react",
      voteWhatsAppPoll: "vote",
    }[op.id];
    if (!method) throw fail("unsupported_operation");
    try {
      return await this.ledger(conn).run(
        input.idempotencyKey,
        { operation: op.id, ...input },
        (messageId) => call(method, { ...input, sendId: messageId }),
      );
    } catch (error) {
      if (op.id === "sendWhatsAppMessage" && input.replyTo && error?.definitive === true) {
        if (error.code === "reply_context_unavailable") {
          // The ledger has already recorded the rejection. Read cached metadata
          // only to explain it, without delaying the error if the helper stalls.
          // Never alter the requested message or retry the native send here.
          let timer;
          try {
            const target = await Promise.race([
              call("message", { chat: input.chat, messageId: input.replyTo }),
              new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); }),
            ]);
            if (["image", "video", "audio", "document", "sticker"].includes(target?.type)) {
              const article = ["image", "audio"].includes(target.type) ? "an" : "a";
              error.message = `This API cannot reply to ${article} ${target.type} message. Nothing was sent. To send without a quote, omit replyTo and use a new idempotencyKey.`;
            }
          } catch { /* Preserve the original rejection if cached metadata is unavailable. */ }
          finally { clearTimeout(timer); }
        } else if (error.code === "message_not_in_synced_cache") {
          error.message = "The quoted message is not in this connection's synced cache. Nothing was sent. Use an ID from this chat's cached history, or omit replyTo and use a new idempotencyKey to send without a quote.";
        }
      }
      throw error;
    }
  }

  dispose() {
    for (const l of this.ledgers.values()) l.close();
    this.ledgers.clear();
  }
}
