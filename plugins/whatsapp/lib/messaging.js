import { createHash } from "node:crypto";
import { messagingOperations } from "./messaging-schema.js";
import { MessagingCursors } from "./messaging-cursors.js";
import { fail } from "./errors.js";
const methods = new Set(["linked-device", "linked-device-qr"]);
function time(stamp) {
  const d = new Date(stamp);
  return Number.isFinite(d.valueOf()) && d.valueOf() > 0
    ? d.toISOString()
    : null;
}
export function conversation(raw) {
  return {
    id: raw.id,
    title: raw.name || raw.id,
    kind: raw.isGroup ? "group" : "direct",
    unread: null,
    updatedAt: time(raw.lastMessageAt),
  };
}
export function message(raw) {
  const type = raw.type;
  const text = type === "poll" ? raw.poll?.name : raw.text;
  const contentState =
    type === "restricted"
      ? "restricted"
      : type === "revoked"
        ? "deleted"
        : raw.textTruncated ||
            typeof text !== "string" ||
            (type !== "text" && !text)
          ? "unavailable"
          : "available";
  return {
    id: raw.id,
    conversationId: raw.chat,
    text: contentState === "available" ? text : null,
    authorId: raw.sender || null,
    authorDisplayName: raw.authorDisplayName || null,
    createdAt: time(raw.timestamp),
    isOwn: typeof raw.fromMe === "boolean" ? raw.fromMe : null,
    ...(Array.isArray(raw.reactions) ? { reactions: raw.reactions } : {}),
    contentState,
    contentType:
      type === "text"
        ? "text"
        : type === "poll"
          ? "poll"
          : ["image", "video", "audio", "document", "sticker"].includes(type)
            ? "media"
            : ["reaction", "poll_vote"].includes(type)
              ? "system"
              : "unknown",
    ...(raw.replyTo ? { replyToId: raw.replyTo } : {}),
  };
}
export function createMessaging(root, pool, auth) {
  const cursors = new MessagingCursors(root);
  async function request(ctx, route, args = {}, method = "GET") {
    ctx.signal.throwIfAborted();
    const query = new URLSearchParams(
      Object.entries(args)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    const response = await ctx.request({
      method,
      url: route + (method === "GET" && query ? "?" + query : ""),
      ...(method === "GET"
        ? {}
        : {
            headers: [["content-type", "application/json"]],
            body: JSON.stringify(args),
          }),
    });
    const data = await response.json();
    ctx.signal.throwIfAborted();
    if (!response.ok || data.error) {
      const code = data.error?.code;
      if (
        response.status === 401 ||
        ["signin_required", "session_revoked", "account_mismatch"].includes(
          code,
        )
      )
        throw fail("authentication_required", 401);
      if (code === "unsupported_method")
        throw fail("contract_not_supported", 501);
      if (response.status === 429)
        throw fail("rate_limited", 429, {
          retryAfterMs: Number(data.error?.retryAfter || 60) * 1000,
        });
      if (
        response.status >= 500 ||
        ["uncertain", "send_uncertain", "invalid_write_receipt"].includes(code)
      )
        throw fail(
          method === "GET" ? "source_unavailable" : "uncertain",
          method === "GET" ? 502 : 409,
        );
      if (code === "idempotency_conflict") throw fail(code, 409);
      if (code === "invalid_cursor") throw fail(code, 409);
      if (response.status === 403) throw fail("permission_denied", 403);
      if (response.status === 404) throw fail("not_found", 404);
      throw fail(
        code === "reply_context_unavailable"
          ? "unsupported_reply"
          : "invalid_request",
        400,
      );
    }
    return data;
  }
  const operations = {};
  const available = (c) =>
    methods.has(c.methodId) && c.credentials?.profile && c.credentials?.account
      ? Object.keys(operations).filter(
          (name) => operations[name].readOnly || c.config.access === "write",
        )
      : [];
  function op(name, invoke) {
    operations[name] = {
      category: "messaging",
      readOnly: /\.(list|get)$/.test(name),
      ...messagingOperations[name],
      async invoke(input, ctx) {
        if (!available(ctx.connection).includes(name))
          throw fail("permission_denied", 403);
        return invoke(input, ctx);
      },
    };
  }
  async function page(ctx, input, path, args, kind, project) {
    const binding = [
      ctx.connection.id,
      ctx.connection.credentials.profile,
      ctx.connection.credentials.account,
      kind,
      args,
      input.limit ?? 50,
    ];
    const cursor = input.cursor
      ? await cursors.decode(binding, input.cursor)
      : undefined;
    const raw = await request(ctx, path, {
      ...args,
      limit: input.limit ?? 50,
      cursor,
    });
    if (!Array.isArray(raw.items)) throw fail("invalid_response", 502);
    return {
      items: raw.items.map(project),
      ...(raw.nextCursor
        ? { nextCursor: await cursors.encode(binding, raw.nextCursor) }
        : {}),
      coverage: {
        complete: false,
        reason:
          raw.nextCursor || raw.hasMore
            ? "more_synced_cache_only"
            : "synced_cache_only",
      },
    };
  }
  op("messaging.conversations.list", (input, ctx) =>
    page(ctx, input, "/chats", { type: "all" }, "conversations", conversation),
  );
  op("messaging.conversations.get", async (input, ctx) =>
    conversation(await request(ctx, "/chats/info", { chat: input.id })),
  );
  op("messaging.messages.list", (input, ctx) => {
    if (input.threadId !== undefined) throw fail("invalid_request");
    return page(
      ctx,
      input,
      "/messages",
      { chat: input.conversationId },
      "messages",
      message,
    );
  });
  op("messaging.messages.get", async (input, ctx) =>
    message(
      await request(ctx, "/messages/info", {
        chat: input.conversationId,
        messageId: input.id,
      }),
    ),
  );
  function key(ctx) {
    if (typeof ctx.idempotencyKey !== "string" || !ctx.idempotencyKey)
      throw fail("invalid_idempotency_key");
    return (
      "contract:" +
      createHash("sha256")
        .update(JSON.stringify([ctx.connection.id, ctx.idempotencyKey]))
        .digest("hex")
    );
  }
  async function write(ctx, path, args) {
    const intentKey = key(ctx);
    try {
      const receipt = await request(
        ctx,
        path,
        { ...args, idempotencyKey: intentKey },
        "POST",
      );
      return { status: "accepted", resourceId: receipt.messageId };
    } catch (e) {
      if (
        e.status === 401 ||
        ["signin_required", "session_revoked", "account_mismatch"].includes(
          e.code,
        )
      )
        throw fail("authentication_required", 401);
      if (e.code === "uncertain") return { status: "uncertain" };
      if (
        [
          "authentication_required",
          "permission_denied",
          "idempotency_conflict",
          "rate_limited",
          "cancelled",
        ].includes(e.code) ||
        ctx.signal.aborted
      )
        throw e;
      return [
        "invalid_request",
        "not_found",
        "unsupported_reply",
        "contract_not_supported",
      ].includes(e.code)
        ? { status: "rejected", code: e.code }
        : { status: "uncertain" };
    }
  }
  op("messaging.messages.send", (input, ctx) => {
    if (input.threadId !== undefined) throw fail("invalid_request");
    return write(ctx, "/messages", {
      chat: input.conversationId,
      text: input.text,
      ...(input.replyToId ? { replyTo: input.replyToId } : {}),
    });
  });
  op("messaging.reactions.update", async (input, ctx) => {
    const result = await write(ctx, "/reactions", {
      chat: input.conversationId,
      messageId: input.messageId,
      emoji: input.remove ? "" : input.emoji,
    });
    return result.status === "accepted"
      ? { status: "accepted", resourceId: input.messageId }
      : result;
  });
  for (const name of ["messaging.messages.list", "messaging.messages.send"]) {
    operations[name].inputSchema = structuredClone(
      operations[name].inputSchema,
    );
    delete operations[name].inputSchema.properties.threadId;
  }
  operations["messaging.messages.send"].inputSchema.properties.text = {
    type: "string",
    minLength: 1,
    maxLength: 4000,
    description: "Up to 4000 UTF-16 code units; no implicit splitting.",
  };
  operations["messaging.reactions.update"].inputSchema = structuredClone(
    operations["messaging.reactions.update"].inputSchema,
  );
  operations[
    "messaging.reactions.update"
  ].inputSchema.properties.emoji.maxLength = 16;
  return {
    version: 1,
    operations,
    available,
    async watch(input, ctx) {
      const c = ctx.connection;
      if (!available(c).some((name) => operations[name].readOnly))
        throw fail("watch_not_supported", 501);
      ctx.signal.throwIfAborted();
      let aborted;
      const cancelled = new Promise((_, reject) => {
        aborted = () => reject(fail("cancelled", 499));
        ctx.signal.addEventListener("abort", aborted, { once: true });
      });
      let helper;
      try {
        helper = await Promise.race([
          pool.get(c.credentials.profile),
          cancelled,
        ]);
      } finally {
        ctx.signal.removeEventListener("abort", aborted);
      }
      ctx.signal.throwIfAborted();
      if (!helper.features?.has("changes.v1"))
        throw fail("watch_not_supported", 501);
      const check = async () => {
        const state = await helper.call("status", {}, { signal: ctx.signal });
        if (
          state.revoked ||
          state.paired === false ||
          !state.account ||
          state.account !== c.credentials.account
        )
          throw fail("authentication_required", 401);
        if (state.cacheHealthy === false) throw fail("source_unavailable", 503);
      };
      await check();
      await auth.ready(c, { signal: ctx.signal });
      let cursor = input.checkpoint;
      while (!ctx.signal.aborted) {
        const waiting = new AbortController(),
          signal = AbortSignal.any([ctx.signal, waiting.signal]);
        const wake = helper.waitForChange(signal);
        try {
          await check();
          let page;
          try {
            page = await helper.call(
              "changes",
              { cursor: cursor ?? "", limit: 100 },
              { signal: ctx.signal },
            );
          } catch (e) {
            if (e.code === "invalid_cursor" && cursor !== undefined) {
              cursor = undefined;
              continue;
            }
            throw e;
          }
          if (
            typeof page.checkpoint !== "string" ||
            typeof page.instance !== "string" ||
            page.instance.length > 100 ||
            !Number.isSafeInteger(page.head) ||
            page.head < 0 ||
            !Array.isArray(page.events) ||
            page.events.length > 100
          )
            throw fail("invalid_response", 502);
          let decoded;
          try {
            decoded = JSON.parse(
              Buffer.from(page.checkpoint, "base64url").toString(),
            );
          } catch {
            throw fail("invalid_response", 502);
          }
          if (
            decoded.instance !== page.instance ||
            decoded.seq !== page.head ||
            typeof page.resync !== "boolean" ||
            typeof page.hasMore !== "boolean" ||
            (page.resync && (page.events.length || page.hasMore))
          )
            throw fail("invalid_response", 502);
          let previous = 0;
          for (const event of page.events) {
            if (
              !Number.isSafeInteger(event.seq) ||
              event.seq <= previous ||
              event.seq > page.head
            )
              throw fail("invalid_response", 502);
            previous = event.seq;
          }
          if (page.events.length && previous !== page.head)
            throw fail("invalid_response", 502);
          const events = page.resync
            ? [
                {
                  sourceId: `${page.instance}:resync:${page.head}`,
                  event: {
                    category: "messaging",
                    type: "resync.required",
                    resourceType: "scope",
                  },
                },
              ]
            : page.events.map((e) => {
                if (
                  !Number.isSafeInteger(e.seq) ||
                  e.seq < 1 ||
                  typeof e.chat !== "string" ||
                  e.chat.length > 256 ||
                  (typeof e.messageId !== "string" &&
                    e.messageId !== undefined) ||
                  e.messageId?.length > 128 ||
                  !["invalidated", "deleted"].includes(e.kind)
                )
                  throw fail("invalid_response", 502);
                return {
                  sourceId: `${page.instance}:${e.seq}`,
                  event: {
                    category: "messaging",
                    type: e.kind,
                    resourceType: e.messageId ? "message" : "conversation",
                    resourceId: e.messageId || e.chat,
                    ...(e.messageId ? { collectionId: e.chat } : {}),
                  },
                };
              });
          if (events.length || page.checkpoint !== cursor)
            await ctx.publish({ events, checkpoint: page.checkpoint });
          cursor = page.checkpoint;
          if (!page.hasMore) await wake;
        } finally {
          waiting.abort();
        }
      }
    },
  };
}
