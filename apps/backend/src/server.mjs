import http from "node:http";
import { deleteUnreceivedUserMessage } from "./application/userMessageDeletion.mjs";
import { routeBackendHttpRequest } from "./application/backendHttpRouter.mjs";
import { createProductEventPublisher } from "./application/productEventPublisher.mjs";
import { createStartupRecoveryOperations } from "./application/startupRecoveryOperations.mjs";
import {
  createSessionToolBindingProjection, desiredToolDomainIds
} from "./application/sessionToolBindingProjection.mjs";
import { createCodexNotificationReceiver } from "./adapters/codexNotificationReceiver.mjs";
import { createClaudeNotificationReceiver } from "./adapters/claudeNotificationReceiver.mjs";
import { createRuntimeAgentWorkQueue } from "./runtime/runtimeAgentWorkQueue.mjs";
import { createCodexReplyProbe, createClaudeReplyProbe, createOpenClackyReplyProbe } from "./agent-provider/providers/providerReplyProbe.mjs";
import { ensureFirstRunAssistantGreeting } from "./application/firstRunAssistantGreeting.mjs";
import { FirstRunSetupService } from "./application/firstRunSetupService.mjs";
import { resolveExternalCommand } from "./utils/externalCommand.mjs";
import { createMockSessionFixtures } from "./application/mockSessionFixtures.mjs";
import { createBackendShutdown } from "./application/backendShutdown.mjs";
import { createWorkspaceTransitionContextReader } from "./application/workspaceTransitionContextReader.mjs";
import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { pathExists, assertDirectory } from "./utils/localPathAccess.mjs";
import { sendJson, readJson } from "./application/backendHttpIO.mjs";
import { proxyEnvForProfile } from "./adapters/providerProxyEnv.mjs";
import { safeTurnFileChanges, turnDiffFor, writeTurnPatch, prepareExternalDiff, launchDiffTool } from "./application/turnDiffReview.mjs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createProviderModelCatalogLoaders } from "./adapters/providerModelCatalogLoaders.mjs";
import {
  codexAppServerSessionCapabilities, readCodexDefaultConfig,
  createCodexSessionConfiguration
} from "./adapters/codexSessionConfiguration.mjs";
import { createCodexConversationClear } from "./adapters/codexConversationClear.mjs";
import { createCodexSessionCommands } from "./adapters/codexSessionCommands.mjs";
import { createCodexTurnDispatcher } from "./adapters/codexTurnDispatcher.mjs";
import { createCodexSessionCreator } from "./adapters/codexSessionCreator.mjs";
import {
  mapCodexThreadToLegacyTimelineItems
} from "./adapters/codexAppServer.mjs";
import { createCodexProviderRuntime } from "./agent-provider/bootstrap/codexProviderRuntime.mjs";
import { configureChoiceParserRuntime, parseChoiceStageWithConfiguredParser } from "./adapters/choiceParser.mjs";
import { createCodexChoiceProjection } from "./adapters/codexChoiceProjection.mjs";
import { createSessionApplicationComposition } from "./application/sessionApplicationComposition.mjs";
import { createSessionForkOperations } from "./application/sessionForkOperations.mjs";
import { createForkWorktree } from "./runtime/forkWorktree.mjs";
import { createSessionReadinessProjection } from "./application/sessionReadinessProjection.mjs";
import { SessionBindingReadinessProbe } from "./application/sessionBindingReadinessProbe.mjs";
import { createSessionMessageOperation } from "./application/sessionMessageOperation.mjs";
import { SessionStateDiagnostics } from "./application/sessionStateDiagnostics.mjs";
import { ProjectApplicationService } from "./application/projectApplicationService.mjs";
import { createWorktreeIntegrationServices } from "./application/worktreeIntegrationComposition.mjs";
import { BackgroundAgentService } from "./application/backgroundAgentService.mjs";
import { FoundationModelSettings } from "./application/foundationModelSettings.mjs";
import { taskCollaborationEdges } from "./application/taskCollaborationEdges.mjs";
import { TaskSummaryService } from "./application/taskSummaryService.mjs";
import { createSkillPackageDiscoveryAssistant } from "./application/skillPackageDiscoveryAssistant.mjs";
import { createHostToolCatalog } from "./application/hostToolCatalogComposition.mjs";
import { appliedToolMaterializationReceipt } from "./agent-provider/toolSchemaCapabilities.mjs";
import {
  ProviderSessionLifecycle,
  codexLifecycleAdapter
} from "./application/providerSessionLifecycle.mjs";
import { createPlatformOperationComposition } from "./application/platformOperationComposition.mjs";
import { createTaskWorktreeOperations } from "./application/taskWorktreeOperations.mjs";
import { createProjectWorktreeOperations } from "./application/projectWorktreeOperations.mjs";
import { PlatformConfirmationService } from "./application/platformConfirmationService.mjs";
import { SessionCollaborationService } from "./application/sessionCollaborationService.mjs";
import { SessionChannelService } from "./collaboration/sessionChannelService.mjs";
import { loadStartupSessionInventory } from "./application/startupSessionInventory.mjs";
import { createManagedProviderSessionProjection } from "./application/managedProviderSessionProjection.mjs";
import { createProjectWorktreeStatusReader } from "./application/projectWorktreeStatusReader.mjs";
import { WorkChatContextService } from "./application/workChatContextService.mjs";
import { WorkDiscussionApplicationService } from "./application/workDiscussionApplicationService.mjs";
import { WorkChatOperationService } from "./application/workChatDynamicTools.mjs";
import { createSessionWorkspaceComposition } from "./application/sessionWorkspaceComposition.mjs";
import { createWorkspaceSessionToolAuthority } from "./application/workspaceSessionToolAuthority.mjs";
import { createProviderTerminalLifecycle } from "./application/providerTerminalLifecycle.mjs";
import { createProviderWorkspaceSwitches } from "./application/providerWorkspaceSwitchOperation.mjs";
import { resolveWorkspaceTransitionRuntime } from "./application/workspaceTransitionRuntimeRouting.mjs";
import { archiveStoredSession } from "./application/sessionArchiveOperation.mjs";
import { handleSessionOrganizationHttpRequest } from "./application/sessionOrganizationHttpApi.mjs";
import { createSessionUsageReader } from "./application/sessionUsageReader.mjs";
import { createTaskExecutionComposition } from "./application/taskExecutionComposition.mjs";
import { TaskWorkspaceService } from "./application/taskWorkspaceService.mjs";
import { createWorkSessionStartupComposition } from "./application/workSessionStartupComposition.mjs";
import {
  persistedProviderWorkspaceProof
} from "./agent-provider/providerWorkspaceBindingService.mjs";
import { WorkspaceContinuationCoordinator } from "./application/workspaceContinuationCoordinator.mjs";
import { ArtifactService } from "./application/artifactService.mjs";
import { ChatResourceService } from "./application/chatResourceService.mjs";
import { migrateStoreOffMainThread } from "./store/storeMigrationRunner.mjs";
import { createSessionTimelineReader } from "./application/sessionTimelineReader.mjs";
import { ContextReadService } from "./application/contextReadService.mjs";
import { createBenchmarkControlPlaneComposition } from "./application/benchmarkControlPlaneComposition.mjs";
import { handleBenchmarkHttpRequest } from "./benchmark/httpApi.mjs";
import { handleArtifactHttpRequest } from "./application/artifactHttpApi.mjs";
import { clientCapabilities } from "./application/clientCapabilities.mjs";
import { startClientDeviceGateway } from "./application/clientDeviceGatewayComposition.mjs";
import { scheduleBackendStartupMaintenance } from "./application/backendStartupMaintenance.mjs";
import { createSessionInteractionCommands } from "./application/sessionInteractionCommands.mjs";
import { ToolHostService } from "./application/toolHostService.mjs";
import { SkillMcpGateway } from "./application/skillMcpGateway.mjs";
import { assignedCapabilitySummary } from "./application/skillMcpTurnContext.mjs";
import { McpRegistryService } from "./application/mcpRegistryService.mjs";
import { McpSessionAvailabilityService } from "./application/mcpSessionAvailabilityService.mjs";
import { handleMcpRegistryHttpRequest } from "./application/mcpRegistryHttpApi.mjs";
import { handleSessionToolHttpRequest } from "./application/sessionToolHttpApi.mjs";
import { requiredToolDomainsForSession as resolveSessionToolDomainRequirements } from "./application/sessionToolDomainRequirements.mjs";
import { ToolMaterializationPort } from "./application/toolMaterializationPort.mjs";
import {
  RegistryToolMaterializationPort,
  ToolHostMaterializationCoordinator
} from "./application/toolHostMaterializationCoordinator.mjs";
import { createProviderStartupPreflights } from "./agent-provider/bootstrap/providerStartupPreflightComposition.mjs";
import { SessionBindingRepository } from "./agent-provider/sessionBindingRepository.mjs";
import { createClaudeProviderRuntime } from "./agent-provider/bootstrap/claudeProviderBootstrap.mjs";
import { createOpenClackyRuntimeManager } from "./agent-provider/bootstrap/openClackyRuntimeManagerComposition.mjs";
import { createOpenClackyProvider } from "./agent-provider/providers/openClackyProvider.mjs";
import { openClackyToolHostAttachment } from "./agent-provider/providers/openClackyToolHostAttachment.mjs";
import { OpenClackyWorkspaceTransitionPort } from "./agent-provider/adapters/openClackyWorkspaceTransitionPort.mjs";
import { ClaudeWorkspaceTransitionPort } from "./agent-provider/adapters/claudeWorkspaceTransitionPort.mjs";
import {
  claudeToolHostAttachment,
  codexToolHostAttachment
} from "./agent-provider/bootstrap/agentProviderBootstrap.mjs";
import { createProviderRuntimeRegistryComposition } from "./agent-provider/bootstrap/providerRuntimeRegistryComposition.mjs";
import { FeishuGatewayManager } from "./feishu/feishuGatewayManager.mjs";
import { handleFeishuHttpRequest } from "./feishu/feishuHttpApi.mjs";
import { CollaborationCore } from "./collaboration/collaborationCore.mjs";
import { CollaborationDeliveryDispatcher } from "./collaboration/collaborationDeliveryDispatcher.mjs";
import { CollaborationDeliveryRouteResolver } from "./collaboration/collaborationDeliveryRouteResolver.mjs";
import { createSessionChannelDeliveryOperation } from "./application/sessionChannelDeliveryOperation.mjs";
import { createCollaborationDeliveryQueue } from "./collaboration/collaborationDeliveryQueue.mjs";
import { createCollaborationTimelinePresentation } from "./collaboration/collaborationTimelinePresentation.mjs";
import { createCollaborationHttpRoutes } from "./application/collaborationHttpComposition.mjs";
import { WorkApplicationService } from "./application/workApplicationService.mjs";
import { createTaskAndSession } from "./application/taskCreationApplicationService.mjs";
import { TaskCompletionService } from "./application/taskCompletionService.mjs";
import { SessionRuntimeReleaseService } from "./application/sessionRuntimeReleaseService.mjs";
import { HubService, createOpenAiEmbedder } from "./application/hubService.mjs";
import { AgentContextService } from "./application/agentContextService.mjs";
import { MemoryOperationService } from "./application/memoryOperationService.mjs";
import { MemoryRecallService } from "./application/memoryRecallService.mjs";
import { MemoryLifecycleService } from "./application/memoryLifecycleService.mjs";
import { SkillRegistryService } from "./application/skillRegistryService.mjs";
import { CollaborationRouter } from "./application/collaborationRouter.mjs";
import { SceneApplicationService } from "./scenes/sceneApplicationService.mjs";
import { handleSceneHttpRequest } from "./scenes/sceneHttpApi.mjs";
import { MemoryExtractor } from "./application/memoryExtractor.mjs";
import { MemoryExtractionScheduler } from "./application/memoryExtractionScheduler.mjs";
import { createMemoryModelClassifier } from "./application/memoryModelClassifier.mjs";
import { AssistantService, createAssistantIntentResolver } from "./application/assistantService.mjs";
import { createEntityHttpRoutes } from "./application/entityHttpComposition.mjs";
import { handleSshWorkspaceHttpRequest } from "./application/sshWorkspaceHttpApi.mjs";
import { SshConnectionService } from "./application/sshConnectionService.mjs";
import { SshWorkspaceProbeService } from "./application/sshWorkspaceProbeService.mjs";
import { SshWorkspaceTransport } from "./runtime/sshWorkspaceTransport.mjs";
import { SessionContextReferenceService } from "./application/sessionContextReferenceService.mjs";
import { ScheduledSessionTaskService } from "./application/scheduledSessionTaskService.mjs";
import { createScheduledSessionRouteResolver } from "./application/scheduledSessionRoute.mjs";
import { handleDshHttpRequest } from "./dsh-adapter/dshHttpApi.mjs";
import { handlePlatformConfirmationHttpRequest } from "./application/platformConfirmationHttpApi.mjs";
import { handleSessionTurnHttpRequest } from "./application/sessionTurnHttpApi.mjs";
import { handleBackendRestartHttpRequest, handleBackendHealthHttpRequest } from "./application/backendLifecycleHttpApi.mjs";
import { rejectDevelopmentPreviewWrite, rejectUnavailableStoreRequest } from "./application/backendHttpGuards.mjs";
import {
  handleDshWebSocketUpgrade,
  broadcastDshMuxFrame,
  broadcastDshHostFrame,
} from "./dsh-adapter/dshWebSocket.mjs";
import { createDshLivePublisher } from "./dsh-adapter/dshLivePublisher.mjs";
import { DataRootMigrationCoordinator } from "./runtime/dataRootMigrationCoordinator.mjs";
import { BackendDataRootOwnership } from "./runtime/backendDataRootOwnership.mjs";
import { ProviderEventIngestionService } from "./application/providerEventIngestionService.mjs";
import { ProviderTurnResponseWatchdog } from "./application/providerTurnResponseWatchdog.mjs";
import { createTurnExecutionProbe } from "./application/turnExecutionProbeComposition.mjs";
import { ProviderEventProjector } from "./application/providerEventProjector.mjs";
import { LegacySessionHistoryRepairService } from "./application/legacySessionHistoryRepairService.mjs";
import { createSessionRecoveryComposition } from "./agent-provider/bootstrap/sessionRecoveryComposition.mjs";
import { CorptieStore } from "./store/corptieStore.mjs";
import { resolveCodexCommand } from "./utils/codexCommand.mjs";
import { resolvePlatformAdminSession } from "./utils/platformAssistantIdentity.mjs";
import { environmentForCommand } from "./utils/externalCommand.mjs";
import {
  sessionHasActiveRun,
  workspaceContinuationKeepsSessionActive
} from "./utils/sessionPresentation.mjs";
import { defaultWorkspacePath, sessionWorkspacePath } from "./utils/workspacePaths.mjs";
import { ensureCorptieCodexRuntime, resolveCorptieRuntimePaths } from "./runtime/corptieCodexRuntime.mjs";
import { createProviderStartupMaintenance } from "./agent-provider/bootstrap/providerStartupMaintenance.mjs";
import { ensureAgentWorkDir, recoverableAgentWorkDir } from "./runtime/agentWorkDir.mjs";
import { clearWorkAvatar as clearWorkAvatarFile } from "./runtime/agentAvatar.mjs";
import { ensureCorptieClaudeRuntime, resolveCorptieClaudeRuntimePaths } from "./runtime/corptieClaudeRuntime.mjs";
import { ensureCorptieOpenClackyRuntime, resolveCorptieOpenClackyRuntimePaths } from "./runtime/corptieOpenClackyRuntime.mjs";
import { OpenClackyServerRuntime, resolveOpenClackyCommand, resolveOpenClackyManagedPort } from "./runtime/openClackyServerRuntime.mjs";
import {
  codexPermissionsForSession,
  normalizeCodexApprovalPolicy,
  normalizeCodexSandbox
} from "./utils/codexPermissions.mjs";
import { normalizeNewSessionDefaults } from "./utils/newSessionDefaults.mjs";
import { configureBackendLogging } from "./utils/backendLogging.mjs";
import { createPersistentRuntimeLifecycle } from "./application/persistentRuntimeLifecycle.mjs";
import { createCollaborationProviderOptions } from "./adapters/collaborationProviderOptions.mjs";
import {
  logSessionMessageLatency
} from "./utils/sessionMessageLatency.mjs";
import { createGitWorkspaceSnapshot, inspectGitWorkspace } from "./utils/gitWorktreeInventory.mjs";
import { ForkingWorkspaceTransitionManager } from "./runtime/forkingWorkspaceTransitionManager.mjs";
import { GitWorkspaceManager } from "./runtime/gitWorkspaceManager.mjs";
import { GitHubPushManager } from "./runtime/gitHubPushManager.mjs";
import { GitCommitProtection } from "./runtime/gitCommitProtection.mjs";
import { ensureArtifactCommitHook } from "./runtime/artifactCommitHook.mjs";
import { ProjectToolsetManager } from "./runtime/projectToolsetManager.mjs";
import { handleSessionGitHttpRequest } from "./application/sessionGitHttpApi.mjs";
import { handleSessionToolsetHttpRequest } from "./application/sessionToolsetHttpApi.mjs";
import { handleSessionWorkspaceHttpRequest } from "./application/sessionWorkspaceHttpApi.mjs";
import { createProjectCodeProductionComposition } from "./application/projectCodeProductionComposition.mjs";
import { initializeBackendStoreReadiness } from "./application/backendStoreReadiness.mjs";
import { activateStartupSessions } from "./application/startupSessionActivation.mjs";
import { createProjectWorktreeGitOperations } from "./application/projectWorktreeGitOperations.mjs";
import { createSessionGitHubPushOperations } from "./application/sessionGitHubPushOperations.mjs";
import { PROJECT_CODE_MODEL_RECOMMENDATION_ENABLED } from "./project-code/projectCodeDynamicTools.mjs";
import { assertWorkspaceRouteUsable } from "./runtime/workspaceRouteGuard.mjs";
import { WorkspaceRoutePreparationCache } from "./runtime/workspaceRoutePreparationCache.mjs";
import { createCommitMessageOperations } from "./application/commitMessageOperations.mjs";
import {
  resumeWorkAfterTransition,
  workspaceTransitionBlocksWork
} from "./runtime/workspaceTransitionBarrier.mjs";
import { ReplayEventLog } from "./utils/replayEventLog.mjs";
import { handleStateSyncHttpRequest } from "./application/stateSyncHttpApi.mjs";
import { handleSettingsReadHttpRequest, handleSettingsUpdateHttpRequest } from "./application/settingsHttpApi.mjs";
import { handleFoundationModelUpdateHttpRequest, handleChoiceParserTestHttpRequest } from "./application/modelSettingsHttpApi.mjs";
import { BackendRuntimeActivity } from "./application/backendRuntimeActivity.mjs";
import { CodeTaskObservabilityService } from "./observability/codeTaskObservability.mjs";
import { handleCodeTaskObservabilityHttpRequest } from "./observability/codeTaskObservabilityHttpApi.mjs";
import { OBSERVABILITY_DEPENDENCY_PINS } from "./observability/dependencyContractManifest.mjs";
import {
  resolveStableSessionIdForProviderDetail
} from "./application/providerSessionIdentity.mjs";
import { RunIsolationAuthorityResolver, RunIsolationExecutionCoordinator } from "./runIsolation/index.mjs";
import { handleSessionTimelineHttpRequest } from "./application/sessionTimelineHttpApi.mjs";
import { handleSessionInteractionHttpRequest } from "./application/sessionInteractionHttpApi.mjs";
import { handleSessionConfigurationHttpRequest } from "./application/sessionConfigurationHttpApi.mjs";
import { handleProviderModelsHttpRequest, handleProviderSetupHttpRequest } from "./application/providerSetupHttpApi.mjs";
import { handleProjectWorkspaceHttpRequest } from "./application/projectWorkspaceHttpApi.mjs";
import { handleSessionCollectionHttpRequest } from "./application/sessionCollectionHttpApi.mjs";
import { handleSessionMutationHttpRequest } from "./application/sessionMutationHttpApi.mjs";
import { deleteSessionWithOptionalMerge } from "./application/sessionDeletionOperation.mjs";
import { handleSessionRecoveryHttpRequest, handleSessionExecutionHttpRequest } from "./application/sessionExecutionHttpApi.mjs";
import { createControlPlaneProjection } from "./application/controlPlaneProjection.mjs";
import { createSessionTitleReservations } from "./application/sessionTitleReservations.mjs";
import { createSessionTaskCommands } from "./application/sessionTaskCommands.mjs";
import { createTaskSessionProjection } from "./application/taskSessionProjection.mjs";
import { createProviderEventPublisher } from "./application/providerEventPublisher.mjs";
import { createTimelineChangeDispatcher } from "./application/timelineChangeDispatcher.mjs";
import { createScheduledSessionBoundary } from "./application/scheduledSessionBoundary.mjs";
import { createProjectActionHandlers } from "./application/projectActionHandlers.mjs";
import { createSessionWorkspacePresentation, historicalDetailProjection } from "./application/sessionWorkspacePresentation.mjs";
import { createProjectToolsetStatusReader } from "./application/projectToolsetStatusReader.mjs";
import { createProviderSessionRouteBootstrap } from "./application/providerSessionRouteBootstrap.mjs";
import { createSessionProviderAttachments } from "./application/sessionProviderAttachments.mjs";
import {
  prepareCodexProviderSessionInput as prepareCodexLaunchInput,
  prepareClaudeProviderSessionInput as prepareClaudeLaunchInput,
  startPreparedWorkSession as startPreparedWorkSessionWithAuthority
} from "./application/sessionLaunchPreparation.mjs";
import { seedDevelopmentFixtures } from "./application/developmentFixtureSeed.mjs";
import {
  createProjectToolsetAuthority, runtimeSourceIdentity
} from "./application/projectToolsetAuthority.mjs";
import { userMessageCommandSource } from "./domain/sessionMessageCommandSource.mjs";
import { createSessionWorkspaceInspection } from "./application/sessionWorkspaceInspection.mjs";
import { createSessionCreationOperation } from "./application/sessionCreationOperation.mjs";
import { createEntitySessionLaunchers } from "./application/entitySessionLaunchers.mjs";
import { createPostTurnWorkspaceOperations } from "./application/postTurnWorkspaceOperations.mjs";
import { createGatewayInventoryReader } from "./application/gatewayInventoryReader.mjs";
import { createCollaborationConfirmationCommands } from "./collaboration/collaborationConfirmationCommands.mjs";
import { createProviderResponseHandlers } from "./application/providerResponseHandlers.mjs";
import { createStateSyncPublisher } from "./application/stateSyncPublisher.mjs";

