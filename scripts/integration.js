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
  `#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');const dir=process.argv[process.argv.indexOf('--data-dir')+1];let ready=fs.existsSync(path.join(dir,'active.json'));readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);let result;if(r.method==='version')result={version:${JSON.stringify(version)},protocol:1};else if(r.method==='start')result=ready?{ready:true,account:'123456789@s.whatsapp.net'}:{ready:false,code:'TEST-CODE'};else if(r.method==='status'){ready=true;result={ready:true,account:'123456789@s.whatsapp.net',historyCoverage:'synced_cache_only'};}else if(r.method==='chats')result={items:[{id:'987654321@s.whatsapp.net'}],nextCursor:'native-cursor',hasMore:true};else if(['send','react','vote'].includes(r.method))result={ok:true,messageId:r.args.sendId,chat:r.args.chat};else result={items:[],nextCursor:null,hasMore:false};process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});\n`,
  { mode: 0o700 },
);
globalThis.fetch = async (input, opts = {}) => {
  const url = String(input);
  if (url.startsWith("https://api.github.com/repos/fixture/whatsapp/")) {
    if (url.includes("/releases")) {
      const r = { tag_name: `v${version}`, published_at: "2026-10-19T00:00:00Z" };
      return Response.json(url.endsWith("/latest") ? r : [r]);
    }
    if (url.includes("/commits/")) return new Response(sha);
    if (url.includes("/tarball/")) return new Response(bytes);
  }
  if (url.startsWith("http://127.0.0.1:")) return realFetch(input, opts);
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
  assert.equal(description.operations.length, 10);
  await manager.stop();
  await manager.start();
  r = await execute(user, connection.id, { method: "GET", url: "/status" });
  assert.equal((await r.response.json()).ready, true);
  r = await send();
  assert.equal((await r.response.json()).replayed, true);
  console.log(
    "PASS: actual helper offline startup, GitHub installer, plugin manager, phone-code flow, scoped proxy, API discovery, encrypted connection storage, durable receipts and restart; fixture account only",
  );
} finally {
  await native?.close();
  await manager?.stop();
  database?.db?.close();
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
