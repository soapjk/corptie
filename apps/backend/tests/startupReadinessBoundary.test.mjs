import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("remote Feishu reconciliation stays outside the backend readiness path", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const listenIndex = source.indexOf('server.listen(port, "127.0.0.1"');
  const initializeIndex = source.indexOf("feishuGateway.initialize()", listenIndex);

  assert.notEqual(listenIndex, -1, "production server must declare its loopback listener");
  assert.notEqual(initializeIndex, -1, "Feishu gateway must still initialize after startup");
  assert.equal(
    source.slice(0, listenIndex).includes("await feishuGateway.initialize()"),
    false,
    "remote Feishu initialization must never block server.listen"
  );
  assert.ok(initializeIndex > listenIndex, "Feishu initialization must be scheduled after the listener opens");
});

test("Provider initialization and recovery stay outside the backend readiness path", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const startupIndex = source.indexOf("await store.initialize()");
  const listenIndex = source.indexOf('server.listen(port, "127.0.0.1"');
  const readinessPath = source.slice(startupIndex, listenIndex);
  const providerOperations = [
    "await ensureCorptieCodexRuntime",
    "await ensureCorptieClaudeRuntime",
    "await ensureCorptieOpenClackyRuntime",
    "openClackyManager.start()",
    "codexResetForecastMonitor.start()",
    "await resumeSessionRecoveryAttemptsAtStartup()",
    "await repairBrokenTaskSessionsAtStartup()",
    "await deleteHistoricalUnusableTaskSessionsAtStartup()",
    "await sessionProviderSwitchCoordinator.completeProviderSwitch",
    "await runtime.manager.recoverWorkspaceTransition",
    "await reconcileMovedWorkspaceRoutes",
    "tickAgentWorkQueue().catch",
    "scheduledSessionTaskService.start()"
  ];

  assert.notEqual(startupIndex, -1, "production startup must initialize the Store");
  assert.notEqual(listenIndex, -1, "production server must declare its loopback listener");
  for (const operation of providerOperations) {
    assert.equal(
      readinessPath.includes(operation),
      false,
      `${operation} must not delay core Backend readiness`
    );
  }

  const maintenanceIndex = source.indexOf("async function runProviderStartupMaintenance", listenIndex);
  assert.ok(maintenanceIndex > listenIndex, "Provider maintenance must be defined after the listener boundary");
  const maintenance = source.slice(maintenanceIndex);
  for (const operation of [
    "ensureCorptieCodexRuntime",
    "ensureCorptieClaudeRuntime",
    "ensureCorptieOpenClackyRuntime",
    "resumeSessionRecoveryAttemptsAtStartup",
    "repairBrokenTaskSessionsAtStartup",
    "recoverPendingWorkspaceTransitions",
    "reconcileMovedWorkspaceRoutes",
    "toolBootstrapBindingPreflight.run"
  ]) {
    assert.ok(maintenance.includes(operation), `${operation} must remain scheduled as background maintenance`);
  }
  assert.doesNotMatch(
    source,
    /promise\.finally\(\(\) => startupMaintenanceTasks\.delete/,
    "startup task tracking must not create an unhandled rejected finally Promise"
  );
});

test("startup settles durable nonterminal work before runtime queue draining", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const listenIndex = source.indexOf('server.listen(port, "127.0.0.1"');
  const reconcileIndex = source.indexOf("store.reconcileInterruptedSessionExecutionAtStartup()", listenIndex);
  const providerMaintenanceIndex = source.indexOf("trackStartupMaintenance(runProviderStartupMaintenance", listenIndex);
  const firstQueueTickIndex = source.indexOf("tickAgentWorkQueue().catch", listenIndex);
  const tickDefinitionIndex = source.indexOf("async function tickAgentWorkQueue()");
  const tickDefinition = source.slice(tickDefinitionIndex, source.indexOf("async function dispatchSessionChannelDelivery", tickDefinitionIndex));

  assert.ok(reconcileIndex > listenIndex, "restart reconciliation must not delay the listener");
  assert.ok(providerMaintenanceIndex > reconcileIndex, "reconciliation must settle old work before Provider recovery starts");
  assert.ok(firstQueueTickIndex > reconcileIndex, "the runtime queue must not drain before restart reconciliation");
  assert.ok(tickDefinition.includes("runtimeQueuedTasksBySession.keys()"));
  assert.equal(
    tickDefinition.includes("listSessionIdsWithUnsettledAgentWork"),
    false,
    "durable unsettled rows must not reconstruct the process-local queue"
  );
  assert.equal(
    source.slice(listenIndex).includes("collaborationCore.recoverInterruptedDeliveries()"),
    false,
    "startup must not revive interrupted collaboration deliveries"
  );
});
