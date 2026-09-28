import { SessionWorkspaceCoordinator } from "./sessionWorkspaceCoordinator.mjs";
import { SessionWorktreeService } from "./sessionWorktreeService.mjs";
import { SessionWorkspaceOperationService } from "./sessionWorkspaceOperationService.mjs";
import { createSessionProviderSwitchComposition } from "../agent-provider/bootstrap/sessionProviderSwitchComposition.mjs";

export function createSessionWorkspaceComposition({
  store, agentProviderRegistry, sessionBindingRepository, collaborationCore,
  ensureCollaborationAgentForSession, toolHostService,
  sessionApplicationService, codexRuntime, prospectiveToolHostBinding,
  toolHostMaterializationCoordinator, gitWorkspaces, workspaceInventory,
  emitEvent
}) {
  const sessionWorkspaceCoordinator = new SessionWorkspaceCoordinator({
    registry: agentProviderRegistry,
    resolveSessionReference: (sessionId) => sessionBindingRepository.resolve(sessionId),
    onTransitionEvent: (type, payload) => emitEvent(type, payload, { sessionId: payload.sessionId })
  });
  const sessionProviderSwitchCoordinator = createSessionProviderSwitchComposition({
    store, agentProviderRegistry, sessionBindingRepository, collaborationCore,
    ensureCollaborationAgentForSession, toolHostService, sessionApplicationService,
    codexRuntime, prospectiveToolHostBinding, toolHostMaterializationCoordinator, emitEvent
  });
  const sessionWorktrees = new SessionWorktreeService({
    gitWorkspaces,
    workspaceCoordinator: sessionWorkspaceCoordinator
  });
  const sessionWorkspaceOperations = new SessionWorkspaceOperationService({
    store,
    collaborationCore,
    worktrees: sessionWorktrees,
    inventory: workspaceInventory,
    onAudit: (record) => {
      console.log(`[workspace-creation] ${JSON.stringify(record)}`);
      const sessionId = record.providerSessionId
        ?? (record.sourceSessionId ? store.getLogicalSession(record.sourceSessionId)?.legacySessionId : null)
        ?? null;
      emitEvent("SessionWorkspaceOperationObserved", record, {
        sessionId,
        source: { type: "session_workspace_operation", operationId: record.operationId ?? null }
      });
    }
  });
  return {
    sessionWorkspaceCoordinator, sessionProviderSwitchCoordinator,
    sessionWorktrees, sessionWorkspaceOperations
  };
}