const environmentName = normalizeEnvironment(process.env.CORPTIE_ENV);
// A copied data root remains non-executable even if a later launch omits flags.
const developmentPreview = Boolean(process.env.CORPTIE_DATA_ROOT
  && pathExists(join(process.env.CORPTIE_DATA_ROOT, ".preview-only")));
if (developmentPreview && environmentName !== "development") {
  throw new Error("Preview snapshots may only be opened by Development.");
}
const port = Number(process.env.CORPTIE_BACKEND_PORT ?? (environmentName === "development" ? 47322 : 47321));
const runIsolationDataRoot = process.env.CORPTIE_RUN_ISOLATION_DATA_ROOT?.trim() || null;
const runIsolationCoordinator = runIsolationDataRoot && !developmentPreview
  ? new RunIsolationExecutionCoordinator({ dataRoot: runIsolationDataRoot })
  : null;
// Startup/Snapshot/Toolset production owners compose their authoritative ports
// here. Until that integration exists, executable Toolset actions fail closed.
let runIsolationAuthorityResolver = new RunIsolationAuthorityResolver();
// 会话快照只返回尾部窗口的完整消息，更早的历史通过补拉端点按需获取。
// 打开会话时前端只渲染尾部一屏，全量 text（千级消息约 1MB+）是切会话延迟的主因。
const execFileAsync = promisify(execFile);
const sessions = new Map();
const { seedSessions, updateMockProgress } = createMockSessionFixtures({ sessions, now, emitEvent });
// The global product-event stream is only a wake-up/side-effect transport; the
// revisioned state stream and durable Session event log remain authoritative.
// Keep enough events for ordinary reconnects without retaining every event for
// the lifetime of the backend process.
const eventLog = new ReplayEventLog({
  capacity: Number(process.env.CORPTIE_GLOBAL_EVENT_REPLAY_CAPACITY ?? 4096)
});
const sseClients = new Set();
let productEventPublisher = null;
// Each state-stream client owns its own delivered revision. A shared cursor
// lets a newly connected client advance past a change before existing clients
// receive it, leaving their Session list stale until another mutation occurs.
const stateSyncPublisher = createStateSyncPublisher({
  readService: () => stateSyncService,
  readRevision: () => store.stateRevision(),
  recordSessionDiagnostic: (...args) => sessionStateDiagnostics.record(...args),
  invalidateDevices: () => {
    clientDeviceGateway?.inspectorEvents.invalidate();
    clientDeviceGateway?.events.invalidate({ inventory: true, control: true });
    clientDeviceGateway?.events.publishState();
  }
});
const { stateSyncClients, writeStateSyncFrame, publishStateChangesIfNeeded, scheduleStateSyncPublish } = stateSyncPublisher;
let stateSyncService = null;
let sessionBindingReadinessProbe = null;
let backendStoreReady = false;
let clientDeviceGateway = null;
const sessionStateDiagnostics = new SessionStateDiagnostics();
let taskExecutionOrchestrator = null;
let sessionWorkspaceOperations = null;
let projectCodeApplicationService = null;
let projectCodeStartupReceipts = null;
let workSessionStartupCoordinator = null;
let workSessionStartApplicationService = null;
let sessionRecoveryCoordinator = null;
let projectToolsetProduction = null;
let projectToolsetInitializer = null;
const dshLivePublisher = createDshLivePublisher({
  lastSessionEventSequence: (sessionId) => store.lastSessionEventSequence(sessionId),
  broadcastDshMuxFrame, broadcastDshHostFrame
});
const { publishDshPromptStart, publishDshPromptFailure } = dshLivePublisher;
const runtimeActivity = new BackendRuntimeActivity({
  emitEvent,
  tickAgentWorkQueue: (...args) => tickAgentWorkQueue(...args),
  updateMockProgress
});
const reportedUnclassifiedProviderSessionIds = new Set();
const sessionCollaborationV2Enabled = process.env.CORPTIE_SESSION_COLLABORATION_V2 !== "0";
const store = new CorptieStore();
const {
  sessionToolMetadata, resolveDynamicToolCallMetadata, resolveToolHostBinding,
  prospectiveToolHostBinding, prepareDesiredWorkspaceToolMaterialization
} = createSessionToolBindingProjection({
  store,
  prepareDesiredReplacement: (input) => toolHostMaterializationCoordinator.prepareDesiredReplacement(input)
});
let sshWorkspaceServices;
function getSshWorkspaceServices() {
  if (sshWorkspaceServices?.dataRoot !== store.dataRoot) {
    const connections = new SshConnectionService({ repository: store.sshWorkspaces, referenceDirectory: join(store.dataRoot, "ssh", "references") });
    const transport = new SshWorkspaceTransport({ resolveConnection: (id) => connections.resolve(id) });
    sshWorkspaceServices = { dataRoot: store.dataRoot, connections,
      probes: new SshWorkspaceProbeService({ repository: store.sshWorkspaces, transport }) };
  }
  return sshWorkspaceServices;
}
const turnObservability = new CodeTaskObservabilityService({
  store,
  environment: environmentName,
  dataRootResolver: () => store.settings().dataRoot,
  resolveArtifactPin: (artifactId, version) => {
    const stored = store.getArtifactVersion(artifactId, version);
    if (!stored) return null;
    const expected = OBSERVABILITY_DEPENDENCY_PINS.find((entry) => entry.artifactId === artifactId && entry.version === version);
    return expected ? { ...stored,
      acceptanceState: stored.approvalStatus === "approved" ? "approved_fixed" : "unapproved" } : null;
  }
});
const providerEventProjector = new ProviderEventProjector({ store });
let providerTurnResponseWatchdog = null;
let turnExecutionProbe = null;
const { scheduleTimelineChangePublish } = createTimelineChangeDispatcher({
  store,
  resolveSessionReference: (sessionId) => sessionBindingRepository?.resolve(sessionId),
  invalidateDevices: (change) => clientDeviceGateway?.events.invalidate(change),
  publishDeviceTimeline: (sessionId) => clientDeviceGateway?.events.publishTimeline(sessionId),
  scheduleTimelineChange: (change) => runtimeActivity.scheduleTimelineChange(change)
});
const providerEventPublisher = createProviderEventPublisher({
  store, eventLog, sseClients, now, resolveProviderEventBinding,
  scheduleTimelineChangePublish, scheduleStateSyncPublish, scheduleAgentWorkDrain,
  onCommittedMessageDelivery: (envelope) => taskSummaryService.onCommittedMessageDelivery(envelope),
  publishDeviceTimeline: (sessionId) => clientDeviceGateway?.events.publishTimeline(sessionId)
});
const { publishProviderEventOutbox, notifySessionEventListeners } = providerEventPublisher;
const providerEventIngestion = new ProviderEventIngestionService({
  store,
  resolveBinding: resolveProviderEventBinding,
  project: (context) => providerEventProjector.project(context),
  onCommitted: publishProviderEventOutbox,
  observe: (context) => {
    const observation = turnObservability.ingestProviderEvent(context);
    providerTurnResponseWatchdog?.observe(context);
    turnExecutionProbe?.observe(context);
    return observation;
  }
});
const workspaceRoutePreparationCache = new WorkspaceRoutePreparationCache({ ttlMs: 15_000 });
let codexResetForecastMonitor = null;
const { sessionWithLogicalWorkspace } = createSessionWorkspacePresentation({ store });
const codexChoiceProjection = createCodexChoiceProjection({
  store, developmentPreview, upsertManagedCodexSession, emitEvent, now
});
const { scheduleCodexChoiceParseForText, bumpChoiceGeneration } = codexChoiceProjection;
const sessionTitleReservations = createSessionTitleReservations({ store });
const { reserveSessionTitle } = sessionTitleReservations;
const collaborationCore = new CollaborationCore(store);
const {
  workspaceInventory, requireAgentLogicalSession,
  callWorkspaceDynamicTool, validateProjectCodeHostRoute
} = createWorkspaceSessionToolAuthority({
  store, collaborationCore,
  getSessionWorkspaceOperations: () => sessionWorkspaceOperations
});
const managedProviderSessionProjection = createManagedProviderSessionProjection({
  store, collaborationCore, sessionWithLogicalWorkspace,
  workspaceRoutePreparationCache,
  getStartupReceipt: (logicalSessionId) => projectCodeStartupReceipts?.require(logicalSessionId) ?? null,
  reportedUnclassifiedProviderSessionIds, now, emitEvent
});
const workService = new WorkApplicationService({
  store,
  onEntityChanged: (type, payload) => emitEvent(type, payload)
});
const workDiscussionService = new WorkDiscussionApplicationService({ workService, launch: (input) => launchWorkChatSession(input) });
let sessionRuntimeReleaseService = null;
const taskCompletionService = new TaskCompletionService({
  store,
  onCompleted: (task, operation) => {
    emitEvent("TaskChanged", {
      action: "user-intent-completion",
      entity: task,
      completionOperationId: operation.operationId
    });
    sessionRuntimeReleaseService?.releaseCompletedTaskSessions(task.id);
  }
});
const {
  reportTaskAcceptanceForAgent, getBoundTaskForAgent,
  reviseTaskForSession, completeTaskForSession
} = createSessionTaskCommands({
  store, collaborationCore, workService, taskCompletionService,
  presentTaskForClient: (task) => presentTaskForClient(task)
});
const ensureRepositoryArtifactCommitHook = (path, options = {}) => ensureArtifactCommitHook(path, {
  ...options,
  dbPath: store.dbPath,
  diagnosticOnly: developmentPreview
});
const artifactService = new ArtifactService({ store, ensureCommitHook: ensureRepositoryArtifactCommitHook });
const contextReadService = new ContextReadService({ store });
const chatResourceService = new ChatResourceService({ store });
const sceneService = new SceneApplicationService({ store });
let benchmarkControlPlane = null;
const dataRootMigrationCoordinator = new DataRootMigrationCoordinator({
  store,
  environment: environmentName,
  inspectBlockers: inspectDataRootMigrationBlockers,
  quiesce: quiescePersistentRuntime,
  resume: resumePersistentRuntime
});
const workChatContextService = new WorkChatContextService({ store, artifactService });
let workChatOperationService = null;
let sessionCollaborationService = null;
const sessionChannelService = new SessionChannelService({ store, collaborationCore });
const {
  dispatchSessionChannelDelivery, inspectCollaborationSession,
  resumeCollaborationSession, startCollaborationTurn
} = createSessionChannelDeliveryOperation({
  store, sessionChannelService, now,
  resumeSession: (sessionId, context) => sessionApplicationService.resumeSession(sessionId, context),
  sendMessage: sendUnifiedSessionMessage
});
const {
  agentWorkTimelineItem,
  collaborationConfirmationTimelineItem,
  sessionChannelAuthorizationTimelineItem,
  sessionChannelMessageTimelineItem
} = createCollaborationTimelinePresentation({ store, collaborationCore, sessionChannelService });
const hubService = new HubService({
  store,
  embedder: createOpenAiEmbedder(store.choiceParserSettings())
});
const memoryRecallService = new MemoryRecallService({ store, hubService });
const memoryLifecycleService = new MemoryLifecycleService({ store });
const agentContextService = new AgentContextService({ store, hubService, recallService: memoryRecallService });
const memoryOperationService = new MemoryOperationService({
  store,
  hubService,
  recallService: memoryRecallService,
  resolveAgentForSession: (sessionId) => collaborationCore.getAgentForSession(sessionId),
  onDiagnostic: (diagnostic) => console.warn("[memory-operation]", JSON.stringify(diagnostic))
});
const collaborationRouter = new CollaborationRouter({ store });
const memoryExtractor = new MemoryExtractor({ store });
const memoryExtractionScheduler = new MemoryExtractionScheduler({ store, extractor: memoryExtractor,
  onMemories: (sessionId, memories) => {
    const task = store.getTaskBySessionId(sessionId);
    if (!task || !memories.length) return;
    const updated = store.updateTask(task.id, {});
    emitEvent("TaskChanged", { action: "memory-updated", entity: updated,
      memoryIds: memories.map((memory) => memory.id) });
  } });
