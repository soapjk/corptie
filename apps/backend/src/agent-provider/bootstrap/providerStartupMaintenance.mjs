import { ensureCorptieCodexRuntime as prepareCodexRuntime } from "../../runtime/corptieCodexRuntime.mjs";
import { ensureCorptieClaudeRuntime as prepareClaudeRuntime } from "../../runtime/corptieClaudeRuntime.mjs";
import { ensureCorptieOpenClackyRuntime as prepareOpenClackyRuntime } from "../../runtime/corptieOpenClackyRuntime.mjs";
import { recoverCollaborationDeliveriesAfterCodexRolloutRepair as recoverRolloutDeliveries } from "../../application/collaborationDeliveryInfrastructureRecovery.mjs";

// Provider-specific startup composition. Creating this runner performs no I/O;
// the host schedules it only after the listener and Store are ready.
export function createProviderStartupMaintenance({
  workSessionStartupCoordinator, projectToolsetInitializer,
  environmentName, bundledAgentMemoryPath, bundledCollaborationSkillPath,
  bundledProjectToolsetReferencePath, collaborationMcpServerPath,
  codexRuntime, openClackyManager, emptyCodexBindingPreflight,
  toolBootstrapBindingPreflight, setProviderRuntimeReadiness,
  collaborationCore, store, codexResetForecastMonitor,
  resumeSessionRecoveryAttemptsAtStartup, deleteHistoricalUnusableTaskSessionsAtStartup,
  recoverPendingWorkspaceTransitions, reconcileMovedWorkspaceRoutes, sessionRuntimeReleaseService,
  ensureCorptieCodexRuntime = prepareCodexRuntime,
  ensureCorptieClaudeRuntime = prepareClaudeRuntime,
  ensureCorptieOpenClackyRuntime = prepareOpenClackyRuntime,
  recoverCollaborationDeliveriesAfterCodexRolloutRepair = recoverRolloutDeliveries
}) {
  async function runProviderStartupMaintenance(knownWorktrees) {
    const recoveredInterruptedTaskStarts = workSessionStartupCoordinator.recoverInterruptedStarts();
    if (recoveredInterruptedTaskStarts > 0) {
      console.warn(`[task-start-recovery] ${JSON.stringify({ recoveredInterruptedTaskStarts })}`);
    }
    const recoveredProjectToolsets = await runContainedStartupOperation(
      "project-toolset-recovery",
      () => projectToolsetInitializer.recoverAll()
    );
    if (recoveredProjectToolsets?.length > 0) {
      console.warn(`[project-toolset-recovery] ${JSON.stringify({ recoveredOperations: recoveredProjectToolsets.length })}`);
    }
    const [corptieCodexRuntime] = await Promise.all([
      runContainedStartupOperation("codex-runtime", async () => {
        const runtime = await ensureCorptieCodexRuntime({
          environmentName,
          bundledMemoryPath: bundledAgentMemoryPath,
          bundledSkillPath: bundledCollaborationSkillPath,
          bundledProjectToolsReferencePath: bundledProjectToolsetReferencePath,
          collaborationMcpServerPath
        });
        await codexRuntime.initialize();
        console.log(`[agent-memory] ready shared=${runtime.sharedMemoryPath}`);
        if (runtime.rolloutPathRepair.repairedCount > 0) {
          console.warn(`[codex-runtime] repaired migrated rollout paths count=${runtime.rolloutPathRepair.repairedCount} backups=${runtime.rolloutPathRepair.backups.length}`);
        }
        console.log(`[codex-runtime] ready home=${runtime.codexHome} auth=${runtime.authAvailable ? "available" : "missing"} agents=${runtime.agentsAvailable ? "ready" : "missing"} skill=${runtime.skillAvailable ? "ready" : "missing"} mcp=${runtime.mcpAvailable ? "ready" : "missing"}`);
        // Candidate discovery is deliberately post-listen and happens while the
        // Provider is still globally Not Ready. This preserves immediate App ↔
        // Backend connection without exposing zero-Turn bindings as sendable.
        const preparation = emptyCodexBindingPreflight.prepare();
        if (preparation.candidates > 0) {
          console.info(`[empty-binding-preflight] pending=${preparation.candidates}`);
        }
        setProviderRuntimeReadiness("codex-app-server", { state: "ready" });
        return runtime;
      }, "codex-app-server"),
      runContainedStartupOperation("claude-runtime", async () => {
        const runtime = await ensureCorptieClaudeRuntime({
          environmentName,
          bundledMemoryPath: bundledAgentMemoryPath,
          bundledSkillPath: bundledCollaborationSkillPath,
          bundledProjectToolsReferencePath: bundledProjectToolsetReferencePath
        });
        console.log(`[claude-runtime] ready home=${runtime.configDir} auth=${runtime.credentialsAvailable ? "available" : "missing"} memory=${runtime.memoryAvailable ? "ready" : "missing"} plugin=${runtime.pluginPath} skill=${runtime.skillAvailable ? "ready" : "missing"} mcp=ready`);
        setProviderRuntimeReadiness("claude-sdk", { state: "ready" });
        return runtime;
      }, "claude-sdk"),
      runContainedStartupOperation("openclacky-runtime", async () => {
        await ensureCorptieOpenClackyRuntime({ environmentName });
        openClackyManager.start();
        setProviderRuntimeReadiness("openclacky", { state: "ready" });
      }, "openclacky")
    ]);
    if (corptieCodexRuntime) {
      const recovered = recoverCollaborationDeliveriesAfterCodexRolloutRepair({
        core: collaborationCore,
        store,
        rolloutPathRepair: corptieCodexRuntime.rolloutPathRepair
      });
      if (recovered.length > 0) {
        console.warn(`[collaboration-recovery] requeued ${recovered.length} exhausted Delivery item(s) after Codex rollout relocation repair`);
      }
    }
    const operations = [
      runContainedStartupOperation("active-session-binding-preflight", async () => {
        // Active empty bindings are proactively warmed after Backend readiness.
        // Complete this pass before the broader Tool bootstrap scan so both
        // verification passes never race the same Provider binding. Neither
        // pass may replace a route; replacement requires explicit Recovery.
        const emptyBindingSummary = await emptyCodexBindingPreflight.run();
        if (emptyBindingSummary?.scanned > 0) {
          console.info(`[empty-binding-preflight] ${JSON.stringify({
            scanned: emptyBindingSummary.scanned,
            ready: emptyBindingSummary.ready,
            failed: emptyBindingSummary.failed
          })}`);
        }
        const toolBootstrapSummary = await toolBootstrapBindingPreflight.run();
        if (toolBootstrapSummary?.scanned > 0) {
          console.info(`[tool-bootstrap-preflight] ${JSON.stringify(toolBootstrapSummary)}`);
        }
      }),
      runContainedStartupOperation("codex-reset-monitor", async () => {
        codexResetForecastMonitor.start();
      }),
      runContainedStartupOperation("session-recovery", resumeSessionRecoveryAttemptsAtStartup),
      runContainedStartupOperation("replaced-session-cleanup", async () => {
        const deleted = await deleteHistoricalUnusableTaskSessionsAtStartup();
        if (deleted > 0) {
          console.warn(`[task-self-repair] startup deleted ${deleted} replaced unusable Session(s)`);
        }
      }),
      runContainedStartupOperation("workspace-transition-recovery", recoverPendingWorkspaceTransitions),
      runContainedStartupOperation("workspace-route-reconciliation", () => reconcileMovedWorkspaceRoutes(
        knownWorktrees,
        { verifyProviderIdle: true }
      ))
    ];
    await Promise.all(operations);
    // Historical runtime cleanup uses the same Provider transport as active
    // binding verification. Start it only after active Sessions are ready, and
    // let the release service enforce a small concurrency window.
    await runContainedStartupOperation("archived-session-runtime-release", async () => {
      const scheduled = sessionRuntimeReleaseService.reconcileArchivedSessions();
      if (scheduled > 0) console.info(`[session-runtime-release] scheduled archived=${scheduled}`);
    });
  }

  async function runContainedStartupOperation(name, operation, providerId = null) {
    try {
      return await operation();
    } catch (error) {
      if (providerId) {
        setProviderRuntimeReadiness(providerId, {
          state: "not_ready",
          reasonCode: "PROVIDER_INITIALIZATION_FAILED",
          message: error?.message ?? "Provider initialization failed.",
          retryable: true
        });
      }
      console.warn(`[startup-maintenance] operation=${name} failed code=${error?.code ?? "unknown"} error=${error?.message ?? error}`);
      return undefined;
    }
  }
  return { runProviderStartupMaintenance };
}
