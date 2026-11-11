import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRuntimeSettings, jsonCredentialReader } from "../src/application/providerRuntimeSettings.mjs";
import { createProviderCredentialAdapters, selectedCredentialEnvironment } from "../src/adapters/providerCredentialAdapters.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "corptie-credential-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "official.json"), target = join(root, "runtime", "auth.json");
  const writeSource = (account = "one", token = "original") => writeFile(source, JSON.stringify({ account, token }));
  await writeSource();
  let busy = false, changes = 0;
  const options = { path: () => join(root, "sources.json"), adapters: { test: {
    runtimeDirectory: join(root, "runtime"), target, sourceKinds: ["file", "directory"],
    read: jsonCredentialReader({ fileName: "auth.json", validate: v => Boolean(v.token), identity: v => v.account })
  } }, isBusy: () => busy, onChanged: async () => { changes++; } };
  const service = new ProviderRuntimeSettings(options);
  await service.initialize();
  const select = () => service.saveSource("test", { kind: "file", path: source });
  return { root, source, target, service, select, writeSource, options, setBusy: value => { busy = value; }, changes: () => changes };
}

test("selection performs local validation and projections never expose credential contents", async t => {
  const f = await fixture(t);
  await f.select();
  const projection = await f.service.describe("test");
  assert.equal(projection.state, "found");
  assert.equal(projection.source.path, f.source);
  assert.ok(!JSON.stringify(projection).includes("original"));
  await assert.rejects(readFile(f.target), { code: "ENOENT" });
  await f.service.sync("test");
  assert.equal(JSON.parse(await readFile(f.target)).token, "original");
  assert.equal((await stat(f.target)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(f.source)).token, "original");
});

test("official token refresh synchronizes, while provider-local refreshed tokens survive an unchanged source", async t => {
  const f = await fixture(t);
  await f.select(); await f.service.sync("test");
  await writeFile(f.target, JSON.stringify({ account: "one", token: "provider-refresh" }));
  await f.service.sync("test");
  assert.equal(JSON.parse(await readFile(f.target)).token, "provider-refresh");
  await f.writeSource("one", "official-refresh");
  assert.equal((await f.service.describe("test")).sourceChanged, true);
  await f.service.sync("test");
  assert.equal(JSON.parse(await readFile(f.target)).token, "official-refresh");
});

test("account changes require explicit application, and deleted sources never fall back to cached credentials", async t => {
  const f = await fixture(t);
  await f.select(); await f.service.sync("test");
  await f.writeSource("two", "new-account");
  assert.equal((await f.service.describe("test")).state, "account_changed");
  await assert.rejects(f.service.sync("test"), { code: "PROVIDER_ACCOUNT_CHANGED" });
  assert.equal(JSON.parse(await readFile(f.target)).account, "one");
  await f.select(); await f.service.sync("test");
  assert.equal(JSON.parse(await readFile(f.target)).account, "two");
  await rm(f.source);
  await assert.rejects(f.service.sync("test"), { code: "PROVIDER_SOURCE_UNAVAILABLE" });
});

test("source choice persists across restarts and cannot change a running provider", async t => {
  const f = await fixture(t);
  await f.select();
  const restarted = new ProviderRuntimeSettings(f.options);
  await restarted.initialize();
  assert.equal((await restarted.describe("test")).source.path, f.source);
  f.setBusy(true);
  await assert.rejects(f.select(), { code: "PROVIDER_BUSY" });
  await assert.rejects(restarted.sync("test"), { code: "PROVIDER_BUSY" });
});

test("invalid and self-referencing sources are rejected without leaking their content", async t => {
  const f = await fixture(t);
  await writeFile(f.source, "SECRET malformed JSON");
  await assert.rejects(f.select(), error => error.code === "PROVIDER_SOURCE_UNAVAILABLE" && !error.message.includes("SECRET"));
  const alias = join(f.root, "alias");
  await symlink(join(f.root, "runtime"), alias);
  await assert.rejects(f.service.saveSource("test", { kind: "directory", path: alias }), { code: "PROVIDER_SOURCE_INVALID" });
});

test("credential adapters advertise supported sources for every provider without implicit keychain reads", async t => {
  const f = await fixture(t);
  let reads = 0;
  const adapters = createProviderCredentialAdapters({
    codexPaths: { codexHome: "/runtime/codex", authPath: "/runtime/codex/auth.json" },
    claudePaths: { configDir: "/runtime/claude", credentialsPath: "/runtime/claude/.credentials.json", sourceCredentialsPath: "/official/claude/.credentials.json" },
    openClackyPaths: { runtimeRoot: "/runtime/openclacky" }, nativeCodexHome: "/official/codex",
    readCodexSource: async (_path, options) => { reads++; assert.equal(options.allowKeychainRead, true); return null; }
  });
  assert.deepEqual(adapters["claude-sdk"].sourceKinds, ["directory", "file", "settings", "connection"]);
  assert.equal(adapters.openclacky.sourceKinds.length, 0);
  assert.match(adapters.openclacky.unsupportedReason, /不支持/);
  await adapters["codex-app-server"].read({ kind: "keychain", path: "/official/codex" });
  assert.equal(reads, 1);
  await writeFile(f.source, JSON.stringify({ tokens: { access_token: "token", account_id: "account" } }));
  const value = await adapters["codex-app-server"].read({ kind: "file", path: f.source });
  assert.ok(value.identity);
  assert.equal(reads, 1);
});

test('new runtimes require a chosen source, while legacy credentials remain readable with an explicit legacy state', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.describe('test')).state, 'unselected');
  await assert.rejects(f.service.sync('test'), { code: 'PROVIDER_SOURCE_REQUIRED' });
  await writeFile(f.target, JSON.stringify({ account: 'legacy', token: 'old' }));
  assert.equal((await f.service.describe('test')).state, 'legacy');
  await f.service.sync('test');
  assert.equal(JSON.parse(await readFile(f.target)).account, 'legacy');
});

test('reply probes hold credential changes until the client has finished', async t => {
  const f = await fixture(t);
  await f.select(); await f.service.sync('test');
  const release = f.service.acquire('test');
  await assert.rejects(f.select(), { code: 'PROVIDER_BUSY' });
  release(); release();
  await f.select();
  assert.equal(f.service.isBusy('test'), false);
});

test('explicit sources remove inherited credential overrides without changing the parent environment', () => {
  const original = { ANTHROPIC_API_KEY: 'other-account', CLAUDE_CODE_OAUTH_TOKEN: 'other-token',
    OPENAI_API_KEY: 'other-key', HTTP_PROXY: 'http://127.0.0.1:7890' };
  const claude = selectedCredentialEnvironment(original, 'claude-sdk', true);
  assert.equal(claude.ANTHROPIC_API_KEY, undefined);
  assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(claude.HTTP_PROXY, original.HTTP_PROXY);
  assert.equal(original.ANTHROPIC_API_KEY, 'other-account');
  assert.equal(selectedCredentialEnvironment(original, 'codex-app-server', true).OPENAI_API_KEY, undefined);
  assert.equal(selectedCredentialEnvironment(original, 'claude-sdk', false), original);
});
