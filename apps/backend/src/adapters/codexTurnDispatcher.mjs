import { codexPreDispatchRecoveryError } from "./codexAppServer.mjs";
import { isConflictResolutionWorkspace } from "../runtime/conflictResolutionWorkspacePermissions.mjs";
import { codexRuntimeWorkspaceRoots, codexTurnPermissionOptions } from "../utils/codexPermissions.mjs";
import { codexTurnRuntimeConfig } from "../utils/codexRuntimeConfig.mjs";
import { normalizeSessionMessageLatencyTrace, logSessionMessageLatency } from "../utils/sessionMessageLatency.mjs";
import { workspaceTransitionBlocksWork } from "../runtime/workspaceTransitionBarrier.mjs";

// Concrete dispatch protocol only. Session queueing, readiness and durable
// lifecycle projection remain in the provider-neutral application services.
export function createCodexTurnDispatcher({
  store, codexRuntime, resolvePreparedWorkspaceRoute, bumpChoiceGeneration,
  ensureCodexSessionPermissions, sessionWithLogicalWorkspace,
  collaborationThreadOptionsForSession
}) {
  async function sendCodexProviderMessage(reference, value, context = {}) {
    const before = context.before ?? reference.metadata?.session;
    const options = context.options ?? context;
    const sessionId = reference.sessionId;
    const latencyTrace = normalizeSessionMessageLatencyTrace(context.latencyTrace ?? {}, {
      sessionId: reference.logicalSessionId ?? sessionId
    });
    const logicalRoute = store.getLogicalSessionByLegacySessionId(sessionId);
    if (workspaceTransitionBlocksWork(logicalRoute)) {
      const error = new Error("The Session is switching workspaces; queued work will resume after the route commits.");
      error.code = "SESSION_BUSY";
      throw error;
    }
    const threadId = logicalRoute?.activeThreadId ?? reference.providerSessionId;
    const routeResolution = logicalRoute
      ? await resolvePreparedWorkspaceRoute(logicalRoute, threadId)
      : null;
    const activeRoute = routeResolution?.route ?? null;
    logSessionMessageLatency(latencyTrace, "workspace_route_resolved", {
      cacheHit: routeResolution?.cacheHit === true
    });
    bumpChoiceGeneration(sessionId);
    store.clearActiveChoicePrompt(sessionId);
    const permissionsStartedAt = Date.now();
    const managed = await ensureCodexSessionPermissions(sessionWithLogicalWorkspace(
      store.getSession(sessionId) ?? before,
      logicalRoute
    ));
    logSessionMessageLatency(latencyTrace, "permissions_resolved", {
      durationMs: Date.now() - permissionsStartedAt
    });
    const activeCwd = activeRoute?.cwd ?? logicalRoute?.activeBinding?.boundCwd ?? managed.external?.cwd;
    const runtimeWorkspaceRoots = codexRuntimeWorkspaceRoots(logicalRoute, activeCwd);
    const conflictResolutionSession = await isConflictResolutionWorkspace({
      path: activeCwd,
      worktreeId: logicalRoute?.worktreeId
    });
    const toolContextStartedAt = Date.now();
    logSessionMessageLatency(latencyTrace, "tool_context_started");
    const threadOptions = await collaborationThreadOptionsForSession(sessionId);
    logSessionMessageLatency(latencyTrace, "tool_context_completed", {
      durationMs: Date.now() - toolContextStartedAt
    });
    const resumeStartedAt = Date.now();
    logSessionMessageLatency(latencyTrace, "thread_resume_started");
    let resumeResult;
    try {
      resumeResult = await codexRuntime.ensureThreadResumed(threadId, {
        cwd: activeCwd,
        runtimeWorkspaceRoots,
        ...(conflictResolutionSession ? {
          sandbox: "danger-full-access",
          approvalPolicy: "never"
        } : {}),
        ...threadOptions
      });
    } catch (error) {
      throw codexPreDispatchRecoveryError(error);
    }
    logSessionMessageLatency(latencyTrace, "thread_resume_completed", {
      durationMs: Date.now() - resumeStartedAt,
      skipped: resumeResult?.alreadyLoaded === true
    });
    const turnStartedAt = Date.now();
    logSessionMessageLatency(latencyTrace, "turn_start_requested");
    const turnRuntime = codexTurnRuntimeConfig(managed, options);
    const result = await codexRuntime.startTurn(threadId, value, {
      cwd: activeCwd,
      model: turnRuntime.model,
      reasoningEffort: turnRuntime.reasoningEffort,
      additionalContext: context.sessionContext?.prompt ? {
        ...(options.additionalContext ?? {}),
        "corptie-session-context": {
          kind: "application",
          value: context.sessionContext.prompt
        }
      } : options.additionalContext,
      ...codexTurnPermissionOptions(managed, {
        runtimeWorkspaceRoots,
        forceFullAccess: conflictResolutionSession
      })
    });
    logSessionMessageLatency(latencyTrace, "turn_start_accepted", {
      durationMs: Date.now() - turnStartedAt,
      turnId: result.turn?.id ?? null
    });
    return result;
  }

  return { sendCodexProviderMessage };
}
