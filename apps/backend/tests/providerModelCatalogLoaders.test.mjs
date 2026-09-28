import assert from "node:assert/strict";
import test from "node:test";
import { createProviderModelCatalogLoaders } from "../src/adapters/providerModelCatalogLoaders.mjs";

function fixture() {
  const calls = [];
  const runtime = {
    query: () => ({ supportedModels: async () => [{ value: "claude-model", supportedEffortLevels: ["high", null] }] }),
    close: () => calls.push("close")
  };
  const loaders = createProviderModelCatalogLoaders({
    store: { listSessions: () => [{ external: { provider: "claude-sdk", currentModel: "claude-model" } }] },
    codexAppServerCommand: () => "/runtime/codex",
    corptieCodexRuntimePaths: { codexHome: "/runtime/home" },
    environmentForCommand: () => ({}),
    execFileAsync: async (...args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ models: [
        { slug: "other", visibility: "list", priority: 10 },
        { slug: "current", visibility: "list", priority: 1 },
        { slug: "hidden", visibility: "hidden" },
        { slug: "auto-review-internal", visibility: "list" }
      ] }) };
    },
    readCodexDefaultConfig: async () => ({ model: "current", reasoningLevel: "high" }),
    defaultWorkspacePath: () => "/workspace",
    claudeCommand: () => "/runtime/claude",
    startup: async () => { calls.push("startup"); return runtime; }
  });
  return { loaders, calls, runtime };
}

test("Codex catalog filters internal models and keeps the current model first", async () => {
  const f = fixture();
  const result = await f.loaders.loadCodexModels();
  assert.deepEqual(result.models.map((model) => model.id), ["current", "other"]);
  assert.equal(result.currentReasoningLevel, "high");
  assert.equal(f.calls[0][2].env.CODEX_HOME, "/runtime/home");
  assert.equal(await f.loaders.loadCodexModels(), result);
  assert.equal(f.calls.length, 1);
  await f.loaders.loadCodexModels({ refresh: true });
  assert.equal(f.calls.length, 2);
});

test("Claude catalog closes its discovery runtime and caches the normalized result", async () => {
  const f = fixture();
  const result = await f.loaders.loadClaudeModels();
  assert.equal(result.currentModel, "claude-model");
  assert.deepEqual(result.models[0].reasoningLevels, ["high"]);
  assert.deepEqual(f.calls, ["startup", "close"]);
  assert.equal(await f.loaders.loadClaudeModels(), result);
  assert.deepEqual(f.calls, ["startup", "close"]);
});

test("Claude discovery failure still closes the runtime and is not cached", async () => {
  const f = fixture();
  f.runtime.query = () => ({ supportedModels: async () => { throw new Error("unavailable"); } });
  await assert.rejects(f.loaders.loadClaudeModels(), /unavailable/);
  await assert.rejects(f.loaders.loadClaudeModels(), /unavailable/);
  assert.deepEqual(f.calls, ["startup", "close", "startup", "close"]);
});
