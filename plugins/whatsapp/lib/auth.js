import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
export function createAuth(pool) {
  const pending = new Map();
  async function finish(profile, state, access, previous) {
    if (
      !state.ready ||
      !/^\d+@(s\.whatsapp\.net|lid)$/.test(state.account ?? "")
    )
      throw fail("signin_required", 401);
    if (previous && previous !== state.account)
      throw fail("account_mismatch", 403);
    await fs.writeFile(
      path.join(pool.profile(profile), "active.json"),
      JSON.stringify({ account: state.account }),
      { mode: 0o600 },
    );
    return {
      credentials: { profile, account: state.account },
      account: { id: state.account, label: state.account },
      config: { access: access === "write" ? "write" : "read" },
    };
  }
  const timer = setInterval(() => {
    for (const [id, f] of pending)
      if (f.expires < Date.now()) {
        pending.delete(id);
        if (f.fresh) void pool.drop(f.profile).catch(() => {});
      }
  }, 10000);
  timer.unref();
  return {
    method: {
      id: "linked-device",
      name: "Link WhatsApp with a phone code",
      description:
        "On your phone, open WhatsApp → Linked devices → Link a device → Link with phone number instead. Sessions are cached on this Switchboard.",
      fields: [
        {
          key: "phone",
          label: "Your WhatsApp phone number",
          type: "secret",
          description:
            "International format, digits only (include country code). Needed only for first pairing.",
        },
        {
          key: "access",
          label: "Access",
          type: "select",
          default: "read",
          options: [
            { value: "read", label: "Read only" },
            { value: "write", label: "Read, send, reply, react and vote" },
          ],
        },
      ],
      async connect({ config, connection }) {
        if (pending.size >= 8) throw fail("too_many_signins", 503);
        const profile = connection?.credentials?.profile ?? randomUUID(),
          previous = connection?.credentials?.account;
        const phone = String(config.phone ?? "").replace(/^\+/, "");
        if (!previous && !/^\d{7,15}$/.test(phone))
          throw fail("international_phone_number_required", 400);
        const start = () =>
          pool.call(profile, "start", {
            phone: phone || undefined,
            expectedAccount: previous,
          });
        let state;
        try {
          state = await start();
        } catch (error) {
          if (error.code !== "session_revoked" || !phone) throw error;
          await pool.restart(profile);
          state = await start();
        }
        if (state.ready) return finish(profile, state, config.access, previous);
        if (!state.code && !previous) throw fail("pairing_failed", 502);
        const id = randomUUID();
        pending.set(id, {
          profile,
          previous,
          access: config.access,
          fresh: !connection,
          expires: Date.now() + 150000,
        });
        return {
          device: {
            userCode: state.code ?? "RECONNECTING",
            verificationUri: "https://www.whatsapp.com/",
            expiresIn: 150,
            interval: 3,
          },
          pending: { id },
        };
      },
      async poll({ pending: state }) {
        const f = pending.get(state.id);
        if (!f || f.expires < Date.now()) throw fail("pairing_expired", 401);
        const status = await pool.call(f.profile, "status");
        if (!status.ready) return { wait: true };
        const result = await finish(f.profile, status, f.access, f.previous);
        pending.delete(state.id);
        return result;
      },
      async revoke(conn) {
        for (const [id, f] of pending)
          if (f.profile === conn.credentials.profile) pending.delete(id);
        await pool.drop(conn.credentials.profile);
      },
    },
    async ready(conn) {
      pool.profile(conn.credentials?.profile);
      const status = await pool.call(conn.credentials.profile, "start", {
        expectedAccount: conn.credentials.account,
      });
      if (status.account && status.account !== conn.credentials.account)
        throw fail("account_mismatch", 403);
      return status;
    },
    dispose() {
      clearInterval(timer);
      pending.clear();
    },
  };
}
