import { sanitizeSessionCommitMessage, sessionCommitMessagePrompt } from "../utils/sessionCommitMessage.mjs";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";
import { workspaceTransitionBlocksWork } from "../runtime/workspaceTransitionBarrier.mjs";

// Background generation goes through the shared service and never posts into
// the requesting Session's ordinary conversation history.
export function createCommitMessageOperations({
  store, sessionApplicationService, sessionBindingRepository, backgroundAgentService,
  assertWorkspaceRouteUsable
}) {
  async function generateSessionCommitMessage(sessionId, plan) {
    const reference = await sessionApplicationService.referenceFor(sessionId);
    const session = store.getSession(reference.sessionId);
    const logical = (reference.logicalSessionId
      ? store.getLogicalSession(reference.logicalSessionId)
      : null) ?? store.getLogicalSessionByLegacySessionId(reference.sessionId);
    if (!logical?.activeBinding) throw new Error("The Session no longer has an active workspace route.");
    if (sessionHasActiveRun(session)) {
      const error = new Error("The Session is busy. Wait for its current turn before merging its worktree.");
      error.code = "SESSION_BUSY";
      throw error;
    }
    if (workspaceTransitionBlocksWork(logical)) {
      const error = new Error("The Session is switching workspaces. Wait for the switch to finish before deleting it.");
      error.code = "SESSION_BUSY";
      throw error;
    }
    const activeRoute = await assertWorkspaceRouteUsable({
      store,
      logicalSession: logical,
      providerThreadId: reference.providerSessionId
    });
    const cwd = activeRoute.cwd;
    const result = await backgroundAgentService.run({
      purpose: "commit-message",
      cwd,
      allowedRoots: [cwd],
      prompt: sessionCommitMessagePrompt(plan),
      preferredProviderId: reference.providerId,
      preferredModel: session.external?.currentModel ?? undefined,
      preferredReasoning: session.external?.currentReasoningLevel ?? undefined,
      timeoutMs: 120_000
    });
    const message = sanitizeSessionCommitMessage(result.text);
    if (!message) throw new Error("The background operation returned an empty commit message.");
    return message;
  }

  async function generateUnownedWorktreeCommitMessage(requestingSessionId, cwd, plan) {
    const reference = requestingSessionId ? sessionBindingRepository.resolve(requestingSessionId) : null;
    const session = reference?.metadata?.session ?? null;
    const result = await backgroundAgentService.run({
      purpose: "commit-message",
      cwd,
      allowedRoots: [cwd],
      prompt: sessionCommitMessagePrompt(plan),
      preferredProviderId: reference?.providerId,
      preferredModel: session?.external?.currentModel ?? undefined,
      preferredReasoning: session?.external?.currentReasoningLevel ?? undefined,
      timeoutMs: 120_000
    });
    const message = sanitizeSessionCommitMessage(result.text);
    if (!message) throw new Error("The background operation returned an empty commit message.");
    return message;
  }

  return { generateSessionCommitMessage, generateUnownedWorktreeCommitMessage };
}
