import { ProviderRuntimeSettings, jsonCredentialReader } from "../src/application/providerRuntimeSettings.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FirstRunSetupService } from "../src/application/firstRunSetupService.mjs";
import { ProviderExecutableDiscovery } from "../src/application/providerExecutableDiscovery.mjs";

test("account changes invalidate connection proof without replacing provider or enable intent", async t => {
  const f = await fixture(t);
  const id = "codex-app-server";
  await f.service.check({ providerId: id, path: f.binary });
  const previous = structuredClone(f.service.state);
  await f.service.invalidateConnectionTest(id);
  const saved = f.service.state.providers[id];
  assert.equal(saved.probe.state, "unknown");
  assert.equal((await f.service.status()).providers[0].enabled, true);
  assert.equal(saved.probe.code, "PROVIDER_ACCOUNT_CHANGED");
  assert.equal(saved.configuredPath, previous.providers[id].configuredPath);
  assert.equal(saved.enabled, previous.providers[id].enabled);
  assert.equal(saved.userDisabled, previous.providers[id].userDisabled);
  assert.equal(f.service.state.defaultProvider, previous.defaultProvider);
  await f.service.setEnabled({ providerId: id, path: f.binary, enabled: true });
  assert.equal((await f.service.status()).providers[0].checkState, "unknown");
});

