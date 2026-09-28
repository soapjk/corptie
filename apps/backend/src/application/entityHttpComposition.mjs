import { handleEntityHttpRequest } from "./entityHttpApi.mjs";

// Domain route composition; global request guards and ordering stay in rootRouter.
export function createEntityHttpRoutes({
  workService, hubService, collaborationRouter, memoryExtractor, memoryRecallService,
  memoryLifecycleService, assistantService, workSessionStartApplicationService,
  agentProviderRegistry, launchAgentSession, workDiscussionService, ensureWorkChatSession,
  requestedProviderId, createSessionThroughApplication, backgroundAgentService,
  skillRegistryService, inspectTaskWorktree, reclaimTaskWorktree, taskDeletionService,
  restartTaskForEntityRoutes, setTaskArchivedForEntityRoutes, taskExecutionOrchestrator,
  taskCompletionService, sessionTitleReservations, emitEvent
}) {
  return function handleEntityRoutes({ request, response, url }) {
    return handleEntityHttpRequest({
    request,
    response,
    url,
    workService,
    hubService,
    router: collaborationRouter,
    memoryExtractor,
    memoryRecallService,
    memoryLifecycleService,
    assistantService,
    startWorkSession: (input) => workSessionStartApplicationService.start(input),
    defaultSessionProviderId: agentProviderRegistry.defaultProviderId,
    getTaskStartup: (input) => workSessionStartApplicationService.getReceipt(input),
    getSessionStartupBinding: (logicalSessionId) => workSessionStartApplicationService.getSessionBinding(logicalSessionId),
    launchAgentSession,
    workDiscussionService,
    ensureWorkChatSession,
    createSession: (input) => {
      const providerId = requestedProviderId(input.providerId ?? input.agent);
      return createSessionThroughApplication(providerId, input, { source: "http" });
    },
    backgroundAgentService,
    skillRegistryService,
    inspectTaskWorktree,
    reclaimTaskWorktree,
    inspectTaskDeletion: (taskId, actor) => taskDeletionService.inspect(taskId, actor),
    deleteTaskSafely: (taskId, input, actor) => taskDeletionService.request(taskId, input, actor),
    getTaskDeletionOperation: (operationId) => taskDeletionService.getOperation(operationId),
    restartTask: restartTaskForEntityRoutes,
    setTaskArchived: setTaskArchivedForEntityRoutes,
    restoreTaskExecution: (taskId) => taskExecutionOrchestrator.restore(taskId),
    taskCompletionService,
    resolveAgentAvailability: (agent) => {
      return { status: "available", reason: null };
    },
    suggestAgentSessionTitle: (agent) => sessionTitleReservations.availableAgentTitle(agent.name),
    observeTaskPerformance: (measurement) => {
      console.info(`[task-performance] ${JSON.stringify(measurement)}`);
    },
    observeFormAssistPerformance: (measurement) => {
      console.info(`[form-assist-performance] ${JSON.stringify(measurement)}`);
    },
    onEntityChanged: (type, payload) => emitEvent(type, payload)
  });
  };
}
