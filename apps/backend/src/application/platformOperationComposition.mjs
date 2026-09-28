import { PlatformOperationService } from "./platformOperationService.mjs";
import { createTaskAndSession } from "./taskCreationApplicationService.mjs";

export function createPlatformOperationComposition({
  store, workService, sessionApplicationService, artifactService,
  collaborationCore, platformConfirmationService, sessionRuntimeReleaseService,
  listSessions, startWorkSession, launchAgentSession, getDefaultProviderId,
  emitEvent
}) {
  return new PlatformOperationService({
    store,
    workService,
    sessionService: sessionApplicationService,
    artifactService,
    collaborationCore,
    confirmationService: platformConfirmationService,
    sessionRuntimeReleaseService,
    listSessions,
    createSession: async ({
      agentId, providerId, taskId, expectedTaskVersion, title, prompt,
      sourceSessionId, idempotencyKey
    }) => {
      if (taskId) {
        const started = await startWorkSession({
          taskId,
          assigneeAgentId: agentId,
          expectedTaskVersion,
          providerId,
          title,
          idempotencyKey,
          sourceSessionId
        });
        return started.session;
      }
      const agent = store.getAgent(agentId);
      if (!agent) {
        const error = new Error(`Agent not found: ${agentId}`);
        error.code = "AGENT_NOT_FOUND";
        throw error;
      }
      return launchAgentSession({ agent, providerId, title, prompt });
    },
    createTask: ({ taskInput, providerId, sourceSessionId, creationContextMessageId, idempotencyKey }) => createTaskAndSession({
      workService,
      startWorkSession,
      taskInput,
      creationOrigin: {
        originType: "session",
        creatorSessionId: sourceSessionId,
        creationContextMessageId,
        operationId: idempotencyKey
      },
      sourceSessionId,
      providerId: providerId ?? getDefaultProviderId(),
      idempotencyKey
    }),
    onEntityChanged: (type, payload) => emitEvent(type, payload)
  });
}
