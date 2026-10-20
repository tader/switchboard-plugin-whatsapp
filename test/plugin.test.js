import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createAdapter } from "../plugins/whatsapp/lib/adapter.js";
import { operations } from "../plugins/whatsapp/lib/operations.js";
import { validate } from "../plugins/whatsapp/lib/validate.js";
import { Ledger } from "../plugins/whatsapp/lib/ledger.js";
import { Bridge, Pool } from "../plugins/whatsapp/lib/bridge.js";
import { ensureBinary } from "../plugins/whatsapp/lib/binary.js";
import { fail } from "../plugins/whatsapp/lib/errors.js";
const account = "123456789@s.whatsapp.net",
  chat = "987654321@s.whatsapp.net",
  profile = "00000000-0000-4000-8000-000000000000";
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-plugin-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  let ready = false,
    mismatch = false,
    writeError = null,
    quoteType = "text";
  const pool = {
    profile: (id) => path.join(dir, "profiles", id),
    async call(id, method, args = {}) {
      calls.push({ id, method, args });
      await fs.mkdir(this.profile(id), { recursive: true, mode: 0o700 });
      if (method === "start" || method === "status")
        return {
          ready,
          account: mismatch ? "999999999@s.whatsapp.net" : account,
          code: "ABCD-EFGH",
        };
      if (["send", "react", "vote"].includes(method)) {
        if (writeError) throw writeError;
        return { ok: true, messageId: args.sendId, chat: args.chat };
      }
      if (method === "chats")
        return {
          items: [{ id: chat }],
          nextCursor: "fixture-next",
          hasMore: true,
          coverage: "synced_cache_only",
        };
      if (method === "messages")
        return {
          items: [{ id: "MSG", chat, text: "fixture" }],
          nextCursor: null,
          hasMore: false,
        };
      if (method === "message") return { id: args.messageId, chat: args.chat, type: quoteType };
      if (method === "history") return { requested: true };
      throw Error("Unexpected method");
    },
    async close() {},
    async drop() {},
    async restore() {},
  };
  const ctx = {
    manifest: { version: "1.0.0" },
    settings: {},
    dataDir: dir,
    log: { warn() {} },
  };
  const instance = await createAdapter(ctx, { pool });
  t.after(() => instance.dispose());
  const auth = instance.services[0].authMethods[0];
  const conn = {
    methodId: auth.id,
    credentials: { profile, account },
    config: { access: "write" },
  };
  const request = async (method, url, body, c = conn) => {
    const req = {
      method,
      url: new URL(url, "http://whatsapp.localhost"),
      headers: new Headers(),
    };
    await auth.authorize(req, c);
    const r = await fetch(req.url, {
      method,
      headers: {
        ...Object.fromEntries(req.headers),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  return {
    dir,
    ctx,
    pool,
    calls,
    auth,
    conn,
    request,
    ready: () => {
      ready = true;
    },
    mismatch: () => {
      mismatch = true;
    },
    failWrites: error => { writeError = error; },
    quoteType: type => { quoteType = type; },
  };
}
test("phone-code flow caches identity and strips phone number from saved config", async (t) => {
  const f = await fixture(t);
  const flow = await f.auth.connect({
    config: { phone: "+31612345678", access: "write" },
  });
  assert.equal(flow.device.userCode, "ABCD-EFGH");
  assert.deepEqual(await f.auth.poll({ pending: flow.pending }), {
    wait: true,
  });
  f.ready();
  const result = await f.auth.poll({ pending: flow.pending });
  assert.deepEqual(result.config, { access: "write" });
  assert.equal(result.credentials.account, account);
  assert(!JSON.stringify(result.credentials).includes("31612345678"));
  const cached = await f.auth.connect({
    connection: { credentials: result.credentials },
    config: { access: "read" },
  });
  assert.equal(cached.account.id, account);
  assert.equal(cached.config.access, "read");
  assert.equal(f.calls.at(-1).args.expectedAccount, account);
});
test("account changes cannot be applied by reconnect or authorization", async (t) => {
  const f = await fixture(t);
  f.ready();
  f.mismatch();
  await assert.rejects(
    f.auth.connect({ connection: f.conn, config: { access: "write" } }),
    { code: "account_mismatch" },
  );
  await assert.rejects(f.request("GET", "/status"), {
    code: "account_mismatch",
  });
});
test("HTTP discovery and opaque pagination reach only the scoped helper", async (t) => {
  const f = await fixture(t);
  for (const [url, method] of [
    ["/chats?limit=1&type=group&cursor=opaque%3D%2B", "chats"],
    ["/messages?chat=" + chat + "&limit=1", "messages"],
    ["/messages/info?chat=" + chat + "&messageId=MSG", "message"],
  ]) {
    const r = await f.request("GET", url);
    assert.equal(r.status, 200);
    const call = f.calls.at(-1);
    assert.equal(call.method, method);
    assert.equal(call.id, profile);
    assert.equal(call.args.limit, method === "message" ? undefined : 1);
    if (method === "chats") {
      assert.equal(call.args.type, "group");
      assert.equal(call.args.cursor, "opaque=+");
    }
  }
});
test("read-only connections reject send, reply, reaction and vote before native writes", async (t) => {
  const f = await fixture(t);
  const c = { ...f.conn, config: { access: "read" } };
  for (const [url, body] of [
    ["/messages", { chat, text: "hello", idempotencyKey: "read-send" }],
    [
      "/messages",
      { chat, text: "hello", replyTo: "MSG", idempotencyKey: "read-reply" },
    ],
    [
      "/reactions",
      { chat, messageId: "MSG", emoji: "👍", idempotencyKey: "read-react" },
    ],
    [
      "/polls/vote",
      {
        chat,
        messageId: "POLL",
        options: ["Soup"],
        idempotencyKey: "read-vote",
      },
    ],
  ]) {
    assert.equal((await f.request("POST", url, body, c)).status, 403);
  }
  assert(!f.calls.some((c) => ["send", "react", "vote"].includes(c.method)));
});
test("send and quote/reaction/vote operations use durable keys and never mark read", async (t) => {
  const f = await fixture(t);
  for (const [url, body, method] of [
    [
      "/messages",
      { chat, text: "hello", replyTo: "MSG", idempotencyKey: "write-send" },
      "send",
    ],
    [
      "/reactions",
      { chat, messageId: "MSG", emoji: "👍", idempotencyKey: "write-react" },
      "react",
    ],
    [
      "/reactions",
      { chat, messageId: "MSG", emoji: "", idempotencyKey: "write-remove" },
      "react",
    ],
    [
      "/polls/vote",
      {
        chat,
        messageId: "POLL",
        options: ["Soup"],
        idempotencyKey: "write-vote",
      },
      "vote",
    ],
    [
      "/polls/vote",
      {
        chat,
        messageId: "POLL",
        options: [],
        idempotencyKey: "write-withdraw",
      },
      "vote",
    ],
  ]) {
    const first = await f.request("POST", url, body);
    assert.equal(first.status, 200);
    assert.equal(first.data.ok, true);
    assert.equal(f.calls.at(-1).method, method);
    const repeat = await f.request("POST", url, body);
    assert.equal(repeat.data.replayed, true);
    const receipt = await f.request(
      "GET",
      "/writes?idempotencyKey=" + body.idempotencyKey,
    );
    assert.equal(receipt.data.state, "accepted");
  }
  assert.equal(
    f.calls.filter((c) => ["send", "react", "vote"].includes(c.method)).length,
    5,
  );
  assert(!f.calls.some((c) => c.method.includes("read")));
});
test("malformed inputs, duplicate query values and arbitrary URLs cannot reach message operations", async (t) => {
  const f = await fixture(t);
  for (const url of [
    "/chats?limit=1&limit=2",
    "/chats?limit=101",
    "/chats?unknown=1",
    "/messages?chat=https://attacker.invalid",
  ])
    assert.equal((await f.request("GET", url)).status, 400);
  await assert.rejects(f.request("GET", "https://attacker.invalid/status"), {
    code: "request_forbidden",
  });
  for (const op of operations)
    for (const key of ["chat", "messageId", "options"])
      if (op.input.required.includes(key)) {
        const base = Object.fromEntries(
          Object.entries(op.input.properties)
            .filter(([k]) => k !== key)
            .map(([k, s]) => [k, s.type === "array" ? [] : "fixture"]),
        );
        assert.throws(() => validate(base, op.input));
      }
});
test("history backfill is explicit, bounded and available without changing read markers", async (t) => {
  const f = await fixture(t);
  const r = await f.request(
    "POST",
    "/history",
    { chat, beforeMessageId: "MSG", count: 50 },
    { ...f.conn, config: { access: "read" } },
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.requested, true);
  assert.equal(f.calls.at(-1).method, "history");
  assert.equal(
    (
      await f.request("POST", "/history", {
        chat,
        beforeMessageId: "MSG",
        count: 51,
      })
    ).status,
    400,
  );
});
test("durable receipts survive restart; uncertain sends and payload changes never resend", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-ledger-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let count = 0;
  let l = new Ledger(dir, "fixture-account");
  const send = async (id) => {
    count++;
    return { ok: true, messageId: id };
  };
  const accepted = await l.run("fixture-key", { text: "same" }, send);
  l.close();
  l = new Ledger(dir, "fixture-account");
  t.after(() => l.close());
  assert.equal(
    (await l.run("fixture-key", { text: "same" }, send)).replayed,
    true,
  );
  assert.equal(count, 1);
  await assert.rejects(l.run("fixture-key", { text: "changed" }, send), {
    code: "idempotency_conflict",
  });
  await assert.rejects(
    l.run("uncertain-key", {}, async () => {
      throw Error("network failure");
    }),
  );
  await assert.rejects(l.run("uncertain-key", {}, send), { code: "uncertain" });
  assert.equal(l.inspect("uncertain-key").state, "attempted");
  assert.equal(l.inspect("fixture-key").messageId, accepted.messageId);
});
test("concurrent ledger instances cannot duplicate sends; known preflight failures remain retryable", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-ledger-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const a = new Ledger(dir, "account"),
    b = new Ledger(dir, "account");
  t.after(() => {
    a.close();
    b.close();
  });
  let finish;
  const pending = a.run(
    "concurrent-key",
    {},
    (id) =>
      new Promise((resolve) => {
        finish = () => resolve({ ok: true, messageId: id });
      }),
  );
  await assert.rejects(
    b.run("concurrent-key", {}, () => {
      throw Error("duplicate send");
    }),
    { code: "uncertain" },
  );
  finish();
  await pending;
  await assert.rejects(
    a.run("rejected-key", {}, () => {
      throw fail("not_a_poll", 400, { definitive: true });
    }),
  );
  assert.equal(
    (
      await a.run("rejected-key", {}, async (id) => ({
        ok: true,
        messageId: id,
      }))
    ).ok,
    true,
  );
});
test("release helper download verifies checksum, reuses cache, and rejects mismatched bytes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-binary-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("fixture-helper"),
    sha = createHash("sha256").update(bytes).digest("hex"),
    name = "whatsapp-bridge-linux-amd64";
  let requests = 0;
  const ctx = { settings: {}, manifest: { version: "1.0.0" }, dataDir: dir };
  const fetcher = async (url) => {
    requests++;
    assert(
      url.startsWith(
        "https://github.com/tader/switchboard-plugin-whatsapp/releases/download/v1.0.0/",
      ),
    );
    return new Response(
      url.endsWith("sha256sums.txt") ? `${sha}  ${name}\n` : bytes,
    );
  };
  const file = await ensureBinary(ctx, {
    platform: "linux",
    arch: "x64",
    fetcher,
  });
  assert.equal(requests, 2);
  await ensureBinary(ctx, { platform: "linux", arch: "x64", fetcher });
  assert.equal(requests, 2);
  await fs.writeFile(file, "corrupt");
  await assert.rejects(
    ensureBinary(ctx, {
      platform: "linux",
      arch: "x64",
      fetcher: async (url) =>
        new Response(
          url.endsWith("sha256sums.txt") ? `${sha}  ${name}\n` : "tampered",
        ),
    }),
    { code: "helper_checksum_mismatch" },
  );
});
test("private helper IPC preserves split UTF-8 reactions and fails cleanly after exit", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-ipc-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fixture-helper");
  await fs.writeFile(
    file,
    `#!/usr/bin/env node\nconst readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);const bytes=Buffer.from(JSON.stringify({id:r.id,result:{emoji:'👍'}})+'\\n');const at=bytes.indexOf(Buffer.from('👍'))+1;process.stdout.write(bytes.subarray(0,at));setTimeout(()=>process.stdout.write(bytes.subarray(at)),5);});\n`,
    { mode: 0o700 },
  );
  const bridge = new Bridge(file, dir);
  assert.deepEqual(await bridge.call("fixture"), { emoji: "👍" });
  await bridge.close();
  await assert.rejects(bridge.call("fixture"), { code: "helper_unavailable" });
});

