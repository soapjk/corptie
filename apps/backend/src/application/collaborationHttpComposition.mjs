import { handleCollaborationHttpRequest } from "../collaboration/collaborationHttpApi.mjs";
import { handleSessionContextReferenceHttpRequest } from "./sessionContextReferenceHttpApi.mjs";
import { handleScheduledSessionTaskHttpRequest } from "./scheduledSessionTaskHttpApi.mjs";

// Collaboration-facing HTTP wiring. Authorization remains in each handler;
// the host runs its global Store and development-preview guards first.
export function createCollaborationHttpRoutes({
  collaborationCore, sessionCollaborationV2Enabled, sessionCollaborationService,
  sessionChannelService, emitEvent, resolveCollaborationConfirmation, resolveSessionChannelRequest,
  projectSessionChannelMessageForSender, syncSessionChannelDeliveriesIntoAgentWorkQueue,
  sessionWorkspaceOperations, memoryOperationService, skillRegistryService, reportTaskAcceptanceForAgent,
  sessionContextReferenceService, scheduledSessionTaskService,
  scheduledSessionHttpActor, scheduledSessionHttpLogicalSessionId
}) {
  return function handleCollaborationRoutes({ request, response, url }) {
    if (handleCollaborationHttpRequest({
      request,
      response,
      url,
      core: collaborationCore,
      sessionCollaborationService: sessionCollaborationV2Enabled ? sessionCollaborationService : null,
      sessionChannelService,
      onConfirmationStaged: async (confirmation) => {
        emitEvent("CollaborationConfirmationRequested", {
          sessionId: confirmation.sourceSessionId,
          confirmation
        }, { sessionId: confirmation.sourceSessionId });
      },
      onConfirmationResolved: resolveCollaborationConfirmation,
      onChannelRequestStaged: async (channelRequest) => {
        emitEvent("SessionChannelAuthorizationRequested", {
          sessionId: channelRequest.requestingSessionId,
          channelRequest
        }, { sessionId: channelRequest.requestingSessionId });
      },
      onChannelRequestResolved: resolveSessionChannelRequest,
      onChannelMessageCreated: async (result) => {
        projectSessionChannelMessageForSender(result);
        await syncSessionChannelDeliveriesIntoAgentWorkQueue();
      },
      onListWorkspaces: (agentId, metadata) => sessionWorkspaceOperations.listWorkspaces(metadata, agentId),
      onCreateWorktree: (agentId, input, metadata) => sessionWorkspaceOperations.createWorktree(metadata, agentId, input),
      onSwitchWorkspace: (agentId, input, metadata) => sessionWorkspaceOperations.switchWorkspace(metadata, agentId, input),
      onMemoryOperation: (agentId, tool, args, metadata) => memoryOperationService.execute({
        actorId: agentId,
        tool,
        arguments: args,
        metadata
      }),
      onSearchSkills: (agentId, intent) => skillRegistryService.searchForAgent(agentId, intent),
      onLoadSkill: (agentId, skillId) => skillRegistryService.loadForAgent(agentId, skillId),
      onReportTaskAcceptance: reportTaskAcceptanceForAgent
    })) {
      return true;
    }

    if (handleSessionContextReferenceHttpRequest({
      request,
      response,
      url,
      service: sessionContextReferenceService
    })) {
      return true;
    }

    if (handleScheduledSessionTaskHttpRequest({
      request,
      response,
      url,
      service: scheduledSessionTaskService,
      resolveActor: scheduledSessionHttpActor,
      resolveCurrentLogicalSessionId: scheduledSessionHttpLogicalSessionId,
      observePerformance: (measurement) => {
        console.info(`[scheduled-task-performance] ${JSON.stringify({ stage: "http", ...measurement })}`);
      }
    })) {
      return true;
    }
    return false;
  };
}
