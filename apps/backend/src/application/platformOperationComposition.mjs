import { PlatformOperationService } from "./platformOperationService.mjs";
import { createTaskAndSession } from "./taskCreationApplicationService.mjs";
import { WorkInitializationService } from "./workInitializationService.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";

export function createWorkInitializationComposition({
  store, workService, sessionApplicationService, workDiscussionService, agentProviderRegistry, getDefaultProviderId
}) {
  return new WorkInitializationService({
    store, workService, discussionService: workDiscussionService,
    resolveProviderId: requested => {
      const providerId = requested ?? getDefaultProviderId();
      return agentProviderRegistry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE)
        && agentProviderRegistry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE) ? providerId : null;
    },
    deleteSession: sessionId => {
      // Initialization opens an empty Work Chat, never an executing prompt.
      // Use the shared unusable-Session cleanup so an offline Provider cannot
      // keep a failed Work's local resource graph alive.
      if (store.hasUnsettledSessionRuntimeWork(sessionId)) throw Object.assign(new Error("Work Chat began execution during initialization."), { code: "WORK_CHAT_ROLLBACK_BUSY" });
      return sessionApplicationService.deleteUnusableSession(sessionId, { source: "work-initialization-rollback" });
    }
  });
}

export function createPlatformOperationComposition({
  store, workService, sessionApplicationService, artifactService,
  collaborationCore, platformConfirmationService, sessionRuntimeReleaseService,
  listSessions, startWorkSession, launchAgentSession, getDefaultProviderId,
  emitEvent, workDiscussionService, agentProviderRegistry, workInitializationService
}) {
  const initialization = workInitializationService ?? createWorkInitializationComposition({
    store, workService, sessionApplicationService, workDiscussionService, agentProviderRegistry, getDefaultProviderId
  });
  return new PlatformOperationService({
    store,
    workService,
    sessionService: sessionApplicationService,
    artifactService,
    collaborationCore,
    confirmationService: platformConfirmationService,
    sessionRuntimeReleaseService,
    listSessions,
    initializeWork: (input, options) => initialization.create(input, options),
    verifyCreatedWork: result => initialization.verify(result),
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
      providerId: providerId ?? store.settings?.().newSessionDefaults?.taskCreation?.providerId ?? getDefaultProviderId(),
      idempotencyKey
    }),
    onEntityChanged: (type, payload) => emitEvent(type, payload)
  });
}