const taskSessionProjection = createTaskSessionProjection({
  store, memoryExtractor, memoryScheduler: memoryExtractionScheduler,
  emitEvent, sessionWithLogicalWorkspace
});
const { settleEntityTaskFromSession, settleTaskForWorkspaceContinuation, reconcileEntityTasksAtStartup } = taskSessionProjection;
const handleCommittedProviderTerminalLifecycle = createProviderTerminalLifecycle({
  store, emitEvent,
  recordWorkSettled: (task) => workspaceContinuationCoordinator.recordWorkSettled(task),
  settleEntityTaskFromSession, collaborationCore,
  refreshWorkspaceInventoryAfterTurn: (...args) => refreshWorkspaceInventoryAfterTurn(...args),
  continuePendingWorkspaceTransition: (...args) => continuePendingWorkspaceTransition(...args),
  continuePendingProviderSwitch: (...args) => continuePendingProviderSwitch(...args),
  resumeWorkAfterTransition, scheduleAgentWorkDrain
});
const assistantService = new AssistantService({
  store,
  workService,
  intentResolver: createAssistantIntentResolver(store.choiceParserSettings()),
  onEntityChanged: (type, payload) => emitEvent(type, payload)
});
const collaborationMcpServerPath = fileURLToPath(new URL("./mcp/collaborationMcpServer.mjs", import.meta.url));
const bundledAgentMemoryPath = fileURLToPath(new URL(
  environmentName === "development"
    ? "../resources/agent/global-instructions.development.md"
    : "../resources/agent/global-instructions.production.md",
  import.meta.url
));
const bundledCollaborationSkillPath = fileURLToPath(new URL("../resources/codex/skills/corptie-collaboration/SKILL.md", import.meta.url));
const bundledProjectToolsetReferencePath = fileURLToPath(new URL(
  "../resources/codex/skills/corptie-collaboration/references/project-tools-set.md",
  import.meta.url
));
const bundledGitCommitProtectionPath = fileURLToPath(new URL(
  "../resources/git-commit-protection.json",
  import.meta.url
));
const corptieCodexRuntimePaths = resolveCorptieRuntimePaths({ environmentName });
const corptieClaudeRuntimePaths = resolveCorptieClaudeRuntimePaths({ environmentName });
const {
  requiredWorkspaceInstructionSources, knownGlobalInstructionSources,
  sessionTransitionCheckpoint, storedTransitionTimelineItems
} = createWorkspaceTransitionContextReader({
  store, bundledAgentMemoryPath, corptieCodexRuntimePaths,
  corptieClaudeRuntimePaths
});
const {
  collaborationThreadOptionsWithAgentContext, collaborationProviderRuntimeOptionsWithAgentContext,
  claudeCollaborationRuntimeOptionsWithAgentContext, collaborationAgentContextInstructions
} = createCollaborationProviderOptions({
  agentContextService, corptieClaudeRuntimePaths, collaborationMcpServerPath, port, environmentName
});
const corptieOpenClackyRuntimePaths = resolveCorptieOpenClackyRuntimePaths({ environmentName });
const configuredOpenClackyBaseURL = process.env.OPENCLACKY_BASE_URL?.trim() || null;
const managedOpenClackyRuntime = configuredOpenClackyBaseURL ? null : new OpenClackyServerRuntime({
  command: () => firstRunSetup.command("openclacky", () => resolveExternalCommand("openclacky", { environmentVariables: ["OPENCLACKY_COMMAND"], extraCandidates: [resolveOpenClackyCommand()] })),
  port: resolveOpenClackyManagedPort(environmentName),
  cwd: corptieOpenClackyRuntimePaths.runtimeRoot,
  // OpenClacky 1.x stores configuration and Session state below HOME. Give the
  // Corptie-managed daemon an isolated home while retaining the backend's macOS
  // privacy grant and other launch context.
  env: () => ({ ...process.env, HOME: corptieOpenClackyRuntimePaths.providerHome })
});
// Skill 维护中心（provider-neutral）：全局共享的 Skill 映射表 + 物化到各 Provider 的 skills 目录。
// skillsDirs 由组合根声明「各 Provider 的 skills 根目录」，SkillRegistryService 不感知 Provider 名语义，
// 仅把 Skill 内容镜像到这些目录；Claude Code / Codex 运行时会自动扫描各自目录发现 Skill。
const skillRegistryService = new SkillRegistryService({
  store,
  skillsDirs: {
    "codex-app-server": corptieCodexRuntimePaths.skillsDir,
    "claude-sdk": join(corptieClaudeRuntimePaths.pluginPath, "skills")
  }
});
const mcpRegistryService = new McpRegistryService({ store });
// Reconcile exact, durably queued package/Keychain cleanup after a prior crash.
void mcpRegistryService.drainCleanup().catch(() => {});
const mcpCleanupInterval = setInterval(() => {
  void mcpRegistryService.drainCleanup().catch(() => {});
}, 5 * 60 * 1000);
mcpCleanupInterval.unref();
function mcpAssignmentRevisionForAgent(agentId) {
  const skill = skillRegistryService.mcpAssignmentRevisionForAgent(agentId);
  const standalone = mcpRegistryService.assignmentRevisionForAgent(agentId);
  return skill === "none" && standalone === "none" ? "none" : `${skill}:${standalone}`;
}
const skillMcpGateway = new SkillMcpGateway({
  onRuntimeEvent: (event) => mcpRegistryService.recordRuntimeEvent(event),
  resolveServers: async ({ actorId, providerId }) => ({
    ...await skillRegistryService.mcpServersForAgent(actorId, providerId, { isolateFailures: true }),
    ...mcpRegistryService.serversForAgent(actorId)
  }),
  resolveRevision: mcpAssignmentRevisionForAgent
});
const mcpSessionAvailabilityService = new McpSessionAvailabilityService({
  store, gateway: skillMcpGateway, registry: mcpRegistryService
});
// 把「Agent 启用的 Skill 解析」注入 AgentContextService，使 Agent 初始化上下文包含 Skill 信息。
agentContextService.resolveAgentSkills = (agentId) => {
  return skillRegistryService.skillsForAgent(agentId);
};
const collaborationDeliveryRouteResolver = new CollaborationDeliveryRouteResolver({
  core: collaborationCore,
  ensureRecipientSession: (task, options) => sessionCollaborationService.ensureTaskRecipientSession(task, options)
});
const collaborationDispatcher = new CollaborationDeliveryDispatcher({
  core: collaborationCore,
  runtime: {
    inspect: inspectCollaborationSession,
    resume: resumeCollaborationSession,
    startTurn: startCollaborationTurn
  },
  routeResolver: collaborationDeliveryRouteResolver,
  onEvent: (type, payload) => {
    const routed = payload?.sessionId
      ? (store.getLogicalSession(payload.sessionId)
        ?? store.getLogicalSessionByLegacySessionId(payload.sessionId))
      : null;
    emitEvent(type, payload, {
      sessionId: routed?.legacySessionId ?? (store.getSession(payload?.sessionId) ? payload.sessionId : null),
      source: { type: "collaboration", taskId: payload?.taskId ?? null, deliveryId: payload?.deliveryId ?? null }
    });
  }
});
const resolveScheduledSessionRoute = createScheduledSessionRouteResolver({ store, collaborationCore });
const {
  authorizeScheduledSessionTask, enqueueScheduledSessionWork,
  scheduledSessionHttpActor, scheduledSessionHttpLogicalSessionId
} = createScheduledSessionBoundary({
  store, environmentName, collaborationCore, emitEvent, scheduleAgentWorkDrain,
  canDeliverScheduledMessage: (deviceId) => clientDeviceGateway?.authority.canDeliverScheduledMessage(deviceId),
  registerRuntimeQueuedWork: (...args) => registerRuntimeQueuedWork(...args),
  runtimeQueuePosition: (...args) => runtimeQueuePosition(...args)
});
const scheduledSessionTaskService = new ScheduledSessionTaskService({
  store,
  environment: environmentName,
  observeListPerformance: (measurement) => {
    console.info(`[scheduled-task-performance] ${JSON.stringify({ stage: "service", ...measurement })}`);
  },
  authorize: authorizeScheduledSessionTask,
  resolveRoute: resolveScheduledSessionRoute,
  resolveActorLogicalSessionId: (actor) => actor?.type === "agent"
    ? requireAgentLogicalSession(actor.id).logical.logicalSessionId
    : null,
  enqueue: enqueueScheduledSessionWork,
  activate: async (payload) => {
    emitEvent("AutomationSessionActivationRequested", payload, { sessionId: payload.sessionId });
    return { delivered: true };
  },
  notify: async (payload) => {
    emitEvent("AutomationLocalNotificationRequested", payload, { sessionId: payload.sessionId });
    return { delivered: true };
  },
  onEvent: (type, payload) => emitEvent(type, payload, {
    sessionId: payload.task?.logicalSessionId
      ? store.getLogicalSession(payload.task.logicalSessionId)?.legacySessionId ?? null
      : null,
    source: { type: "scheduled_session_task", taskId: payload.task?.taskId ?? null }
  })
});
let platformOperationService = null;
let toolMaterializationPort = null;
const platformConfirmationService = new PlatformConfirmationService({ store });
const hostToolCatalog = createHostToolCatalog({
  mcpRegistryService, onIntegrationChanged: (type, payload) => emitEvent(type, payload),
  memoryOperationService, artifactService, callWorkspaceDynamicTool,
  validateProjectCodeHostRoute,
  getProjectCodeApplicationService: () => projectCodeApplicationService,
  sessionCollaborationV2Enabled, port, skillRegistryService,
  scheduledSessionTaskService, getBoundTaskForAgent,
  reportTaskAcceptanceForAgent, completeTaskForSession,
  reviseTaskForSession, sceneService,
  getToolMaterializationPort: () => toolMaterializationPort,
  getPlatformOperationService: () => platformOperationService,
  getWorkChatOperationService: () => workChatOperationService,
  contextReadService
});
let toolHostService = null;
const codexAppServerCommand = () => firstRunSetup.command("codex-app-server", resolveCodexCommand);
const { loadCodexModels, loadClaudeModels } = createProviderModelCatalogLoaders({
  store, codexAppServerCommand, corptieCodexRuntimePaths, environmentForCommand,
  execFileAsync, readCodexDefaultConfig, defaultWorkspacePath,
  claudeCommand: () => firstRunSetup.command("claude-sdk", () => resolveExternalCommand("claude"))
});
const { ensureCodexSessionPermissions, resolvedNewCodexRuntimeConfig } = createCodexSessionConfiguration({
  store, upsertManagedCodexSession, loadCodexModels
});
const codexRuntime = createCodexProviderRuntime({
  command: codexAppServerCommand,
  env: () => ({
    ...environmentForCommand(codexAppServerCommand()),
    ...proxyEnvForProfile(store.settings().agentProxy?.codex),
    CODEX_HOME: corptieCodexRuntimePaths.codexHome
  }),
  onNotification: (message) => {
    handleCodexAppServerNotificationSafely(message);
  },
  onDynamicToolCall: (params) => toolHostService.execute({
    ...params,
    actorId: params.agentId,
    metadata: resolveDynamicToolCallMetadata(params)
  })
});
const workspaceContinuationCoordinator = new WorkspaceContinuationCoordinator({
  store,
  resolveAgent: (sessionId) => collaborationCore.getAgentForSession(sessionId)
    ?? ensureCollaborationAgentForSession(
      store.getSession(sessionId)
    ),
  enqueueWork: (task) => {
    const queued = store.enqueueAgentTask(task);
    registerRuntimeQueuedWork(queued.sessionId, queued.taskId);
    return queued;
  },
  scheduleDrain: (sessionId) => scheduleAgentWorkDrain(sessionId),
  onEvent: (type, payload) => {
    const sessionId = payload.logicalSession?.legacySessionId ?? payload.task?.sessionId ?? null;
    emitEvent(type, payload, {
      sessionId,
      source: { type: "workspace-continuation" }
    });
    const transitionId = payload.transitionId ?? payload.transition?.transitionId ?? null;
    if (transitionId) settleTaskForWorkspaceContinuation(transitionId);
  }
});
const workspaceTransitionManager = new ForkingWorkspaceTransitionManager({
  store,
  providerPort: codexRuntime,
  sourceTimelineItems: storedTransitionTimelineItems,
  requiredInstructionSources: ({ cwd }) => requiredWorkspaceInstructionSources(cwd),
  globalInstructionSources: () => knownGlobalInstructionSources(),
  confirmToolSchema: ({ threadId, dynamicTools }) => (
    codexRuntime.confirmThreadToolPlan(threadId, dynamicTools)
  ),
  prepareToolMaterialization: async ({
    logicalSessionId,
    sessionId,
    sourceBinding,
    binding,
    dynamicToolConfirmation
  }) => {
    const session = sessionId ? store.getSession(sessionId) : null;
    const source = sourceBinding?.bindingId
      ? store.getSessionToolCatalogMaterialization(logicalSessionId, sourceBinding.bindingId)
      : null;
    return toolHostMaterializationCoordinator.prepareAppliedReplacement({
      binding: prospectiveToolHostBinding({ logicalSessionId, binding, session }),
      desiredDomains: desiredToolDomainIds(source),
      providerConfirmation: dynamicToolConfirmation
    });
  },
  onRouteCommitted: async (event) => {
    await commitManagedCodexWorkspaceRoute(event);
    enqueueWorkspaceContinuationSafely(event.transitionId);
  }
});
// Execution preparation, recovery stabilization, restart and turn-change
// management are product orchestration, not Provider protocol. Each Provider
// supplies the few protocol-level calls through its adapter, so product code
// never branches on a Provider id for these operations.
const providerSessionLifecycle = new ProviderSessionLifecycle({
  store,
  adapters: {
    "codex-app-server": codexLifecycleAdapter({
      runtime: codexRuntime,
      ensureSessionPermissions: ensureCodexSessionPermissions,
      withPersistedToolConfirmation: withPersistedCodexToolConfirmation,
      collaborationThreadOptionsForSession,
      ensureLogicalRouteForCodexSession
    })
  },
  collaborationThreadOptionsForSession,
  workspaceTransitionManager,
  workspaceRoutePreparationCache,
  assertWorkspaceRouteUsable,
  prepareExternalDiff,
  launchDiffTool,
  writeTurnPatch,
  safeTurnFileChanges,
  turnDiffFor,
  workspaceTransitionBlocksWork,
  sessionHasActiveRun,
  emitEvent
});
const claudeProviderRuntime = createClaudeProviderRuntime({
  store,
  environment: () => process.env,
  prepareSessionInput: prepareClaudeProviderSessionInput,
  onProviderEvent: handleClaudeProviderEventSafely,
  listModels: loadClaudeModels,
  onTurnSettled: handleClaudeTurnSettledSafely,
  prepareWorkspaceTransition: switchClaudeProviderWorkspace,
  bindWorkspace: (input) => persistedProviderWorkspaceProof(store, input),
  inspectWorkspaceBinding: (input) => persistedProviderWorkspaceProof(store, input),
  attachTools: async (attachment) => claudeToolHostAttachment(
    attachment,
    withWorkChatClaudeContext(
      await claudeCollaborationRuntimeOptionsWithAgentContext(attachment.actorId, attachment.metadata),
      attachment.metadata
    )
  ),
  executable: () => firstRunSetup.command("claude-sdk", () => resolveExternalCommand("claude", { environmentVariables: ["CORPTIE_CLAUDE_PATH"] })),
  resolveRuntimeOptions: (providerSessionId) => claudeRuntimeOptionsForSession(providerSessionId)
});
const openClackyManager = createOpenClackyRuntimeManager({
  configuredOpenClackyBaseURL, managedOpenClackyRuntime,
  corptieOpenClackyRuntimePaths, store,
  executeToolCall: (input) => toolHostService.execute(input),
  collaborationAgentContextInstructions, sessionStateDiagnostics,
  providerEventIngestion, handleCommittedProviderTerminalLifecycle, now
});
const openClackyWorkspaceTransitionManager = new ForkingWorkspaceTransitionManager({
  store,
  providerPort: new OpenClackyWorkspaceTransitionPort({
    store,
    manager: openClackyManager,
    instructionSources: requiredWorkspaceInstructionSources,
    bootstrapSession: async (options = {}) => {
      const cwd = typeof options.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : null;
      if (!cwd) throw new Error("OpenClacky workspace handoff requires a target cwd.");
      return openClackyManager.create({
        title: options.title ?? "OpenClacky Workspace",
        cwd,
        ...(options.dynamicToolAgentId ? { actorId: options.dynamicToolAgentId } : {})
      });
    }
  }),
  sourceTimelineItems: storedTransitionTimelineItems,
  requiredInstructionSources: ({ cwd }) => requiredWorkspaceInstructionSources(cwd),
  globalInstructionSources: () => knownGlobalInstructionSources(),
  prepareToolMaterialization: prepareDesiredWorkspaceToolMaterialization,
  onRouteCommitted: async (event) => {
    const logical = store.getLogicalSession(event.logicalSessionId);
    const sessionId = logical?.legacySessionId;
    if (!sessionId) return;
    const previous = store.getSession(sessionId);
    if (previous) {
      emitEvent("SessionWorkspaceSwitched", {
        session: sessionWithLogicalWorkspace(previous, logical),
        ...event
      }, { sessionId });
    }
    enqueueWorkspaceContinuationSafely(event.transitionId);
  }
});
const claudeWorkspaceTransitionManager = new ForkingWorkspaceTransitionManager({
  store,
  providerPort: new ClaudeWorkspaceTransitionPort({
    store,
    manager: claudeProviderRuntime.manager,
    instructionSources: requiredWorkspaceInstructionSources
  }),
  sourceTimelineItems: storedTransitionTimelineItems,
  requiredInstructionSources: ({ cwd }) => requiredWorkspaceInstructionSources(cwd),
  globalInstructionSources: () => knownGlobalInstructionSources(),
  prepareToolMaterialization: prepareDesiredWorkspaceToolMaterialization,
  onRouteCommitted: async (event) => {
    await commitManagedClaudeWorkspaceRoute(event);
    enqueueWorkspaceContinuationSafely(event.transitionId);
  }
});
const providerWorkspaceSwitches = createProviderWorkspaceSwitches({
  store, ensureLogicalRouteForCodexSession, sessionTransitionCheckpoint,
  workspaceTransitionManager, claudeWorkspaceTransitionManager,
  openClackyWorkspaceTransitionManager,
  collaborationThreadOptionsForSession, emitEvent
});
const {
  resumeCodexProviderSession, probeCodexProviderBinding, deleteCodexProviderSession,
  renameCodexProviderSession, readCodexProviderAccountUsage, readCodexProviderSessionUsage,
  interruptCodexProviderSession, updateCodexProviderConfiguration,
  updateCodexProviderPermissions, respondCodexProviderApproval, respondCodexProviderUserInput
} = createCodexSessionCommands({
  store, codexRuntime, now, codexAppServerSessionCapabilities, upsertManagedCodexSession,
  withPersistedCodexToolConfirmation, collaborationThreadOptionsForSession,
  invalidateWorkspaceRoute: (logicalSessionId) => workspaceRoutePreparationCache.invalidate(logicalSessionId)
});
const { sendCodexProviderMessage } = createCodexTurnDispatcher({
  store, codexRuntime, resolvePreparedWorkspaceRoute, bumpChoiceGeneration,
  ensureCodexSessionPermissions, sessionWithLogicalWorkspace, collaborationThreadOptionsForSession
});
const { clearCodexAppServerSession } = createCodexConversationClear({
  store, codexRuntime, collaborationCore, ensureCodexSessionPermissions,
  reserveSessionTitle, collaborationThreadOptionsForSession, codexAppServerSessionCapabilities,
  ensureLogicalRouteForCodexSession, sessionWithLogicalWorkspace, upsertManagedCodexSession, emitEvent
});
const gitWorkspaces = new GitWorkspaceManager({
  store,
  transitions: workspaceTransitionManager,
  ensureCommitGate: ensureRepositoryArtifactCommitHook,
  taskWorktreesRoot: ({ repositoryId }) => resolve(
    store.layout.worktreesDirectory,
    repositoryId.split(":").at(-1)
  ),
  observePerformance: (measurement) => {
    console.info(`[worktree-performance] ${JSON.stringify(measurement)}`);
  }
});
const projectToolsets = new ProjectToolsetManager({
  runIsolationCoordinator,
  validationReceiptResolver: (receiptId) => projectToolsetProduction?.resolveToolsetReceipt(receiptId) ?? null
});
const gitCommitProtection = new GitCommitProtection({ configPath: bundledGitCommitProtectionPath });
const gitHubPushes = new GitHubPushManager({
  commitProtection: gitCommitProtection,
  ensureCommitGate: ensureRepositoryArtifactCommitHook
});
const agentProviderRegistry = createProviderRuntimeRegistryComposition({
  store, claudeProviderRuntime, codexRuntime, openClackyManager,
  openClackyToolHostAttachment, applyOpenClackyToolPlanAtTurnBoundary,
  switchOpenClackyProviderWorkspace, prepareCodexProviderSessionInput,
  createCodexProviderSession,
  forkCodexSession: (input, context) => codexSessionCreator.create(input, context.forkSource),
  resumeCodexProviderSession, probeCodexProviderBinding,
  prepareCodexProviderExecution, stabilizeCodexRecoverySession,
  deleteCodexProviderSession, restartCodexProviderSession,
  renameCodexProviderSession, loadCodexModels, sendCodexProviderMessage,
  clearCodexAppServerSession, interruptCodexProviderSession,
  respondCodexProviderApproval, respondCodexProviderUserInput,
  manageCodexTurnChanges, updateCodexProviderConfiguration,
  updateCodexProviderPermissions, readCodexProviderAccountUsage,
  readCodexProviderSessionUsage, switchCodexProviderWorkspace,
  codexToolHostAttachment, withWorkChatCodexContext,
  collaborationProviderRuntimeOptionsWithAgentContext
});
// Composition root: provider-specific executable ports are confined here.
const { handleCodexAppServerNotificationSafely } = createCodexNotificationReceiver({
  store, codexRuntime, sessionStateDiagnostics, requireSessionReference,
  chatResourceService, agentProviderRegistry, providerEventIngestion, now,
  scheduleCodexChoiceParseForText, handleCommittedProviderTerminalLifecycle
});

