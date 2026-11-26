import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Bridge } from "../plugins/whatsapp/lib/bridge.js";
const { version } = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const root = process.env.SWITCHBOARD_ROOT;
if (!root)
  throw Error(
    "Set SWITCHBOARD_ROOT to a Switchboard checkout with dependencies installed.",
  );
const core = path.resolve(root),
  dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "switchboard-whatsapp-integration-"),
  );
process.env.SWITCHBOARD_DATA_DIR = path.join(dir, "data");
process.env.SWITCHBOARD_WATCH_PLUGINS = "false";
process.env.SWITCHBOARD_PUBLIC_URL = "http://localhost:8770";
process.env.SWITCHBOARD_BUILTIN_PLUGINS_DIR = path.join(core, "plugins");
fs.mkdirSync(process.env.SWITCHBOARD_DATA_DIR, { recursive: true });
const previewRoot = path.join(dir, "previews");
const verifyPreviews = process.env.VERIFY_ACTIVITY_PREVIEWS === "1";
if (verifyPreviews) {
  process.env.SWITCHBOARD_ACTIVITY_PREVIEW_ROOT = previewRoot;
  process.env.SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE = "1";
  process.env.SWITCHBOARD_ACTIVITY_PREVIEW_INSTANCE = "whatsapp-fixture";
  process.env.SWITCHBOARD_ACTIVITY_PREVIEW_EPOCH = "fixture-epoch";
}
const load = (file) => import(pathToFileURL(path.join(core, file)).href),
  realFetch = globalThis.fetch;
const archiveRoot = path.join(dir, "archive-root");
fs.mkdirSync(path.join(archiveRoot, "plugins"), { recursive: true });
fs.cpSync("plugins/whatsapp", path.join(archiveRoot, "plugins/whatsapp"), {
  recursive: true,
});
const tar = createRequire(path.join(core, "package.json"))("tar"),
  archive = path.join(dir, "whatsapp.tgz");
await tar.c({ gzip: true, file: archive, cwd: dir }, ["archive-root"]);
const bytes = fs.readFileSync(archive),
  sha = "b".repeat(40);