test("loopback authorization is single-use and has no raw session-token endpoint", async (t) => {
  const f = await fixture(t);
  assert.equal(f.auth.token, undefined);
  const req = {
    method: "GET",
    url: new URL("http://whatsapp.localhost/status"),
    headers: new Headers(),
  };
  await f.auth.authorize(req, f.conn);
  const first = await fetch(req.url, { headers: req.headers });
  assert.equal(first.status, 200);
  await first.json();
  const replay = await fetch(req.url, { headers: req.headers });
  assert.equal(replay.status, 401);
  await replay.json();
  const bare = await fetch(req.url);
  assert.equal(bare.status, 401);
  await bare.json();
});
test("helper pool reuses one process, rejects incompatible versions and restores cached sessions", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-pool-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let created = 0,
    closed = 0;
  const calls = [];
  const ctx = {
    dataDir: dir,
    manifest: { version: "1.0.0" },
    settings: {},
    log: { warn() {} },
  };
  const create = () => {
    created++;
    return {
      closed: false,
      async call(method, args) {
        calls.push({ method, args });
        return method === "version"
          ? { protocol: 1, version: "1.0.0" }
          : { ready: true };
      },
      async close() {
        closed++;
        this.closed = true;
      },
    };
  };
  const pool = new Pool(ctx, { binary: async () => "/fixture-helper", create });
  assert.throws(() => pool.profile("../escape"), { code: "invalid_profile" });
  const [a, b] = await Promise.all([pool.get(profile), pool.get(profile)]);
  assert.equal(a, b);
  assert.equal(created, 1);
  await fs.writeFile(
    path.join(pool.profile(profile), "active.json"),
    JSON.stringify({ account }),
  );
  await pool.restore();
  await new Promise((r) => setImmediate(r));
  assert(
    calls.some(
      (c) => c.method === "start" && c.args.expectedAccount === account,
    ),
  );
  await pool.close();
  assert.equal(closed, 1);
  const bad = new Pool(ctx, {
    binary: async () => "/fixture-helper",
    create: () => ({
      closed: false,
      async call() {
        return { protocol: 99, version: "other" };
      },
      async close() {
        closed++;
      },
    }),
  });
  await assert.rejects(bad.get(profile), { code: "helper_version_mismatch" });
  assert.equal(closed, 2);
  await bad.close();
});
test("malformed native receipts stay uncertain and cannot be resent", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-bad-receipt-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const l = new Ledger(dir, "account");
  t.after(() => l.close());
  await assert.rejects(
    l.run("bad-receipt", {}, async () => ({ ok: true, messageId: "wrong" })),
    { code: "invalid_write_receipt" },
  );
  await assert.rejects(
    l.run("bad-receipt", {}, async (id) => ({ ok: true, messageId: id })),
    { code: "uncertain" },
  );
});

