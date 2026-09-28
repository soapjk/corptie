import { mkdir } from "node:fs/promises";
import { StateSyncService } from "./stateSyncService.mjs";
import { CodexResetForecastMonitor } from "../runtime/codexResetForecastMonitor.mjs";

export async function initializeBackendStoreReadiness({
  store, benchmarkControlPlane, runIsolationCoordinator, runIsolationDataRoot,
  developmentPreview, dataRootMigrationCoordinator, turnObservability,
  artifactService, ensureArtifactCommitHook, chatResourceService,
  collaborationCore, controlPlaneSnapshot, readControlPlaneEntity,
  runtimeActivity, scheduleStateSyncPublish, scheduleTimelineChangePublish,
  activateStoredBackendLogging, onStateSyncReady,
  onResetForecastMonitorReady
}) {
  benchmarkControlPlane.initialize();
  if (runIsolationCoordinator) {
    await mkdir(runIsolationDataRoot, { recursive: true, mode: 0o700 });
    await runIsolationCoordinator.initialize();
    console.log(`[run-isolation] production coordinator ready dataRootHash=${runIsolationCoordinator.service.binding.canonicalPathHash}`);
  }
  if (!developmentPreview) await dataRootMigrationCoordinator.initialize();
  const telemetryConfiguration = turnObservability.initialize();
  console.log(`[turn-observability] ${JSON.stringify(telemetryConfiguration)}`);
  // Only establish local Artifact directories before readiness. Traversal,
  // orphan audits, FTS rebuilds and usage reconciliation are maintenance.
  await artifactService.initialize({ performMaintenance: false });
  void Promise.allSettled(store.listGitRepositories().flatMap((repository) => {
    const paths = new Set([repository.path, ...(store.listGitWorktrees(repository.id) ?? [])
      .flatMap((item) => [item.path, item.canonicalPath])].filter(Boolean));
    return [...paths].map(async (path) => {
      try { await ensureArtifactCommitHook(path, { dbPath: store.dbPath }); }
      catch (error) {
        console.error(`[artifact-commit-gate] installation failed repository=${repository.id} path=${path} code=${error.code ?? "ERROR"} message=${error.message}`);
      }
    });
  }));
  await chatResourceService.initialize();
  const collaborationMigration = collaborationCore.initialize();
  if (collaborationMigration.status === "applied") {
    console.log(`[collaboration-migration] id=${collaborationMigration.migrationId} migratedTasks=${collaborationMigration.migratedTaskCount}`);
  }
  const stateSyncService = new StateSyncService({
    store, snapshot: controlPlaneSnapshot, readEntity: readControlPlaneEntity
  });
  onStateSyncReady(stateSyncService);
  runtimeActivity.startTimelinePublisher();
  store.setStateDirtyListener(scheduleStateSyncPublish);
  store.setTimelineDirtyListener(scheduleTimelineChangePublish);
  const codexResetProxy = store.settings().agentProxy?.codex;
  const codexResetForecastMonitor = new CodexResetForecastMonitor({
    store,
    proxyUrl: codexResetProxy?.enabled
      ? codexResetProxy.httpsProxy || codexResetProxy.httpProxy || codexResetProxy.allProxy
      : null
  });
  onResetForecastMonitorReady(codexResetForecastMonitor);
  const detachedOrphanedAgents = collaborationCore.detachMissingSessionBindings();
  if (detachedOrphanedAgents.length > 0) {
    console.log(`[collaboration] detached deleted Session bindings from ${detachedOrphanedAgents.length} Agent(s)`);
  }
  activateStoredBackendLogging();
  console.log(`[store] SQLite ready at ${store.dbPath}`);
}