const claudeNotificationReceiver = createClaudeNotificationReceiver({
  store, emitEvent, sessionWithLogicalWorkspace, providerEventIngestion,
  sessionStateDiagnostics, now, workspaceContinuationCoordinator,
  settleEntityTaskFromSession, collaborationCore, resumeWorkAfterTransition,
  scheduleAgentWorkDrain,
  refreshWorkspaceInventoryAfterTurn: (...args) => refreshWorkspaceInventoryAfterTurn(...args),
  continuePendingWorkspaceTransition: (...args) => continuePendingWorkspaceTransition(...args),
  continuePendingProviderSwitch: (...args) => continuePendingProviderSwitch(...args)
});

const firstRunSetup = new FirstRunSetupService({
  path: () => join(store.dataRoot, "first-run-setup.json"),
  hasWorks: () => store.listWorks().length > 0,
  firstWorkSession: () => {
    const work = store.listWorks()[0];
    return work ? store.getWorkChatSession(work.id) : null;
  },
  findAssistantSession: () => store.listSessionsByAgent("assistant").find((session) =>
    session.sessionKind === "assistantChat" && !session.archived && !session.deletedAt),
  createAssistantSession: (providerId) => launchAgentSession({
    agent: store.ensureAssistantAgent(), providerId, title: "Corptie", prompt: ""
  }),
  ensureAssistantGreeting: (sessionId, language) => ensureFirstRunAssistantGreeting(store, sessionId, language),
  onDefaultChanged: (providerId) => {
    if (!providerId) return;
    agentProviderRegistry.defaultProviderId = providerId;
    backgroundAgentService.defaultProviderId = providerId;
    taskSummaryService.onProviderChanged();
    workChatOperationService.defaultProviderId = providerId;
    sessionCollaborationService.defaultProviderId = providerId;
  },
  providers: [
    { id: "codex-app-server", name: "Codex", discover: resolveCodexCommand,
      probe: createCodexReplyProbe({ environment: async () => {
        await ensureCorptieCodexRuntime({ environmentName, bundledMemoryPath: bundledAgentMemoryPath,
          bundledSkillPath: bundledCollaborationSkillPath, bundledProjectToolsReferencePath: bundledProjectToolsetReferencePath,
          collaborationMcpServerPath });
        return { ...process.env, ...proxyEnvForProfile(store.settings().agentProxy?.codex),
          CODEX_HOME: corptieCodexRuntimePaths.codexHome };
      } }),
      prepare: async () => {
        await ensureCorptieCodexRuntime({ environmentName, bundledMemoryPath: bundledAgentMemoryPath,
          bundledSkillPath: bundledCollaborationSkillPath, bundledProjectToolsReferencePath: bundledProjectToolsetReferencePath,
          collaborationMcpServerPath });
        await codexRuntime.initialize();
        setProviderRuntimeReadiness("codex-app-server", { state: "ready" });
      },
      configure: async (path) => {
        assertSetupPathChangeAllowed("codex-app-server", path);
        if (codexAppServerCommand() !== path) codexRuntime.close();
      } },
    { id: "claude-sdk", name: "Claude Code", discover: () => resolveExternalCommand("claude", { environmentVariables: ["CORPTIE_CLAUDE_PATH"] }),
      probe: createClaudeReplyProbe({ environment: async () => {
        await ensureCorptieClaudeRuntime({ environmentName, bundledMemoryPath: bundledAgentMemoryPath,
          bundledSkillPath: bundledCollaborationSkillPath, bundledProjectToolsReferencePath: bundledProjectToolsetReferencePath });
        return process.env;
      } }),
      prepare: async () => {
        await ensureCorptieClaudeRuntime({ environmentName, bundledMemoryPath: bundledAgentMemoryPath,
          bundledSkillPath: bundledCollaborationSkillPath, bundledProjectToolsReferencePath: bundledProjectToolsetReferencePath });
        setProviderRuntimeReadiness("claude-sdk", { state: "ready" });
      },
      configure: async (path) => { assertSetupPathChangeAllowed("claude-sdk", path); } },
    { id: "openclacky", name: "OpenClacky",
      probe: createOpenClackyReplyProbe({ environment: async () => {
        await ensureCorptieOpenClackyRuntime({ environmentName });
        return { ...process.env, HOME: corptieOpenClackyRuntimePaths.providerHome };
      } }),
      prepare: async () => {
        await ensureCorptieOpenClackyRuntime({ environmentName });
        openClackyManager.start();
        setProviderRuntimeReadiness("openclacky", { state: "ready" });
      },
      discover: () => resolveExternalCommand("openclacky", { environmentVariables: ["OPENCLACKY_COMMAND"], extraCandidates: [resolveOpenClackyCommand()] }),
      configure: async (path) => {
        assertSetupPathChangeAllowed("openclacky", path);
        const current = firstRunSetup.command("openclacky", () => resolveExternalCommand("openclacky", {
          environmentVariables: ["OPENCLACKY_COMMAND"], extraCandidates: [resolveOpenClackyCommand()]
        }));
        if (current !== path) managedOpenClackyRuntime?.stop();
      } }
  ]
});
function assertSetupPathChangeAllowed(providerId, path) {
  const saved = firstRunSetup.state.providers?.[providerId];
  const previous = saved?.configuredPath ?? (saved?.confirmed ? saved.path : null);
  if (previous === path) return;
  if (store.listSessions({ archived: false }).some((session) => session.external?.provider === providerId)) {
    throw new Error("该 Provider 已有会话，请先保留当前路径完成引导。");
  }
}