const helper = path.join(dir, "fixture-helper");
fs.writeFileSync(
  helper,
  `#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');const dir=process.argv[process.argv.indexOf('--data-dir')+1];let ready=fs.existsSync(path.join(dir,'active.json')),mode='phone',polls=0;readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);let result;if(r.method==='version')result={version:${JSON.stringify(version)},protocol:1};else if(r.method==='start'){mode=r.args.pairingMode||mode;result=ready?{ready:true,account:'123456789@s.whatsapp.net'}:mode==='qr'?{ready:false,qrCode:'fixture-first-qr',qrExpiresAt:Date.now()+60000}:{ready:false,code:'TEST-CODE'};}else if(r.method==='pairingStatus'&&mode==='qr'&&polls++===0){result={ready:false,qrCode:'fixture-rotated-qr',qrExpiresAt:Date.now()+20000};}else if(r.method==='pairingStatus'||r.method==='status'){ready=true;result={ready:true,account:'123456789@s.whatsapp.net',historyCoverage:'synced_cache_only'};}else if(r.method==='chats')result={items:[{id:'987654321@s.whatsapp.net'}],nextCursor:'native-cursor',hasMore:true};else if(['send','react','vote'].includes(r.method))result={ok:true,messageId:r.args.sendId,chat:r.args.chat};else result={items:[],nextCursor:null,hasMore:false};process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});\n`,
  { mode: 0o700 },
);
let loopbackRequests = 0;
let replaceResponse;
globalThis.fetch = async (input, opts = {}) => {
  const url = String(input);
  if (url.startsWith("https://api.github.com/repos/fixture/whatsapp/")) {
    if (url.includes("/releases")) {
      const r = {
        tag_name: `v${version}`,
        published_at: "2026-10-19T00:00:00Z",
      };
      return Response.json(url.endsWith("/latest") ? r : [r]);
    }
    if (url.includes("/commits/")) return new Response(sha);
    if (url.includes("/tarball/")) return new Response(bytes);
  }
  if (url.startsWith("http://127.0.0.1:")) {
    loopbackRequests++;
    if (replaceResponse) return replaceResponse();
    return realFetch(input, opts);
  }
  throw Error("Unexpected network destination");
};
let manager, database, native;
try {
  native = new Bridge(
    path.resolve(".local/whatsapp-bridge"),
    path.join(dir, "native-session"),
  );
  assert.deepEqual(await native.call("version"), {
    protocol: 1,
    version,
    features: ["changes.v1"],
  });
  assert.equal((await native.call("status")).ready, false);
  await native.close();
  native = undefined;
  const crypto = await load("server/crypto.ts");
  database = await load("server/db.ts");
  crypto.initKey();
  database.initDb();
  manager = (await load("server/plugins/manager.ts")).plugins;
  await manager.start();
  const user = (await load("server/users.ts")).createUser(
    "whatsapp-integration",
    "admin",
  );
  await (
    await load("server/plugins/github.ts")
  ).install({ repo: "fixture/whatsapp", path: "plugins/whatsapp" }, { user });
  assert.equal(manager.get("whatsapp").status, "active");
  assert.equal(manager.get("whatsapp").source.commit, sha);
  await manager.saveSettings("whatsapp", { bridgePath: helper });
  const connections = await load("server/connections.ts");
  const flow = await connections.startConnect(user, {
    service: "whatsapp",
    method: "linked-device",
    config: { phone: "31612345678", access: "write" },
  });
  assert.equal(flow.status, "device");
  assert.equal(flow.device.userCode, "TEST-CODE");
  const connected = await connections.pollDevice(flow.flowId, user);
  assert.equal(connected.status, "connected");
  const connection = connected.connection;
  const qr = await connections.startConnect(user, {
    service: "whatsapp",
    config: { access: "read" },
  });
  assert.equal(qr.status, "device");
  assert.equal(qr.device.qrCode, "fixture-first-qr");
  assert.equal(qr.device.userCode, undefined);
  const rotated = await connections.pollDevice(qr.flowId, user);
  assert.equal(rotated.status, "pending");
  assert.equal(rotated.device.qrCode, "fixture-rotated-qr");
  assert.ok(rotated.device.qrExpiresAt > Date.now());
  const qrConnected = await connections.pollDevice(qr.flowId, user);
  assert.equal(qrConnected.status, "connected");
  assert.equal(qrConnected.connection.methodId, "linked-device-qr");
  if (verifyPreviews) {
    const { openPreviewStore } = await load("shared/activity-preview-store.ts");
    const { config } = await load("server/config.ts");
    const output = await load("server/activity-output.ts");
    openPreviewStore(previewRoot, [process.env.SWITCHBOARD_DATA_DIR], "whatsapp-fixture");
    config.previewStoreId = JSON.parse(fs.readFileSync(path.join(previewRoot, "store.json"), "utf8")).storeId;
    output.initOutputStore();
    const { execute } = await load("server/proxy.ts");
    const caller = { source: "proxy", tokenId: null, tokenName: null, ip: null, userAgent: null };
    const preview = { historyCoverage: "synced_cache_only" };
    const auditedCall = async (connection, url, { method = "GET", status = 200, expected, body, count = 1, state = expected ? "retained" : "omitted" } = {}) => {
      const before = loopbackRequests;
      const result = await execute(user, connection.id, { method, url }, undefined, caller);
      assert.ok(result.auditId);
      assert.equal(result.response.status, status);
      const received = await result.response.text();
      if (body !== undefined) assert.equal(received, body);
      assert.equal(loopbackRequests - before, count);
      const stored = output.readOutput(user.id, result.auditId, true);
      assert.equal(stored.state, state);
      assert.deepEqual(stored.preview, expected);
      return { result, received };
    };

    const origins = new Set();
    for (let start = 0; start < 2; start++) {
      if (start) await manager.saveSettings("whatsapp", { bridgePath: helper });
      const service = manager.service("whatsapp");
      const [rule] = service.outputPreviews;
      assert.deepEqual(service.outputPreviews, [{
        origin: rule.origin, method: "GET", path: "/capabilities",
        authMethods: ["linked-device", "linked-device-qr"],
        fields: { historyCoverage: { maxBytes: 32 } },
      }]);
      assert.match(rule.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      origins.add(rule.origin);
      for (const conn of [connection, qrConnected.connection]) {
        const direct = await execute(user, conn.id, { method: "GET", url: "/capabilities" });
        const body = await direct.response.text();
        assert.deepEqual(JSON.parse(body).historyCoverage, preview.historyCoverage);
        assert.ok(Object.hasOwn(JSON.parse(body), "features"));
        const { result } = await auditedCall(conn, "/capabilities", { expected: preview, body });
        assert.equal(result.url.origin, rule.origin);
        const stableHeaders = response => [...response.headers].filter(([name]) => name !== "date");
        assert.deepEqual(stableHeaders(result.response), stableHeaders(direct.response));
        await auditedCall(conn, "/status"); // The helper returns the same field plus account data.
        await auditedCall(conn, "/capabilities?unknown=1", { status: 400 });
        await auditedCall(conn, "/capabilities", { method: "HEAD", body: "" });

        try {
          const privateBody = JSON.stringify({ ...preview, account: "private-account", nested: { token: "private-token" } });
          replaceResponse = () => new Response(privateBody, { headers: { "content-type": "application/json" } });
          await auditedCall(conn, "/capabilities", { expected: preview, body: privateBody });
          await auditedCall(conn, "/capabilities?unknown=1", { body: privateBody });
          await auditedCall(conn, "/status", { body: privateBody });
          if (start) {
            service.outputPreviews = [{ ...rule, origin: origins.values().next().value }];
            try {
              await auditedCall(conn, "/capabilities", { body: privateBody });
            } finally {
              service.outputPreviews = [rule];
            }
          }
          const { credentials } = connections.loadConnection(user.id, conn.id).conn;
          assert.ok(Buffer.byteLength(credentials.account) <= rule.fields.historyCoverage.maxBytes);
          replaceResponse = () => Response.json({ historyCoverage: credentials.account });
          await auditedCall(conn, "/capabilities");
          for (const [body, status, type] of [
            [privateBody, 500, "application/json"],
            [null, 204, "application/json"],
            [privateBody, 200, "application/octet-stream"],
            ["{", 200, "application/json"],
            [JSON.stringify({ historyCoverage: "a".repeat(33) }), 200, "application/json"],
          ]) {
            replaceResponse = () => new Response(body, { status, headers: { "content-type": type } });
            await auditedCall(conn, "/capabilities", { status, body: body ?? "" });
          }
          for (const limit of [16_384, 16_385]) {
            const prefix = JSON.stringify({ ...preview, padding: "" });
            const padded = prefix.slice(0, -2) + "a".repeat(limit - Buffer.byteLength(prefix)) + '"}';
            replaceResponse = () => new Response(padded, { headers: { "content-type": "application/json" } });
            await auditedCall(conn, "/capabilities", {
              body: padded,
              expected: limit === 16_384 ? preview : undefined,
            });
          }
          let retry = true;
          replaceResponse = () => {
            if (!retry) return Response.json(preview);
            retry = false;
            return new Response(null, { status: 401 });
          };
          await auditedCall(conn, "/capabilities", { expected: preview, count: 2 });
        } finally {
          replaceResponse = undefined;
        }
      }
    }
    assert.equal(origins.size, 2);
    output.setOutputRetention(0);
    await auditedCall(connection, "/capabilities", { state: "disabled" });
    console.log("PASS: audited capability previews through core storage for phone-code and QR on two loopback ports");
  }
  await connections.deleteConnection(user.id, qrConnected.connection.id);

  const { execute } = await load("server/proxy.ts");
  let r = await execute(user, connection.id, { method: "GET", url: "/" });
  assert.equal(r.response.status, 200);
  assert.equal((await r.response.json()).ready, true);
  r = await execute(user, connection.id, {
    method: "GET",
    url: "/chats?limit=1&type=direct",
  });
  assert.equal((await r.response.json()).nextCursor, "native-cursor");
  const body = {
    chat: "987654321@s.whatsapp.net",
    text: "fixture send, never leaves test process",
    idempotencyKey: "integration-send",
  };
  const send = () =>
    execute(user, connection.id, {
      method: "POST",
      url: "/messages",
      headers: [["content-type", "application/json"]],
      body: JSON.stringify(body),
    });
  r = await send();
  assert.equal((await r.response.json()).ok, true);
  r = await send();
  assert.equal((await r.response.json()).replayed, true);
  const stored = database.one(
    "SELECT credentials_enc,config_enc FROM connections WHERE id=?",
    connection.id,
  );
  assert(!stored.credentials_enc.includes("123456789"));
  assert.deepEqual(crypto.decrypt(stored.config_enc), { access: "write" });
  assert(
    !JSON.stringify(crypto.decrypt(stored.credentials_enc)).includes(
      "31612345678",
    ),
  );
  const description = await (
    await load("server/openapi.ts")
  ).describe(
    manager.service("whatsapp"),
    connections.loadConnection(user.id, connection.id).conn,
  );
  assert(description.operations.some((o) => o.id === "voteWhatsAppPoll"));
  assert.equal(description.operations.length, 11);
  await manager.stop();
  await manager.start();
  r = await execute(user, connection.id, { method: "GET", url: "/status" });
  assert.equal((await r.response.json()).ready, true);
  r = await send();
  assert.equal((await r.response.json()).replayed, true);
  console.log(
    "PASS: actual helper offline startup, GitHub installer, plugin manager, phone-code flow, default QR linking and rotation, scoped proxy, API discovery, encrypted connection storage, durable receipts and restart; fixture account only",
  );
} finally {
  await native?.close();
  await manager?.stop();
  database?.db?.close();
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
