import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexEnvironmentRegistry } from "../src/runtime/codexEnvironmentRegistry.mjs";

async function fixture(t, { legacyConfig = false, hasExistingSessions = () => false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "corptie-environments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { path: () => join(root, "environments.json"),
    isolatedHome: join(root, "isolated"), nativeHome: join(root, "native"), hasExistingSessions };
  await mkdir(options.isolatedHome); await mkdir(options.nativeHome);
  if (legacyConfig) await writeFile(join(options.isolatedHome, "config.toml"), 'model = "legacy-model"\n');
  const registry = new CodexEnvironmentRegistry(options);
  await registry.initialize();
  return { registry, root, options };
}

test("a new installation defaults to native while unindexed threads remain isolated", async t => {
  const { registry, options } = await fixture(t);
  assert.equal(registry.current.mode, "native");
  assert.equal(registry.current.home, options.nativeHome);
  assert.equal(registry.forThread("unindexed-old-thread").mode, "isolated");
  const restored = new CodexEnvironmentRegistry(options);
  await restored.initialize();
  assert.equal(restored.current.mode, "native");
});

test("upgrades default new Sessions to official Home while preserving legacy threads and configuration", async t => {
  const { registry, options } = await fixture(t, { legacyConfig: true });
  assert.equal(registry.current.mode, "native");
  const config = await readFile(join(options.isolatedHome, "config.toml"), "utf8");
  assert.equal(config, 'model = "legacy-model"\n');
  const restored = new CodexEnvironmentRegistry(options);
  await restored.initialize();
  assert.equal(restored.current.mode, "native");
  assert.equal(restored.forThread("old-thread").mode, "isolated");
  assert.equal(await readFile(join(options.isolatedHome, "config.toml"), "utf8"), config);
});

test("existing sessions retain legacy bindings while new Sessions use native Home", async t => {
  const { registry } = await fixture(t, { hasExistingSessions: () => true });
  assert.equal(registry.current.mode, "native");
  assert.equal(registry.forThread("old-thread").mode, "isolated");
});

test("an explicitly saved native selection survives upgrade evidence", async t => {
  const { registry, options } = await fixture(t, { legacyConfig: true });
  await registry.register(registry.selection({ mode: "native" }), { makeDefault: true, threadId: "native-thread" });
  const restored = new CodexEnvironmentRegistry(options);
  await restored.initialize();
  assert.equal(restored.current.mode, "native");
  assert.equal(restored.forThread("native-thread").mode, "native");
  assert.equal(restored.forThread("old-thread").mode, "isolated");
});

test("a legacy isolated default no longer controls new Sessions after restart", async t => {
  const { registry, options } = await fixture(t);
  await registry.register(registry.legacy, { makeDefault: true });
  const restored = new CodexEnvironmentRegistry(options);
  await restored.initialize();
  assert.equal(restored.current.mode, "native");
  assert.equal(restored.forThread("unindexed").profileId, registry.legacy.profileId);
});

test("default changes never reroute old threads, including after restart", async t => {
  const { registry, options } = await fixture(t);
  const legacy = registry.legacy;
  assert.equal(registry.forThread("unindexed-old-thread").profileId, legacy.profileId);
  await registry.register(legacy, { threadId: "old" });
  const native = await registry.validate(registry.selection({ mode: "native" }));
  await registry.register(native, { makeDefault: true });
  await registry.register(native, { threadId: "new" });
  const restored = new CodexEnvironmentRegistry(options);
  await restored.initialize();
  assert.equal(restored.current.mode, "native");
  assert.equal(restored.forThread("old").mode, "isolated");
  assert.equal(restored.forThread("new").mode, "native");
  assert.equal(restored.forThread("unindexed-old-thread").mode, "isolated");
});

test("validation canonicalizes Home without changing native configuration or authentication", async t => {
  const { registry, root, options } = await fixture(t);
  await writeFile(join(options.nativeHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
  await writeFile(join(options.nativeHome, "auth.json"), "do-not-read-or-import");
  const alias = join(root, "alias"); await symlink(options.nativeHome, alias);
  const native = await registry.validate(registry.selection({ mode: "native", home: alias }));
  assert.equal(native.home, await realpath(options.nativeHome));
  assert.equal(await readFile(join(options.nativeHome, "config.toml"), "utf8"), 'cli_auth_credentials_store = "keyring"\n');
  assert.equal(await readFile(join(options.nativeHome, "auth.json"), "utf8"), "do-not-read-or-import");
  await assert.rejects(registry.validate(registry.selection({ mode: "native", home: join(root, "missing") })), /无法访问/);
  assert.throws(() => registry.selection({ mode: "native", home: "relative/path" }), /绝对/);
  const isolatedAlias = join(root, "isolated-alias"); await symlink(options.isolatedHome, isolatedAlias);
  await assert.rejects(registry.validate(registry.selection({ mode: "native", home: isolatedAlias })), /无法访问/);
});

test("config changes invalidate environment fingerprint, credentials are not inspected", async t => {
  const { registry, options } = await fixture(t);
  const first = await registry.fingerprint(registry.current);
  await writeFile(join(options.nativeHome, "config.toml"), 'model = "different-model"\n');
  assert.notEqual(await registry.fingerprint(registry.current), first);
  const second = await registry.fingerprint(registry.current);
  await writeFile(join(options.nativeHome, "auth.json"), "private");
  assert.equal(await registry.fingerprint(registry.current), second);
});

test("a retired custom default does not replace the official Home on restart", async t => {
  const { registry, options, root } = await fixture(t);
  const home = join(root, "custom-native"); await mkdir(home);
  await registry.register(registry.selection({ mode: "native", home }), { makeDefault: true });
  await registry.register(registry.legacy, { makeDefault: true });
  const restored = new CodexEnvironmentRegistry(options); await restored.initialize();
  assert.equal(restored.nativeHome, options.nativeHome);
  assert.equal(restored.current.mode, "native");
});

test("first official login can create its own missing Home without Corptie writing config or credentials", async t => {
  const { registry, options } = await fixture(t);
  await rm(options.nativeHome, { recursive: true });
  assert.equal((await registry.validate(registry.current)).home, options.nativeHome);
  await assert.rejects(readFile(join(options.nativeHome, "config.toml")), { code: "ENOENT" });
  await assert.rejects(registry.validate(registry.selection({ mode: "native", home: join(options.nativeHome, "missing-custom") })),
    { code: "PROVIDER_HOME_UNAVAILABLE" });
});
