import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureBinary } from "./binary.js";
import { fail } from "./errors.js";
export class Bridge {
  constructor(executable, dir, { spawnProcess = spawn } = {}) {
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.closed = false;
    this.child = spawnProcess(executable, ["--data-dir", dir], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.exited = new Promise((resolve) => this.child.once("close", resolve));
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
    this.child.stdout.on("data", (chunk) => {
      this.buffer += this.decoder.write(chunk);
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) {
        this.fail();
        this.child.kill();
        return;
      }
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          this.fail();
          this.child.kill();
          return;
        }
        if (d.event === "changes" && d.id === undefined) {
          for (const fn of [...this.listeners]) fn();
          continue;
        }
        const p = this.pending.get(d.id);
        if (!p) continue;
        p.cleanup();
        this.pending.delete(d.id);
        if (d.error) {
          const code = /^[a-z_]{1,100}$/.test(d.error.code)
            ? d.error.code
            : "helper_failed";
          p.reject(
            fail(
              code,
              Number.isInteger(d.error.status) &&
                d.error.status >= 400 &&
                d.error.status <= 599
                ? d.error.status
                : 502,
              { definitive: d.error.definitive === true },
            ),
          );
        } else p.resolve(d.result);
      }
    });
  }
  fail() {
    this.closed = true;
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(fail("helper_unavailable", 503));
    }
    this.pending.clear();
    for (const fn of [...this.listeners]) fn();
  }
  waitForChange(signal) {
    if (this.closed || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.listeners.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      this.listeners.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  call(method, args = {}, { signal } = {}) {
    if (this.closed) return Promise.reject(fail("helper_unavailable", 503));
    if (this.pending.size >= 128)
      return Promise.reject(fail("helper_busy", 503));
    const id = randomUUID();
    if (signal?.aborted) return Promise.reject(fail("cancelled", 499));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        this.pending.delete(id);
        cleanup();
        reject(fail("cancelled", 499));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(fail("helper_timeout", 504));
      }, 100000);
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      this.child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
    });
  }
  async close() {
    this.fail();
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    await this.exited;
    clearTimeout(timer);
  }
}
export class Pool {
  constructor(
    ctx,
    {
      create = (file, dir) => new Bridge(file, dir),
      binary = ensureBinary,
    } = {},
  ) {
    this.ctx = ctx;
    this.create = create;
    this.binary = binary;
    this.helpers = new Map();
    this.closed = false;
  }
  profile(id) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    )
      throw fail("invalid_profile", 401);
    return path.join(this.ctx.dataDir, "profiles", id);
  }
  async get(id) {
    if (this.closed) throw fail("plugin_unavailable", 503);
    const existing = this.helpers.get(id);
    if (existing) {
      const h = await existing;
      if (!h.closed) return h;
      if (this.helpers.get(id) !== existing) return this.get(id);
      this.helpers.delete(id);
    }
    const p = (async () => {
      const dir = this.profile(id);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700);
      const h = this.create(await this.binary(this.ctx), dir);
      if (this.closed) {
        await h.close();
        throw fail("plugin_unavailable", 503);
      }
      let v;
      try {
        v = await h.call("version");
      } catch (error) {
        await h.close();
        throw error;
      }
      if (v.protocol !== 1 || v.version !== this.ctx.manifest.version) {
        await h.close();
        throw fail("helper_version_mismatch", 503);
      }
      h.features = new Set(
        Array.isArray(v.features)
          ? v.features.filter((x) => typeof x === "string")
          : [],
      );
      return h;
    })();
    this.helpers.set(id, p);
    try {
      return await p;
    } catch (e) {
      this.helpers.delete(id);
      throw e;
    }
  }
  async call(id, method, args, options) {
    return (await this.get(id)).call(method, args, options);
  }
  async restart(id) {
    const h = this.helpers.get(id);
    this.helpers.delete(id);
    if (h)
      await h.then(
        (value) => value.close(),
        () => {},
      );
    return this.get(id);
  }
  async drop(id) {
    const h = this.helpers.get(id);
    this.helpers.delete(id);
    if (h)
      await h.then(
        (value) => value.close(),
        () => {},
      );
    await fs.rm(this.profile(id), { recursive: true, force: true });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(
      [...this.helpers.values()].map(async (p) => (await p).close()),
    );
    this.helpers.clear();
  }
  async restore() {
    const root = path.join(this.ctx.dataDir, "profiles");
    for (const id of await fs.readdir(root).catch(() => [])) {
      try {
        const active = JSON.parse(
          await fs.readFile(path.join(this.profile(id), "active.json"), "utf8"),
        );
        void this.call(id, "start", { expectedAccount: active.account }).catch(
          () => this.ctx.log?.warn("WhatsApp session requires attention"),
        );
      } catch {}
    }
  }
}
