import { mapCodexThreadToSession } from "./codexAppServer.mjs";
import { codexPermissionsForSession, withCodexSessionPermissions } from "../utils/codexPermissions.mjs";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";
import { defaultWorkspacePath } from "../utils/workspacePaths.mjs";

// Provider-specific conversation replacement behind the shared clear contract.
export function createCodexConversationClear({
  store, codexRuntime, collaborationCore, ensureCodexSessionPermissions,
  reserveSessionTitle, collaborationThreadOptionsForSession, codexAppServerSessionCapabilities,
  ensureLogicalRouteForCodexSession, sessionWithLogicalWorkspace, upsertManagedCodexSession, emitEvent
}) {
  async function clearCodexAppServerSession(sessionId, session, source = { type: "desktop" }) {
    if (sessionHasActiveRun(session)) {
      const error = new Error("The current task is still running. Stop it before using /clear.");
      error.code = "SESSION_BUSY";
      throw error;
    }

    session = await ensureCodexSessionPermissions(session);
    const permissions = codexPermissionsForSession(session);
    const previousAgent = collaborationCore.getAgentForSession(sessionId);
    const cwd = session.external?.cwd || defaultWorkspacePath();
    const model = session.external?.currentModel ?? undefined;
    const reasoningLevel = session.external?.currentReasoningLevel ?? null;
    const title = session.title || "Codex";
    const releaseTitle = reserveSessionTitle(title, sessionId);
    try {
    const started = await codexRuntime.startThread({
      cwd,
      ...permissions,
      model,
      ...await collaborationThreadOptionsForSession(sessionId)
    });
    await codexRuntime.setThreadName(started.thread.id, title).catch((error) => {
      console.log(`[codex] clear created thread=${started.thread.id} but could not preserve title: ${error.message}`);
    });

    let replacement = withCodexSessionPermissions({
      ...mapCodexThreadToSession({
        ...started.thread,
        preview: title,
        name: title,
        cwd,
        updatedAt: Date.now() / 1000,
        status: "idle",
        source: "corptie",
        currentModel: model ?? started.model ?? null,
        currentReasoningLevel: reasoningLevel ?? started.reasoningEffort ?? null
      }),
      title,
      pinned: session.pinned,
      accent: session.accent ?? "cyan",
      status: "complete",
      progress: 1,
      summary: "Conversation cleared. Ready for a new instruction.",
      activityStatus: null,
      capabilities: codexAppServerSessionCapabilities({ canInterrupt: false }),
      external: {
        ...mapCodexThreadToSession({
          ...started.thread,
          cwd,
          currentModel: model ?? started.model ?? null,
          currentReasoningLevel: reasoningLevel ?? started.reasoningEffort ?? null
        }).external,
        activeTurnId: null
      }
    }, permissions);
    store.deleteSession(sessionId);
    const logicalRoute = await ensureLogicalRouteForCodexSession(replacement, started);
    replacement = sessionWithLogicalWorkspace(replacement, logicalRoute);
    upsertManagedCodexSession(replacement, previousAgent?.agentId ?? null);
    emitEvent("SessionCleared", {
      previousSessionId: sessionId,
      session: replacement,
      source
    }, { sessionId: replacement.id, source });
    return {
      accepted: true,
      cleared: true,
      previousSessionId: sessionId,
      sessionId: replacement.id,
      session: replacement
    };
    } finally {
      releaseTitle();
    }
  }

  return { clearCodexAppServerSession };
}
