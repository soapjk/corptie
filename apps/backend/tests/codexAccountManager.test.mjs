import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexEnvironmentRegistry } from "../src/runtime/codexEnvironmentRegistry.mjs";
import { CodexAccountManager } from "../src/adapters/codexAccountManager.mjs";

const credential = (id, token = "test-token") => JSON.stringify({ tokens: { account_id: id, access_token: token } });

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "corptie-accounts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const isolatedHome = join(root, "legacy");
  await mkdir(isolatedHome);
  const original = credential("old");
  await writeFile(join(isolatedHome, "auth.json"), original);
  const registry = new CodexEnvironmentRegistry({ isolatedHome, nativeHome: join(root, "native"),
    path: () => join(root, "environments.json") });
  await registry.initialize();
  await registry.register(registry.current, { threadId: "existing" });
  const options = { registry, path: () => join(root, "accounts.json"), sourceKinds: ["file"],
    readSource: async ({ path }) => ({ content: await readFile(path, "utf8") }), prepare: async () => {},
    bindingCount: profile => Object.keys(registry.state.threads).filter(id => registry.forThread(id).profileId === profile.profileId).length,
    ...extra };
  const manager = new CodexAccountManager(options);
  await manager.initialize();
  return { manager, registry, root, original, options };
}

test("migration and default switching preserve the original account and its session binding", async t => {
  const { manager, registry, root, original, options } = await fixture(t);
  const old = registry.current;
  const source = { kind: "file", path: join(root, "official-auth.json") };
  await writeFile(source.path, credential("new"));
  const result = await manager.operation({ action: "import", name: "New", source });
  const added = result.accounts.accounts.find(row => row.name === "New");
  assert.equal(result.accounts.selectedAccountId, old.profileId);
  assert.equal((await stat(added.credentialPath)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes("test-token"));
  await manager.select(added.id);
  assert.equal(registry.current.profileId, added.id);
  assert.equal(registry.forThread("existing").profileId, old.profileId);
  assert.equal(registry.forThread("unindexed-old").profileId, old.profileId);
  await writeFile(source.path, credential("different"));
  await manager.assertProfileReady(registry.current);
  await manager.assertProfileReady(registry.forThread("existing"));
  assert.equal(await readFile(join(old.home, "auth.json"), "utf8"), original);
  await assert.rejects(manager.operation({ action: "import", accountId: old.profileId, source }), { code: "CODEX_ACCOUNT_MISMATCH" });
  await assert.rejects(manager.operation({ action: "delete", accountId: added.id }), { code: "CODEX_ACCOUNT_IN_USE" });
  const restored = new CodexAccountManager(options);
  await restored.initialize();
  assert.equal((await restored.list()).selectedAccountId, added.id);
  await restored.select(old.profileId);
  await restored.operation({ action: "delete", accountId: added.id });
  assert.equal(await readFile(source.path, "utf8"), credential("different"));
  await assert.rejects(stat(added.credentialPath), { code: "ENOENT" });
});

test("official login writes to a staging Home and verifies identity before replacing credentials", async t => {
  let notify;
  const { manager, registry, original } = await fixture(t, {
    command: () => "mock-codex",
    environment: profile => ({ CODEX_HOME: profile.home }),
    createClient: ({ env, onNotification }) => {
      notify = onNotification;
      return {
        initialize: async () => {},
        close: async () => {},
        async request(method) {
          assert.equal(method, "account/login/start");
          await writeFile(join(env.CODEX_HOME, "auth.json"), credential("wrong-account"));
          return { loginId: "mock-login", authUrl: "https://auth.openai.com/authorize" };
        }
      };
    }
  });
  const result = await manager.operation({ action: "login", accountId: registry.current.profileId });
  assert.equal(result.flow.state, "pending");
  notify({ method: "account/login/completed", params: { loginId: "mock-login", success: true } });
  const status = await manager.operation({ action: "loginStatus", loginId: result.flow.id });
  assert.equal(status.flow.state, "failed");
  assert.equal(await readFile(join(registry.current.home, "auth.json"), "utf8"), original);
});

test("discovery lists only readable credentials without reading the keychain implicitly", async t => {
  const { manager, root } = await fixture(t);
  const valid = join(root, "existing.json");
  await writeFile(valid, credential("discovered"));
  manager.candidates = [
    { kind: "file", path: valid },
    { kind: "file", path: join(root, "missing.json") },
    { kind: "keychain", path: valid }
  ];
  const result = await manager.operation({ action: "discover" });
  assert.deepEqual(result.discovered, [{ kind: "file", path: valid, label: "ChatGPT 账号" }]);
  assert.ok(!JSON.stringify(result).includes("test-token"));
  const imported = await manager.operation({ action: "import", source: result.discovered[0] });
  assert.equal(imported.accounts.accounts.find(account => account.origin === "imported")?.name, "ChatGPT 账号");
});