workChatOperationService = new WorkChatOperationService({
  store,
  workService,
  contextService: workChatContextService,
  workSessionStartApplicationService: {
    start: (command) => workSessionStartApplicationService.start(command)
  },
  defaultProviderId: agentProviderRegistry.defaultProviderId
});
sessionCollaborationService = new SessionCollaborationService({
  store,
  workService,
  artifactService,
  collaborationCore,
  workSessionStartApplicationService: {
    start: (command) => workSessionStartApplicationService.start(command)
  },
  defaultProviderId: agentProviderRegistry.defaultProviderId
});
const { setProviderRuntimeReadiness, decorateSessionForClient } = createSessionReadinessProjection({
  store, agentProviderRegistry, scheduleStateSyncPublish,
  readBindingProbe: () => sessionBindingReadinessProbe,
  readFallbackBindingReadiness: (logicalSessionId) => emptyCodexBindingPreflight.readiness(logicalSessionId)
});
const providerToolMaterializationPort = new RegistryToolMaterializationPort({
  registry: agentProviderRegistry
});
const toolHostMaterializationCoordinator = new ToolHostMaterializationCoordinator({
  store,
  catalog: hostToolCatalog,
  providerPort: providerToolMaterializationPort,
  resolveBinding: (logicalSessionId, providerBindingId) => resolveToolHostBinding(
    logicalSessionId,
    providerBindingId
  ),
  onEvent: (type, payload) => emitEvent("ToolHostMaterializationObserved", { type, ...payload })
});
const publicToolMaterializationPort = new ToolMaterializationPort({
  coordinator: toolHostMaterializationCoordinator,
  resolveCurrentBinding: (logicalSessionId) => {
    const logical = store.getLogicalSession(logicalSessionId);
    const bindingId = logical?.activeBinding?.bindingId ?? null;
    return bindingId ? resolveToolHostBinding(logicalSessionId, bindingId) : null;
  }
});
toolHostService = new ToolHostService({
  registry: agentProviderRegistry,
  catalog: hostToolCatalog,
  coordinator: toolHostMaterializationCoordinator,
  materializationPort: publicToolMaterializationPort,
  skillMcpGateway,
  recordRuntimeEvent: (event) => store.recordSkillRuntimeEvent(event)
});
// Artifact consumes only the approved provider-neutral positional Port. Tool
// Host keeps binding, generation, receipt, catalog, and Provider state internal.
toolMaterializationPort = publicToolMaterializationPort;
// Re-register the OpenClacky Provider after its runtime probe produces a fresh,
// honest capability snapshot. This is how the bridge handshake gates TOOL_HOST_ATTACH
// and WORKSPACE_TRANSITION: they are only declared after a healthy bridge confirms
// support, and never appear when the runtime is missing or outdated.
openClackyManager.onProbe = () => {
  agentProviderRegistry.refreshProvider(createOpenClackyProvider(openClackyManager, {
    attachTools: async (attachment) => openClackyToolHostAttachment(attachment),
    applyToolPlanAtTurnBoundary: applyOpenClackyToolPlanAtTurnBoundary,
    prepareWorkspaceTransition: (reference, input = {}) => switchOpenClackyProviderWorkspace(reference, input),
    readSessionUsage: async (reference) => store.getSessionContextUsage(reference.sessionId)?.context ?? null,
    bindWorkspace: (input) => persistedProviderWorkspaceProof(store, input),
    inspectWorkspaceBinding: (input) => persistedProviderWorkspaceProof(store, input)
  }));
};

async function applyOpenClackyToolPlanAtTurnBoundary(binding, plan, request) {
  const metadata = {
    logicalSessionId: binding.logicalSessionId,
    providerBindingId: binding.providerBindingId,
    sessionId: binding.sessionId,
    sessionKind: binding.sessionKind,
    workId: binding.workId,
    taskId: binding.taskId
  };
  const providerAttachment = openClackyToolHostAttachment({
    actorId: binding.agentId,
    tools: plan.providerDefinitions,
    metadata
  });
  const confirmation = await openClackyManager.applyConfirmedToolHost(
    binding.providerSessionId,
    { actorId: binding.agentId, metadata, providerAttachment }
  );
  return appliedToolMaterializationReceipt({
    providerBindingId: binding.providerBindingId,
    providerCapabilityRevision: request.capabilityRevision,
    requestedVersion: request.requestedVersion,
    appliedCatalogVersion: request.catalogVersion,
    appliedDomains: request.appliedDomains,
    appliedExposurePlanHash: plan.exposurePlanHash,
    providerDefinitionsHash: plan.providerDefinitionsHash,
    providerContractHash: plan.providerContractHash,
    refreshMode: plan.refreshMode,
    providerRevision: confirmation.providerRevision,
    receiptId: confirmation.receiptId
  });
}

const sessionBindingRepository = new SessionBindingRepository({
  store,
  normalizeLegacySessionId: normalizeSessionId,
  resolveProviderId: (providerId, options = {}) => agentProviderRegistry.resolveId(providerId, options)
});
const {
  getTimelineReadPool, closeTimelineReadPool, getStoredSessionSnapshot,
  readSessionHistory, readSessionTimelineWindow, readStoredSessionDetail
} = createSessionTimelineReader({ store, requireSessionReference, decorateSessionForClient });
const legacySessionHistoryRepairService = new LegacySessionHistoryRepairService({
  store,
  resolveReference: (sessionId) => sessionBindingRepository.resolve(sessionId),
  importers: new Map([
    ["codex-app-server", async (reference) => {
      const result = await codexRuntime.readThreadForLegacyHistoryRepair(reference.providerSessionId);
      return { items: mapCodexThreadToLegacyTimelineItems(result?.thread) };
    }]
  ])
});
const sessionApplicationService = createSessionApplicationComposition({
  store, agentProviderRegistry, sessionBindingRepository, toolHostService, toolMaterializationPort,
  requiredToolDomainsForSession,
  assertForkDispatchAllowed: (sessionId) => sessionForkService.assertCanDispatch(sessionId),
  assertSessionRecoveryMessageBoundary,
  recoverSession: (input) => sessionRecoveryCoordinator.recover(input),
  requireSessionReference, workChatContextService,
  resolveContextReferences: (sessionId, options) => sessionContextReferenceService.resolve(sessionId, options),
  artifactService, memoryRecallService, mcpAssignmentRevisionForAgent,
  resolveAssignedCapabilities: (agentId) => assignedCapabilitySummary(store, agentId),
  ensureCollaborationAgentForSession, ensureLogicalRouteForProviderSession,
  sessionWithLogicalWorkspace, collaborationCore, emitEvent
});
const { interruptUnifiedSession, respondUnifiedSessionApproval, respondUnifiedSessionUserInput } = createSessionInteractionCommands({
  store, requireSessionReference, sessionApplicationService, providerEventIngestion,
  handleCommittedProviderTerminalLifecycle, sendUnifiedSessionMessage, emitEvent, now,
  onInterruptRequested: (entry) => turnExecutionProbe?.request(entry)
});
const { handleProviderResponseDelayed, handleProviderResponseTimeout } = createProviderResponseHandlers({
  store, providerEventIngestion, sessionApplicationService,
  handleCommittedProviderTerminalLifecycle, now
});
providerTurnResponseWatchdog = new ProviderTurnResponseWatchdog({
  warningAfterMs: configuredProviderResponseDelay("CORPTIE_PROVIDER_RESPONSE_WARNING_MS", 20_000),
  timeoutAfterMs: configuredProviderResponseDelay("CORPTIE_PROVIDER_RESPONSE_TIMEOUT_MS", 120_000),
  resolveTurnLiveness: (providerId) => agentProviderRegistry.get(providerId).descriptor.metadata.turnLiveness,
  onDelayed: handleProviderResponseDelayed,
  onTimeout: handleProviderResponseTimeout
});
turnExecutionProbe = createTurnExecutionProbe({ store, registry: agentProviderRegistry,
  enabled: !developmentPreview,
  bindings: sessionBindingRepository, ingestion: providerEventIngestion,
  onRunning: (entry) => providerTurnResponseWatchdog.confirmRunning(entry),
  onTerminal: handleCommittedProviderTerminalLifecycle, now });
// Re-arm only current unfinished turns after startup; no Provider history scan,
// model prompt, resume, or replay is performed here.
function restoreTurnExecutionProbes() {
  for (const row of store.selectAll(`SELECT session_id, binding_id, turn_id, routing_version
    FROM session_turns WHERE execution_status IN ('running', 'blocked')`)) {
    const reference = sessionBindingRepository.resolve(row.session_id);
    if (reference?.bindingId !== row.binding_id || reference.routingVersion !== row.routing_version) continue;
    turnExecutionProbe.observe({ event: { ...reference, turnId: row.turn_id, type: "turn.started" }, binding: reference });
  }
}
sessionRuntimeReleaseService = new SessionRuntimeReleaseService({
  store,
  sessionService: sessionApplicationService
});
sessionRecoveryCoordinator = createSessionRecoveryComposition({
  store, agentProviderRegistry, toolHostService,
  runBackgroundAgent: (input) => backgroundAgentService.run(input),
  sessionApplicationService, codexRuntime, prospectiveToolHostBinding,
  toolHostMaterializationCoordinator, emitEvent
});
const { toolBootstrapBindingPreflight, emptyCodexBindingPreflight } = createProviderStartupPreflights({
  store, toolHostMaterializationCoordinator, sessionRecoveryCoordinator,
  requireSessionReference, sessionApplicationService
});
sessionBindingReadinessProbe = new SessionBindingReadinessProbe({
  resolveReference: (sessionId) => sessionApplicationService.referenceFor(sessionId),
  probe: (sessionId, context) => sessionApplicationService.probeBindingReadiness(sessionId, context),
  onChanged: (sessionId) => store.touchSessionProjectionDependency(sessionId)
});

platformOperationService = createPlatformOperationComposition({
  store, workService, sessionApplicationService, artifactService,
  collaborationCore, platformConfirmationService, sessionRuntimeReleaseService,
  listSessions: (input) => listGatewaySessions(input),
  startWorkSession: (command) => workSessionStartApplicationService.start(command),
  launchAgentSession: (input) => launchAgentSession(input),
  getDefaultProviderId: () => agentProviderRegistry.defaultProviderId,
  emitEvent
});
const sessionContextReferenceService = new SessionContextReferenceService({
  store,
  readSessionDetail: (sessionId) => readStoredSessionDetail(requireSessionReference(sessionId))
});
const foundationModelSettings = new FoundationModelSettings(store.dataRoot);
const backgroundAgentService = new BackgroundAgentService({
  getModelSettings: () => foundationModelSettings.value,
  isEnabled: () => !developmentPreview,
  registry: agentProviderRegistry,
  defaultProviderId: agentProviderRegistry.defaultProviderId,
  resolveProviderId: (provider) => resolveSessionProviderId(provider),
  resolveAgentContext: (agentId, { intent } = {}) => agentContextService.buildAgentContext(agentId, { intent }),
  onOperationEvent: (type, payload) => {
    emitEvent(type, payload);
    if (type === "BackgroundAgentCompleted" || type === "BackgroundAgentFailed") {
      console.info(`[background-agent-performance] ${JSON.stringify({ type, ...payload })}`);
    }
  }
});
memoryExtractor.classifyMany = createMemoryModelClassifier({ backgroundAgent: backgroundAgentService,
  claimBudget: (day) => store.claimMemoryExtractionDailyCall(day, 24),
  refundBudget: (day) => store.refundMemoryExtractionDailyCall(day) });
const taskSummaryService = new TaskSummaryService({ store, backgroundAgent: backgroundAgentService,
  isEnabled: () => !developmentPreview });
