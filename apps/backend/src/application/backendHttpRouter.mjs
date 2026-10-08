export function routeBackendHttpRequest(request, response, ports) {
  const {
    clientDeviceGateway, sendJson, developmentPreview, clientCapabilities, backendStoreReady,
    store, taskCollaborationEdges, foundationModelSettings, rejectDevelopmentPreviewWrite, handleFoundationModelUpdateHttpRequest,
    agentProviderRegistry, backgroundAgentService, taskSummaryService, readJson, rejectUnavailableStoreRequest,
    dataRootMigrationCoordinator, handleSceneHttpRequest, sceneService, handleBackendRestartHttpRequest, shutdown,
    handlePlatformConfirmationHttpRequest, platformConfirmationService, errorStatus, handleSessionToolHttpRequest, collaborationCore,
    toolHostService, sessionToolMetadata, handleCollaborationRoutes, handleArtifactHttpRequest, artifactService,
    handleBenchmarkHttpRequest, benchmarkControlPlane, handleCodeTaskObservabilityHttpRequest, turnObservability, handleSshWorkspaceHttpRequest,
    getSshWorkspaceServices, handleMcpRegistryHttpRequest, mcpRegistryService, mcpSessionAvailabilityService, emitEvent,
    handleEntityRoutes, handleDshHttpRequest, sessionApplicationService, listGatewaySessions, readStoredSessionConversation,
    readStoredSessionTimeline, now, createSessionThroughApplication, publishDshPromptStart, sendUnifiedSessionMessage,
    publishDshPromptFailure, handleBackendHealthHttpRequest, projectCodeIndexStore, projectCodeRunIsolationPort, projectCodeApplicationService,
    projectCodeFreshnessMonitor, handleSettingsReadHttpRequest, handleProviderModelsHttpRequest, unifiedErrorStatus, handleSettingsUpdateHttpRequest,
    configureChoiceParserRuntime, codexRuntime, handleFeishuHttpRequest, feishuGateway, handleSessionTimelineHttpRequest,
    getStoredSessionSnapshot, getTimelineReadPool, readSessionUsage, readSessionHistory, readSessionTimelineWindow,
    publishStateChangesIfNeeded, handleSessionInteractionHttpRequest, userMessageCommandSource, chatResourceService, requireSessionReference,
    interruptUnifiedSession, cancelQueuedUserMessage, respondUnifiedSessionApproval, respondUnifiedSessionUserInput, handleSessionConfigurationHttpRequest, normalizeCodexSandbox,
    normalizeCodexApprovalPolicy, handleChoiceParserTestHttpRequest, parseChoiceStageWithConfiguredParser, handleProviderSetupHttpRequest, firstRunSetup,
    handleProjectWorkspaceHttpRequest, projectApplicationService, projectWorktreeIntegrationService, worktreeIntegrationJobService, handleSessionCollectionHttpRequest,
    sessions, listGatewaySessionPage, requestedProviderId, sessionForkService, sessionTitleErrorPayload,
    handleSessionOrganizationHttpRequest, normalizeSessionId, archiveStoredSession, sessionRuntimeReleaseService, upsertManagedCodexSession,
    handleSessionRecoveryHttpRequest, sessionRecoveryCoordinator, handleSessionGitHttpRequest, prepareGitHubPush, generateGitHubPushCommitMessage,
    confirmGitHubPush, projectWorktreeStatus, mergeProjectWorktree, prepareProjectWorktreeCommit, generateProjectWorktreeCommitMessage,
    commitProjectWorktree, completeProjectWorktree, operateProjectWorktree, restartProjectWorktree, handleSessionToolsetHttpRequest,
    projectToolsetStatus, projectWorkingDirectoryForSession, projectToolsetAuthenticatedSession, projectToolsetInitializer, projectToolsets,
    projectToolsetRunIsolationOptions, handleSessionMutationHttpRequest, sessionDeletionPlan, reserveSessionTitle, deleteSessionWithOptionalMerge,
    mergeSessionWorktreeBeforeDeletion, gitWorkspaces, handleSessionExecutionHttpRequest, sessionBindingReadinessProbe, handleSessionWorkspaceHttpRequest,
    ensureLogicalRouteForProviderSession, createGitWorkspaceSnapshot, reconcileMovedWorkspaceRoutes, sessionWorkspaceRecoveryStatus, switchSessionWorkspace,
    recoverableAgentWorkDir, ensureAgentWorkDir, switchSessionProvider, decorateSessionForClient, handleSessionTurnHttpRequest,
    handleStateSyncHttpRequest, eventLog, sseClients, stateSyncService, stateSyncClients,
    sessionStateDiagnostics, writeStateSyncFrame
  } = ports;
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname.startsWith("/internal/client-devices")) {
    if (!clientDeviceGateway && request.method === "GET" && url.pathname === "/internal/client-devices"
        && !request.headers.origin) sendJson(response, 200, {
      state: developmentPreview ? "preview" : "initializing", devices: [], pending: []
    });
    else if (!clientDeviceGateway) sendJson(response, 503, { code: "REMOTE_ACCESS_DISABLED" });
    else void clientDeviceGateway.handleAdmin(request, response);
    return;
  }
  if (url.pathname.startsWith("/client/")) {
    if (!clientDeviceGateway) sendJson(response, 503, { code: "REMOTE_ACCESS_DISABLED" });
    else void clientDeviceGateway.handle(request, response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/client-capabilities") {
    sendJson(response, 200, clientCapabilities());
    return;
  }
  if (request.method === "GET" && url.pathname === "/collaboration/task-edges") {
    if (!backendStoreReady || store.migrationInProgress) {
      sendJson(response, 503, { error: "Store unavailable" });
    } else {
      sendJson(response, 200, { edges: taskCollaborationEdges(store) });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/settings/foundation-model") {
    sendJson(response, 200, foundationModelSettings.publicValue());
    return;
  }
  if (rejectDevelopmentPreviewWrite({ request, response, url, developmentPreview, sendJson })) return;

  if (handleFoundationModelUpdateHttpRequest({
    request, response, url, backendStoreReady, store, foundationModelSettings,
    agentProviderRegistry, backgroundAgentService, taskSummaryService, readJson, sendJson
  })) return;
  if (rejectUnavailableStoreRequest({
    request, response, url, backendStoreReady, store, dataRootMigrationCoordinator, sendJson
  })) return;

  if (request.method === "GET" && url.pathname === "/search") {
    const failed = error => sendJson(response, error.statusCode ?? 500, { code: error.code ?? "SEARCH_FAILED", error: error.statusCode === 400 ? error.message : "Search unavailable." });
    try { void getTimelineReadPool().readUnifiedSearch({ query: url.searchParams.toString() })
      .then(result => sendJson(response, 200, result)).catch(failed); }
    catch (error) { failed(error); }
    return;
  }

  if (handleSceneHttpRequest({ request, response, url, service: sceneService })) return;

  const taskSummaryRefreshMatch = url.pathname.match(/^\/tasks\/([^/]+)\/summary-refresh$/);
  if (taskSummaryRefreshMatch && request.method === "POST") {
    const accepted = taskSummaryService.request(decodeURIComponent(taskSummaryRefreshMatch[1]));
    sendJson(response, accepted ? 202 : 409, { accepted,
      ...(accepted ? {} : { code: "TASK_SUMMARY_UNAVAILABLE", error: "此 Task 当前无法生成摘要。" }) });
    return;
  }

  if (handleBackendRestartHttpRequest({ request, response, url, dataRootMigrationCoordinator, shutdown, sendJson })) return;

  if (handlePlatformConfirmationHttpRequest({ request, response, url, platformConfirmationService, readJson, sendJson, errorStatus })) return;

  if (handleSessionToolHttpRequest({
    request, response, url, store, collaborationCore, toolHostService,
    sessionToolMetadata, readJson, sendJson, errorStatus
  })) return;

  if (handleCollaborationRoutes({ request, response, url })) return;

  if (handleArtifactHttpRequest({ request, response, url, service: artifactService })) {
    return;
  }
  if (handleBenchmarkHttpRequest({ request, response, url, controlPlane: benchmarkControlPlane })) {
    return;
  }

  if (handleCodeTaskObservabilityHttpRequest({ request, response, url, service: turnObservability })) {
    return;
  }

  if (url.pathname.startsWith("/ssh/")) {
    handleSshWorkspaceHttpRequest({
      request, response, url,
      repository: store.sshWorkspaces,
      ...getSshWorkspaceServices()
    }).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "SSH configuration operation failed." });
    });
    return;
  }

  if (url.pathname === "/mcp-servers" || url.pathname.startsWith("/mcp-servers/")
    || url.pathname === "/mcp-availability"
    || /^\/agents\/[^/]+\/mcp-servers(?:\/[^/]+)?$/.test(url.pathname)
    || /^\/sessions\/[^/]+\/mcp-availability$/.test(url.pathname)) {
    handleMcpRegistryHttpRequest({ request, response, url, service: mcpRegistryService,
      availabilityService: mcpSessionAvailabilityService,
      onChanged: (type, payload) => emitEvent(type, payload) }).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { code: "MCP_MANAGEMENT_FAILED", error: error.message });
    });
    return;
  }

  if (handleEntityRoutes({ request, response, url })) return;

  if (handleDshHttpRequest({
    request, response, url, sessionApplicationService, store, listGatewaySessions,
    sendJson, readJson, readStoredSessionConversation, readStoredSessionTimeline, now,
    createSession: (input, dshContext = {}) => createSessionThroughApplication(
      "codex-app-server",
      input,
      { source: "dsh", ...dshContext }
    ),
    sendSessionMessage: async (sessionId, text) => {
      publishDshPromptStart(sessionId, text);
      try {
        return await sendUnifiedSessionMessage(sessionId, text, { type: "dsh" });
      } catch (error) {
        publishDshPromptFailure(sessionId, error?.message ?? "Send failed");
        throw error;
      }
    }
  })) return;

  if (handleBackendHealthHttpRequest({
    request, response, url, developmentPreview, now, backendStoreReady, store,
    dataRootMigrationCoordinator, projectCodeIndexStore, projectCodeRunIsolationPort,
    projectCodeApplicationService, projectCodeFreshnessMonitor, sendJson
  })) return;

  if (handleSettingsReadHttpRequest({
    request, response, url, store, developmentPreview, dataRootMigrationCoordinator, sendJson
  })) return;

  if (handleProviderModelsHttpRequest({
    request, response, url, sessionApplicationService, sendJson, unifiedErrorStatus
  })) return;

  if (handleSettingsUpdateHttpRequest({
    request, response, url, store, dataRootMigrationCoordinator,
    configureChoiceParserRuntime, readJson, sendJson, errorStatus,
    onSettingsSaved: async (before, settings) => {
      // Preserve the existing adapter-specific configuration invalidation at composition.
      const codexBackendChanged = JSON.stringify(before.codexBackend) !== JSON.stringify(settings.codexBackend);
      const codexProxyChanged = JSON.stringify(before.agentProxy?.codex) !== JSON.stringify(settings.agentProxy?.codex);
      if (codexBackendChanged || codexProxyChanged) {
        await codexRuntime.close();
      }
    }
  })) return;

  if (handleFeishuHttpRequest({
    request, response, url, feishuGateway, store,
    readJson, sendJson, emitEvent, unifiedErrorStatus
  })) return;

  if (handleSessionTimelineHttpRequest({
    request, response, url, store, sessionApplicationService,
    getStoredSessionSnapshot, getTimelineReadPool, readSessionUsage,
    readSessionHistory, readSessionTimelineWindow, publishStateChangesIfNeeded,
    readJson, sendJson, unifiedErrorStatus
  })) return;

  if (handleSessionInteractionHttpRequest({
    request, response, url, sendUnifiedSessionMessage, userMessageCommandSource,
    chatResourceService, requireSessionReference, interruptUnifiedSession, cancelQueuedUserMessage,
    respondUnifiedSessionApproval, respondUnifiedSessionUserInput,
    readJson, sendJson, unifiedErrorStatus
  })) return;

  if (handleSessionConfigurationHttpRequest({
    request, response, url, sessionApplicationService, requireSessionReference,
    normalizeSandbox: normalizeCodexSandbox,
    normalizeApprovalPolicy: normalizeCodexApprovalPolicy,
    emitEvent, readJson, sendJson, unifiedErrorStatus
  })) return;

  if (handleChoiceParserTestHttpRequest({
    request, response, url, store, configureChoiceParserRuntime,
    parseChoiceStageWithConfiguredParser, readJson, sendJson
  })) return;

  if (handleProviderSetupHttpRequest({
    request, response, url, agentProviderRegistry, firstRunSetup, readJson, sendJson, errorStatus
  })) return;

  if (handleProjectWorkspaceHttpRequest({
    request, response, url, projectApplicationService,
    projectWorktreeIntegrationService, worktreeIntegrationJobService,
    readJson, sendJson, emitEvent, errorStatus, unifiedErrorStatus
  })) return;

  if (handleSessionCollectionHttpRequest({
    request, response, url, sessions, store, agentProviderRegistry,
    listGatewaySessionPage, requestedProviderId, createSessionThroughApplication,
    sessionForkService, readJson, sendJson, errorStatus, unifiedErrorStatus, sessionTitleErrorPayload
  })) return;

  if (handleSessionOrganizationHttpRequest({
    request, response, url, store, normalizeSessionId, listGatewaySessions,
    readJson, sendJson, emitEvent, errorStatus, unifiedErrorStatus,
    archiveSession: (sessionId, archived) => archiveStoredSession(sessionId, archived, {
      store, sessionRuntimeReleaseService, normalizeSessionId,
      // Retains legacy projection restoration until the old archive path is retired.
      legacyArchiveFor: (id) => id.startsWith("codex:") ? { upsert: upsertManagedCodexSession } : null
    })
  })) return;

  if (handleSessionRecoveryHttpRequest({
    request, response, url, store, requireSessionReference, sessionRecoveryCoordinator,
    readJson, sendJson, errorStatus
  })) return;

  if (handleSessionGitHttpRequest({
    request, response, url, prepareGitHubPush, generateGitHubPushCommitMessage,
    confirmGitHubPush, projectWorktreeStatus, mergeProjectWorktree, prepareProjectWorktreeCommit,
    generateProjectWorktreeCommitMessage, commitProjectWorktree, completeProjectWorktree,
    operateProjectWorktree, restartProjectWorktree, readJson, sendJson, errorStatus
  })) return;
  if (handleSessionToolsetHttpRequest({
    request, response, url, projectToolsetStatus, projectWorkingDirectoryForSession,
    projectToolsetAuthenticatedSession, projectToolsetInitializer, projectToolsets,
    projectToolsetRunIsolationOptions, readJson, sendJson, errorStatus, emitEvent
  })) return;
  if (handleSessionMutationHttpRequest({
    request, response, url, sessionDeletionPlan, sessionApplicationService,
    reserveSessionTitle, emitEvent, readJson, sendJson,
    errorStatus, unifiedErrorStatus, sessionTitleErrorPayload,
    deleteSession: (sessionId, options) => deleteSessionWithOptionalMerge(sessionId, options, {
      sessionApplicationService, sessionDeletionPlan, mergeSessionWorktreeBeforeDeletion,
      store, gitWorkspaces,
      // Legacy merge-before-delete is still restricted by the existing deletion planner.
      // Keep this compatibility policy out of the provider-neutral deletion operation.
      supportsMergeBeforeDeletion: (reference) => reference.providerId === "codex-app-server"
    })
  })) return;

  if (handleSessionExecutionHttpRequest({
    request, response, url, sessionApplicationService, sessionBindingReadinessProbe,
    sendJson, unifiedErrorStatus
  })) return;

  if (handleSessionWorkspaceHttpRequest({
    request, response, url, store, sessionApplicationService, requireSessionReference,
    ensureLogicalRouteForProviderSession, createGitWorkspaceSnapshot, reconcileMovedWorkspaceRoutes,
    sessionWorkspaceRecoveryStatus, switchSessionWorkspace, recoverableAgentWorkDir, ensureAgentWorkDir,
    gitWorkspaces, switchSessionProvider, decorateSessionForClient,
    readJson, sendJson, emitEvent, errorStatus, unifiedErrorStatus
  })) return;

  if (handleSessionTurnHttpRequest({ request, response, url, sessionApplicationService, readJson, sendJson, errorStatus, unifiedErrorStatus })) return;

  if (handleStateSyncHttpRequest({
    request, response, url, store, eventLog, sseClients, stateSyncService,
    stateSyncClients, sessionStateDiagnostics, writeStateSyncFrame, sendJson
  })) return;

  const cancelMatch = url.pathname.match(/^\/tasks\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const taskId = decodeURIComponent(cancelMatch[1]);
    if (taskId.startsWith("codex:")) {
      interruptUnifiedSession(taskId, { type: "legacy-task-api" })
        .then((session) => sendJson(response, 200, { session }))
        .catch((error) => sendJson(response, unifiedErrorStatus(error), {
          error: error.message,
          code: error.code ?? null
        }));
      return;
    }

    const session = sessions.get(taskId);
    if (!session) {
      sendJson(response, 404, { error: "Task not found" });
      return;
    }

    session.status = "cancelled";
    session.summary = "Cancelled by user.";
    session.updatedAt = now();
    emitEvent("TaskCancelled", { session });
    sendJson(response, 200, { session });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}
