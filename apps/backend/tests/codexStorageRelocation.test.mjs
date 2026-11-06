import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebaseCodexStoragePaths } from "../src/runtime/codexStorageRelocation.mjs";
import { CodexEnvironmentRegistry } from "../src/runtime/codexEnvironmentRegistry.mjs";

test("moving the data root preserves legacy and account profile IDs and leaves external homes alone", async t => {
  const root = await mkdtemp(join(tmpdir(), "codex-rebase-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceLayout = { dataRoot: join(root, "old") };
  const targetLayout = { dataRoot: join(root, "new") };
  const stagingLayout = { dataRoot: join(root, "stage") };
  await mkdir(stagingLayout.dataRoot);
  const path = () => join(stagingLayout.dataRoot, "codex-environments.json");
  const registry = new CodexEnvironmentRegistry({ path, isolatedHome: join(sourceLayout.dataRoot, "runtimes", "codex") });
  const native = registry.profile("native", join(root, "external"));
  const managed = registry.profile("isolated", join(sourceLayout.dataRoot, "runtimes", "codex-accounts", "b"));
  await registry.register(native, { threadId: "native" });
  await registry.register(managed, { makeDefault: true, threadId: "account" });
  const initial = JSON.parse(await readFile(path(), "utf8"));
  delete initial.legacyProfileId; // Upgraded registry.
  await writeFile(path(), JSON.stringify(initial));
  await rebaseCodexStoragePaths({ sourceLayout, targetLayout, stagingLayout });
  const loaded = new CodexEnvironmentRegistry({ path, isolatedHome: join(targetLayout.dataRoot, "runtimes", "codex") });
  await loaded.initialize();
  assert.equal(loaded.current.profileId, managed.profileId);
  assert.equal(loaded.forThread("account").home, join(targetLayout.dataRoot, "runtimes", "codex-accounts", "b"));
  assert.equal(loaded.forThread("native").home, native.home);
  assert.equal(loaded.forThread("old-unindexed-thread").profileId, registry.legacy.profileId);
});