skillRegistryService.setDiscoveryAssistant(createSkillPackageDiscoveryAssistant({
  backgroundAgent: backgroundAgentService
}));
const projectCodeProduction = createProjectCodeProductionComposition({
  store, runIsolationCoordinator, backgroundAgentService,
  environmentName, emitEvent
});
projectCodeStartupReceipts = projectCodeProduction.projectCodeStartupReceipts;
const projectCodeIndexStore = projectCodeProduction.projectCodeIndexStore;
const projectCodeFreshnessMonitor = projectCodeProduction.projectCodeFreshnessMonitor;
const projectCodeRunIsolationPort = projectCodeProduction.projectCodeRunIsolationPort;
projectCodeApplicationService = projectCodeProduction.projectCodeApplicationService;
projectToolsetProduction = projectCodeProduction.projectToolsetProduction;
projectToolsetInitializer = projectCodeProduction.projectToolsetInitializer;
if (projectCodeProduction.runAuthorityResolver) {
  runIsolationAuthorityResolver = projectCodeProduction.runAuthorityResolver;
}
const {
  authenticatedSession: projectToolsetAuthenticatedSession,
  runIsolationOptions: projectToolsetRunIsolationOptions
} = createProjectToolsetAuthority({
  getRunIsolationCoordinator: () => runIsolationCoordinator,
  getProjectToolsetProduction: () => projectToolsetProduction,
  startupReceipts: projectCodeStartupReceipts,
  authorityResolver: { resolve: (...args) => runIsolationAuthorityResolver.resolve(...args) },
  requireSessionReference,
  store
});
benchmarkControlPlane = createBenchmarkControlPlaneComposition({
  store, artifactService, sessionApplicationService, turnObservability,
  runIsolationCoordinator, projectToolsetProduction,
  projectCodeStartupReceipts, projectCodeApplicationService
});
const {
  sessionWorkspaceCoordinator, sessionProviderSwitchCoordinator,
  sessionWorktrees, sessionWorkspaceOperations: composedSessionWorkspaceOperations
} = createSessionWorkspaceComposition({
  store, agentProviderRegistry, sessionBindingRepository, collaborationCore,
  ensureCollaborationAgentForSession, toolHostService, sessionApplicationService,
  codexRuntime, prospectiveToolHostBinding, toolHostMaterializationCoordinator,
  gitWorkspaces, workspaceInventory, emitEvent
});
sessionWorkspaceOperations = composedSessionWorkspaceOperations;
const { generateSessionCommitMessage, generateUnownedWorktreeCommitMessage } = createCommitMessageOperations({
  store, sessionApplicationService, sessionBindingRepository, backgroundAgentService,
  assertWorkspaceRouteUsable
});
const { projectToolsetStatusForPath } = createProjectToolsetStatusReader({
  projectToolsets,
  readInitializationStatus: (...args) => projectToolsetInitializer.status(...args),
  getProduction: () => projectToolsetProduction,
  runtimeSourceIdentity
});
const projectWorktreeStatusReader = createProjectWorktreeStatusReader({
  store, requireSessionReference, ensureLogicalRouteForProviderSession,
  projectToolsetAuthenticatedSession, projectToolsetStatusForPath,
  projectToolsets, gitWorkspaces, gitHubPushes
});
const { resolveProjectContext, performProjectDevelopmentServiceAction, performProjectWorkspaceAction } = createProjectActionHandlers({
  store, gitWorkspaces, projectToolsets, gitCommitProtection, gitHubPushes,
  rebuildAndRestartProjectService, generateUnownedWorktreeCommitMessage,
  resolveProjectCommitProtection: (...args) => resolveProjectCommitProtection(...args)
});
const projectApplicationService = new ProjectApplicationService({
  resolveProject: resolveProjectContext,
  inspectWorkspaces: (project, options = {}) => gitWorkspaces.projectStatusForPath(
    project.mainPath,
    project.id,
    options
  ),
  inspectWorkspacePushStatus: (_project, workspace) => gitHubPushes.status({
    workingDirectory: workspace.path
  }),
  inspectDevelopmentService: (project) => projectToolsetStatusForPath(project.mainPath),
  performDevelopmentServiceAction: performProjectDevelopmentServiceAction,
  performWorkspaceAction: performProjectWorkspaceAction
});
const { controlPlaneSnapshot, readControlPlaneEntity, presentTaskForClient } = createControlPlaneProjection({
  store, environmentName, decorateSessionForClient
});
const { readSessionUsage, getGatewayUsage } = createSessionUsageReader({
  store, sessionApplicationService,
  publishTimeline: (sessionId) => clientDeviceGateway?.events.publishTimeline(sessionId),
  resetForecastForSession: (session) => session.external?.provider === "codex-app-server"
    ? codexResetForecastMonitor?.snapshot() ?? null : null
});
const { sessionDeletionPlan, sessionWorkspaceRecoveryStatus } = createSessionWorkspaceInspection({
  store, gitWorkspaces, assertWorkspaceRouteUsable, createGitWorkspaceSnapshot
});
const taskWorkspaceService = new TaskWorkspaceService({
  store,
  requireProject: (repositoryId) => projectApplicationService.requireProject(repositoryId),
  inspectProject: (mainPath, repositoryId) => gitWorkspaces.projectStatusForPath(mainPath, repositoryId),
  ensureWorktree: (input) => gitWorkspaces.ensureTaskWorktreeForProject(input),
  restoreMissingWorktree: (input) => gitWorkspaces.restoreMissingWorktree(input)
});
const { inspectTaskWorktree, removeTaskDeletionWorktree, reclaimTaskWorktree } = createTaskWorktreeOperations({
  store, gitWorkspaces, projectApplicationService, emitEvent
});
const {
  commitMessageForProjectWorktree, resolveProjectCommitProtection,
  mergeProjectWorktree, restartProjectWorktree, commitProjectWorktree,
  prepareProjectWorktreeCommit, generateProjectWorktreeCommitMessage
} = createProjectWorktreeGitOperations({
  store, gitWorkspaces, gitCommitProtection, projectToolsets,
  generateSessionCommitMessage, generateUnownedWorktreeCommitMessage,
  rebuildAndRestartProjectService, projectWorktreeStatus
});
const { prepareGitHubPush, generateGitHubPushCommitMessage, confirmGitHubPush } = createSessionGitHubPushOperations({
  sessionApplicationService, gitHubPushes, projectWorkingDirectoryForSession,
  generateSessionCommitMessage, emitEvent
});
const { completeProjectWorktree, operateProjectWorktree } = createProjectWorktreeOperations({
  store, gitWorkspaces, projectToolsets, collaborationCore,
  resolveProjectCommitProtection, commitMessageForProjectWorktree,
  rebuildAndRestartProjectService, emitEvent
});
const {
  taskDeletionService, taskExecutionOrchestrator: composedTaskExecutionOrchestrator,
  restartTaskForEntityRoutes, setTaskArchivedForEntityRoutes
} = createTaskExecutionComposition({
  store, inspectTaskWorktree, removeTaskDeletionWorktree,
  sessionApplicationService, artifactService, emitEvent,
  workService, sessionRuntimeReleaseService, sessionWorktrees,
  ensureTaskWorkspace
});
taskExecutionOrchestrator = composedTaskExecutionOrchestrator;
({ workSessionStartupCoordinator, workSessionStartApplicationService } = createWorkSessionStartupComposition({
  store, workService, agentProviderRegistry, sessionApplicationService,
  forkContextForTask: (taskId) => sessionForkService.contextForTask(taskId),
  prepareConversationForkWorkspace: (...args) => prepareConversationForkWorkspace(...args),
  ensureTaskWorkspace,
  createProviderWorkSession: (input) => createProviderWorkSession(input),
  requiredWorkspaceInstructionSources, knownGlobalInstructionSources,
  sendUnifiedSessionMessage, projectApplicationService, gitWorkspaces,
  projectCodeApplicationService, resolveSessionProviderId, emitEvent
}));
const { sessionForkService, prepareConversationForkWorkspace } = createSessionForkOperations({
  store, agentProviderRegistry, sessionApplicationService, workService,
  workSessionStartApplicationService, chatResourceService, collaborationCore,
  createSessionThroughApplication: (...args) => createSessionThroughApplication(...args),
  emitEvent, createForkWorktree,
  createGitWorkspaceSnapshot, ensureArtifactCommitHook: ensureRepositoryArtifactCommitHook
});
const { projectWorktreeIntegrationService, worktreeIntegrationJobService } = createWorktreeIntegrationServices({
  store, projectApplicationService, gitWorkspaces, gitHubPushes, gitCommitProtection,
  workService, artifactService, agentProviderRegistry, startPreparedWorkSession,
  sendUnifiedSessionMessage, emitEvent, presentTaskForClient
});
const {
  syncSessionChannelDeliveriesIntoAgentWorkQueue,
  syncCollaborationDeliveriesIntoAgentWorkQueue,
  resolveCollaborationDeliveryRoute
} = createCollaborationDeliveryQueue({
  store, sessionChannelService, collaborationCore, collaborationDispatcher,
  collaborationDeliveryRouteResolver, emitEvent, scheduleAgentWorkDrain,
  registerRuntimeQueuedWork: (...args) => registerRuntimeQueuedWork(...args),
  moveRuntimeQueuedWork: (...args) => moveRuntimeQueuedWork(...args)
});
const { resolveCollaborationConfirmation, resolveSessionChannelRequest } = createCollaborationConfirmationCommands({
  collaborationCore, sessionChannelService, sessionCollaborationService, emitEvent,
  syncCollaborationDeliveriesIntoAgentWorkQueue, syncSessionChannelDeliveriesIntoAgentWorkQueue
});
const {
  continuePendingWorkspaceTransition, continuePendingProviderSwitch,
  enqueueWorkspaceContinuationSafely, refreshWorkspaceInventoryAfterTurn, reconcileMovedWorkspaceRoutes
} = createPostTurnWorkspaceOperations({
  store, workspaceTransitionRuntimeForLogicalSession, sessionBindingRepository,
  sessionProviderSwitchCoordinator, workspaceContinuationCoordinator,
  createGitWorkspaceSnapshot, emitEvent
});
const { createSessionThroughApplication } = createSessionCreationOperation({
  store, sessionApplicationService, sessionForkService, sessionTitleReservations,
  desiredToolDomainIds, assertDirectory, emitEvent, sendUnifiedSessionMessage
});
const {
  createProviderWorkSession, launchAgentSession, launchWorkChatSession,
  ensureWorkChatSession, reconcileWorkChatsAtStartup
} = createEntitySessionLaunchers({
  store, workService, collaborationCore, workChatContextService, workDiscussionService,
  agentProviderRegistry, environmentName, resolveSessionProviderId, createSessionThroughApplication
});
const { listGatewaySessions, listGatewaySessionPage, describeGatewaySession, listGatewayWorkspaces } = createGatewayInventoryReader({
  store, decorateSessionForClient, now
});
const feishuGateway = new FeishuGatewayManager({
  store,
  listSessions: listGatewaySessions,
  describeSession: describeGatewaySession,
  listWorkspaces: listGatewayWorkspaces,
  createSession: createGatewaySession,
  getSnapshot: getUnifiedSessionSnapshot,
  getUsage: getGatewayUsage,
  sendMessage: sendUnifiedSessionMessage,
  interruptSession: interruptUnifiedSession,
  respondToApproval: respondUnifiedSessionApproval,
  respondToCollaborationConfirmation: resolveCollaborationConfirmation
});

const {
  registerRuntimeQueuedWork, forgetRuntimeQueuedWork, moveRuntimeQueuedWork,
  runtimeQueuePosition, drainAgentWork, tickAgentWorkQueue
} = createRuntimeAgentWorkQueue({
  store, collaborationCore, sessionChannelService, collaborationDispatcher,
  workspaceContinuationCoordinator, inspectCollaborationSession, resolveCollaborationDeliveryRoute,
  scheduleAgentWorkDrain, dispatchSessionChannelDelivery, sendUnifiedSessionMessage, emitEvent,
  syncSessionChannelDeliveriesIntoAgentWorkQueue, syncCollaborationDeliveriesIntoAgentWorkQueue
});
function cancelQueuedUserMessage(sessionId, taskId) {
  const routedSessionId = requireSessionReference(sessionId).sessionId;
  const task = store.runInTransaction(() => {
    const cancelled = store.cancelQueuedUserAgentTask(routedSessionId, taskId);
    if (cancelled?.source?.deliveryId) {
      store.updateMessageDelivery(cancelled.source.deliveryId, { status: "cancelled" });
    }
    return cancelled;
  });
  if (!task) {
    const error = new Error("This message is no longer queued.");
    error.code = "SESSION_BUSY";
    throw error;
  }
  forgetRuntimeQueuedWork(routedSessionId, taskId);
  emitEvent("AgentWorkCompleted", { sessionId: routedSessionId, task }, {
    sessionId: routedSessionId, source: task.source
  });
  scheduleAgentWorkDrain(routedSessionId);
  return task;
}

function deleteUserMessage(sessionId, messageId) {
  return deleteUnreceivedUserMessage(store, requireSessionReference(sessionId).sessionId, messageId);
}

const codexSessionCreator = createCodexSessionCreator({
  collaborationCore, codexRuntime, resolvedNewCodexRuntimeConfig,
  collaborationThreadOptionsWithAgentContext, withPersistedCodexToolConfirmation,
  codexAppServerSessionCapabilities
});

function now() {
  return new Date().toISOString();
}

const providerSessionRouteBootstrap = createProviderSessionRouteBootstrap({
  store, createGitWorkspaceSnapshot, inspectGitWorkspace,
  defaultWorkspacePath, normalizeSessionId, codexPermissionsForSession
});
const sessionProviderAttachments = createSessionProviderAttachments({
  store, collaborationCore, ensureCollaborationAgentForSession,
  sessionToolMetadata, toolHostService, workChatContextService
});







async function ensureLogicalRouteForProviderSession(session, providerId, options = {}) {
  return providerSessionRouteBootstrap.ensureLogicalRouteForProviderSession(session, providerId, options);
}

async function ensureLogicalRouteForCodexSession(session, appServerResponse = null) {
  return providerSessionRouteBootstrap.ensureLogicalRouteForCodexSession(session, appServerResponse);
}
async function commitManagedCodexWorkspaceRoute(event) {
  return managedProviderSessionProjection.commitManagedCodexWorkspaceRoute(event);
}




function errorStatus(error, fallback = 400) {
  return Number.isInteger(error?.statusCode) ? error.statusCode : fallback;
}

function sessionTitleErrorPayload(error, extra = {}) {
  return {
    error: error.message,
    code: error.code ?? null,
    suggestedTitle: error.suggestedTitle ?? null,
    ...extra
  };
}


function emitEvent(type, payload, options = {}) {
  productEventPublisher ??= createProductEventPublisher({
    store, eventLog, sseClients, now,
    getClientDeviceGateway: () => clientDeviceGateway,
    scheduleStateSyncPublish: () => scheduleStateSyncPublish(),
    requestTaskSummary: (taskId) => taskSummaryService.request(taskId),
    notifySessionEventListeners: (event) => notifySessionEventListeners(event),
    publishDshSessionEvent: (event) => dshLivePublisher.publishSessionEvent(event),
    handleScheduledWorkEvent: (type, task) => scheduledSessionTaskService.handleAgentWorkEvent(type, task),
    reconcileCompletedCollaborationWork: (task) => collaborationCore.reconcileCompletedAgentWork(task),
    reconcileConflictResolutionSession: (sessionId) => worktreeIntegrationJobService.reconcileConflictResolutionSession(sessionId),
    agentWorkTimelineItem: (...args) => agentWorkTimelineItem(...args),
    collaborationConfirmationTimelineItem: (...args) => collaborationConfirmationTimelineItem(...args),
    sessionChannelAuthorizationTimelineItem: (...args) => sessionChannelAuthorizationTimelineItem(...args),
    sessionChannelMessageTimelineItem: (...args) => sessionChannelMessageTimelineItem(...args)
  });
  return productEventPublisher.emitEvent(type, payload, options);
}

function resolveProviderEventBinding(event) {
  return managedProviderSessionProjection.resolveProviderEventBinding(event);
}







function upsertManagedCodexSession(session, preferredAgentId = null) {
  return managedProviderSessionProjection.upsertManagedCodexSession(session, preferredAgentId);
}

function ensureCollaborationAgentForSession(session, preferredAgentId = null) {
  return managedProviderSessionProjection.ensureCollaborationAgentForSession(session, preferredAgentId);
}


async function claudeRuntimeOptionsForSession(providerSessionId) {
  return sessionProviderAttachments.claudeRuntimeOptionsForSession(providerSessionId);
}

async function collaborationThreadOptionsForSession(sessionId, options = {}) {
  return sessionProviderAttachments.collaborationThreadOptionsForSession(sessionId, options);
}
async function workspaceTransitionRuntimeForLogicalSession(logical) {
  return resolveWorkspaceTransitionRuntime(logical?.activeBinding?.providerId, {
    "codex-app-server": {
      manager: workspaceTransitionManager,
      loadOptions: () => collaborationThreadOptionsForSession(logical?.legacySessionId)
    },
    "claude-sdk": { manager: claudeWorkspaceTransitionManager },
    openclacky: { manager: openClackyWorkspaceTransitionManager }
  });
}

function withPersistedCodexToolConfirmation(reference, attachment = {}) {
  return sessionProviderAttachments.withPersistedCodexToolConfirmation(reference, attachment);
}
function requiredToolDomainsForSession(context = {}) {
  return resolveSessionToolDomainRequirements(context, {
    projectCodeRecommendationEnabled: PROJECT_CODE_MODEL_RECOMMENDATION_ENABLED
  });
}

function withWorkChatCodexContext(options, metadata) {
  return sessionProviderAttachments.withWorkChatCodexContext(options, metadata);
}

function withWorkChatClaudeContext(options, metadata) {
  return sessionProviderAttachments.withWorkChatClaudeContext(options, metadata);
}
async function readStoredSessionConversation(sessionId) {
  return store.getItems(sessionId, 500).flatMap((item) => {
    if (item.type === "userMessage") return [{ role: "user", text: item.text }];
    if (item.type === "agentMessage") return [{ role: "assistant", text: item.text }];
    return [];
  });
}

async function readStoredSessionTimeline(sessionId) {
  return store.getItems(sessionId, 500);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function normalizeSessionId(id) {
  return id;
}

function requestedProviderId(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  // 先走统一的 Session Provider id 规范化（覆盖 codex / claude / claude_code 等别名）。
  const resolved = resolveSessionProviderId(normalized);
  if (resolved) return resolved;
  return normalized;
}

function titleFromPrompt(prompt) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "New Codex task";
  }
  return compact.length > 64 ? `${compact.slice(0, 61)}...` : compact;
}

