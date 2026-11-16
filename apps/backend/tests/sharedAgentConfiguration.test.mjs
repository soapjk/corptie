import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SHARED_AGENT_CONFIGURATION_PATHS, linkSharedAgentConfiguration } from "../src/runtime/sharedAgentConfiguration.mjs";

test("Corptie local state is never linked, even through explicit legacy shared-path overrides", async t => {
  const root = await mkdtemp(join(tmpdir(), "corptie-shared-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mainPath = join(root, "main"), targetPath = join(root, "task");
  await mkdir(join(mainPath, ".corptie/runtime"), { recursive: true });
  await mkdir(targetPath);
  assert.equal(DEFAULT_SHARED_AGENT_CONFIGURATION_PATHS.includes(".corptie"), false);
  const result = await linkSharedAgentConfiguration({ mainPath, targetPath,
    paths: [".corptie", "./.corptie", ".corptie/runtime"],
    execFile: async () => assert.fail("Excluded local state must not reach Git or symlink operations") });
  assert.deepEqual(result.linked, []);
  assert.deepEqual(await readdir(targetPath), []);
});

test("explicit configuration sharing never changes repository ignore rules", async t => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "corptie-explicit-share-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mainPath = join(root, "main"), targetPath = join(root, "task"), commonGitDir = join(root, "git");
  await mkdir(mainPath); await mkdir(targetPath); await mkdir(join(commonGitDir, "info"), { recursive: true });
  await writeFile(join(mainPath, "AGENTS.md"), "instructions");
  const original = "# user ignore rules\ncustom\n";
  await writeFile(join(commonGitDir, "info/exclude"), original);
  const result = await linkSharedAgentConfiguration({ mainPath, targetPath, commonGitDir, paths: ["AGENTS.md"], execFile: async () => { throw Object.assign(new Error(), { code: 1 }); } });
  assert.deepEqual(result.linked, ["AGENTS.md"]);
  assert.equal(await readFile(join(commonGitDir, "info/exclude"), "utf8"), original);
});