test("revoked device reconnect restarts the helper in the same profile and preserves account binding", async (t) => {
  const f = await fixture(t);
  f.ready();
  const original = f.pool.call.bind(f.pool);
  let revoked = true,
    restarts = 0;
  f.pool.call = async (id, method, args) => {
    if (revoked && method === "start") {
      revoked = false;
      throw fail("session_revoked", 401);
    }
    return original(id, method, args);
  };
  f.pool.restart = async (id) => {
    assert.equal(id, profile);
    restarts++;
  };
  const result = await f.auth.connect({
    connection: f.conn,
    config: { phone: "123456789", access: "write" },
  });
  assert.equal(restarts, 1);
  assert.equal(result.credentials.profile, profile);
  assert.equal(result.account.id, account);
  assert.equal(f.calls.at(-1).args.expectedAccount, account);
});

test("unpublished helper release reports development setup rather than a retryable download failure", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-unreleased-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ctx = { settings: {}, manifest: { version: "1.0.0" }, dataDir: dir };
  await assert.rejects(
    ensureBinary(ctx, {
      platform: "linux",
      arch: "x64",
      fetcher: async () => new Response(null, { status: 404 }),
    }),
    { code: "helper_release_unavailable" },
  );
  await assert.rejects(
    ensureBinary(ctx, {
      platform: "linux",
      arch: "x64",
      fetcher: async () => new Response(null, { status: 503 }),
    }),
    { code: "helper_download_failed" },
  );
});

