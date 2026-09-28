import { visibleClaudeItems, lastMeaningfulText, latestSuggestedOptions } from "./claudeMessageProjection.mjs";

export function claudeSessionDetail(session, maxItems) {
    // A cancelled status settles the previous Turn; it does not close the
    // Corptie Session or invalidate its persisted Claude session id. A later
    // send lazily starts a new Query and resumes that same Provider Session.
    const canSend = session.turnState !== "running" && !hasPendingChoices(session);
    return {
      id: session.id,
      title: session.title,
      status: hasPendingChoices(session) ? "blocked" : session.status,
      source: "claude-sdk",
      connectionStatus: "connected",
      currentModel: session.currentModel ?? null,
      currentReasoningLevel: session.currentReasoningLevel ?? null,
      activityStatus: activityStatusForSession(session),
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archived: session.archived === true,
      rawStatus: {
        provider: session.provider,
        command: session.command,
        args: session.args,
        agentSessionId: session.agentSessionId,
        phase: session.phase,
        cwd: session.cwd,
        sandbox: session.sandbox,
        approvalPolicy: session.approvalPolicy,
        permissionMode: session.permissionMode,
        nextItemSeq: session.nextItemSeq,
        nextTurnSeq: session.nextTurnSeq,
        lastInputAt: session.lastInputAt,
        lastOutputAt: session.lastOutputAt,
        turnState: session.turnState,
        currentTurnId: session.currentTurnId,
        accent: session.accent
      },
      canSend,
      sendUnavailableReason: canSend ? null : (hasPendingChoices(session) ? "Claude is waiting for your approval choice." : unavailableReasonForSession(session)),
      capabilities: {
        canSend,
        canSwitchModel: true,
        canSwitchReasoning: true,
        canInterrupt: Boolean(session.query) && session.turnState === "running",
        canReconnect: false
      },
      turnCount: 1,
      items: visibleClaudeItems(session.items).slice(-maxItems)
    };
  }

export function claudeSessionSummary(session, storedSession, detail) {
    const latest = lastMeaningfulText(detail.items);
    return {
      id: `pty:${session.id}`,
      title: session.title,
      agent: session.agentName,
      sessionKind: storedSession?.sessionKind ?? session.sessionKind ?? null,
      status: detail.status,
      progress: detail.status === "running" || detail.status === "blocked" ? 0.5 : 1,
      summary: latest || "Claude Code is ready.",
      suggestedOptions: latestSuggestedOptions(session.items),
      activityStatus: detail.activityStatus,
      capabilities: detail.capabilities,
      updatedAt: session.updatedAt,
      accent: session.accent,
      archived: session.archived === true,
      pinned: session.pinned === true || storedSession?.pinned === true,
      sortOrder: Number.isFinite(session.sortOrder) ? session.sortOrder : (storedSession?.sortOrder ?? 0),
      external: {
        provider: session.provider,
        threadId: session.id,
        sessionId: session.id,
        agentSessionId: session.agentSessionId,
        connectionStatus: detail.connectionStatus,
        currentModel: session.currentModel ?? null,
        currentReasoningLevel: session.currentReasoningLevel ?? null,
        cwd: session.cwd,
        sandbox: session.sandbox,
        approvalPolicy: session.approvalPolicy,
        permissionMode: session.permissionMode,
        source: "claude-sdk"
      }
    };
  }

export function hasPendingChoices(session) {
  return (session.pendingChoices?.size ?? 0) > 0 || (session.pendingInteractions?.size ?? 0) > 0;
}

function activityStatusForSession(session) {
  if (hasPendingChoices(session)) {
    return "Waiting for your choice";
  }
  if (session.turnState === "running") {
    return "Claude is working";
  }
  if (session.status === "failed") {
    return "Claude request failed";
  }
  return "Ready";
}

function unavailableReasonForSession(session) {
  return "Claude is still processing the previous request.";
}
