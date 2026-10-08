import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("remote Feishu reconciliation stays outside the backend readiness path", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const listenIndex = source.indexOf('server.listen(port, "127.0.0.1"');
  const scheduleIndex = source.indexOf("scheduleBackendStartupMaintenance({", listenIndex);
  const startup = await readFile(new URL("../src/application/backendStartupMaintenance.mjs", import.meta.url), "utf8");

  assert.notEqual(listenIndex, -1, "production server must declare its loopback listener");
  assert.notEqual(scheduleIndex, -1, "Feishu gateway must still initialize after startup");
  assert.equal(
    source.slice(0, listenIndex).includes("await feishuGateway.initialize()"),
    false,
    "remote Feishu initialization must never block server.listen"
  );
  assert.match(startup, /setImmediate\(\(\) => \{[\s\S]*feishuGateway\.initialize\(\)/);
  assert.ok(scheduleIndex > listenIndex, "Feishu initialization must be scheduled after the listener opens");
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

  const maintenanceIndex = source.indexOf("scheduleBackendStartupMaintenance({", listenIndex);
  assert.ok(maintenanceIndex > listenIndex, "Provider maintenance must be scheduled after the listener boundary");
  assert.match(source, /const \{ runProviderStartupMaintenance \} = createProviderStartupMaintenance\(/);
  const maintenance = await readFile(new URL("../src/agent-provider/bootstrap/providerStartupMaintenance.mjs", import.meta.url), "utf8");
  const startup = await readFile(new URL("../src/application/backendStartupMaintenance.mjs", import.meta.url), "utf8");
  assert.match(startup, /trackStartupMaintenance\(runProviderStartupMaintenance/);
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
  const activity = await readFile(new URL("../src/application/backendRuntimeActivity.mjs", import.meta.url), "utf8");
  assert.match(source, /runtimeActivity\.trackMaintenance\(promise\)/);
  assert.doesNotMatch(
    activity,
    /promise\.finally\(/,
    "startup task tracking must not create an unhandled rejected finally Promise"
  );
  const preflights = await readFile(new URL("../src/agent-provider/bootstrap/providerStartupPreflightComposition.mjs", import.meta.url), "utf8");
  assert.match(
    preflights,
    /idempotencyKey: `startup-empty-binding-recovery:\$\{candidate\.bindingId\}`/,
    "a proven unavailable zero-Turn binding must use an idempotent recovery attempt"
  );
  assert.doesNotMatch(
    source,
    /PROVIDER_BINDING_RECOVERY_REQUIRED/,
    "a proven unavailable zero-Turn binding must not require manual recovery"
  );
  const bindingProjection = await readFile(new URL("../src/application/sessionToolBindingProjection.mjs", import.meta.url), "utf8");
  assert.match(
    bindingProjection,
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

test("memory extraction starts only after the main Store connection is ready", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const mainStoreOpenIndex = source.indexOf(
    "await store.initialize({ resolveDataPath: false, performMigrations: false })"
  );
  const schedulerStartIndex = source.indexOf("memoryExtractionScheduler.start()", mainStoreOpenIndex);
  const readyIndex = source.indexOf("backendStoreReady = true", mainStoreOpenIndex);
  const runtimeStartIndex = source.indexOf("startBackendRuntime();", readyIndex);

  assert.ok(mainStoreOpenIndex >= 0, "the main Store connection must be opened during startup");
  assert.ok(schedulerStartIndex > mainStoreOpenIndex,
    "the memory scheduler must not query SQLite before the main Store connection opens");
  assert.equal(source.match(/memoryExtractionScheduler\.start\(\)/g)?.length, 1,
    "the memory scheduler must have one runtime-owned startup call");
  assert.ok(runtimeStartIndex > readyIndex,
    "the runtime containing the memory scheduler must start only after Store readiness");
  assert.equal(source.slice(0, mainStoreOpenIndex).includes("memoryExtractionScheduler.start()"), false);
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
  const scheduleIndex = source.indexOf("scheduleBackendStartupMaintenance({", listenIndex);
  const startup = await readFile(new URL("../src/application/backendStartupMaintenance.mjs", import.meta.url), "utf8");
  const reconcileIndex = startup.indexOf("store.reconcileInterruptedSessionExecutionAtStartup()");
  const providerMaintenanceIndex = startup.indexOf("trackStartupMaintenance(runProviderStartupMaintenance");
  const firstQueueTickIndex = startup.indexOf("tickAgentWorkQueue().catch");
  const queueSource = await readFile(new URL("../src/runtime/runtimeAgentWorkQueue.mjs", import.meta.url), "utf8");
  const tickDefinitionIndex = queueSource.indexOf("async function tickAgentWorkQueue()");
  assert.ok(tickDefinitionIndex >= 0);
  assert.match(source, /createRuntimeAgentWorkQueue\(\{/);
  const tickDefinition = queueSource.slice(tickDefinitionIndex);

  assert.ok(scheduleIndex > listenIndex && reconcileIndex >= 0, "restart reconciliation must not delay the listener");
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
  const [server, store, sessionReads, collection, router] = await Promise.all([
    readFile(new URL("../src/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/store/corptieStore.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/store/repositories/sessionReadRepository.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/application/sessionCollectionHttpApi.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/application/backendHttpRouter.mjs", import.meta.url), "utf8")
  ]);
  assert.match(server, /routeBackendHttpRequest\(/);
  assert.match(router, /if \(handleSessionCollectionHttpRequest\(/);
  const sessionsRoute = collection.slice(
    collection.indexOf('if (request.method === "GET" && url.pathname === "/sessions")'),
    collection.indexOf('if (request.method === "POST" && url.pathname === "/sessions")')
  );
  const projection = await readFile(new URL("../src/application/controlPlaneProjection.mjs", import.meta.url), "utf8");
  const snapshot = projection.slice(
    projection.indexOf("function controlPlaneSnapshot()"),
    projection.indexOf("function presentControlPlaneSession(")
  );
  const readiness = await readFile(new URL("../src/application/backendStoreReadiness.mjs", import.meta.url), "utf8");
  assert.match(server, /initializeBackendStoreReadiness\(/);
  assert.match(readiness, /snapshot: controlPlaneSnapshot/);

  assert.match(sessionsRoute, /limit/);
  assert.match(sessionsRoute, /nextCursor/);
  assert.match(sessionsRoute, /hasMore/);
  assert.match(sessionsRoute, /sessionId/);
  assert.match(store, /listSessionPage\(options = \{\}\)/);
  assert.match(store, /return this\.sessionReadRepository\.listSessionPage\(options\)/);
  const page = sessionReads.slice(
    sessionReads.indexOf("  listSessionPage("),
    sessionReads.indexOf("\n  getSession(")
  );
  assert.match(page, /LIMIT \?/);
  assert.match(page, /limit \+ 1/);
  assert.match(snapshot, /listLatestSessionMessageTimes\(residentSessionIds\)/);
  assert.match(snapshot, /listSessionMessageCursors\(residentSessionIds\)/);
  assert.match(snapshot, /listSessionTimelineRevisions\(residentSessionIds\)/);
});

test("startup migrations run in place without creating full database backups", async () => {
  const store = await readFile(new URL("../src/store/corptieStore.mjs", import.meta.url), "utf8");
  const initialize = store.slice(
    store.indexOf("async initialize(options = {})"),
    store.indexOf("\n  reconcileInterruptedSessionExecutionAtStartup(")
  );

  assert.match(initialize, /performMigrations !== false\)[\s\S]*this\.migrate\(\)/);
  assert.doesNotMatch(initialize, /backup\(/);
  assert.doesNotMatch(initialize, /MigrationBackup/);
  assert.doesNotMatch(store, /pre-task-domain-v1\.backup/);
  assert.doesNotMatch(store, /pre-sqlite-performance-v1\.backup/);
  assert.doesNotMatch(store, /pre-canonical-unread-v2\.backup/);
});
