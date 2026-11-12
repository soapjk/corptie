import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRuntimeSettings } from "../src/application/providerRuntimeSettings.mjs";
import { createProviderCredentialAdapters, selectedCredentialEnvironment } from "../src/adapters/providerCredentialAdapters.mjs";
import { createProviderModelCatalogLoaders } from "../src/adapters/providerModelCatalogLoaders.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "corptie-model-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { configDir: join(root, "runtime"), credentialsPath: join(root, "runtime", ".credentials.json"),
    settingsPath: join(root, "runtime", "settings.json"), sourceSettingsPath: join(root, "native-settings.json"),
    sourceCredentialsPath: join(root, "native-credentials.json") };
  const adapters = createProviderCredentialAdapters({
    codexPaths: { codexHome: join(root, "codex"), authPath: join(root, "codex", "auth.json") },
    claudePaths: paths, openClackyPaths: { runtimeRoot: join(root, "clacky") }, nativeCodexHome: join(root, "native-codex"),
    readCodexSource: async () => { throw new Error("Unexpected credential read"); }
  });
  const options = { path: () => join(root, "sources.json"), adapters };
  const service = new ProviderRuntimeSettings(options);
  await service.initialize();
  return { root, paths, options, service };
}
const manual = { endpoint: "https://gateway.invalid", model: "fixture-model", authType: "authToken",
  credential: "fixture-gateway-token" };

test("import only connection settings and preserve native files and Corptie-owned configuration", async t => {
  const f = await fixture(t);
  const native = { env: { ANTHROPIC_BASE_URL: manual.endpoint, ANTHROPIC_AUTH_TOKEN: manual.credential,
    OTHER_SECRET: "not-imported" }, model: manual.model, hooks: { Stop: ["native"] }, permissions: { allow: ["Bash(*)"] } };
  await writeFile(f.paths.sourceSettingsPath, JSON.stringify(native));
  await writeFile(f.paths.settingsPath, JSON.stringify({ permissions: { deny: ["Bash(rm *)"] }, env: { CORPTIE_OWNED: "keep" } }));
  const projection = await f.service.saveSource("claude-sdk", { kind: "settings", path: f.paths.sourceSettingsPath });
  assert.equal(projection.connection.current.model, manual.model);
  assert.equal(projection.connection.current.credentialConfigured, true);
  assert.ok(!JSON.stringify(projection).includes(manual.credential));
  assert.ok(!JSON.stringify(projection).includes("not-imported"));
  await f.service.sync("claude-sdk");
  const target = JSON.parse(await readFile(f.paths.settingsPath, "utf8"));
  assert.equal(target.env.ANTHROPIC_AUTH_TOKEN, manual.credential);
  assert.equal(target.env.CORPTIE_OWNED, "keep");
  assert.equal(target.env.OTHER_SECRET, undefined);
  assert.equal(target.hooks, undefined);
  assert.deepEqual(target.permissions, { deny: ["Bash(rm *)"] });
  assert.deepEqual(JSON.parse(await readFile(f.paths.sourceSettingsPath, "utf8")), native);
  assert.equal((await stat(f.paths.settingsPath)).mode & 0o777, 0o600);
});

test("manual source survives restart without returning credentials and reaches execution environment", async t => {
  const f = await fixture(t);
  const projection = await f.service.saveConnection("claude-sdk", manual);
  assert.equal(projection.source.kind, "connection");
  assert.equal(projection.connection.current.endpoint, manual.endpoint);
  assert.ok(!JSON.stringify(projection).includes(manual.credential));
  const inherited = { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_CUSTOM_HEADERS: "Authorization: old",
    ANTHROPIC_API_KEY: "wrong-key", ANTHROPIC_BASE_URL: "https://wrong.invalid", HTTP_PROXY: "http://localhost:1" };
  const env = f.service.executionEnvironment("claude-sdk", selectedCredentialEnvironment(inherited, "claude-sdk", true));
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, manual.credential);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, manual.endpoint);
  assert.equal(env.ANTHROPIC_MODEL, manual.model);
  assert.equal(env.HTTP_PROXY, inherited.HTTP_PROXY);
  assert.equal(inherited.ANTHROPIC_API_KEY, "wrong-key");
  await f.service.sync("claude-sdk");
  const restarted = new ProviderRuntimeSettings(f.options);
  await restarted.initialize();
  assert.equal(restarted.executionEnvironment("claude-sdk", {}).ANTHROPIC_AUTH_TOKEN, manual.credential);
  await restarted.saveConnection("claude-sdk", { ...manual, model: "other-model", credential: null });
  assert.equal(restarted.executionEnvironment("claude-sdk", {}).ANTHROPIC_AUTH_TOKEN, manual.credential);
  assert.equal(restarted.connectionMetadata("claude-sdk").model, "other-model");
});

test("switching to an account clears prepared gateway credentials; unsupported providers stay unsupported", async t => {
  const f = await fixture(t);
  await f.service.saveConnection("claude-sdk", manual);
  await writeFile(f.paths.sourceCredentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "fixture-oauth-token" } }));
  await f.service.saveSource("claude-sdk", { kind: "file", path: f.paths.sourceCredentialsPath });
  assert.equal(f.service.executionEnvironment("claude-sdk", {}).ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(f.service.connectionMetadata("claude-sdk"), null);
  assert.equal(await readFile(join(f.paths.configDir, ".corptie-source-managed"), "utf8"), "");
  for (const provider of ["codex-app-server", "openclacky"]) {
    await assert.rejects(f.service.saveConnection(provider, manual), { code: "PROVIDER_CONNECTION_UNSUPPORTED" });
  }
});

