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
  const startupIndex = source.indexOf("await store.resolveDataPath()");
  const listenIndex = source.indexOf('server.listen(port, "127.0.0.1"');
  const readinessPath = source.slice(startupIndex, listenIndex);
  const providerOperations = [
    "await ensureCorptieCodexRuntime",
    "await ensureCorptieClaudeRuntime",
    "await ensureCorptieOpenClackyRuntime",
    "openClackyManager.start()",
    "codexResetForecastMonitor.start()",
    "await resumeSessionRecoveryAttemptsAtStartup()",
    "await deleteHistoricalUnusableTaskSessionsAtStartup()",
    "await sessionProviderSwitchCoordinator.completeProviderSwitch",
    "await runtime.manager.recoverWorkspaceTransition",
    "await reconcileMovedWorkspaceRoutes",
    "emptyCodexBindingPreflight.prepare()",
    "emptyCodexBindingPreflight.run()",
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
    "recoverPendingWorkspaceTransitions",
    "reconcileMovedWorkspaceRoutes",
    "toolBootstrapBindingPreflight.run",
    "emptyCodexBindingPreflight.prepare",
    "emptyCodexBindingPreflight.run"
  ]) {
    assert.ok(maintenance.includes(operation), `${operation} must remain scheduled as background maintenance`);
  }
  assert.doesNotMatch(
    source,
    /repairBrokenTaskSessionsAtStartup|selfRepairTaskSession/,
    "startup and message delivery must never replace a Session binding implicitly"
  );
  assert.doesNotMatch(
    source,
    /promise\.finally\(\(\) => startupMaintenanceTasks\.delete/,
    "startup task tracking must not create an unhandled rejected finally Promise"
  );
  assert.match(
    source,
    /idempotencyKey: `startup-empty-binding-recovery:\$\{candidate\.bindingId\}`/,
    "a proven unavailable zero-Turn binding must use an idempotent recovery attempt"
  );
  assert.doesNotMatch(
    source,
    /PROVIDER_BINDING_RECOVERY_REQUIRED/,
    "a proven unavailable zero-Turn binding must not require manual recovery"
  );
  assert.match(
    source,
    /domainId === "work-item-acceptance" \? "task-acceptance" : domainId/,
    "legacy Tool Domain ids must normalize before active binding recovery"
  );
});

test("SQLite migration cannot block the fixed-cost transport event loop", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const listenIndex = source.indexOf('server.listen(port, "127.0.0.1"');
  const ownershipIndex = source.indexOf("await BackendDataRootOwnership.acquire(", listenIndex);
  const migrationIndex = source.indexOf("await migrateStoreOffMainThread(", listenIndex);
  const mainStoreOpenIndex = source.indexOf(
    "await store.initialize({ resolveDataPath: false, performMigrations: false })",
    migrationIndex
  );
  const readyIndex = source.indexOf("backendStoreReady = true", mainStoreOpenIndex);

  assert.ok(listenIndex >= 0);
  assert.ok(ownershipIndex > listenIndex, "Data Root ownership resolves after the fixed-cost listener opens");
  assert.ok(migrationIndex > ownershipIndex, "only the owning Backend may migrate or open the production Store");
  assert.ok(migrationIndex > listenIndex, "the loopback listener must open before schema migration");
  assert.ok(mainStoreOpenIndex > migrationIndex, "the main Store must open only after the Worker releases SQLite");
  assert.ok(readyIndex > mainStoreOpenIndex, "Store-backed APIs must remain gated until the main connection opens");
  assert.match(source.slice(migrationIndex, mainStoreOpenIndex), /dbPath: store\.dbPath/);
});

test("full-database query planner optimization is absent from application startup", async () => {
  const [serverSource, workerSource] = await Promise.all([
    readFile(new URL("../src/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/store/storeMigrationWorker.mjs", import.meta.url), "utf8")
  ]);

  assert.equal(
    serverSource.includes("optimizeStoreOffMainThread"),
    false,
    "opening the App must not launch a competing query-planner writer"
  );
  assert.equal(
    workerSource.includes("PRAGMA optimize=0x10002"),
    false,
    "explicit optimization must not force an all-table scan"
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

test("Session collection reads are bounded and publish an explicit continuation contract", async () => {
  const [server, store] = await Promise.all([
    readFile(new URL("../src/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/store/corptieStore.mjs", import.meta.url), "utf8")
  ]);
  const sessionsRoute = server.slice(
    server.indexOf('if (request.method === "GET" && url.pathname === "/sessions")'),
    server.indexOf('if (request.method === "POST" && url.pathname === "/sessions")')
  );
  const snapshot = server.slice(
    server.indexOf("function controlPlaneSnapshot()"),
    server.indexOf("function sessionChangeAffects", server.indexOf("function controlPlaneSnapshot()"))
  );

  assert.match(sessionsRoute, /limit/);
  assert.match(sessionsRoute, /nextCursor/);
  assert.match(sessionsRoute, /hasMore/);
  assert.match(sessionsRoute, /sessionId/);
  assert.match(store, /listSessionPage\(options = \{\}\)/);
  assert.match(store, /LIMIT \?/);
  assert.match(snapshot, /listLatestSessionMessageTimes\(residentSessionIds\)/);
  assert.match(snapshot, /listSessionMessageCursors\(residentSessionIds\)/);
  assert.match(snapshot, /listSessionTimelineRevisions\(residentSessionIds\)/);
});

test("startup migrations run in place without creating full database backups", async () => {
  const store = await readFile(new URL("../src/store/corptieStore.mjs", import.meta.url), "utf8");
  const initialize = store.slice(
    store.indexOf("async initialize(options = {})"),
    store.indexOf("reconcileInterruptedSessionExecutionAtStartup")
  );

  assert.match(initialize, /performMigrations !== false\) this\.migrate\(\)/);
  assert.doesNotMatch(initialize, /backup\(/);
  assert.doesNotMatch(initialize, /MigrationBackup/);
  assert.doesNotMatch(store, /pre-task-domain-v1\.backup/);
  assert.doesNotMatch(store, /pre-sqlite-performance-v1\.backup/);
  assert.doesNotMatch(store, /pre-canonical-unread-v2\.backup/);
});