test("an unreadable cached helper reports permissions instead of trying an unrelated download", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "whatsapp-cache-permissions-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = fs.readFile;
  const mocked = t.mock.method(fs, "readFile", async (file, ...args) => {
    if (String(file).endsWith(".sha256"))
      throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    return original(file, ...args);
  });
  let downloads = 0;
  try {
    await assert.rejects(
      ensureBinary(
        { settings: {}, manifest: { version: "1.0.0" }, dataDir: dir },
        {
          platform: "linux",
          arch: "x64",
          fetcher: async () => {
            downloads++;
            return new Response(null, { status: 404 });
          },
        },
      ),
      { code: "helper_cache_unavailable" },
    );
    assert.equal(downloads, 0);
  } finally {
    mocked.mock.restore();
  }
});


test("empty and omitted replyTo share one canonical send and durable receipt", async (t) => {
  const f = await fixture(t);
  for (const emptyFirst of [true, false]) {
    const payload = { chat, text: "fixture text", idempotencyKey: `empty-reply-${emptyFirst}` };
    const first = await f.request("POST", "/messages", { ...payload, ...(emptyFirst ? { replyTo: "" } : {}) });
    assert.equal(first.status, 200);
    assert.equal(Object.hasOwn(f.calls.at(-1).args, "replyTo"), false, "an empty replyTo never reaches the helper");
    const repeat = await f.request("POST", "/messages", { ...payload, ...(!emptyFirst ? { replyTo: "" } : {}) });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.data.replayed, true);
    assert.equal(repeat.data.messageId, first.data.messageId);
  }
  assert.equal(f.calls.filter(c => c.method === "send").length, 2, "one mock send per distinct key");
  const op = operations.find(op => op.id === "sendWhatsAppMessage");
  assert.doesNotThrow(() => validate({ chat, text: "fixture", replyTo: "", idempotencyKey: "empty-schema" }, op.input));
});

