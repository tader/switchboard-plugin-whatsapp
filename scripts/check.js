import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { operations, openapi } from "../plugins/whatsapp/lib/operations.js";
const manifest = JSON.parse(
  fs.readFileSync("plugins/whatsapp/plugin.json", "utf8"),
);
assert.equal(
  manifest.version,
  JSON.parse(fs.readFileSync("package.json", "utf8")).version,
);
assert.equal(manifest.id, "whatsapp");
assert.equal(new Set(operations.map((o) => o.id)).size, operations.length);
for (const o of operations)
  assert.equal(openapi.paths[o.path][o.method.toLowerCase()].operationId, o.id);
for (const root of ["plugins/whatsapp/lib", "scripts", "test"])
  for (const f of fs.readdirSync(root))
    if (f.endsWith(".js"))
      execFileSync(process.execPath, ["--check", `${root}/${f}`]);
console.log(
  `Validated ${operations.length} WhatsApp operations and plugin manifest`,
);

assert.equal(
  fs.readFileSync("bridge/main.go", "utf8").match(/var version = "([^"]+)"/)[1],
  manifest.version,
);