function codexApprovalPolicyForCli(approvalPolicy) {
  return approvalPolicy === "ask-risky" ? "on-request" : approvalPolicy;
}


async function createGatewaySession(input = {}) {
  const providerId = input.agent === "claude" ? "claude-sdk" : "codex-app-server";
  return createSessionThroughApplication(providerId, input, { source: "feishu" });
}


function prepareCodexProviderSessionInput(input = {}) {
  return prepareCodexLaunchInput(input, {
    defaults: normalizeNewSessionDefaults(store.settings().newSessionDefaults),
    normalizeSandbox: normalizeCodexSandbox,
    normalizeApprovalPolicy: normalizeCodexApprovalPolicy
  });
}

function prepareClaudeProviderSessionInput(input = {}) {
  return prepareClaudeLaunchInput(input, {
    defaults: normalizeNewSessionDefaults(store.settings().newSessionDefaults),
    normalizeSandbox: normalizeCodexSandbox,
    normalizeApprovalPolicy: normalizeCodexApprovalPolicy
  });
}

// Normalize display tags, historical aliases and registry IDs at the composition boundary.
function resolveSessionProviderId(provider) {
  const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  return agentProviderRegistry.resolveId(normalized, { useDefault: normalized === "" });
}

async function startPreparedWorkSession(input) {
  return startPreparedWorkSessionWithAuthority(input, {
    store, workService, workSessionStartApplicationService
  });
}

async function createCodexProviderSession(input = {}) {
  return codexSessionCreator.create(input);
}



// Recovery stabilization is Provider-neutral orchestration. The Codex-specific
// proof requirement lives in the adapter; see ProviderSessionLifecycle.
function stabilizeCodexRecoverySession(reference, context = {}) {
  return providerSessionLifecycle.stabilizeRecoverySession(reference, context);
}

// Execution preparation is Provider-neutral orchestration. The Codex-specific
// resume/permission protocol lives in the adapter; see ProviderSessionLifecycle.
function prepareCodexProviderExecution(reference, context = {}) {
  return providerSessionLifecycle.prepareExecution(reference, context);
}


function resolvePreparedWorkspaceRoute(logicalRoute, threadId) {
  return workspaceRoutePreparationCache.resolve({
    store,
    logicalSession: logicalRoute,
    providerThreadId: threadId,
    resolve: () => assertWorkspaceRouteUsable({
      store,
      logicalSession: logicalRoute,
      providerThreadId: threadId
    })
  });
}



async function getUnifiedSessionSnapshot(sessionId) {
  // Snapshot reads are strictly local and read-only. Provider callbacks
  // materialize state before publishing wake events.
  return getStoredSessionSnapshot(sessionId);
}


function requireSessionReference(sessionId) {
  const reference = sessionBindingRepository.resolve(sessionId);
  if (reference?.metadata?.session) return reference;
  const error = new Error("Session not found.");
  error.code = "SESSION_NOT_FOUND";
  throw error;
}



// Turn-change review/undo is Provider-neutral orchestration. Only the stored
// item normalisation knows the Provider id; see ProviderSessionLifecycle.
function manageCodexTurnChanges(reference, turnId, action) {
  return providerSessionLifecycle.manageTurnChanges(reference, turnId, action);
}


function projectSessionChannelMessageForSender(result) {
  const message = result?.message;
  if (!message?.messageId || !message.senderSessionId) return;
  emitEvent("SessionChannelMessageSent", {
    sessionId: message.senderSessionId,
    channel: result.channel,
    message,
    delivery: result.delivery ?? null
  }, {
    eventId: `session-channel-message-sent:${message.messageId}`,
    sessionId: message.senderSessionId,
    source: {
      type: "session_channel",
      channelId: result.channel?.channelId ?? message.channelId,
      messageId: message.messageId
    }
  });
}




const sessionMessageOperation = createSessionMessageOperation({
  store, requireSessionReference, agentProviderRegistry, sessionChannelService,
  resolveSessionChannelRequest, collaborationCore, resolveCollaborationConfirmation,
  sessionBindingReadinessProbe, sessionApplicationService, emitEvent, now,
  decorateSessionForClient, chatResourceService, providerTurnResponseWatchdog,
  ensureCollaborationAgentForSession, registerRuntimeQueuedWork,
  runtimeQueuePosition, publishProviderEventOutbox, scheduleAgentWorkDrain,
  scheduleMemoryExtraction: (sessionId, reason) => memoryExtractionScheduler.request(sessionId, reason)
});

async function sendUnifiedSessionMessage(sessionId, input, source = { type: "desktop" }, options = {}) {
  return sessionMessageOperation.sendUnifiedSessionMessage(sessionId, input, source, options);
}

function assertSessionRecoveryMessageBoundary(reference) {
  return sessionMessageOperation.assertSessionRecoveryMessageBoundary(reference);
}


function scheduleAgentWorkDrain(sessionId, latencyTrace = null, taskId = null) {
  if (taskId) registerRuntimeQueuedWork(sessionId, taskId);
  queueMicrotask(() => {
    logSessionMessageLatency(latencyTrace, "queue_drain_dispatched");
    drainAgentWork(sessionId).catch((error) => {
      console.error(`[agent-work] session=${sessionId} drain failed: ${error.message}`);
    });
  });
}





function configuredProviderResponseDelay(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}




function unifiedErrorStatus(error) {
  if (["SESSION_NOT_FOUND", "PROJECT_NOT_FOUND", "WORKSPACE_NOT_FOUND", "AGENT_PROVIDER_NOT_FOUND"].includes(error.code)) return 404;
  if (["INVALID_PROJECT_ACTION", "INVALID_READ_SEQUENCE", "UNSUPPORTED_REASONING_LEVEL"].includes(error.code)) return 400;
  if (["INVALID_MESSAGE", "NO_ACTIVE_RUN", "SESSION_BUSY", "SESSION_NOT_READY", "UNSUPPORTED_COMMAND", "CAPABILITY_UNSUPPORTED"].includes(error.code)) return 409;
  if (error.code === "FEISHU_SESSION_OCCUPIED") return 409;
  return 502;
}



async function switchCodexProviderWorkspace(reference, input = {}) {
  return providerWorkspaceSwitches.switchCodexProviderWorkspace(reference, input);
}

async function switchClaudeProviderWorkspace(reference, input = {}) {
  return providerWorkspaceSwitches.switchClaudeProviderWorkspace(reference, input);
}

async function switchOpenClackyProviderWorkspace(reference, input = {}) {
  return providerWorkspaceSwitches.switchOpenClackyProviderWorkspace(reference, input);
}

async function commitManagedClaudeWorkspaceRoute(event) {
  return claudeNotificationReceiver.commitManagedClaudeWorkspaceRoute(event);
}

function handleClaudeProviderEventSafely(event) {
  return claudeNotificationReceiver.handleClaudeProviderEventSafely(event);
}

async function handleClaudeTurnSettledSafely(event) {
  return claudeNotificationReceiver.handleClaudeTurnSettledSafely(event);
}

// Session restart is Provider-neutral orchestration: it re-binds the workspace
// route at a Turn boundary. See ProviderSessionLifecycle.
function restartCodexProviderSession(reference, context = {}) {
  return providerSessionLifecycle.restartSession(reference, context);
}

async function switchSessionWorkspace(sessionId, targetWorktreeId, transitionId = undefined, continuationPrompt = undefined) {
  return sessionWorkspaceCoordinator.switchWorkspace(sessionId, {
    targetWorkspaceId: targetWorktreeId,
    transitionId,
    continuationPrompt
  });
}


async function switchSessionProvider(sessionId, providerId, transitionId = undefined, expectedRoutingVersion = undefined) {
  return sessionProviderSwitchCoordinator.switchProvider(sessionId, {
    providerId,
    transitionId,
    expectedRoutingVersion
  });
}


async function mergeSessionWorktreeBeforeDeletion(sessionId, plan) {
  const logical = store.getLogicalSessionByLegacySessionId(sessionId);
  if (!logical?.activeBinding) throw new Error("The Session no longer has an active workspace route.");
  const commitMessage = plan.hasUncommittedChanges
    ? await generateSessionCommitMessage(sessionId, plan)
    : null;
  return gitWorkspaces.mergeSessionWorktreeIntoMain({
    logicalSessionId: logical.logicalSessionId,
    commitMessage
  });
}

function projectWorkingDirectoryForSession(sessionId) {
  return projectWorktreeStatusReader.projectWorkingDirectoryForSession(sessionId);
}

async function projectToolsetStatus(sessionId) {
  return projectWorktreeStatusReader.projectToolsetStatus(sessionId);
}


async function rebuildAndRestartProjectService(workingDirectory, executionRoot = undefined) {
  return projectWorktreeStatusReader.rebuildAndRestartProjectService(workingDirectory, executionRoot);
}

async function projectWorktreeStatus(sessionId) {
  return projectWorktreeStatusReader.projectWorktreeStatus(sessionId);
}

async function ensureTaskWorkspace({ task, session = null }) {
  return taskWorkspaceService.ensure({ task, session });
}



const persistentRuntimeLifecycle = createPersistentRuntimeLifecycle({
  store, dshLivePublisher, taskSessionProjection, codexChoiceProjection,
  turnObservability, runtimeActivity, stateSyncPublisher, scheduledSessionTaskService,
  getResetForecastMonitor: () => codexResetForecastMonitor,
  openClackyManager, feishuGateway, codexRuntime,
  claudeManager: claudeProviderRuntime.manager,
  closeTimelineReadPool, activateStoredBackendLogging
});

function inspectDataRootMigrationBlockers() {
  return persistentRuntimeLifecycle.inspectDataRootMigrationBlockers();
}

async function quiescePersistentRuntime() {
  return persistentRuntimeLifecycle.quiescePersistentRuntime();
}

async function resumePersistentRuntime() {
  return persistentRuntimeLifecycle.resumePersistentRuntime();
}

function trackStartupMaintenance(promise) {
  return runtimeActivity.trackMaintenance(promise);
}

const handleCollaborationRoutes = createCollaborationHttpRoutes({
  collaborationCore, sessionCollaborationV2Enabled, sessionCollaborationService,
  sessionChannelService, emitEvent, resolveCollaborationConfirmation, resolveSessionChannelRequest,
  projectSessionChannelMessageForSender, syncSessionChannelDeliveriesIntoAgentWorkQueue,
  sessionWorkspaceOperations, memoryOperationService, skillRegistryService, reportTaskAcceptanceForAgent,
  sessionContextReferenceService, scheduledSessionTaskService,
  scheduledSessionHttpActor, scheduledSessionHttpLogicalSessionId
});

const handleEntityRoutes = createEntityHttpRoutes({
  workService, hubService, collaborationRouter, memoryExtractor, memoryRecallService,
  memoryLifecycleService, assistantService, workSessionStartApplicationService,
  agentProviderRegistry, launchAgentSession, workDiscussionService, ensureWorkChatSession,
  requestedProviderId, createSessionThroughApplication, backgroundAgentService,
  skillRegistryService, inspectTaskWorktree, reclaimTaskWorktree, taskDeletionService,
  restartTaskForEntityRoutes, setTaskArchivedForEntityRoutes, taskExecutionOrchestrator,
  taskCompletionService, sessionTitleReservations, emitEvent
});

