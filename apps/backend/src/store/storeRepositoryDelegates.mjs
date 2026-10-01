// CorptieStore is the stable public Store API. These entries preserve its
// methods while keeping repository-owned operations beside their repositories.
const foundationalDelegates = Object.freeze({
  skillRegistryRepository: [
    "listRegistrySkills", "getRegistrySkill", "createRegistrySkill", "updateRegistrySkill",
    "deleteRegistrySkill", "registrySkillDeletionImpact", "createSkillDeletionOperation",
    "updateSkillDeletionOperation", "getSkillDeletionOperation", "listRegistrySkillIdsForAgent",
    "listRegistrySkillsForAgent", "recordSkillRuntimeEvent", "getSkillRuntimeEvent",
    "listSkillRuntimeEvents"
  ],
  agentRepository: [
    "createAgentWithRegistrySkills", "createAgentWithRegistrySkillsIdempotently",
    "updateAgentWithRegistrySkills", "setAgentRegistrySkills"
  ],
  workspaceRepository: [
    "upsertGitWorkspaceSnapshot", "listGitRepositories", "createWorkspace",
    "listWorkspaces", "getWorkspace", "presentWorkspace", "getGitRepositoryForWorkspace",
    "resolveWorkspaceRoot", "getGitRepository", "resolveWorkspacePath",
    "listGitWorktrees", "listAllGitWorktrees", "getGitWorktree"
  ],
  sessionRouteRepository: [
    "createLogicalSessionRoute", "getLogicalSession", "getLogicalSessionByLegacySessionId",
    "getLogicalSessionByName", "findLogicalSessionsByName",
    "getLogicalSessionByProviderThreadId", "getLogicalSessionByProviderSessionId",
    "deleteLogicalSessionByLegacySessionId", "listLogicalSessionsByWorkspaceId",
    "rebindActiveWorkspacePath", "getProviderThreadBinding",
    "getAgentSessionBinding", "getAgentSessionBindingByProviderSession",
    "listProviderThreadBindings", "listActiveProviderSessionIds",
    "hasUnsettledSessionRuntimeWork", "recordProviderThreadBinding",
    "assertLogicalSessionRoute", "retireLogicalSessionWorkspace",
    "restoreLogicalSessionWorkspace", "assertLogicalWorkSessionBinding"
  ],
  sessionToolCatalogRepository: [
    "getSessionToolCatalogMaterialization", "listSessionToolCatalogMaterializations",
    "writeSessionToolCatalogDesired",
    "beginSessionToolCatalogRefresh", "applySessionToolCatalogReceipt",
    "failSessionToolCatalogRefresh", "invalidateSessionToolCatalogAppliedProof",
    "markSessionToolCatalogRecoveryRequired", "adoptCompatibleSessionToolCatalogDefinition",
    "recordSessionToolCatalogPendingReceipt", "cancelSessionToolCatalogMaterialization"
  ],
  sessionRecoveryRepository: [
    "getSessionRecoveryAttempt", "getSessionRecoveryAttemptByIdempotency",
    "listSessionRecoveryAttempts", "listResumableSessionRecoveryAttempts",
    "freezeSessionRecoveryAttempt", "claimSessionRecoveryBoundary",
    "retryUnstartedSessionRecoveryAttempt", "listSessionEventsThrough",
    "listSessionRecoveryEventSample", "saveSessionRecoveryManifest",
    "recordSessionRecoveryReplacement", "replaceSessionRecoveryReplacement",
    "requestSessionRecoveryCancellation", "cancelSessionRecoveryAttempt",
    "failSessionRecoveryAttempt", "commitSessionRecoveryBinding",
    "listSessionRecoveryBindingAudit"
  ],
  workspaceTransitionRepository: [
    "beginWorkspaceTransition", "updateWorkspaceTransition", "commitWorkspaceTransition",
    "getWorkspaceTransition", "getPendingWorkspaceTransition",
    "getLatestCommittedWorkspaceTransition", "listWorkspaceTransitionsAwaitingContinuation",
    "updateWorkspaceTransitionContinuation", "listPendingWorkspaceTransitions"
  ],
  sessionCapabilityRepository: [
    "grantSessionCapability", "revokeSessionCapability", "sessionHasCapability",
    "listSessionCapabilities"
  ],
  // Timeline item upserts only project events already committed by ingestion.
  timelineMutationRepository: [
    "upsertTimelineItemProjection", "getExecutionPlanState", "upsertExecutionPlanState",
    "removeItem", "clearItems", "getQueuedItems",
    "listSessionTimelineRevisions", "sessionTimelineRevision", "sessionTimelineChangesAfter"
  ],
  legacyHistoryRepository: [
    "listLegacyHistoryRepairCandidates", "getLegacyHistoryRepair",
    "recordLegacyHistoryRepair", "importLegacyHistoryRepair", "rollbackLegacyHistoryRepair"
  ],
  automationRepository: [
    "createScheduledSessionTask", "getScheduledSessionTask", "listScheduledSessionTasks",
    "listTaskIdsWithPendingScheduledWake", "hasPendingScheduledWakeForTask",
    "listSessionIdsWithPendingScheduledWake", "updateScheduledSessionTask",
    "claimDueScheduledSessionTasks", "listExpiredActiveScheduledSessionTasks",
    "createScheduledSessionRun", "getScheduledSessionRun", "getScheduledSessionRunByKey",
    "getScheduledSessionRunForAgentTask", "listScheduledSessionRuns",
    "listScheduledSessionRunsForTasks", "countActiveScheduledSessionRuns",
    "countPendingScheduledSessionRunsForLogicalSession", "listExpiredScheduledSessionRuns",
    "updateScheduledSessionRun", "recordScheduledSessionEvent", "listScheduledSessionEvents"
  ],
  agentWorkQueueRepository: [
    "enqueueAgentTask", "enqueueAgentTaskWithResult", "getAgentTask",
    "getAgentTaskForDelivery", "getAgentTaskForTurn",
    "claimRunningAgentTaskForProviderTurn", "getRunningAgentTaskForSession",
    "getRunningAgentTask", "listAgentTasksForSession", "listQueuedAgentTasks",
    "listQueuedAgentTasksForSession", "listAgentIdsWithQueuedWork",
    "listAgentIdsWithUnsettledWork", "listSessionIdsWithUnsettledAgentWork",
    "claimAgentTask", "updateAgentTask"
  ],
  timelineReadRepository: [
    "getItems", "getItemsForTurn", "getFileChangeItemsForTurn",
    "latestTimelineRowsWithConversationBoundaries", "getTimelineItemWindow",
    "getSessionTimelineHistoryPage", "getLatestTimelineItemWindow",
    "listStoredTimelineEvents", "getSessionItem"
  ],
  runtimeStateRepository: ["getRuntimeState", "setRuntimeState"],
  sessionEventRepository: [
    "hasSessionEvent", "appendSessionEvent", "ensureSessionLog", "listSessionEvents",
    "listSessionAutomationEvents", "listSessionEventPage",
    "listLatestSessionMessageTimes", "listSessionMessageCursors",
    "lastAgentMessageSequence", "markSessionMessagesRead", "lastSessionEventSequence"
  ],
  providerEventRepository: [
    "providerInboxEvent", "insertProviderInboxEvent", "markProviderInboxEvent",
    "providerBindingCursor", "markProviderBindingCursorDegraded",
    "upsertProviderBindingCursor", "upsertSessionTurn", "getSessionTurn",
    "hasSessionTurnForBinding", "upsertSessionUsageSnapshot",
    "getSessionUsageSnapshot", "listUnsettledSessionTurns",
    "latestCompletedSessionTurn", "enqueueEventOutbox",
    "listPendingEventOutbox", "markEventOutboxPublished"
  ],
  messageDeliveryRepository: [
    "getMessageDelivery", "getMessageDeliveryForMessage",
    "getMessageDeliveryForProviderTurn", "updateMessageDelivery",
    "rerouteUnsentMessageDelivery"
  ],
  feishuRepository: [
    "listFeishuBots", "getFeishuBot", "createFeishuBot", "updateFeishuBot",
    "deleteFeishuBot", "replaceFeishuPairingCode", "consumeFeishuPairingCode",
    "getFeishuBinding", "listFeishuBindings", "updateFeishuBindingChat",
    "claimFeishuInboundEvent", "revokeFeishuBinding", "getFeishuAssignmentForBot",
    "getFeishuAssignmentForSession", "listFeishuAssignments",
    "initializeFeishuDelivery", "markFeishuItemDelivered",
    "assignFeishuSession", "releaseFeishuSession", "updateFeishuAssignmentCursor"
  ]
});

