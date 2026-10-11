import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderExecutableDiscovery, compareExecutableVersions, parseExecutableVersion } from "../src/application/providerExecutableDiscovery.mjs";

test("semantic ordering handles numeric prereleases and core versions", () => {
  assert.ok(compareExecutableVersions("0.155.0-alpha.16", "0.155.0-alpha.9") > 0);
  assert.ok(compareExecutableVersions("0.155.0", "0.155.0-alpha.16") > 0);
  assert.ok(compareExecutableVersions("0.155.0-alpha.16", "0.141.0") > 0);
  assert.ok(compareExecutableVersions("0.10.0", "0.9.0") > 0);
  assert.equal(parseExecutableVersion("codex-cli 0.155.0-alpha.16\n").version, "0.155.0-alpha.16");
  assert.equal(parseExecutableVersion("unknown"), null);
});

test("inventory deduplicates symlinks and recommends newest independently of PATH order", async t => {
  const root = await mkdtemp(join(tmpdir(), "corptie-binaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const older = join(root, "old codex"), newer = join(root, "new codex"), alias = join(root, "alias");
  await writeFile(older, "#!/bin/sh\necho 'codex-cli 0.141.0'\n", { mode: 0o700 });
  await writeFile(newer, "#!/bin/sh\necho 'codex-cli 0.155.0-alpha.16'\n", { mode: 0o700 });
  await symlink(newer, alias);
  let calls = 0;
  const discovery = new ProviderExecutableDiscovery({ candidates: () => [
    { path: older, source: "cli" }, { path: newer, source: "ChatGPT" }, { path: alias, source: "alias" }],
    probeVersion: async path => { calls++; return { version: path === older ? "0.141.0" : "0.155.0-alpha.16", state: "discovered" }; } });
  const result = await discovery.scan();
  assert.equal(result.recommendedPath, newer);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0].sources, ["ChatGPT", "alias"]);
  await discovery.scan(); assert.equal(calls, 2);
  await writeFile(newer, "#!/bin/sh\n# updated binary\n");
  await discovery.scan(); assert.equal(calls, 3);
  assert.equal(discovery.describe({ configuredPath: older }).mode, "legacyPinned");
  assert.equal(discovery.describe({ configuredPath: older }).adoptedPath, older);
});

test("controlled missing path remains authoritative and actual probes are bounded", async t => {
  const root = await mkdtemp(join(tmpdir(), "corptie-version-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "codex with spaces");
  await writeFile(binary, "#!/bin/sh\necho 'codex-cli 1.0.0'\n", { mode: 0o700 });
  const discovery = new ProviderExecutableDiscovery({ candidates: () => [{ path: binary, source: "cli" }],
    controlledPath: () => "/missing/controlled" });
  const result = await discovery.scan();
  assert.equal(result.mode, "controlled");
  assert.equal(result.recommendedPath, "/missing/controlled");
  assert.equal(result.candidates[0].version, "1.0.0");
  await writeFile(binary, "#!/bin/sh\nwhile :; do :; done\n");
  const bounded = new ProviderExecutableDiscovery({ candidates: () => [{ path: binary, source: "cli" }],
    perCandidateMs: 25, budgetMs: 100 });
  const started = Date.now();
  assert.equal((await bounded.scan()).candidates[0].state, "timeout");
  assert.ok(Date.now() - started < 1000);
});
