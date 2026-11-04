import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
async function run(t, overrides = {}) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "whatsapp-release-check-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pr = {
    state: "open",
    base: { ref: "main" },
    head: {
      ref: "release-please--branches--main--components--example",
      sha: "a".repeat(40),
      repo: { full_name: "fixture/example" },
    },
    ...overrides,
  };
  const log = path.join(dir, "dispatch.json");
  await fs.writeFile(
    path.join(dir, "gh"),
    `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='api')process.stdout.write(process.env.FIXTURE_PR);else fs.writeFileSync(process.env.FIXTURE_LOG,JSON.stringify(args));`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/dispatch-release-checks.js"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: dir + path.delimiter + process.env.PATH,
        GH_TOKEN: "fixture",
        GH_REPO: "fixture/example",
        RELEASE_PRS: '[{"number":1}]',
        FIXTURE_PR: JSON.stringify(pr),
        FIXTURE_LOG: log,
      },
    },
  );
  return {
    result,
    dispatch: await fs
      .readFile(log, "utf8")
      .then(JSON.parse)
      .catch(() => null),
  };
}
test("release PR checks dispatch at the verified immutable head without a personal token", async (t) => {
  const { result, dispatch } = await run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(dispatch, [
    "workflow",
    "run",
    "check.yml",
    "--ref",
    "release-please--branches--main--components--example",
    "-f",
    "expected_sha=" + "a".repeat(40),
  ]);
});
test("release check dispatch rejects unexpected refs, forks, closed PRs and malformed revisions", async (t) => {
  for (const override of [
    { state: "closed" },
    { base: { ref: "other" } },
    {
      head: {
        ref: "other",
        sha: "a".repeat(40),
        repo: { full_name: "fixture/example" },
      },
    },
    {
      head: {
        ref: "release-please--branches--main",
        sha: "a".repeat(40),
        repo: { full_name: "fork/example" },
      },
    },
    {
      head: {
        ref: "release-please--branches--main",
        sha: "invalid",
        repo: { full_name: "fixture/example" },
      },
    },
  ]) {
    const { result, dispatch } = await run(t, override);
    assert.notEqual(result.status, 0);
    assert.equal(dispatch, null);
  }
});
