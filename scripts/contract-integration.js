// Offline conformance through actual core HTTP/SSE routes, proxy and helper IPC.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fixture, chat, profile } from "../test/contracts-fixture.js";
const core = process.env.SWITCHBOARD_ROOT;
assert(core, "Set SWITCHBOARD_ROOT to a staged shared-contract core");
const root = path.resolve(core),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-contract-http-"));
process.env.SWITCHBOARD_DATA_DIR = temp;
process.env.SWITCHBOARD_SHARED_CONTRACTS = "1";
const load = (file) => import(pathToFileURL(path.join(root, file)).href);
const database = await load("server/db.ts");
database.initDb();
const { initKey, encrypt, decrypt } = await load("server/crypto.ts");
initKey();
const { createUser, createToken } = await load("server/users.ts");
const { plugins } = await load("server/plugins/manager.ts");
const { api } = await load("server/routes/connections.ts");
const { pushSources, collectors, startContractCollectors } = await load(
  "server/contracts/service.ts",
);
const { validateDefinition } = await load("server/contracts/model.ts");
const cleanup = [],
  f = await fixture({ after: (fn) => cleanup.push(fn) });
validateDefinition(f.service.contracts);
plugins.services.set("whatsapp", { pluginId: "whatsapp", service: f.service });
assert.equal(
  fs.readFileSync("plugins/whatsapp/lib/messaging-v1.json", "utf8"),
  fs.readFileSync(
    path.join(root, "server/contracts/messaging-v1.json"),
    "utf8",
  ),
);
const { serve } = createRequire(path.join(root, "package.json"))(
  "@hono/node-server",
);
let ready;
const listening = new Promise((r) => (ready = r));
const server = serve(
  { fetch: api.fetch, hostname: "127.0.0.1", port: 0 },
  ready,
);
await listening;
const stop = startContractCollectors();
const base = "http://127.0.0.1:" + server.address().port,
  user = createUser("fixture", "admin"),
  id = "whatsapp-fixture",
  ro = "whatsapp-readonly";
const insert = (id, access) =>
  database.run(
    "INSERT INTO connections(id,user_id,service_id,method_id,name,config_enc,credentials_enc,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    id,
    user.id,
    "whatsapp",
    "linked-device",
    id,
    encrypt({ access }),
    encrypt({ ...f.connection.credentials, sessionRevision: "initial" }),
    "ok",
    Date.now(),
    Date.now(),
  );
insert(id, "write");
insert(ro, "read");
const token = createToken(user.id, "fixture", [id]).secret,
  readToken = createToken(user.id, "readonly", [ro]).secret;
