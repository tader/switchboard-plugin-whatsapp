import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ajv } from "ajv";
import { fixture, chat, account } from "./contracts-fixture.js";
import { messagingOperations } from "../plugins/whatsapp/lib/messaging-schema.js";
import { createMessaging } from "../plugins/whatsapp/lib/messaging.js";
const ajv = new Ajv({ strict: false });
async function invoke(f, name, input, ctx = f.invocation()) {
  const op = f.service.contracts.operations[name];
  for (const schema of [
    messagingOperations[name].inputSchema,
    op.inputSchema,
  ]) {
    const valid = ajv.compile(schema);
    assert.ok(valid(input), JSON.stringify(valid.errors));
  }
  const result = await op.invoke(input, ctx),
    valid = ajv.compile(messagingOperations[name].outputSchema);
  assert.ok(valid(result), JSON.stringify(valid.errors));
  return result;
}
async function until(fn) {
  for (let n = 0; n < 200; n++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("fixture not ready");
}
test("canonical discovery, partial cache reads and restricted content preserve unknown state", async (t) => {
  const f = await fixture(t),
    contract = f.service.contracts;
  assert.equal(contract.version, 1);
  assert.equal(contract.collect, undefined);
  assert.equal(contract.available(f.connection).length, 6);
  const ro = { ...f.connection, config: { access: "read" } };
  assert.equal(contract.available(ro).length, 4);
  const list = await invoke(f, "messaging.conversations.list", {});
  assert.equal(list.coverage.complete, false);
  assert.equal(list.items[0].unread, null);
  const item = await invoke(f, "messaging.conversations.get", { id: chat });
  assert.equal(item.title, "Fixture");
  assert.equal(item.kind, "direct");
  const history = await invoke(f, "messaging.messages.list", {
    conversationId: chat,
  });
  assert.equal(history.coverage.complete, false);
  assert.equal(history.items[0].isOwn, true);
  assert.equal(history.items[0].authorId, account);
  assert.equal(history.items[1].contentState, "restricted");
  assert.equal(history.items[1].text, null);
  assert.equal(history.items[2].contentState, "deleted");
  assert.equal(history.items[2].text, null);
  assert.equal(history.items[3].contentType, "media");
  assert.equal(history.items[3].text, null);
  assert.ok(!JSON.stringify(history).includes("PRIVATE-"));
  const exact = await invoke(f, "messaging.messages.get", {
    conversationId: chat,
    id: "M1",
  });
  assert.equal(exact.text, "Hello");
  await assert.rejects(
    invoke(f, "messaging.messages.get", {
      conversationId: chat,
      id: "missing",
    }),
    (e) => e.code === "not_found",
  );
  await assert.rejects(
    invoke(
      f,
      "messaging.messages.send",
      { conversationId: chat, text: "no" },
      f.invocation(ro),
    ),
    (e) => e.code === "permission_denied",
  );
});
test("signed cursors bind connection/account/chat/limit and unsupported thread filters fail closed", async (t) => {
  const f = await fixture(t),
    name = "messaging.messages.list";
  const page = await invoke(f, name, { conversationId: chat, limit: 1 });
  assert.ok(page.nextCursor);
  const decoded = Buffer.from(
    page.nextCursor.split(".")[0],
    "base64url",
  ).toString();
  assert.ok(!decoded.includes(f.connection.credentials.profile));
  assert.ok(!decoded.includes(f.connection.credentials.account));
  f.service.contracts = createMessaging(f.dir, f.pool, {
    ready: () => Promise.resolve(),
  });
  const next = await invoke(f, name, {
    conversationId: chat,
    limit: 1,
    cursor: page.nextCursor,
  });
  assert.equal(next.items[0].id, "M2");
  for (const [input, conn] of [
    [{ conversationId: chat, limit: 2, cursor: page.nextCursor }, f.connection],
    [
      {
        conversationId: "11111111@s.whatsapp.net",
        limit: 1,
        cursor: page.nextCursor,
      },
      f.connection,
    ],
    [
      { conversationId: chat, limit: 1, cursor: page.nextCursor + "x" },
      f.connection,
    ],
    [
      { conversationId: chat, limit: 1, cursor: page.nextCursor },
      { ...f.connection, id: "another" },
    ],
  ])
    await assert.rejects(
      invoke(f, name, input, f.invocation(conn)),
      (e) => e.code === "invalid_cursor",
    );
  assert.equal(
    ajv.validate(f.service.contracts.operations[name].inputSchema, {
      conversationId: chat,
      threadId: "thread",
    }),
    false,
  );
  await assert.rejects(
    f.service.contracts.operations[name].invoke(
      { conversationId: chat, threadId: "thread" },
      f.invocation(),
    ),
    (e) => e.code === "invalid_request",
  );
});
test("nested durable keys replay, conflict and prevent uncertain resend without putting bodies in receipts", async (t) => {
  const f = await fixture(t),
    input = { conversationId: chat, text: "PRIVATE-WRITE" };
  const first = await invoke(f, "messaging.messages.send", input);
  assert.equal(first.status, "accepted");
  assert.deepEqual(await invoke(f, "messaging.messages.send", input), first);
  assert.equal((await f.helper.call("fixture.writeCount")).count, 1);
  await assert.rejects(
    invoke(f, "messaging.messages.send", { ...input, text: "changed" }),
    (e) => e.code === "idempotency_conflict",
  );
  const uncertain = f.invocation(f.connection, "ambiguous-key");
  for (let n = 0; n < 2; n++)
    assert.deepEqual(
      await invoke(
        f,
        "messaging.messages.send",
        { conversationId: chat, text: "UNCERTAIN" },
        uncertain,
      ),
      { status: "uncertain" },
    );
  assert.equal((await f.helper.call("fixture.writeCount")).count, 2);
  const files = await fs.readdir(path.join(f.dir, "writes"));
  for (const file of files.filter((x) => x.endsWith(".db"))) {
    const db = new DatabaseSync(path.join(f.dir, "writes", file));
    try {
      const rows = db.prepare("SELECT * FROM writes").all();
      assert.ok(!JSON.stringify(rows).includes("PRIVATE-WRITE"));
      assert.ok(rows.some((r) => r.state === "attempted"));
    } finally {
      db.close();
    }
  }
});
test("quotes never silently downgrade and reaction targets use common metadata receipts", async (t) => {
  const f = await fixture(t);
  const rejected = await invoke(
    f,
    "messaging.messages.send",
    { conversationId: chat, text: "Quote", replyToId: "M4" },
    f.invocation(f.connection, "unsupported-quote"),
  );
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.code, "unsupported_reply");
  const accepted = await invoke(
    f,
    "messaging.messages.send",
    { conversationId: chat, text: "Quote", replyToId: "M1" },
    f.invocation(f.connection, "supported-quote"),
  );
  assert.equal(accepted.status, "accepted");
  const react = await invoke(
    f,
    "messaging.reactions.update",
    { conversationId: chat, messageId: "M1", emoji: "👍" },
    f.invocation(f.connection, "reaction-key"),
  );
  assert.deepEqual(react, { status: "accepted", resourceId: "M1" });
});
test("native watch wakes on real helper hints, publishes before advancing and detaches on cancellation", async (t) => {
  const f = await fixture(t),
    contract = f.service.contracts,
    abort = new AbortController(),
    batches = [];
  const running = contract.watch(
    {},
    {
      ...f.invocation(),
      signal: abort.signal,
      async publish(batch) {
        batches.push(batch);
      },
    },
  );
  await until(() => batches.length === 1);
  assert.equal(batches[0].events[0].event.type, "resync.required");
  await f.helper.call("fixture.emit", { id: "NEW", text: "PRIVATE-NEW" });
  await until(() =>
    batches.some((b) => b.events.some((e) => e.event.resourceId === "NEW")),
  );
  assert.ok(!JSON.stringify(batches).includes("PRIVATE-NEW"));
  const checkpoint = batches.at(-1).checkpoint;
  abort.abort();
  await running;
  assert.equal(f.helper.listeners.size, 0);
  assert.equal(f.helper.pending.size, 0);
  f.helper = await f.pool.restart(f.connection.credentials.profile);
  const again = new AbortController(),
    replayed = [];
  await f.helper.call("fixture.emit", { id: "OFFLINE", text: "Offline" });
  const second = contract.watch(
    { checkpoint },
    {
      ...f.invocation(),
      signal: again.signal,
      publish: async (b) => replayed.push(b),
    },
  );
  await until(() =>
    replayed.some((b) =>
      b.events.some((e) => e.event.resourceId === "OFFLINE"),
    ),
  );
  again.abort();
  await second;
  assert.equal(f.helper.listeners.size, 0);
});
test("failed publication cannot advance the native checkpoint and terminal logout wakes the watcher", async (t) => {
  const f = await fixture(t),
    contract = f.service.contracts;
  const page = await f.helper.call("changes", { cursor: "" });
  await f.helper.call("fixture.emit", {
    id: "PENDING",
    text: "not acknowledged",
  });
  await assert.rejects(
    contract.watch(
      { checkpoint: page.checkpoint },
      {
        ...f.invocation(),
        publish: async () => {
          throw Error("commit failed");
        },
      },
    ),
    /commit failed/,
  );
  assert.equal(f.helper.listeners.size, 0);
  const abort = new AbortController(),
    seen = [];
  const running = contract.watch(
    { checkpoint: page.checkpoint },
    {
      ...f.invocation(),
      signal: abort.signal,
      publish: async (b) => seen.push(b),
    },
  );
  // Attach rejection immediately to avoid an unhandled rejection when the helper expires.
  const rejected = assert.rejects(
    running,
    (e) => e.code === "authentication_required",
  );
  await until(() =>
    seen.some((b) => b.events.some((e) => e.event.resourceId === "PENDING")),
  );
  await f.helper.call("fixture.expire");
  await rejected;
  assert.equal(f.helper.listeners.size, 0);
});
test("aborted IPC reads remove pending handles and a stalled helper install does not hold the watcher", async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  const call = f.helper.call("fixture.hang", {}, { signal: abort.signal });
  abort.abort();
  await assert.rejects(call, (e) => e.code === "cancelled");
  assert.equal(f.helper.pending.size, 0);
  let release;
  const delayed = new Promise((r) => (release = r)),
    signal = new AbortController();
  const contract = createMessaging(f.dir, { get: () => delayed }, {});
  const waiting = contract.watch(
    {},
    {
      ...f.invocation(),
      signal: signal.signal,
      publish: async () => assert.fail("aborted watcher published"),
    },
  );
  signal.abort();
  await assert.rejects(waiting);
  release(f.helper);
});