test("automatic inventory adopts exactly the tested program; failed candidates and rescans preserve it", async t => {
  const f = await fixture(t);
  const provider = f.options.providers[0];
  const second = `${f.binary}-new`;
  await writeFile(second, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  provider.programDiscovery = new ProviderExecutableDiscovery({ candidates: () => [
    { path: f.binary, source: "cli" }, { path: second, source: "ChatGPT" }],
    probeVersion: async path => ({ version: path === second ? "0.155.0-alpha.16" : "0.141.0", state: "discovered" }) });
  await provider.programDiscovery.scan();
  assert.equal((await f.service.status()).providers[0].program.mode, "auto");
  assert.equal(f.service.command(provider.id, () => "wrong"), second);
  const row = await f.service.check({ providerId: provider.id, path: second, selectionMode: "auto", model: "test-model" });
  assert.equal(row.enabled, true);
  assert.equal(row.program.mode, "auto");
  assert.equal(row.program.model, "test-model");
  assert.equal(f.service.command(provider.id, () => "wrong"), second);
  await f.service.validateRuntimeProgram(provider.id, second);
  const saved = structuredClone(f.service.state);
  provider.probe = async () => { throw new Error("candidate failed"); };
  assert.equal((await f.service.check({ providerId: provider.id, path: f.binary })).checkState, "failed");
  assert.deepEqual(f.service.state, saved);
  assert.equal((await f.service.status()).providers[0].enabled, true);
  await f.service.scanPrograms({ providerId: provider.id });
  assert.deepEqual(f.service.state, saved);
  assert.equal(f.probes.length, 1);
  await writeFile(second, "#!/bin/sh\n# upgraded\nexit 0\n");
  await assert.rejects(f.service.validateRuntimeProgram(provider.id, second), { code: "PROVIDER_PROGRAM_CHANGED" });
});

test("cancelled or different-model probes never commit obsolete results", async t => {
  const f = await fixture(t);
  let began, finish;
  const started = new Promise(resolve => { began = resolve; });
  f.options.providers[0].probe = async (_, { model }) => {
    if (model === "slow") { began(); await new Promise(resolve => { finish = resolve; }); }
    return { ok: true };
  };
  const slow = f.service.check({ providerId: "codex-app-server", path: f.binary, model: "slow", checkId: "old" });
  await started;
  await f.service.cancelCheck({ providerId: "codex-app-server", checkId: "not-old" });
  assert.equal(f.service.checks.size, 1);
  await f.service.cancelCheck({ providerId: "codex-app-server", checkId: "old" });
  assert.equal(f.service.checks.size, 0);
  const fast = await f.service.check({ providerId: "codex-app-server", path: f.binary, model: "new", checkId: "new" });
  assert.equal(fast.enabled, true);
  finish(); await slow;
  assert.equal(f.service.state.providers["codex-app-server"].probe.model, "new");
});

test("controlled paths, legacy paths and explicitly disabled choices are preserved", async t => {
  const f = await fixture(t);
  const provider = f.options.providers[0];
  let controlled = null;
  provider.programDiscovery = new ProviderExecutableDiscovery({ candidates: () => [], controlledPath: () => controlled });
  await f.service.check({ providerId: provider.id, path: f.binary });
  await f.service.setEnabled({ providerId: provider.id, path: f.binary, enabled: false });
  assert.equal((await f.service.check({ providerId: provider.id, path: f.binary })).enabled, false);
  delete f.service.state.providers[provider.id].selectionMode;
  assert.equal((await f.service.status()).providers[0].program.mode, "auto");
  controlled = "/missing/controlled";
  assert.equal(f.service.command(provider.id, () => "wrong"), controlled);
  assert.equal((await f.service.status()).providers[0].path, controlled);
  assert.throws(() => f.service.check({ providerId: provider.id, path: f.binary }), /运行环境/);
});

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

test("environment checks commit only successful candidates and invalidate on Home config changes", async t => {
  const f = await fixture(t);
  const provider = f.options.providers[0];
  let current = { profileId: "old", mode: "isolated", home: "/old" };
  let configRevision = 1;
  provider.resolveEnvironment = input => input ?? current;
  provider.environmentDescriptor = input => input ?? current;
  provider.environmentFingerprint = async profile => `${profile.profileId}:${configRevision}`;
  provider.configureEnvironment = async profile => { current = profile; };
  provider.probe = async (_, { environment }) => ({ ok: true, environment });
  const input = { providerId: provider.id, path: f.binary };
  assert.equal((await f.service.check(input)).enabled, true);
  const candidate = { profileId: "new", mode: "native", home: "/new" };
  provider.probe = async () => { throw Object.assign(new Error("needs login"), { code: "PROVIDER_LOGIN_REQUIRED" }); };
  const failed = await f.service.check({ ...input, environment: candidate });
  assert.equal(failed.errorCode, "PROVIDER_LOGIN_REQUIRED");
  assert.equal(failed.enabled, true);
  assert.equal(failed.environment.profileId, "new");
  assert.equal(current.profileId, "old");
  assert.equal((await f.service.status()).providers[0].enabled, true);
  provider.probe = async (_, { environment }) => ({ ok: true, environment });
  assert.equal((await f.service.check({ ...input, environment: candidate })).enabled, true);
  assert.equal(current.profileId, "new");
  configRevision++;
  assert.equal((await f.service.status()).providers[0].enabled, true);
  assert.equal((await f.service.status()).providers[0].checkState, "unknown");
});

test("same CLI with different environments does not coalesce or commit stale results", async t => {
  const f = await fixture(t);
  const provider = f.options.providers[0];
  let current = { profileId: "old", mode: "isolated", home: "/old" };
  provider.resolveEnvironment = input => input ?? current;
  provider.environmentDescriptor = input => input ?? current;
  provider.environmentFingerprint = async profile => profile.profileId;
  provider.configureEnvironment = async profile => { current = profile; };
  let started, finish;
  const began = new Promise(resolve => { started = resolve; });
  provider.probe = async (_, { environment }) => {
    if (environment.profileId === "slow") { started(); await new Promise(resolve => { finish = resolve; }); }
    return { ok: true, environment };
  };
  const input = { providerId: provider.id, path: f.binary };
  const slow = f.service.check({ ...input, environment: { ...current, profileId: "slow" } });
  await began;
  const fast = await f.service.check({ ...input, environment: { ...current, profileId: "fast" } });
  assert.equal(fast.environment.profileId, "fast");
  finish(); await slow;
  assert.equal(current.profileId, "fast");
});

test("discovery and legacy user confirmation cannot substitute for a reply test", async t => {
  const f = await fixture(t);
  f.service.state.providers["codex-app-server"] = { path: f.binary, confirmed: true };
  assert.ok((await f.service.status()).providers.every(p => !p.enabled && p.checkState === "unknown"));
  await f.service.setEnabled({ providerId: "codex-app-server", path: f.binary, enabled: true });
  assert.equal((await f.service.status()).providers[0].checkState, "unknown");
  await f.service.prepareAssistant();
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
    assert.equal((await restored.status()).providers.find(p => p.id === providerId).enabled, true);
    assert.equal((await restored.status()).providers.find(p => p.id === providerId).checkState, "missing");
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
  assert.equal(row.enabled, true);
});

test("concurrent Chat preparation and restart reuse the same Session", async t => {
  const f = await fixture(t);
  await f.service.check({ providerId: "claude-sdk", path: f.binary });
  await Promise.all([f.service.prepareAssistant(), f.service.prepareAssistant()]);
  assert.equal(f.launches(), 1);
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

for (const providerId of ["codex-app-server", "claude-sdk", "openclacky"]) {
  test(`${providerId}: single-step completion creates Chat without a Work`, async t => {
    const f = await fixture(t);
    await assert.rejects(f.service.complete());
    await f.service.check({ providerId, path: f.binary });
    await f.service.setEnabled({ providerId, path: f.binary, enabled: false });
    await assert.rejects(f.service.complete());
    await f.service.setEnabled({ providerId, path: f.binary, enabled: true });
    const done = await f.service.complete();
    assert.equal(done.completed, true);
    assert.equal(done.hasWorks, false);
    const restarted = new FirstRunSetupService(f.options);
    await restarted.initialize();
    assert.equal((await restarted.status()).completed, true);
  });
}


test("concurrent completion initializes once and greeting retry reuses the Session", async t => {
  const f = await fixture(t);
  let greetings = 0;
  f.service.ensureAssistantGreeting = async () => {
    greetings += 1;
    if (greetings === 1) throw new Error("greeting failed");
  };
  await f.service.check({ providerId: "claude-sdk", path: f.binary });
  await assert.rejects(f.service.complete(), /greeting failed/);
  assert.equal((await f.service.status()).completed, false);
  await Promise.all([f.service.complete(), f.service.complete()]);
  assert.equal(f.launches(), 1);
  assert.equal(greetings, 2);
  assert.equal((await f.service.status()).completed, true);
  assert.equal((await f.service.status()).hasWorks, false);
});

test("completed retries respect removal of the assistant Session", async t => {
  const f = await fixture(t);
  await f.service.check({ providerId: "openclacky", path: f.binary });
  await f.service.complete();
  f.service.findAssistantSession = () => null;
  assert.equal((await f.service.complete()).completed, true);
  assert.equal(f.launches(), 1);
});


test("assistant preparation failure preserves setup and succeeds on retry", async t => {
  const f = await fixture(t);
  await f.service.check({ providerId: "openclacky", path: f.binary });
  f.options.providers[2].prepare = async () => { throw new Error("runtime unavailable"); };
  await assert.rejects(f.service.complete(), /runtime unavailable/);
  assert.equal((await f.service.status()).completed, false);
  assert.equal(f.launches(), 0);
  f.options.providers[2].prepare = async () => {};
  assert.equal((await f.service.complete()).completed, true);
  assert.equal(f.launches(), 1);
});

test("completion rechecks binary availability after Session creation", async t => {
  const f = await fixture(t);
  await f.service.check({ providerId: "codex-app-server", path: f.binary });
  f.options.providers[0].prepare = async () => chmod(f.binary, 0o600);
  await assert.rejects(f.service.complete());
  assert.equal((await f.service.status()).completed, false);
});

for (const providerId of ["codex-app-server", "claude-sdk", "openclacky"]) {
  test(`${providerId}: migrate existing use without claiming a successful reply test`, async t => {
    const f = await fixture(t);
    await writeFile(f.options.path(), JSON.stringify({ completed: true, providers: {} }));
    const options = { ...f.options, hasProviderUsage: id => id === providerId };
    const migrated = new FirstRunSetupService(options);
    await migrated.initialize();
    const row = (await migrated.status()).providers.find(p => p.id === providerId);
    assert.equal(row.enabled, true);
    assert.equal(row.checkState, "unknown");
    assert.equal(f.probes.length, 0);
    assert.equal(f.configured.length, 0);
    await migrated.prepareAssistant();
    assert.ok((await migrated.status()).providers.filter(p => p.id !== providerId).every(p => !p.enabled));
    await migrated.setEnabled({ providerId, path: f.binary, enabled: false });
    const restarted = new FirstRunSetupService(options);
    await restarted.initialize();
    assert.equal((await restarted.status()).providers.find(p => p.id === providerId).enabled, false);
    assert.equal(restarted.state.providers[providerId].userDisabled, true);
  });
}

test("failed rechecks and account invalidation retain enabled intent", async t => {
  const f = await fixture(t);
  const providerId = "claude-sdk";
  await f.service.check({ providerId, path: f.binary });
  f.options.providers[1].probe = async () => { throw new Error("disconnected"); };
  const row = await f.service.check({ providerId, path: f.binary });
  assert.equal(row.enabled, true);
  assert.equal(row.checkState, "failed");
  await f.service.prepareAssistant();
  await f.service.setEnabled({ providerId, path: f.binary, enabled: false });
  assert.equal((await f.service.status()).providers[1].enabled, false);
});

for (const providerId of ["codex-app-server", "claude-sdk", "openclacky"]) {
  test(`${providerId}: local program adoption and enable intent do not require a paid reply`, async t => {
    const f = await fixture(t);
    await f.service.setProgram({ providerId, path: f.binary });
    await f.service.setEnabled({ providerId, path: f.binary, enabled: true });
    assert.equal(f.service.isEnabled(providerId), true);
    assert.equal(f.probes.length, 0);
    assert.equal((await f.service.row(f.service.provider(providerId))).checkState, "unknown");
    await f.service.setEnabled({ providerId, path: f.binary, enabled: false });
    assert.throws(() => f.service.assertExecutionAllowed(providerId), { code: "PROVIDER_DISABLED", dispatchState: "not_dispatched" });
    assert.equal(f.service.state.defaultProviderId, providerId);
  });
}

test('one settings submission adopts executable and enable intent with no paid checks', async t => {
  const f = await fixture(t);
  const status = await f.service.saveSettings({ providers: [{ providerId: 'codex-app-server', path: f.binary, enabled: true }] });
  assert.equal(status.providers[0].enabled, true);
  assert.equal(f.probes.length, 0);
  assert.equal(f.service.command('codex-app-server', () => 'wrong'), f.binary);
});

test('invalid engine in a multi-engine form leaves earlier engine enable intent untouched', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.saveSettings({ providers: [
    { providerId: 'codex-app-server', path: f.binary, enabled: true },
    { providerId: 'claude-sdk', path: '/missing/claude', enabled: true }
  ] }));
  assert.equal(f.service.isEnabled('codex-app-server'), false);
  assert.equal(f.configured.length, 0);
  assert.equal(f.probes.length, 0);
});

test('page save applies credential source and enable state together without a model request', async t => {
  const f = await fixture(t);
  const source = `${f.binary}-official-auth.json`;
  await writeFile(source, JSON.stringify({ token: 'synthetic-token' }));
  const runtime = new ProviderRuntimeSettings({ path: () => `${f.binary}-sources.json`,
    adapters: Object.fromEntries(f.options.providers.map(p => [p.id, {
      runtimeDirectory: `${f.binary}-${p.id}-runtime`, target: `${f.binary}-${p.id}-runtime/auth.json`,
      sourceKinds: ['file'], read: jsonCredentialReader({ fileName: 'auth.json', validate: value => Boolean(value.token) })
    }])), onChanged: id => f.service.invalidateConnectionTest(id) });
  await runtime.initialize();
  f.service.runtimeSettings = runtime;
  const status = await f.service.saveSettings({ providers: [{ providerId: 'codex-app-server', path: f.binary,
    enabled: true, source: { kind: 'file', path: source } }] });
  assert.equal(status.providers[0].enabled, true);
  assert.equal(status.providers[0].runtime.source.path, source);
  assert.equal(f.probes.length, 0);
});

test("account management is advertised only by providers that implement it, and default changes use settings save", async t => {
  const f = await fixture(t);
  const provider = f.options.providers[0];
  let selectedAccountId = "old";
  provider.accounts = {
    list: async () => ({ selectedAccountId }),
    validateSelection: async id => assert.equal(id, "new"),
    select: async id => { selectedAccountId = id; },
    operation: async input => ({ action: input.action })
  };
  assert.equal((await f.service.accountOperation(provider.id, null)).selectedAccountId, "old");
  assert.deepEqual(await f.service.accountOperation(provider.id, { action: "rename" }), { action: "rename" });
  const status = await f.service.status();
  const row = status.providers.find(value => value.id === provider.id);
  const other = status.providers.find(value => value.id !== provider.id);
  assert.equal(row.accounts.selectedAccountId, "old");
  assert.equal(other.accounts, undefined);
  await assert.rejects(f.service.accountOperation(other.id, null), /不支持账号管理/);
  await assert.rejects(f.service.saveCredentialSource({ providerId: provider.id }), /账号管理/);
  const saved = await f.service.saveSettings({ providers: [
    { providerId: provider.id, path: row.path, enabled: row.enabled, accountId: "new" }
  ] });
  assert.equal(saved.providers.find(value => value.id === provider.id).accounts.selectedAccountId, "new");
});