test("invalid nonempty replyTo values explain the field and never reach a native send", async (t) => {
  const f = await fixture(t);
  for (const replyTo of [null, " ", "id with spaces", 123]) {
    const result = await f.request("POST", "/messages", { chat, text: "fixture", replyTo, idempotencyKey: "invalid-reply" });
    assert.equal(result.status, 400);
    assert.equal(result.data.error.code, "invalid_input");
    assert.match(result.data.error.message, /Invalid replyTo/);
    assert.match(result.data.error.message, /Omit or use an empty string/);
  }
  assert.equal(f.calls.filter(c => c.method === "send").length, 0);
});

test("unsupported quoted media explains recovery and never automatically sends unquoted", async (t) => {
  const f = await fixture(t);
  for (const type of ["video", "image", "audio", "document", "sticker"]) {
    f.quoteType(type);
    f.failWrites(fail("reply_context_unavailable", 409, { definitive: true }));
    const payload = { chat, text: "fixture text", replyTo: "CACHED", idempotencyKey: `media-reply-${type}` };
    const result = await f.request("POST", "/messages", payload);
    assert.equal(result.status, 409);
    assert.equal(result.data.error.code, "reply_context_unavailable");
    assert.match(result.data.error.message, new RegExp(`cannot reply to (?:a|an) ${type} message`));
    assert.match(result.data.error.message, /Nothing was sent/);
    assert.match(result.data.error.message, /omit replyTo and use a new idempotencyKey/);
    const receipt = await f.request("GET", `/writes?idempotencyKey=${payload.idempotencyKey}`);
    assert.equal(receipt.data.state, "rejected");
    const changed = await f.request("POST", "/messages", { ...payload, replyTo: "" });
    assert.equal(changed.status, 409);
    assert.equal(changed.data.error.code, "idempotency_conflict", "normalization never overwrites a different existing payload");
    assert.equal(f.calls.filter(c => c.method === "send" && c.args.idempotencyKey === payload.idempotencyKey).length, 1);
  }
});