const domainDelegates = Object.freeze({
  timelineReadRepository: [
    "getItemsForBinding"
  ],
  agentRepository: [
    "listAgents", "getAgent", "ensureAssistantAgent",
    "migrateAgentAvailability", "createAgent", "updateAgent",
    "deleteAgent"
  ],
  associationAuditRepository: [
    "auditWorkTaskAssociations", "recordAssociationAudit", "listWorkTaskAssociationAudit"
  ],
  workRepository: [
    "createWork", "listWorks", "listClientWorkPage",
    "getWork", "listWorkContributors", "replaceWorkContributors",
    "updateWork", "deleteWork", "assertWorkAssociations"
  ],
  taskRepository: [
    "createTask", "getTaskCreationOrigin", "listTasks",
    "listTasksByWork", "listTaskPage", "getTask",
    "getTaskWorkspaceContext", "getTaskBySessionId", "setTaskArchived",
    "updateTask", "getTaskSnapshot", "listTaskSnapshots",
    "reviseTask", "assertTaskAssociations", "addTaskDependency",
    "removeTaskDependency", "listTaskDependencies", "listTaskDependents"
  ],
  artifactRepository: [
    "createArtifactMetadata", "getArtifact", "listArtifacts",
    "listArtifactsByWork", "countArtifactsByWork", "listArtifactsReferencedByTask",
    "countArtifactsReferencedByTask", "listArtifactVersionsByArtifactIds", "listArtifactReferencesByArtifactIds",
    "listArtifactAuditByArtifactIds", "updateArtifact", "upsertArtifactSearchDocument",
    "searchArtifactDocuments", "createArtifactVersion", "getArtifactVersion",
    "listArtifactVersions", "createArtifactReference", "getArtifactWorkerCreateOperation",
    "createArtifactWorkerCreateOperation", "getArtifactWorkerPublishOperation", "createArtifactWorkerPublishOperation",
    "getArtifactReference", "listArtifactReferences", "createTaskFileReference",
    "getTaskFileReference", "listTaskFileReferences", "updateArtifactReference",
    "appendArtifactAudit", "listArtifactAudit", "createArtifactContentOperation",
    "updateArtifactContentOperation", "listIncompleteArtifactContentOperations", "recordArtifactUsage",
    "getArtifactTurnReadUsage", "reserveArtifactTurnRead", "adjustArtifactTurnReadReservation",
    "createArtifactReadReceipt", "getArtifactReadReceipt", "hasArtifactTextReadBoundary",
    "reconcileArtifactTurnReadUsage", "appendArtifactStorageAudit", "listArtifactStorageAudit"
  ],
  projectIntegrationRepository: [
    "createProjectIntegrationRun", "getProjectIntegrationRun", "listProjectIntegrationRuns",
    "getLatestProjectIntegrationRun", "updateProjectIntegrationRun", "updateProjectIntegrationItem",
    "createWorktreeIntegrationJob", "createWorktreeIntegrationJobIdempotently",
    "getWorktreeIntegrationJob", "getWorktreeIntegrationJobByIdempotencyKey", "listWorktreeIntegrationJobs",
    "getLatestWorktreeIntegrationJob", "listRecoverableWorktreeIntegrationJobs", "updateWorktreeIntegrationJob"
  ],
  sessionEventRepository: [
    "getSessionEventByIdentity", "getSessionEvent"
  ],
  taskCompletionRepository: [
    "createTaskCompletionIntent", "getTaskCompletionIntent", "getTaskCompletionIntentByTokenHash",
    "getTaskCompletionIntentByRequest", "getTaskCompletionOperationByIdempotency", "getTaskCompletionOperation",
    "listTaskCompletionOperations", "recordRejectedTaskCompletion", "recordRejectedTaskCompletionBypass",
    "completeTaskWithAuthorization"
  ],
  taskDeletionRepository: [
    "deleteTask", "markTaskDeletion", "beginTaskDeletionOperation",
    "getTaskDeletionOperation", "getTaskDeletionOperationByKey", "listRecoverableTaskDeletionOperations",
    "updateTaskDeletionOperation", "markTaskWorktreeRemoved", "listTaskDeletionBlockingAssociations",
    "finalizeTaskDeletion"
  ],
  memorySkillRepository: [
    "createMemory", "getMemory", "listMemoriesByOwner",
    "getMemoryBySourceEvent", "getMemoryRememberOperation", "createMemoryRememberOperation",
    "validateMemoryAssociation", "listMemoriesByKind", "listAllMemories",
    "listMemoryPage", "updateMemory", "deleteMemory",
    "createMemoryAudit", "getMemoryAudit", "listMemoryAudit",
    "rollbackMemoryAudit", "createMemoryRecallAudit", "listMemoryRecallAudit",
    "decayMemories", "touchMemory", "applyConfidenceDecay",
    "listPromotionCandidates", "promoteMemoryToSkill", "createSkill",
    "getSkill", "listSkillsByAgent", "listDiscoverableSkills",
    "updateSkillStatus", "setMemoryEmbedding", "getMemoryEmbedding",
    "listMemoryEmbeddings", "deleteMemoryEmbedding"
  ],
  collaborationDirectoryRepository: [
    "upsertCollaborator", "getCollaborator", "listCollaborators",
    "removeCollaborator", "createCollaborationSession", "getCollaborationSession",
    "updateCollaborationSession", "upsertReputation", "getReputation",
    "countActiveCollaborations"
  ],
  hubRepository: [
    "cacheHubIntent", "getHubIntentCache", "registerActiveTool",
    "listActiveTools"
  ]
});

export const storeRepositoryDelegateMap = Object.freeze(Object.fromEntries(
  [...new Set([...Object.keys(foundationalDelegates), ...Object.keys(domainDelegates)])]
    .map((key) => [key, Object.freeze([
      ...(foundationalDelegates[key] ?? []), ...(domainDelegates[key] ?? [])
    ])])
));

export function installStoreRepositoryDelegates(StoreClass) {
  const seen = new Set();
  for (const [repositoryKey, methods] of Object.entries(storeRepositoryDelegateMap)) {
    for (const method of methods) {
      if (seen.has(method) || method in StoreClass.prototype) {
        throw new Error(`Duplicate CorptieStore repository delegate: ${method}`);
      }
      seen.add(method);
      Object.defineProperty(StoreClass.prototype, method, {
        configurable: true,
        writable: true,
        value: function (...args) {
          return this[repositoryKey][method](...args);
        }
      });
    }
  }
}
