import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("settings follow replaced configuration and retain normalization and persistence failure semantics", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-settings-config", manageProcessEnvironment: false });
  let writes = 0;
  store.writeConfig = async () => { writes += 1; };
  await store.updateSettings({ gateway: { trustedWorkspaces: [" /repo ", "/repo", "", null] }, codeDiff: { tool: "unknown" } });
  assert.equal(writes, 2);
  assert.deepEqual(store.gatewaySettings(), { trustedWorkspaces: ["/repo"] });
  assert.deepEqual(store.codeDiffSettings(), { tool: "automatic" });
  store.config = { codeDiff: { tool: "vscode" } };
  assert.deepEqual(store.settings().codeDiff, { tool: "vscode" });
  assert.deepEqual(store.gatewaySettings(), { trustedWorkspaces: [] });
  await assert.rejects(() => store.updateSettings({ dataDir: "/unapproved" }), { code: "DEPRECATED_SETTINGS_PATH_FIELD" });
  await assert.rejects(() => store.updateSettings({ unknown: true }), { code: "UNKNOWN_SETTINGS_FIELD" });
  assert.equal(writes, 2);
  const failure = new Error("configuration persistence failure");
  store.writeConfig = async () => { throw failure; };
  await assert.rejects(() => store.updateSettings({ codeDiff: { tool: "filemerge" } }), error => error === failure);
  // Preserve existing behavior: normalization updates memory before persistence.
  assert.deepEqual(store.codeDiffSettings(), { tool: "filemerge" });
});
