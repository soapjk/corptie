import assert from "node:assert/strict";
import test from "node:test";
import { runToolHostFirstCallBenchmark } from "../scripts/benchmark-tool-host-first-call.mjs";
import { performance } from "node:perf_hooks";
import { ToolHostMaterializationCoordinator } from "../src/application/toolHostMaterializationCoordinator.mjs";
import { ToolHostService } from "../src/application/toolHostService.mjs";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import { collaborationDynamicTools } from "../src/collaboration/collaborationDynamicTools.mjs";
import { scheduledSessionTaskDynamicTools } from "../src/application/scheduledSessionTaskDynamicTools.mjs";

test("real catalog search and per-turn map remain bounded without Provider work", async () => {
  const catalog = new HostToolCatalog([
    { id: "collaboration", tools: collaborationDynamicTools, execute: () => { throw new Error("read-only benchmark"); } },
    { id: "scheduled-tasks", tools: scheduledSessionTaskDynamicTools, execute: () => null }
  ]);
  const binding = { logicalSessionId: "logical:bench", providerBindingId: "binding:bench", state: "active",
    isCurrent: true, sessionKind: "assistantChat", sessionId: "session:bench", agentId: "agent:bench" };
  const coordinator = new ToolHostMaterializationCoordinator({ store: {}, catalog, providerPort: {}, resolveBinding: async () => binding });
  const durations = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const result = await coordinator.search({ ...binding, intent: "创建独立Task并指定Agent", domainHint: "tasks" });
    durations.push(performance.now() - start);
    assert.equal(result.domains[0].recommendedTool, "corptie_collaboration_tasks_create");
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 65_536);
  }
  durations.sort((a, b) => a - b);
  assert.ok(durations[95] < 100, `catalog p95 ${durations[95]}ms exceeded local regression ceiling`);
  const service = new ToolHostService({ registry: {}, catalog });
  const context = service.discoveryContext({ actorId: binding.agentId, metadata: { sessionId: binding.sessionId } });
  assert.ok(Buffer.byteLength(context.prompt) <= 4096);
  assert.match(context.prompt, /Task creation still requires/);
});

test("cold and loaded Automation discovery benchmark stays within the first-call round-trip budget", async () => {
  const result = await runToolHostFirstCallBenchmark(20);
  assert.equal(result.firstSuccessfulCallSteps, 3);
  assert.equal(result.loadedBusinessCallSteps, 1);
  assert.equal(result.schemaValidationFailures, 0);
  assert.equal(result.discoveredDomain, "scheduled-tasks");
  assert.equal(result.recommendedTool, "corptie_automations_create");
  assert.ok(Number.isFinite(result.catalogSearchDurationMs.p95));
  assert.ok(Number.isFinite(result.businessCallDurationMs.p95));
});
