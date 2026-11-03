import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "../plugins/whatsapp/lib/bridge.js";
import { createAdapter } from "../plugins/whatsapp/lib/adapter.js";
import manifest from "../plugins/whatsapp/plugin.json" with { type: "json" };
export const profile = "00000000-0000-4000-8000-000000000000",
  account = "123456789@s.whatsapp.net",
  chat = "987654321@s.whatsapp.net";
export async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-contract-"));
  const ctx = {
    manifest,
    dataDir: dir,
    settings: { bridgePath: path.resolve("test/fixture-helper.cjs") },
    capabilities: { deviceQr: true, deviceUpdates: true },
    log: { warn() {}, info() {}, error() {} },
  };
  const pool = new Pool(ctx),
    adapter = await createAdapter(ctx, { pool }),
    service = adapter.services[0];
  t.after(async () => {
    await adapter.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const connection = {
    id: "contract-connection",
    name: "Fixture",
    serviceId: "whatsapp",
    methodId: "linked-device",
    credentials: { profile, account },
    config: { access: "write" },
  };
  const helper = await pool.get(profile);
  const invocation = (
    conn = connection,
    key = "fixture-core-key",
    signal = new AbortController().signal,
  ) => ({
    connection: conn,
    idempotencyKey: key,
    signal,
    async request(input) {
      const req = {
        method: input.method ?? "GET",
        url: new URL(input.url, "http://whatsapp.localhost"),
        headers: new Headers(input.headers),
        body: input.body,
      };
      await service.authMethods
        .find((m) => m.id === conn.methodId)
        .authorize(req, conn);
      return fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal,
      });
    },
  });
  return { dir, ctx, pool, adapter, service, connection, helper, invocation };
}