test("a revoked session fails common writes as authentication-required rather than a successful rejection receipt", async (t) => {
  const f = await fixture(t);
  await f.helper.call("fixture.expire");
  await assert.rejects(
    invoke(f, "messaging.messages.send", {
      conversationId: chat,
      text: "blocked",
    }),
    (e) => e.code === "authentication_required",
  );
  assert.equal((await f.helper.call("fixture.writeCount")).count, 0);
});

test("malformed native checkpoints cannot be published or acknowledged", async (t) => {
  const f = await fixture(t),
    original = f.helper.call.bind(f.helper);
  f.helper.call = (method, ...args) =>
    method === "changes"
      ? Promise.resolve({
          checkpoint: Buffer.from(
            JSON.stringify({ instance: "fixture", seq: 1 }),
          ).toString("base64url"),
          instance: "fixture",
          head: 0,
          resync: true,
          hasMore: false,
          events: [],
        })
      : original(method, ...args);
  await assert.rejects(
    f.service.contracts.watch(
      {},
      {
        ...f.invocation(),
        publish: async () => assert.fail("malformed batch published"),
      },
    ),
    (e) => e.code === "invalid_response",
  );
  assert.equal(f.helper.listeners.size, 0);
});
test("a helper without the feed extension fails native watch explicitly and leaves ordinary reads available", async (t) => {
  const f = await fixture(t);
  f.helper.features = new Set();
  await assert.rejects(
    f.service.contracts.watch(
      {},
      {
        ...f.invocation(),
        publish: async () => assert.fail("unsupported watch published"),
      },
    ),
    (e) => e.code === "watch_not_supported",
  );
  assert.equal(
    (
      await invoke(f, "messaging.messages.get", {
        conversationId: chat,
        id: "M1",
      })
    ).text,
    "Hello",
  );
  assert.equal(f.helper.listeners.size, 0);
});