test("manual save validates locally, rejects active execution and restores exact settings on persistence failure", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.saveConnection("claude-sdk", { ...manual, credential: null }), { code: "PROVIDER_CONNECTION_INVALID" });
  const release = f.service.acquire("claude-sdk");
  await assert.rejects(f.service.saveConnection("claude-sdk", manual), { code: "PROVIDER_BUSY" });
  release();
  const previous = '{ "permissions": { "deny": ["Bash(rm *)"] } }';
  await writeFile(f.paths.settingsPath, previous);
  f.service.persist = async () => { throw new Error("fixture write failure"); };
  await assert.rejects(f.service.saveConnection("claude-sdk", manual), /fixture write failure/);
  assert.equal(await readFile(f.paths.settingsPath, "utf8"), previous);
  assert.equal(f.service.sources["claude-sdk"], undefined);
  assert.equal(f.service.connectionMetadata("claude-sdk"), null);
});

test("invalid URLs and imports do not echo secrets in public failures", async t => {
  const f = await fixture(t);
  for (const endpoint of ["file:///tmp/file", "https://user:fixture-secret@gateway.invalid", "https://gateway.invalid?token=fixture-secret"]) {
    await assert.rejects(f.service.saveConnection("claude-sdk", { ...manual, endpoint }),
      error => error.code === "PROVIDER_CONNECTION_INVALID" && !error.message.includes("fixture-secret"));
  }
  await writeFile(f.paths.sourceSettingsPath, JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: "https://user:fixture-secret@gateway.invalid", ANTHROPIC_AUTH_TOKEN: manual.credential } }));
  await assert.rejects(f.service.saveSource("claude-sdk", { kind: "settings", path: f.paths.sourceSettingsPath }),
    error => !error.message.includes(manual.credential) && !error.message.includes("fixture-secret"));
});

test("configured gateway model catalog does not start the SDK or use stale official aliases", async () => {
  let current = { model: "custom-one" };
  const { loadClaudeModels } = createProviderModelCatalogLoaders({
    claudeConnection: () => current,
    startup: async () => { throw new Error("No SDK startup is needed for an explicitly configured model"); }
  });
  assert.equal((await loadClaudeModels()).currentModel, "custom-one");
  current = { model: "custom-two" };
  assert.deepEqual((await loadClaudeModels()).models.map(row => row.id), ["custom-two"]);
});


test("failure after persisting a manual source restores previous settings, source and prepared credentials", async t => {
  const f = await fixture(t);
  await f.service.saveConnection("claude-sdk", manual);
  const beforeSettings = await readFile(f.paths.settingsPath, "utf8");
  const beforeSources = await readFile(f.options.path(), "utf8");
  f.service.onChanged = async () => { throw new Error("fixture invalidation failure"); };
  await assert.rejects(f.service.saveConnection("claude-sdk", { ...manual, credential: "replacement-fixture-token" }), /fixture invalidation failure/);
  assert.equal(await readFile(f.paths.settingsPath, "utf8"), beforeSettings);
  assert.equal(await readFile(f.options.path(), "utf8"), beforeSources);
  assert.equal(f.service.executionEnvironment("claude-sdk", {}).ANTHROPIC_AUTH_TOKEN, manual.credential);
});


test("import preserves native effective model and bearer credential precedence", async t => {
  const f = await fixture(t);
  await writeFile(f.paths.sourceSettingsPath, JSON.stringify({
    model: "file-default", env: { ANTHROPIC_MODEL: "effective-model",
      ANTHROPIC_AUTH_TOKEN: "selected-fixture-token", ANTHROPIC_API_KEY: "unused-fixture-key" }
  }));
  const projection = await f.service.saveSource("claude-sdk", { kind: "settings", path: f.paths.sourceSettingsPath });
  assert.equal(projection.connection.current.model, "effective-model");
  const env = f.service.executionEnvironment("claude-sdk", {});
  assert.equal(env.ANTHROPIC_MODEL, "effective-model");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "selected-fixture-token");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});


test("native apiKeyHelper imports without execution or disclosure and survives restart and source switches", async t => {
  const f = await fixture(t);
  const marker = join(f.root, "helper-must-not-run");
  const helper = `touch '${marker}'; printf fixture-helper-key`;
  const native = { apiKeyHelper: helper, env: { ANTHROPIC_BASE_URL: manual.endpoint,
    ANTHROPIC_MODEL: manual.model }, hooks: { Stop: ["untrusted-hook"] } };
  await writeFile(f.paths.sourceSettingsPath, JSON.stringify(native));
  const before = await readFile(f.paths.sourceSettingsPath, "utf8");
  assert.equal((await f.service.describe("claude-sdk")).candidates[0].state, "found");
  const projection = await f.service.saveSource("claude-sdk", { kind: "settings", path: f.paths.sourceSettingsPath });
  assert.equal(projection.connection.current.authType, "helper");
  assert.equal(projection.connection.current.credentialConfigured, true);
  assert.ok(!JSON.stringify(projection).includes(helper));
  await f.service.sync("claude-sdk");
  const imported = JSON.parse(await readFile(f.paths.settingsPath, "utf8"));
  assert.equal(imported.apiKeyHelper, helper);
  assert.equal(imported.hooks, undefined);
  assert.equal(await readFile(f.paths.sourceSettingsPath, "utf8"), before);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  const restarted = new ProviderRuntimeSettings(f.options);
  await restarted.initialize();
  assert.deepEqual(restarted.executionOptions("claude-sdk"), { settings: { apiKeyHelper: helper } });
  assert.equal(restarted.executionEnvironment("claude-sdk", {}).ANTHROPIC_MODEL, manual.model);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  await restarted.saveConnection("claude-sdk", manual);
  assert.deepEqual(restarted.executionOptions("claude-sdk"), {});
  assert.equal(JSON.parse(await readFile(f.paths.settingsPath, "utf8")).apiKeyHelper, undefined);
});