test("quote metadata failures preserve the actionable original rejection", async (t) => {
  const f = await fixture(t);
  f.failWrites(fail("reply_context_unavailable", 409, { definitive: true }));
  const original = f.pool.call.bind(f.pool);
  f.pool.call = async (id, method, args) => {
    if (method === "message") throw Error("metadata unavailable");
    return original(id, method, args);
  };
  const result = await f.request("POST", "/messages", { chat, text: "fixture", replyTo: "CACHED", idempotencyKey: "missing-metadata" });
  assert.equal(result.status, 409);
  assert.equal(result.data.error.code, "reply_context_unavailable");
  assert.match(result.data.error.message, /complete cached text messages and polls/);
  assert.match(result.data.error.message, /omit replyTo and use a new idempotencyKey/);
  assert.equal(f.calls.filter(c => c.method === "send").length, 1);
});

test("uncertain sends retain the original key and never fall back or resend", async (t) => {
  const f = await fixture(t);
  f.failWrites(fail("send_uncertain", 502, { definitive: false }));
  const payload = { chat, text: "fixture", replyTo: "CACHED", idempotencyKey: "uncertain-reply" };
  const first = await f.request("POST", "/messages", payload);
  assert.equal(first.status, 502);
  assert.match(first.data.error.message, /may have been delivered/);
  assert.match(first.data.error.message, /Do not retry with a new key/);
  const repeat = await f.request("POST", "/messages", payload);
  assert.equal(repeat.status, 409);
  assert.equal(repeat.data.error.code, "uncertain");
  const receipt = await f.request("GET", `/writes?idempotencyKey=${payload.idempotencyKey}`);
  assert.equal(receipt.data.state, "attempted");
  assert.equal(f.calls.filter(c => c.method === "send").length, 1);
  assert.equal(f.calls.filter(c => c.method === "message").length, 0);
});


test("slow quote diagnostics do not delay rejection or leave an attempted write", async (t) => {
  const f = await fixture(t);
  f.failWrites(fail("reply_context_unavailable", 409, { definitive: true }));
  const original = f.pool.call.bind(f.pool);
  let metadataStarted;
  const started = new Promise(resolve => { metadataStarted = resolve; });
  f.pool.call = async (id, method, args) => {
    if (method === "message") { metadataStarted(); return new Promise(() => {}); }
    return original(id, method, args);
  };
  const pending = f.request("POST", "/messages", { chat, text: "fixture", replyTo: "CACHED", idempotencyKey: "slow-diagnostics" });
  await started;
  const receipt = await f.request("GET", "/writes?idempotencyKey=slow-diagnostics");
  assert.equal(receipt.data.state, "rejected", "persist rejection before optional diagnostics");
  const result = await pending;
  assert.equal(result.status, 409);
  assert.match(result.data.error.message, /omit replyTo/);
  assert.equal(f.calls.filter(c => c.method === "send").length, 1);
});

test("missing cached quote explains recovery without suggesting a send already happened", async (t) => {
  const f = await fixture(t);
  f.failWrites(fail("message_not_in_synced_cache", 404, { definitive: true }));
  const result = await f.request("POST", "/messages", { chat, text: "fixture", replyTo: "MISSING", idempotencyKey: "missing-quote-id" });
  assert.equal(result.status, 404);
  assert.equal(result.data.error.code, "message_not_in_synced_cache");
  assert.match(result.data.error.message, /quoted message is not in this connection's synced cache/);
  assert.match(result.data.error.message, /Nothing was sent/);
  assert.match(result.data.error.message, /new idempotencyKey/);
  assert.equal(f.calls.filter(c => c.method === "send").length, 1);
});
