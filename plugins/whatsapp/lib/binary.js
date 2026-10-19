import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.js";
export async function bounded(response, max) {
  if (!response.ok) {
    await response.body?.cancel();
    throw fail(
      response.status === 404
        ? "helper_release_unavailable"
        : "helper_download_failed",
      503,
    );
  }
  const chunks = [];
  let n = 0;
  if (!response.body) throw fail("helper_download_failed", 503);
  for await (const b of response.body) {
    n += b.length;
    if (n > max) throw fail("helper_download_too_large", 503);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
export async function ensureBinary(
  ctx,
  { fetcher = fetch, platform = process.platform, arch = process.arch } = {},
) {
  if (ctx.settings.bridgePath) {
    if (!path.isAbsolute(ctx.settings.bridgePath))
      throw fail("helper_path_must_be_absolute", 400);
    await fs.access(ctx.settings.bridgePath, fs.constants.X_OK);
    return ctx.settings.bridgePath;
  }
  if (
    !["darwin", "linux"].includes(platform) ||
    !["arm64", "x64"].includes(arch)
  )
    throw fail("helper_platform_unsupported", 503);
  const version = ctx.manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw fail("invalid_helper_version", 503);
  const name = `whatsapp-bridge-${platform === "darwin" ? "darwin" : "linux"}-${arch === "x64" ? "amd64" : "arm64"}`,
    dir = path.join(ctx.dataDir, "bin", version),
    file = path.join(dir, name),
    marker = file + ".sha256";
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  try {
    const expected = (await fs.readFile(marker, "utf8")).trim();
    if (
      /^[a-f0-9]{64}$/.test(expected) &&
      sha(await fs.readFile(file)) === expected
    ) {
      await fs.chmod(file, 0o700);
      return file;
    }
  } catch {}
  const base = `https://github.com/tader/switchboard-plugin-whatsapp/releases/download/v${version}`;
  const get = async (url, max) =>
    bounded(
      await fetcher(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(120000),
      }),
      max,
    );
  const sums = (await get(base + "/sha256sums.txt", 16384)).toString("utf8");
  const expected = sums
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find((x) => x[1] === name)?.[0];
  if (!/^[a-f0-9]{64}$/.test(expected ?? ""))
    throw fail("helper_checksum_missing", 503);
  const bytes = await get(base + "/" + name, 128 * 1024 * 1024);
  if (sha(bytes) !== expected) throw fail("helper_checksum_mismatch", 503);
  const temp = file + "." + randomUUID();
  try {
    await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o700 });
    await fs.rename(temp, file);
    await fs.writeFile(marker, expected, { mode: 0o600 });
  } finally {
    await fs.rm(temp, { force: true });
  }
  return file;
}
