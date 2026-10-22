import http from "node:http";
import { randomBytes } from "node:crypto";
import { Pool } from "./bridge.js";
import { Service } from "./service.js";
import { createAuth } from "./auth.js";
import { operations, openapi } from "./operations.js";
import { fail, publicError } from "./errors.js";
import { validate } from "./validate.js";
export async function createAdapter(ctx, { pool = new Pool(ctx) } = {}) {
  const auth = createAuth(pool, ctx.capabilities),
    service = new Service(ctx, pool),
    invocations = new Map();
  let closed = false;
  const route = (method, url) =>
    operations.find(
      (op) =>
        op.method === (method === "HEAD" ? "GET" : method) &&
        op.path === (url.pathname === "/" ? "/status" : url.pathname),
    );
  const timer = setInterval(() => {
    for (const [key, value] of invocations)
      if (value.expires < Date.now()) invocations.delete(key);
  }, 10_000);
  timer.unref();
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const key = String(req.headers.authorization ?? "").replace(
          /^Bearer /,
          "",
        ),
        invocation = invocations.get(key);
      invocations.delete(key);
      if (
        !invocation ||
        invocation.expires < Date.now() ||
        invocation.method !== req.method ||
        invocation.path !== req.url
      )
        throw fail("invalid_invocation", 401);
      const url = new URL(req.url, "http://whatsapp.localhost"),
        op = route(req.method, url);
      if (!op) throw fail("not_found", 404);
      let input;
      if (op.method === "GET") {
        if (
          [...url.searchParams.keys()].some(
            (k) => url.searchParams.getAll(k).length !== 1,
          )
        )
          throw fail("invalid_input");
        input = validate(Object.fromEntries(url.searchParams), op.input, true);
      } else {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 128 * 1024) throw fail("body_too_large", 413);
          chunks.push(chunk);
        }
        let raw;
        try {
          raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw fail("invalid_json");
        }
        input = validate(raw, op.input);
      }
      const result = await service.invoke(
        op,
        input,
        invocation.conn,
        controller.signal,
      );
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      const status =
        Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status <= 599
          ? error.status
          : 500;
      if (!res.headersSent)
        res.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
          ...(error.retryAfter
            ? { "retry-after": String(error.retryAfter) }
            : {}),
        });
      res.end(JSON.stringify({ error: publicError(error) }));
    }
  });
  server.requestTimeout = 35_000;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (e) {
    clearInterval(timer);
    await auth.dispose();
    await pool.close();
    service.dispose();
    throw e;
  }
  const origin = new URL(`http://127.0.0.1:${server.address().port}`);
  await pool.restore?.();
  return {
    services: [
      {
        id: "whatsapp",
        name: "WhatsApp",
        description: "WhatsApp linked-device messaging",
        icon: "icon.svg",
        baseUrl: "http://whatsapp.localhost",
        allowedHosts: ["whatsapp.localhost", origin.host],
        openapi,
        authMethods: auth.methods.map(method => ({
            ...method,
            async authorize(req, conn, opts = {}) {
              if (closed) throw fail("plugin_unavailable", 503);
              if (
                !["whatsapp.localhost", origin.host].includes(req.url.host) ||
                req.url.protocol !== "http:" ||
                req.url.username ||
                req.url.password
              )
                throw fail("request_forbidden", 403);
              const op = route(req.method, req.url);
              if (!op) throw fail("request_forbidden", 403);
              if (invocations.size >= 1024) throw fail("adapter_busy", 503);
              await auth.ready(conn);
              const credentials = conn.credentials;
              const key = randomBytes(32).toString("base64url");
              invocations.set(key, {
                conn: { ...conn, credentials },
                method: req.method,
                path: req.url.pathname + req.url.search,
                expires: Date.now() + 30_000,
              });
              req.url.host = origin.host;
              req.headers.set("authorization", `Bearer ${key}`);
              if (credentials !== conn.credentials) return { credentials };
            },
          })),
      },
    ],
    async dispose() {
      closed = true;
      await auth.dispose();
      clearInterval(timer);
      invocations.clear();
      const drained = new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      });
      await pool.close();
      await drained;
      service.dispose();
    },
  };
}
