import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const output = path.resolve(".local/release/licenses");
fs.mkdirSync(output, { recursive: true });
const raw = execFileSync("go", ["list", "-m", "-json", "all"], {
  cwd: "bridge",
  encoding: "utf8",
});
let from = 0,
  depth = 0,
  inString = false,
  escape = false;
const modules = [];
for (let i = 0; i < raw.length; i++) {
  const c = raw[i];
  if (inString) {
    if (escape) escape = false;
    else if (c === "\\") escape = true;
    else if (c === '"') inString = false;
    continue;
  }
  if (c === '"') {
    inString = true;
    continue;
  }
  if (c === "{") {
    if (depth === 0) from = i;
    depth++;
  } else if (c === "}" && --depth === 0)
    modules.push(JSON.parse(raw.slice(from, i + 1)));
}
for (const m of modules) {
  if (m.Main || !m.Dir) continue;
  const dir = path.join(output, m.Path.replaceAll("/", "_") + "@" + m.Version);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(m.Dir))
    if (
      /^(license|licence|copying|notice|authors|copyright)(\.|$)/i.test(name) &&
      fs.statSync(path.join(m.Dir, name)).isFile()
    )
      fs.copyFileSync(path.join(m.Dir, name), path.join(dir, name));
}
fs.copyFileSync("NOTICE.md", path.join(output, "NOTICE.md"));
console.log(`Collected notices for ${modules.length - 1} Go modules`);