const backendHttpPorts = Object.freeze({
  get clientDeviceGateway() { return clientDeviceGateway; },
  get sendJson() { return sendJson; },
  get developmentPreview() { return developmentPreview; },
  get clientCapabilities() { return clientCapabilities; },
  get backendStoreReady() { return backendStoreReady; },
  get store() { return store; },
  get taskCollaborationEdges() { return taskCollaborationEdges; },
  get foundationModelSettings() { return foundationModelSettings; },
  get rejectDevelopmentPreviewWrite() { return rejectDevelopmentPreviewWrite; },
  get handleFoundationModelUpdateHttpRequest() { return handleFoundationModelUpdateHttpRequest; },
  get agentProviderRegistry() { return agentProviderRegistry; },
  get backgroundAgentService() { return backgroundAgentService; },
  get taskSummaryService() { return taskSummaryService; },
  get readJson() { return readJson; },
  get rejectUnavailableStoreRequest() { return rejectUnavailableStoreRequest; },
  get dataRootMigrationCoordinator() { return dataRootMigrationCoordinator; },
  get handleSceneHttpRequest() { return handleSceneHttpRequest; },
  get sceneService() { return sceneService; },
  get handleBackendRestartHttpRequest() { return handleBackendRestartHttpRequest; },
  get shutdown() { return shutdown; },
  get handlePlatformConfirmationHttpRequest() { return handlePlatformConfirmationHttpRequest; },
  get platformConfirmationService() { return platformConfirmationService; },
  get errorStatus() { return errorStatus; },
  get handleSessionToolHttpRequest() { return handleSessionToolHttpRequest; },
  get collaborationCore() { return collaborationCore; },
  get toolHostService() { return toolHostService; },
  get sessionToolMetadata() { return sessionToolMetadata; },
  get handleCollaborationRoutes() { return handleCollaborationRoutes; },
  get handleArtifactHttpRequest() { return handleArtifactHttpRequest; },
  get artifactService() { return artifactService; },
  get handleBenchmarkHttpRequest() { return handleBenchmarkHttpRequest; },
  get benchmarkControlPlane() { return benchmarkControlPlane; },
  get handleCodeTaskObservabilityHttpRequest() { return handleCodeTaskObservabilityHttpRequest; },
  get turnObservability() { return turnObservability; },
  get handleSshWorkspaceHttpRequest() { return handleSshWorkspaceHttpRequest; },
  get getSshWorkspaceServices() { return getSshWorkspaceServices; },
  get handleMcpRegistryHttpRequest() { return handleMcpRegistryHttpRequest; },
  get mcpRegistryService() { return mcpRegistryService; },
  get mcpSessionAvailabilityService() { return mcpSessionAvailabilityService; },
  get emitEvent() { return emitEvent; },
  get handleEntityRoutes() { return handleEntityRoutes; },
  get handleDshHttpRequest() { return handleDshHttpRequest; },
  get sessionApplicationService() { return sessionApplicationService; },
  get listGatewaySessions() { return listGatewaySessions; },
  get readStoredSessionConversation() { return readStoredSessionConversation; },
  get readStoredSessionTimeline() { return readStoredSessionTimeline; },
  get now() { return now; },
  get createSessionThroughApplication() { return createSessionThroughApplication; },
  get publishDshPromptStart() { return publishDshPromptStart; },
  get sendUnifiedSessionMessage() { return sendUnifiedSessionMessage; },
  get cancelQueuedUserMessage() { return cancelQueuedUserMessage; },
  get deleteUserMessage() { return deleteUserMessage; },
  get publishDshPromptFailure() { return publishDshPromptFailure; },
  get handleBackendHealthHttpRequest() { return handleBackendHealthHttpRequest; },
  get projectCodeIndexStore() { return projectCodeIndexStore; },
  get projectCodeRunIsolationPort() { return projectCodeRunIsolationPort; },
  get projectCodeApplicationService() { return projectCodeApplicationService; },
  get projectCodeFreshnessMonitor() { return projectCodeFreshnessMonitor; },
  get handleSettingsReadHttpRequest() { return handleSettingsReadHttpRequest; },
  get handleProviderModelsHttpRequest() { return handleProviderModelsHttpRequest; },
  get unifiedErrorStatus() { return unifiedErrorStatus; },
  get handleSettingsUpdateHttpRequest() { return handleSettingsUpdateHttpRequest; },
  get configureChoiceParserRuntime() { return configureChoiceParserRuntime; },
  get codexRuntime() { return codexRuntime; },
  get handleFeishuHttpRequest() { return handleFeishuHttpRequest; },
  get feishuGateway() { return feishuGateway; },
  get handleSessionTimelineHttpRequest() { return handleSessionTimelineHttpRequest; },
  get getStoredSessionSnapshot() { return getStoredSessionSnapshot; },
  get getTimelineReadPool() { return getTimelineReadPool; },
  get readSessionUsage() { return readSessionUsage; },
  get readSessionHistory() { return readSessionHistory; },
  get readSessionTimelineWindow() { return readSessionTimelineWindow; },
  get publishStateChangesIfNeeded() { return publishStateChangesIfNeeded; },
  get handleSessionInteractionHttpRequest() { return handleSessionInteractionHttpRequest; },
  get userMessageCommandSource() { return userMessageCommandSource; },
  get chatResourceService() { return chatResourceService; },
  get requireSessionReference() { return requireSessionReference; },
  get interruptUnifiedSession() { return interruptUnifiedSession; },
  get respondUnifiedSessionApproval() { return respondUnifiedSessionApproval; },
  get respondUnifiedSessionUserInput() { return respondUnifiedSessionUserInput; },
  get handleSessionConfigurationHttpRequest() { return handleSessionConfigurationHttpRequest; },
  get normalizeCodexSandbox() { return normalizeCodexSandbox; },
  get normalizeCodexApprovalPolicy() { return normalizeCodexApprovalPolicy; },
  get handleChoiceParserTestHttpRequest() { return handleChoiceParserTestHttpRequest; },
  get parseChoiceStageWithConfiguredParser() { return parseChoiceStageWithConfiguredParser; },
  get handleProviderSetupHttpRequest() { return handleProviderSetupHttpRequest; },
  get firstRunSetup() { return firstRunSetup; },
  get handleProjectWorkspaceHttpRequest() { return handleProjectWorkspaceHttpRequest; },
  get projectApplicationService() { return projectApplicationService; },
  get projectWorktreeIntegrationService() { return projectWorktreeIntegrationService; },
  get worktreeIntegrationJobService() { return worktreeIntegrationJobService; },
  get handleSessionCollectionHttpRequest() { return handleSessionCollectionHttpRequest; },
  get sessions() { return sessions; },
  get listGatewaySessionPage() { return listGatewaySessionPage; },
  get requestedProviderId() { return requestedProviderId; },
  get sessionForkService() { return sessionForkService; },
  get sessionTitleErrorPayload() { return sessionTitleErrorPayload; },
  get handleSessionOrganizationHttpRequest() { return handleSessionOrganizationHttpRequest; },
  get normalizeSessionId() { return normalizeSessionId; },
  get archiveStoredSession() { return archiveStoredSession; },
  get sessionRuntimeReleaseService() { return sessionRuntimeReleaseService; },
  get upsertManagedCodexSession() { return upsertManagedCodexSession; },
  get handleSessionRecoveryHttpRequest() { return handleSessionRecoveryHttpRequest; },
  get sessionRecoveryCoordinator() { return sessionRecoveryCoordinator; },
  get handleSessionGitHttpRequest() { return handleSessionGitHttpRequest; },
  get prepareGitHubPush() { return prepareGitHubPush; },
  get generateGitHubPushCommitMessage() { return generateGitHubPushCommitMessage; },
  get confirmGitHubPush() { return confirmGitHubPush; },
  get projectWorktreeStatus() { return projectWorktreeStatus; },
  get mergeProjectWorktree() { return mergeProjectWorktree; },
  get prepareProjectWorktreeCommit() { return prepareProjectWorktreeCommit; },
  get generateProjectWorktreeCommitMessage() { return generateProjectWorktreeCommitMessage; },
  get commitProjectWorktree() { return commitProjectWorktree; },
  get completeProjectWorktree() { return completeProjectWorktree; },
  get operateProjectWorktree() { return operateProjectWorktree; },
  get restartProjectWorktree() { return restartProjectWorktree; },
  get handleSessionToolsetHttpRequest() { return handleSessionToolsetHttpRequest; },
  get projectToolsetStatus() { return projectToolsetStatus; },
  get projectWorkingDirectoryForSession() { return projectWorkingDirectoryForSession; },
  get projectToolsetAuthenticatedSession() { return projectToolsetAuthenticatedSession; },
  get projectToolsetInitializer() { return projectToolsetInitializer; },
  get projectToolsets() { return projectToolsets; },
  get projectToolsetRunIsolationOptions() { return projectToolsetRunIsolationOptions; },
  get handleSessionMutationHttpRequest() { return handleSessionMutationHttpRequest; },
  get sessionDeletionPlan() { return sessionDeletionPlan; },
  get reserveSessionTitle() { return reserveSessionTitle; },
  get deleteSessionWithOptionalMerge() { return deleteSessionWithOptionalMerge; },
  get mergeSessionWorktreeBeforeDeletion() { return mergeSessionWorktreeBeforeDeletion; },
  get gitWorkspaces() { return gitWorkspaces; },
  get handleSessionExecutionHttpRequest() { return handleSessionExecutionHttpRequest; },
  get sessionBindingReadinessProbe() { return sessionBindingReadinessProbe; },
  get handleSessionWorkspaceHttpRequest() { return handleSessionWorkspaceHttpRequest; },
  get ensureLogicalRouteForProviderSession() { return ensureLogicalRouteForProviderSession; },
  get createGitWorkspaceSnapshot() { return createGitWorkspaceSnapshot; },
  get reconcileMovedWorkspaceRoutes() { return reconcileMovedWorkspaceRoutes; },
  get sessionWorkspaceRecoveryStatus() { return sessionWorkspaceRecoveryStatus; },
  get switchSessionWorkspace() { return switchSessionWorkspace; },
  get recoverableAgentWorkDir() { return recoverableAgentWorkDir; },
  get ensureAgentWorkDir() { return ensureAgentWorkDir; },
  get switchSessionProvider() { return switchSessionProvider; },
  get decorateSessionForClient() { return decorateSessionForClient; },
  get handleSessionTurnHttpRequest() { return handleSessionTurnHttpRequest; },
  get handleStateSyncHttpRequest() { return handleStateSyncHttpRequest; },
  get eventLog() { return eventLog; },
  get sseClients() { return sseClients; },
  get stateSyncService() { return stateSyncService; },
  get stateSyncClients() { return stateSyncClients; },
  get sessionStateDiagnostics() { return sessionStateDiagnostics; },
  get writeStateSyncFrame() { return writeStateSyncFrame; },
});

function route(request, response) {
  return routeBackendHttpRequest(request, response, backendHttpPorts);
}

const server = http.createServer(route);

// DSH 前端实时事件下行通道（WebSocket downlink）：/api/events.mux 与 /api/events.host。
// 这两个 WebSocket 的「onOpen」是 DSH 前端严格就绪握手的组成部分——不建立则前端
// 陷入 reconnecting 死循环。最小实现：完成握手后保持连接打开（downlink-only）。
server.on("upgrade", (request, socket, head) => {
  const handled = handleDshWebSocketUpgrade({ request, socket, head });
  if (!handled) {
    // 非 DSH 路径的升级请求：销毁 socket，避免悬挂。
    socket.destroy();
  }
});

// The loopback transport is the fixed-cost application connection boundary.
// Store migration and every data-dependent initialization happen only after
// the port is accepting health/SSE requests; other APIs return an explicit,
// retryable initialization state until their local authority is ready.
await new Promise((resolve, reject) => {
  const onError = (error) => {
    server.off("listening", onListening);
    reject(error);
  };
  const onListening = () => {
    server.off("error", onError);
    resolve();
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port, "127.0.0.1");
});
console.log(`Corptie backend (${environmentName}) transport listening on http://127.0.0.1:${port}`);


// SQLite schema work is synchronous inside a connection. Run it in a Worker so
// a large production database cannot starve the already-open health/SSE
// transport. The main-thread Store opens only after the migration lock is
// released and skips the already-completed schema pass.
await store.resolveDataPath();
const developmentFixtureMarker = join(store.layout.stateDirectory, "development-fixtures-v1.json");
const shouldSeedDevelopmentFixtures = environmentName === "development"
  && !developmentPreview
  && process.env.CORPTIE_DEVELOPMENT_FIXTURES === "1"
  && !pathExists(developmentFixtureMarker);
const backendDataRootOwnership = await BackendDataRootOwnership.acquire({
  stateDirectory: store.layout.stateDirectory,
  environment: environmentName,
  port
});
await migrateStoreOffMainThread({
  dbPath: store.dbPath,
  configPath: store.configPath,
  dataRoot: store.dataRoot
});
await store.initialize({ resolveDataPath: false, performMigrations: false });
await firstRunSetup.initialize();
if (firstRunSetup.state.defaultProviderId) {
  agentProviderRegistry.defaultProviderId = firstRunSetup.state.defaultProviderId;
  backgroundAgentService.defaultProviderId = firstRunSetup.state.defaultProviderId;
  workChatOperationService.defaultProviderId = firstRunSetup.state.defaultProviderId;
  sessionCollaborationService.defaultProviderId = firstRunSetup.state.defaultProviderId;
}
await seedDevelopmentFixtures({
  store, skillRegistryService,
  bundledCollaborationSkillPath, now, marker: developmentFixtureMarker,
  enabled: shouldSeedDevelopmentFixtures
});
await initializeBackendStoreReadiness({
  store, benchmarkControlPlane, runIsolationCoordinator, runIsolationDataRoot,
  developmentPreview, dataRootMigrationCoordinator, turnObservability,
  artifactService, ensureArtifactCommitHook: ensureRepositoryArtifactCommitHook, chatResourceService,
  collaborationCore, controlPlaneSnapshot, readControlPlaneEntity,
  runtimeActivity, scheduleStateSyncPublish, scheduleTimelineChangePublish,
  activateStoredBackendLogging,
  onStateSyncReady: (service) => { stateSyncService = service; },
  onResetForecastMonitorReady: (monitor) => { codexResetForecastMonitor = monitor; }
});
const { storedSessions: storedSessionsAtStartup, knownActiveWorktrees } = loadStartupSessionInventory(store, normalizeSessionId);
await activateStartupSessions({
  store, storedSessionsAtStartup, developmentPreview, environmentName,
  corptieCodexRuntimePaths, corptieClaudeRuntimePaths,
  ensureAgentWorkDir, ensureCollaborationAgentForSession,
  publishProviderEventOutbox, workspaceContinuationCoordinator,
  providerEventPublisher, feishuGateway, taskSummaryService,
  configureChoiceParserRuntime, seedSessions, runtimeActivity,
  enableMockSessions: process.env.CORPTIE_ENABLE_MOCK_SESSIONS === "1"
});

function startBackendRuntime() {
  console.log(`Corptie backend (${environmentName}) Store ready on http://127.0.0.1:${port}`);
  if (developmentPreview) {
    console.log("[development-preview] read-only browsing; recovery, providers, schedules and integrations disabled");
    return;
  }
  restoreTurnExecutionProbes();
  memoryExtractionScheduler.start();
  taskSummaryService.start();
  startClientDeviceGateway({
    store, environmentName, developmentPreview, worktreeIntegrationJobService, projectApplicationService,
    emitEvent, readSessionTimelineWindow, getTimelineReadPool, requireSessionReference,
    sessionContextReferenceService, artifactService, scheduledSessionTaskService,
    turnObservability, agentProviderRegistry, switchSessionProvider, workService,
    inspectTaskWorktree, reclaimTaskWorktree, sendUnifiedSessionMessage,
    admitReliableMessage: sessionMessageOperation.admitReliableMessage,
    interruptUnifiedSession, cancelQueuedUserMessage, deleteUserMessage, respondUnifiedSessionApproval, respondUnifiedSessionUserInput,
    resolveCollaborationConfirmation, resolveSessionChannelRequest,
    publishStateChangesIfNeeded, workDiscussionService, sessionApplicationService,
    workSessionStartApplicationService, chatResourceService, decorateSessionForClient,
    readSessionUsage, setTaskArchivedForEntityRoutes, restartTaskForEntityRoutes,
    taskDeletionService, clearWorkAvatarFile, sessionBindingRepository, createTaskAndSession,
    getClientDeviceGateway: () => clientDeviceGateway,
    onReady: gateway => { clientDeviceGateway = gateway; }
  });
  scheduleBackendStartupMaintenance({
    store, taskDeletionService, trackStartupMaintenance, runProviderStartupMaintenance,
    knownActiveWorktrees, worktreeIntegrationJobService, reconcileEntityTasksAtStartup,
    reconcileWorkChatsAtStartup, scheduledSessionTaskService, runtimeActivity,
    tickAgentWorkQueue, emitEvent, artifactService, feishuGateway,
    skillRegistryService, legacySessionHistoryRepairService
  });
}

const {
  resumeSessionRecoveryAttemptsAtStartup, deleteHistoricalUnusableTaskSessionsAtStartup,
  recoverPendingWorkspaceTransitions
} = createStartupRecoveryOperations({
  store, sessionApplicationService, sessionRecoveryCoordinator,
  sessionBindingRepository, sessionProviderSwitchCoordinator,
  workspaceTransitionRuntimeForLogicalSession
});
const { runProviderStartupMaintenance } = createProviderStartupMaintenance({
  workSessionStartupCoordinator, projectToolsetInitializer,
  environmentName, bundledAgentMemoryPath, bundledCollaborationSkillPath,
  bundledProjectToolsetReferencePath, collaborationMcpServerPath,
  codexRuntime, openClackyManager, emptyCodexBindingPreflight,
  toolBootstrapBindingPreflight, setProviderRuntimeReadiness,
  collaborationCore, store, codexResetForecastMonitor,
  resumeSessionRecoveryAttemptsAtStartup, deleteHistoricalUnusableTaskSessionsAtStartup,
  recoverPendingWorkspaceTransitions, reconcileMovedWorkspaceRoutes, sessionRuntimeReleaseService
});

backendStoreReady = true;
emitEvent("BackendStoreReady", { ready: true, time: now() }, { recordSessionEvent: false });
startBackendRuntime();



const shutdownBackend = createBackendShutdown({
  backgroundAgentService, memoryExtractionScheduler, getClientDeviceGateway: () => clientDeviceGateway,
  taskSummaryService, turnObservability, runtimeActivity, mcpCleanupInterval, turnExecutionProbe,
  stateSyncPublisher, scheduledSessionTaskService,
  getResetForecastMonitor: () => codexResetForecastMonitor,
  openClackyManager, feishuGateway, codexRuntime, skillMcpGateway,
  runIsolationCoordinator, projectCodeFreshnessMonitor,
  closeTimelineReadPool, store, dataRootMigrationCoordinator,
  backendDataRootOwnership
});

function shutdown() {
  return shutdownBackend();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function activateStoredBackendLogging() {
  const configuredDirectory = store.logDirectory();
  const options = { mirrorToOriginalConsole: environmentName === "development" };
  configureBackendLogging(configuredDirectory, options);
}

function normalizeEnvironment(value = "") {
  const normalized = String(value || "").toLowerCase();
  return normalized === "dev" || normalized === "development" ? "development" : "production";
}
