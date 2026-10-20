const str = (description, extra = {}) => ({
  type: "string",
  description,
  ...extra,
});
const chat = str(
  "Exact chat JID from listWhatsAppChats; direct chats and groups only.",
  { pattern: "^[0-9]+(?:-[0-9]+)?@(s\\.whatsapp\\.net|g\\.us|lid)$" },
);
const id = str("Exact message ID from message history.", {
  pattern: "^[A-Za-z0-9_-]{1,128}$",
});
const limit = { type: "integer", minimum: 1, maximum: 100, default: 50 };
const cursor = str(
  "Opaque nextCursor from the previous page; retain the same chat/filter.",
  { maxLength: 2048 },
);
const key = str(
  "Stable idempotency key; use the same key only for identical content.",
  { pattern: "^[A-Za-z0-9._:-]{8,128}$" },
);
const text = str("Message text.", { minLength: 1, maxLength: 4000 });
export const operations = [
  [
    "GET",
    "/status",
    "getWhatsAppStatus",
    "Check linked-device connection and history-sync status",
    {},
  ],
  [
    "GET",
    "/capabilities",
    "getWhatsAppCapabilities",
    "Inspect supported operations and cache coverage",
    {},
  ],
  [
    "GET",
    "/chats",
    "listWhatsAppChats",
    "List synced chats without marking them read",
    {
      limit,
      cursor,
      type: {
        type: "string",
        enum: ["all", "direct", "group"],
        default: "all",
      },
    },
  ],
  [
    "GET",
    "/messages",
    "listWhatsAppMessages",
    "Read synced chat history; older history may be incomplete",
    { chat, limit, cursor },
    ["chat"],
  ],
  [
    "GET",
    "/messages/info",
    "getWhatsAppMessage",
    "Get one cached message, reply context or poll options",
    { chat, messageId: id },
    ["chat", "messageId"],
  ],
  [
    "GET",
    "/writes",
    "getWhatsAppWriteStatus",
    "Inspect an accepted or uncertain write without resending",
    { idempotencyKey: key },
    ["idempotencyKey"],
  ],
  [
    "POST",
    "/messages",
    "sendWhatsAppMessage",
    "Send text, optionally quoting a cached message",
    {
      chat,
      text,
      replyTo: str(
        "Optional exact ID of a cached text message or poll to quote. Omit or use an empty string for an unquoted message. Unsupported quotes fail without sending; they never fall back automatically.",
        { pattern: "^[A-Za-z0-9_-]{0,128}$" },
      ),
      idempotencyKey: key,
    },
    ["chat", "text", "idempotencyKey"],
    true,
  ],
  [
    "POST",
    "/reactions",
    "reactWhatsAppMessage",
    "React to a cached message; empty emoji removes your reaction",
    {
      chat,
      messageId: id,
      emoji: str("Reaction emoji, or empty to remove.", { maxLength: 32 }),
      idempotencyKey: key,
    },
    ["chat", "messageId", "emoji", "idempotencyKey"],
    true,
  ],
  [
    "POST",
    "/polls/vote",
    "voteWhatsAppPoll",
    "Replace your poll selection; empty options withdraws your vote",
    {
      chat,
      messageId: id,
      options: {
        type: "array",
        minItems: 0,
        maxItems: 12,
        uniqueItems: true,
        items: str("Exact poll option text.", {
          minLength: 1,
          maxLength: 1024,
        }),
      },
      idempotencyKey: key,
    },
    ["chat", "messageId", "options", "idempotencyKey"],
    true,
  ],
  [
    "POST",
    "/history",
    "requestWhatsAppHistory",
    "Request an older history batch from your phone; delivery is asynchronous",
    {
      chat,
      beforeMessageId: id,
      count: { type: "integer", minimum: 1, maximum: 50, default: 50 },
    },
    ["chat", "beforeMessageId"],
  ],
].map(
  ([method, path, id, summary, properties, required = [], write = false]) => ({
    method,
    path,
    id,
    summary,
    input: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    write,
  }),
);
export const openapi = {
  openapi: "3.0.3",
  info: { title: "WhatsApp", version: "1.0.0" },
  paths: Object.fromEntries(
    [...new Set(operations.map((o) => o.path))].map((path) => [
      path,
      Object.fromEntries(
        operations
          .filter((o) => o.path === path)
          .map((o) => [
            o.method.toLowerCase(),
            {
              operationId: o.id,
              summary: o.summary,
              ...(o.method === "GET"
                ? {
                    parameters: Object.entries(o.input.properties).map(
                      ([name, schema]) => ({
                        name,
                        in: "query",
                        required: o.input.required.includes(name),
                        schema,
                      }),
                    ),
                  }
                : {
                    requestBody: {
                      required: true,
                      content: { "application/json": { schema: o.input } },
                    },
                  }),
              responses: { 200: { description: "WhatsApp result" } },
            },
          ]),
      ),
    ]),
  ),
};
