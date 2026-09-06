import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FirstRunSetupService } from "../src/application/firstRunSetupService.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "corptie-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "provider with spaces");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  let works = false, session = null, launches = 0;
  const configured = [], probes = [];
  const options = {
    path: () => join(root, "setup.json"),
    providers: ["codex-app-server", "claude-sdk", "openclacky"].map(id => ({
      id, name: id, discover: () => binary,
      configure: async path => configured.push({ id, path }),
      probe: async path => { probes.push({ id, path }); return { ok: true }; }
    })),
    hasWorks: () => works, findAssistantSession: () => session,
    createAssistantSession: async provider => {
      launches += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      return session = { id: "session:assistant", provider };
    }
  };
  const service = new FirstRunSetupService(options);
  await service.initialize();
  return { service, options, binary, configured, probes, setWorks: () => { works = true; }, launches: () => launches };
}

test("discovery and legacy user confirmation cannot substitute for a reply test", async t => {
  const f = await fixture(t);
  f.service.state.providers["codex-app-server"] = { path: f.binary, confirmed: true };
  assert.ok((await f.service.status()).providers.every(p => !p.enabled && p.checkState === "unknown"));
  await assert.rejects(f.service.setEnabled({ providerId: "codex-app-server", path: f.binary, enabled: true }));
  await assert.rejects(f.service.prepareAssistant());
  assert.equal(f.probes.length, 0);
});

for (const providerId of ["codex-app-server", "claude-sdk", "openclacky"]) {
  test(`${providerId}: real adapter success automatically enables the exact tested binary`, async t => {
    const f = await fixture(t);
    const row = await f.service.check({ providerId, path: f.binary });
    assert.equal(row.checkState, "available");
    assert.equal(row.enabled, true);
    assert.deepEqual(f.probes, [{ id: providerId, path: f.binary }]);
    assert.deepEqual(f.configured, f.probes);
    const restored = new FirstRunSetupService(f.options);
    await restored.initialize();
    assert.equal((await restored.status()).providers.find(p => p.id === providerId).enabled, true);
    assert.equal(restored.command(providerId, () => "wrong"), f.binary);
    await chmod(f.binary, 0o600);
    assert.equal((await restored.status()).providers.find(p => p.id === providerId).enabled, false);
    await assert.rejects(restored.prepareAssistant());
  });
}

test("failed, empty and invalid-path tests do not enable or configure the Provider", async t => {
  const f = await fixture(t);
  f.options.providers[0].probe = async () => ({ ok: false });
  assert.equal((await f.service.check({ providerId: "codex-app-server", path: f.binary })).enabled, false);
  assert.equal((await f.service.check({ providerId: "openclacky", path: "/missing/provider" })).checkState, "missing");
  assert.equal(f.configured.length, 0);
  await assert.rejects(f.service.prepareAssistant());
});

test("the user's disabled choice survives retest and restart", async t => {
  const f = await fixture(t);
  const input = { providerId: "claude-sdk", path: f.binary };
  await f.service.check(input);
  await f.service.setEnabled({ ...input, enabled: false });
  const row = await f.service.check(input);
  assert.equal(row.checkState, "available");
  assert.equal(row.enabled, false);
  const restored = new FirstRunSetupService(f.options);
  await restored.initialize();
  assert.equal((await restored.status()).providers.find(p => p.id === input.providerId).enabled, false);
  await restored.setEnabled({ ...input, enabled: true });
  assert.equal((await restored.status()).defaultProviderId, input.providerId);
});

test("same-path requests coalesce and obsolete responses cannot enable a replacement path", async t => {
  const f = await fixture(t);
  let settle, began;
  const started = new Promise(resolve => { began = resolve; });
  f.options.providers[0].probe = async () => { began(); return new Promise(resolve => { settle = resolve; }); };
  const first = f.service.check({ providerId: "codex-app-server", path: f.binary });
  assert.equal(f.service.check({ providerId: "codex-app-server", path: f.binary }), first);
  await started;
  await f.service.check({ providerId: "codex-app-server", path: "/missing/new" });
  settle({ ok: true });
  await first;
  const row = (await f.service.status()).providers[0];
  assert.equal(row.path, "/missing/new");
  assert.equal(row.enabled, false);
});

test("one slow Provider does not block enabling another", async t => {
  const f = await fixture(t);
  let settle;
  f.options.providers[0].probe = () => new Promise(resolve => { settle = resolve; });
  const slow = f.service.check({ providerId: "codex-app-server", path: f.binary });
  const fast = await f.service.check({ providerId: "claude-sdk", path: f.binary });
  assert.equal(fast.enabled, true);
  assert.equal((await f.service.prepareAssistant()).sessionId, "session:assistant");
  settle({ ok: true });
  await slow;
  assert.equal((await f.service.status()).defaultProviderId, "claude-sdk");
});

test("replaced executable invalidates persisted success", async t => {
  const f = await fixture(t);
  await f.service.check({ providerId: "openclacky", path: f.binary });
  await writeFile(f.binary, "#!/bin/sh\nexit 1\n# different build\n");
  const row = (await f.service.status()).providers[2];
  assert.equal(row.checkState, "unknown");
  assert.equal(row.enabled, false);
});

test("concurrent Chat preparation and restart reuse the same Session", async t => {
  const f = await fixture(t);
  await f.service.check({ providerId: "claude-sdk", path: f.binary });
  await Promise.all([f.service.prepareAssistant(), f.service.prepareAssistant()]);
  assert.equal(f.launches(), 1);
  await assert.rejects(f.service.complete());
  f.setWorks();
  assert.equal((await f.service.complete()).completed, true);
});

test("existing Work skips setup and remains completed after Works are removed", async t => {
  const f = await fixture(t);
  await writeFile(f.options.path(), JSON.stringify({ completed: false, providers: {} }));
  f.setWorks();
  const restarted = new FirstRunSetupService(f.options);
  await restarted.initialize();
  assert.equal((await restarted.status()).completed, true);
  const empty = new FirstRunSetupService({ ...f.options, hasWorks: () => false });
  await empty.initialize();
  assert.equal((await empty.status()).completed, true);
  assert.equal(f.probes.length, 0);
});

test("new installs require setup while legacy installs without markers skip it", async t => {
  const f = await fixture(t);
  assert.equal((await f.service.status()).completed, false);
  f.setWorks();
  const legacy = new FirstRunSetupService(f.options);
  await legacy.initialize();
  assert.equal((await legacy.status()).completed, true);
});
