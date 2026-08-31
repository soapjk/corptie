import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveWorkspaceTransitionRuntime } from "../src/application/workspaceTransitionRuntimeRouting.mjs";

test("workspace transition recovery loads Provider-owned options only for its selected runtime", async () => {
  const codexManager = {};
  const claudeManager = {};
  const openClackyManager = {};
  let codexOptionLoads = 0;
  const runtimes = {
    "codex-app-server": {
      manager: codexManager,
      loadOptions: async () => {
        codexOptionLoads += 1;
        return { dynamicTools: [{ name: "corptie_tool_call" }] };
      }
    },
    "claude-sdk": { manager: claudeManager },
    openclacky: { manager: openClackyManager }
  };

  const claude = await resolveWorkspaceTransitionRuntime("claude-sdk", runtimes);
  const openClacky = await resolveWorkspaceTransitionRuntime("openclacky", runtimes);
  assert.equal(claude.manager, claudeManager);
  assert.deepEqual(claude.options, {});
  assert.equal(openClacky.manager, openClackyManager);
  assert.deepEqual(openClacky.options, {});
  assert.equal(codexOptionLoads, 0);

  const codex = await resolveWorkspaceTransitionRuntime("codex-app-server", runtimes);
  assert.equal(codex.manager, codexManager);
  assert.deepEqual(codex.options, { dynamicTools: [{ name: "corptie_tool_call" }] });
  assert.equal(codexOptionLoads, 1);
});

test("workspace transition recovery fails closed for an unregistered Provider runtime", async () => {
  await assert.rejects(
    () => resolveWorkspaceTransitionRuntime("future-provider", {}),
    (error) => error?.code === "PROVIDER_WORKSPACE_TRANSITION_UNSUPPORTED"
  );
});

test("Claude and OpenClacky workspace managers atomically prepare desired-only Tool replacements", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  for (const managerName of [
    "openClackyWorkspaceTransitionManager",
    "claudeWorkspaceTransitionManager"
  ]) {
    const begin = source.indexOf(`const ${managerName} = new ForkingWorkspaceTransitionManager({`);
    const end = source.indexOf("\n});", begin);
    assert.notEqual(begin, -1, `${managerName} must exist in production composition`);
    assert.notEqual(end, -1, `${managerName} composition must be closed`);
    assert.match(
      source.slice(begin, end),
      /prepareToolMaterialization:\s*prepareDesiredWorkspaceToolMaterialization/,
      `${managerName} must carry Tool desired state in the atomic route commit`
    );
  }
  const helperBegin = source.indexOf("async function prepareDesiredWorkspaceToolMaterialization");
  const helperEnd = source.indexOf("\nfunction desiredToolDomainIds", helperBegin);
  const helper = source.slice(helperBegin, helperEnd);
  assert.notEqual(helperBegin, -1);
  assert.notEqual(helperEnd, -1);
  assert.match(helper, /getSessionToolCatalogMaterialization/);
  assert.match(helper, /desiredToolDomainIds\(source\)/);
  assert.match(helper, /prepareDesiredReplacement/);
  assert.doesNotMatch(helper, /prepareAppliedReplacement|providerReceipt|status:\s*["']applied/);
});
