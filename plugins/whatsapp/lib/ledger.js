import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fail } from "./errors.js";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const canonical = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
export class Ledger {
  constructor(root, account) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, hash(account) + ".db");
    this.accountHash = hash(account);
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(
      "PRAGMA synchronous=FULL;PRAGMA busy_timeout=3000;CREATE TABLE IF NOT EXISTS writes(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,message_id TEXT NOT NULL);",
    );
  }
  inspect(key) {
    const r = this.db
      .prepare("SELECT state,result,message_id FROM writes WHERE key=?")
      .get(hash(key));
    return r
      ? {
          state: r.state,
          messageId: r.message_id,
          ...(r.result ? { result: JSON.parse(r.result) } : {}),
        }
      : { state: "unknown" };
  }
  async run(key, payload, write) {
    const k = hash(key),
      fingerprint = hash(canonical(payload));
    const messageId =
      "3EB0" +
      hash(this.accountHash + k + fingerprint)
        .slice(0, 28)
        .toUpperCase();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = this.db.prepare("SELECT * FROM writes WHERE key=?").get(k);
      if (r) {
        if (r.fingerprint !== fingerprint)
          throw fail("idempotency_conflict", 409);
        if (r.state === "accepted") {
          this.db.exec("COMMIT");
          return { ...JSON.parse(r.result), replayed: true };
        }
        if (r.state !== "rejected") throw fail("uncertain", 409);
      }
      if (
        !r &&
        this.db.prepare("SELECT count(*) n FROM writes").get().n >= 10000
      )
        throw fail("ledger_full", 503);
      this.db
        .prepare(
          "INSERT INTO writes VALUES(?,?,'attempted',NULL,?) ON CONFLICT(key) DO UPDATE SET state='attempted'",
        )
        .run(k, fingerprint, messageId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    try {
      const result = await write(messageId);
      if (result?.ok !== true || result.messageId !== messageId)
        throw fail("invalid_write_receipt", 502);
      this.db
        .prepare("UPDATE writes SET state='accepted',result=? WHERE key=?")
        .run(JSON.stringify(result), k);
      return result;
    } catch (e) {
      if (e.definitive)
        this.db
          .prepare("UPDATE writes SET state='rejected' WHERE key=?")
          .run(k);
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
