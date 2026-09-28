export function scheduleBackendStartupMaintenance({
  store, taskDeletionService, trackStartupMaintenance, runProviderStartupMaintenance,
  knownActiveWorktrees, worktreeIntegrationJobService, reconcileEntityTasksAtStartup,
  reconcileWorkChatsAtStartup, scheduledSessionTaskService, runtimeActivity,
  tickAgentWorkQueue, emitEvent, artifactService, feishuGateway,
  skillRegistryService, legacySessionHistoryRepairService
}) {
  // Store-backed APIs and state streams are the Backend readiness boundary.
  // Provider runtimes, recovery, and route verification are optional
  // capabilities: start them only after the frontend can connect, and contain
  // every failure inside the affected background capability.
  setImmediate(() => {
    const reconciled = store.reconcileInterruptedSessionExecutionAtStartup();
    if (Object.values(reconciled).some((count) => count > 0)) {
      console.warn(`[startup-interruption-reconcile] ${JSON.stringify(reconciled)}`);
    }
    const recoveredTaskDeletions = taskDeletionService.recoverInterruptedDeletions();
    if (recoveredTaskDeletions > 0) {
      console.warn(`[task-deletion-recovery] ${JSON.stringify({ recoveredTaskDeletions })}`);
    }
    trackStartupMaintenance(runProviderStartupMaintenance([...knownActiveWorktrees.values()]));
    trackStartupMaintenance(worktreeIntegrationJobService.recover()
      .then((recoveredWorktreeIntegrationJobs) => {
        if (recoveredWorktreeIntegrationJobs > 0) {
          console.log(`[worktree-integration] queued ${recoveredWorktreeIntegrationJobs} persisted task(s) for recovery`);
        }
      })
      .catch((error) => {
        console.warn(`[worktree-integration] startup recovery failed error=${error?.message ?? error}`);
      }));
    reconcileEntityTasksAtStartup();
    trackStartupMaintenance(reconcileWorkChatsAtStartup());
    scheduledSessionTaskService.start();
    runtimeActivity.startQueueTimer();
    tickAgentWorkQueue().catch((error) => emitEvent("AgentWorkQueueError", { error: error.message }));
  });
  setImmediate(() => {
    trackStartupMaintenance(artifactService.runStartupMaintenance()
      .then((recoveredArtifactContentOperations) => {
        if (recoveredArtifactContentOperations.length > 0) {
          console.warn(`[artifact-recovery] ${JSON.stringify(recoveredArtifactContentOperations)}`);
        }
      })
      .catch((error) => {
        console.warn(`[artifact-recovery] startup maintenance failed code=${error?.code ?? "unknown"} error=${error?.message ?? error}`);
      }));
  });
  // Provider callbacks converge truth into SQLite before wake publication.
  // There is intentionally no periodic read/repair loop here.
  // Feishu reconciliation may stop daemons and call remote identity/model
  // services for every configured bot. It is maintenance, not an API
  // readiness dependency, so never hold the loopback server closed for it.
  setImmediate(() => {
    trackStartupMaintenance(feishuGateway.initialize()
      .then(() => {
        const status = feishuGateway.status();
        console.log(`[feishu] gateway ready cli=${status.cliAvailable ? status.cliPath : "unavailable"}`);
      })
      .catch((error) => {
        console.warn(`[feishu] gateway initialization failed error=${error?.message ?? error}`);
      }));
  });
  // Legacy Skill repair is maintenance, not a readiness dependency. Run it
  // only after the API is healthy so an invalid external package cannot block
  // every App launch. Persistent failure fingerprints suppress unchanged,
  // deterministic failures on later starts.
  setImmediate(() => {
    trackStartupMaintenance(skillRegistryService.repairLegacyRegistrations()
      .then((result) => {
        if (result.repaired.length > 0) {
          console.log(`[skills] repaired ${result.repaired.length} legacy Skill registration(s)`);
        }
        for (const skipped of result.skipped) {
          console.warn(`[skills] legacy Skill repair skipped skill=${skipped.skillId} reason=${skipped.reason}`);
        }
      })
      .catch((error) => {
        console.warn(`[skills] legacy Skill repair failed error=${error?.message ?? error}`);
      }));
  });
  // The 2026-08-26 Store-authority cutover deliberately removed Provider
  // history reads from GET. Repair pre-cutover Sessions once, after readiness,
  // and retain an audit row for every import, empty history, limitation or
  // failure. Timeline revisions wake connected clients after each commit.
  setImmediate(() => {
    trackStartupMaintenance(legacySessionHistoryRepairService.run()
      .then((result) => {
        console.log(`[legacy-history-repair] ${JSON.stringify({
          scanned: result.scanned,
          imported: result.imported,
          importedItems: result.importedItems,
          noHistory: result.noHistory,
          skipped: result.skipped,
          unsupported: result.unsupported,
          unavailable: result.unavailable,
          failed: result.failed
        })}`);
      })
      .catch((error) => {
        console.warn(`[legacy-history-repair] run failed code=${error?.code ?? "unknown"} error=${error?.message ?? error}`);
      }));
  });
}
