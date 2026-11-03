import fs from "node:fs/promises";
import path from "node:path";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fail } from "./errors.js";
/** Sign opaque provider cursors and bind them to the connection, account and query. */
export class MessagingCursors {
  constructor(root) {
    this.root = root;
  }
  key() {
    return (this.pending ??= this.loadKey());
  }
  async loadKey() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = path.join(this.root, "messaging-cursor-key");
    try {
      return await this.readKey(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const temp = file + "." + randomUUID();
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      try {
        await fs.link(temp, file);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      const dir = await fs.open(this.root, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await fs.unlink(temp);
    }
    return this.readKey(file);
  }
  async readKey(file) {
    const key = await fs.readFile(file);
    if (key.length !== 32) throw fail("cursor_key_invalid", 503);
    return key;
  }
  async encode(binding, cursor) {
    if (typeof cursor !== "string" || cursor.length > 20000)
      throw fail("invalid_response", 502);
    const value = Buffer.from(JSON.stringify([binding, cursor])).toString(
      "base64url",
    );
    return (
      value +
      "." +
      createHmac("sha256", await this.key())
        .update(value)
        .digest("base64url")
    );
  }
  async decode(binding, token) {
    try {
      if (typeof token !== "string" || token.length > 30000) throw Error();
      const [value, mac, extra] = token.split(".");
      if (!value || !mac || extra !== undefined) throw Error();
      const supplied = Buffer.from(mac, "base64url"),
        expected = createHmac("sha256", await this.key())
          .update(value)
          .digest();
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw Error();
      const [bound, cursor] = JSON.parse(
        Buffer.from(value, "base64url").toString(),
      );
      if (
        JSON.stringify(bound) !== JSON.stringify(binding) ||
        typeof cursor !== "string"
      )
        throw Error();
      return cursor;
    } catch {
      throw fail("invalid_cursor", 409);
    }
  }
}
