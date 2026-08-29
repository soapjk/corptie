import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureCorptieOpenClackyRuntime } from "../src/runtime/corptieOpenClackyRuntime.mjs";

test("OpenClacky runtime bootstraps provider config into an isolated HOME once", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "corptie-openclacky-runtime-"));
  const source = join(root, "native-config.yml");
  await writeFile(source, "current: first\n", { mode: 0o600 });

  const first = await ensureCorptieOpenClackyRuntime({
    homeDir: root,
    corptieHome: join(root, "corptie"),
    sourceConfigPath: source,
    environmentName: "development"
  });
  assert.equal(first.configCopied, true);
  assert.equal(first.configAvailable, true);
  assert.equal(await readFile(first.providerConfigPath, "utf8"), "current: first\n");
  assert.equal((await stat(first.providerConfigPath)).mode & 0o777, 0o600);
  assert.equal(first.providerConfigPath, join(first.providerHome, ".clacky", "config.yml"));

  await writeFile(source, "current: changed\n", { mode: 0o600 });
  const second = await ensureCorptieOpenClackyRuntime({
    homeDir: root,
    corptieHome: join(root, "corptie"),
    sourceConfigPath: source,
    environmentName: "development"
  });
  assert.equal(second.configCopied, false);
  assert.equal(await readFile(second.providerConfigPath, "utf8"), "current: first\n");
});