const request = (
  url,
  body,
  auth = token,
  method = body === undefined ? "GET" : "POST",
) =>
  fetch(base + url, {
    method,
    headers: {
      authorization: "Bearer " + auth,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const call = (operation, args, key, connection = id, auth = token) =>
  request(
    `/connections/${connection}/contracts/v1/call`,
    { operation, arguments: args, ...(key ? { idempotencyKey: key } : {}) },
    auth,
  );
async function until(fn) {
  for (let n = 0; n < 200; n++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("fixture not ready");
}
async function change(sub, cursor, resource) {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 5000);
  try {
    const stream = await fetch(
      base + `/contracts/v1/subscriptions/${sub}/events?cursor=${cursor}`,
      { headers: { authorization: "Bearer " + token }, signal: abort.signal },
    );
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    let text = "";
    try {
      while (!text.includes('"resourceId":"' + resource + '"')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
      assert.ok(!text.includes("PRIVATE-"));
      return text;
    } finally {
      await reader.cancel();
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
let subscription;
try {
  const description = await (
    await request(`/connections/${id}/contracts/v1`)
  ).json();
  assert.deepEqual(description.changes, {
    native: true,
    reconciliation: false,
  });
  assert.equal(description.operations.length, 6);
  assert.equal(
    description.operations.find((o) => o.name === "messaging.messages.list")
      .inputConstraints.properties.threadId,
    undefined,
  );
  assert.equal(
    (
      await call("messaging.messages.list", {
        conversationId: chat,
        threadId: "thread",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "messaging.messages.send",
        { conversationId: chat, text: "x".repeat(4001) },
        "too-large",
      )
    ).status,
    400,
  );
  assert.equal((await request(`/connections/${ro}/contracts/v1`)).status, 403);
  assert.equal(
    (
      await call(
        "messaging.messages.send",
        { conversationId: chat, text: "blocked" },
        "blocked",
        ro,
        readToken,
      )
    ).status,
    403,
  );
  const sources = await (
    await request("/contracts/v1/connections?category=messaging")
  ).json();
  assert.deepEqual(
    sources.connections.map((c) => c.id),
    [id],
  );
  subscription = await (
    await request("/contracts/v1/subscriptions", { connections: [id] })
  ).json();
  assert.equal(
    (
      await request(`/contracts/v1/subscriptions/${subscription.id}/activity`, {
        active: true,
      })
    ).status,
    200,
  );
  await until(() =>
    database.one(
      "SELECT cursor FROM contract_push_checkpoints WHERE connection=?",
      id,
    ),
  );
  const snapshot = await (
    await call("messaging.messages.list", { conversationId: chat })
  ).json();
  assert.equal(snapshot.coverage.complete, false);
  assert.deepEqual(snapshot.items[0].reactions[0].users,[{id:chat,displayName:"Fixture contact"}]);
  assert.equal(snapshot.items[0].reactions[0].usersComplete,false);
  assert.equal(snapshot.items[1].text, null);
  assert.equal(snapshot.items[1].contentState, "restricted");
  assert.equal(snapshot.items[2].text, null);
  assert.ok(!JSON.stringify(snapshot).includes("PRIVATE-"));
  const receipt = await (
    await call(
      "messaging.messages.send",
      { conversationId: chat, text: "PRIVATE-WRITE" },
      "replay-key",
    )
  ).json();
  assert.equal(receipt.status, "accepted");
  assert.deepEqual(
    await (
      await call(
        "messaging.messages.send",
        { conversationId: chat, text: "PRIVATE-WRITE" },
        "replay-key",
      )
    ).json(),
    receipt,
  );
  assert.equal((await f.helper.call("fixture.writeCount")).count, 1);
  assert.equal(
    (
      await call(
        "messaging.messages.send",
        { conversationId: chat, text: "different" },
        "replay-key",
      )
    ).status,
    409,
  );
  for (let n = 0; n < 2; n++)
    assert.equal(
      (
        await (
          await call(
            "messaging.messages.send",
            { conversationId: chat, text: "UNCERTAIN" },
            "uncertain-key",
          )
        ).json()
      ).status,
      "uncertain",
    );
  assert.equal((await f.helper.call("fixture.writeCount")).count, 2);
  await f.helper.call("fixture.emit", {
    id: "ARRIVED",
    text: "PRIVATE-ARRIVED",
  });
  const replay = await change(subscription.id, subscription.cursor, "ARRIVED");
  assert.ok(replay.includes('"connectionId":"' + id + '"'));
  const stored = database.one(
    "SELECT seq FROM contract_events WHERE json_extract(event,'$.resourceId')='ARRIVED'",
  );
  assert.ok(stored);
  await change(subscription.id, stored.seq - 1, "ARRIVED");
  assert.equal(
    (
      await request(`/contracts/v1/subscriptions/${subscription.id}/refresh`, {
        connectionId: id,
      })
    ).status,
    501,
  );
  await f.helper.call("fixture.expire");
  await until(() => collectors().state(id).status === "auth_required");
  const before = (await f.helper.call("fixture.writeCount")).count;
  assert.equal(
    (
      await call(
        "messaging.messages.send",
        { conversationId: chat, text: "blocked" },
        "paused-send",
      )
    ).status,
    409,
  );
  assert.equal((await f.helper.call("fixture.writeCount")).count, before);
  // A verified helper reauthentication changes an opaque session revision even in the same profile.
  await f.helper.call("fixture.restore");
  const connected = await (
    await load("server/connections.ts")
  ).startConnect(user, {
    service: "whatsapp",
    method: "linked-device",
    connection: id,
    config: { access: "write" },
  });
  assert.equal(connected.status, "connected");
  const credentials = decrypt(
    database.one("SELECT credentials_enc FROM connections WHERE id=?", id)
      .credentials_enc,
  );
  assert.equal(credentials.profile, profile);
  assert.notEqual(credentials.sessionRevision, "initial");
  await request(`/contracts/v1/subscriptions/${subscription.id}/activity`, {
    active: true,
  });
  await f.helper.call("fixture.emit", {
    id: "AFTER-AUTH",
    text: "Private after auth",
  });
  await change(subscription.id, stored.seq, "AFTER-AUTH");
  assert.ok(
    !JSON.stringify(database.all("SELECT * FROM contract_events")).includes(
      "PRIVATE-",
    ),
  );
  assert.ok(
    !JSON.stringify(database.all("SELECT * FROM contract_receipts")).includes(
      "PRIVATE-WRITE",
    ),
  );
  assert.ok(
    !JSON.stringify(database.all("SELECT * FROM audit_log")).includes(
      "PRIVATE-WRITE",
    ),
  );
  assert.equal(
    (
      await request(
        `/contracts/v1/subscriptions/${subscription.id}`,
        undefined,
        token,
        "DELETE",
      )
    ).status,
    200,
  );
  await until(() => f.helper.listeners.size === 0);
  console.log(
    "PASS: real core HTTP/SSE, scoped WhatsApp reads/writes, durable replay/uncertainty, native helper publication/replay, auth pause/reconnect and listener cleanup; offline fixtures only",
  );
} finally {
  await stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  for (const fn of cleanup) await fn();
  database.db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
