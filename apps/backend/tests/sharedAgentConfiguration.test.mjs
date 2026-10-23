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
