import { SessionCapabilityRepository } from "./repositories/sessionCapabilityRepository.mjs";
import { RuntimeStateRepository } from "./repositories/runtimeStateRepository.mjs";
import { SessionAssociationRepository } from "./repositories/sessionAssociationRepository.mjs";
import { AssociationAuditRepository } from "./repositories/associationAuditRepository.mjs";
import { SessionMutationRepository } from "./repositories/sessionMutationRepository.mjs";
import { SessionReadRepository } from "./repositories/sessionReadRepository.mjs";
import { ProjectCodeReceiptRepository } from "./repositories/projectCodeReceiptRepository.mjs";
import { StateSyncRepository } from "./repositories/stateSyncRepository.mjs";
import { AgentRepository } from "./repositories/agentRepository.mjs";
import { TaskRepository } from "./repositories/taskRepository.mjs";
import { TaskCompletionRepository } from "./repositories/taskCompletionRepository.mjs";
import { TaskDeletionRepository } from "./repositories/taskDeletionRepository.mjs";
import { WorkRepository } from "./repositories/workRepository.mjs";
import { TimelineMutationRepository } from "./repositories/timelineMutationRepository.mjs";
import { SessionEventRepository } from "./repositories/sessionEventRepository.mjs";
import { SessionContextRepository } from "./repositories/sessionContextRepository.mjs";
import { TimelineReadRepository } from "./repositories/timelineReadRepository.mjs";
import { LegacyHistoryRepository } from "./repositories/legacyHistoryRepository.mjs";
import { SessionRouteRepository } from "./repositories/sessionRouteRepository.mjs";
import { WorkspaceTransitionRepository } from "./repositories/workspaceTransitionRepository.mjs";
import { SessionRecoveryRepository } from "./repositories/sessionRecoveryRepository.mjs";
import { MessageDeliveryRepository } from "./repositories/messageDeliveryRepository.mjs";
import { SessionToolCatalogRepository } from "./repositories/sessionToolCatalogRepository.mjs";
import { ProjectIntegrationRepository } from "./repositories/projectIntegrationRepository.mjs";
import { WorkspaceRepository } from "./repositories/workspaceRepository.mjs";
import { CollaborationDirectoryRepository } from "./repositories/collaborationDirectoryRepository.mjs";
import { HubRepository } from "./repositories/hubRepository.mjs";
import { MemorySkillRepository } from "./repositories/memorySkillRepository.mjs";
import { ProviderEventRepository } from "./repositories/providerEventRepository.mjs";
import { SkillRegistryRepository } from "./repositories/skillRegistryRepository.mjs";
import { AgentWorkQueueRepository } from "./repositories/agentWorkQueueRepository.mjs";
import { ArtifactRepository } from "./repositories/artifactRepository.mjs";
import { AutomationRepository } from "./repositories/automationRepository.mjs";
import { FeishuRepository } from "./repositories/feishuRepository.mjs";
import { toRawStatus } from "./storedSessionInput.mjs";
import { sessionProjectionSelectSQL, sessionPresentationTitle } from "./storedSessionProjection.mjs";

// Constructs repository instances only. No Store object, database lifecycle, or methods are copied.
// ports are live callbacks; bound retains the existing captured-callback behavior of older repositories.
export function createStoreRepositories({ getDatabase, getSshWorkspaces, environmentName, ports, bound }) {
    const sessionCapabilityRepository = new SessionCapabilityRepository({
      getDatabase: () => getDatabase(),
      selectOne: (...args) => ports.selectOne(...args),
      selectAll: (...args) => ports.selectAll(...args),
      getSession: (...args) => ports.getSession(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
    });
    const runtimeStateRepository = new RuntimeStateRepository({
      getDatabase: () => getDatabase(),
      selectOne: (...args) => ports.selectOne(...args),
    });
    const sessionAssociationRepository = new SessionAssociationRepository({
      getDatabase: () => getDatabase(),
      selectOne: (...args) => ports.selectOne(...args),
      selectAll: (...args) => ports.selectAll(...args),
      getSession: (...args) => ports.getSession(...args),
      getTask: (...args) => ports.getTask(...args),
      getWork: (...args) => ports.getWork(...args),
      getAgent: (...args) => ports.getAgent(...args),
      getProjectIntegrationRun: (...args) => ports.getProjectIntegrationRun(...args),
      getWorkChatSession: (...args) => ports.getWorkChatSession(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
    });
    const associationAuditRepository = new AssociationAuditRepository({
      getDatabase: () => getDatabase(),
      selectAll: (...args) => ports.selectAll(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args),
      listWorks: (...args) => ports.listWorks(...args),
      getWorkspace: (...args) => ports.getWorkspace(...args),
      getAgent: (...args) => ports.getAgent(...args),
      listTasks: (...args) => ports.listTasks(...args),
      getWork: (...args) => ports.getWork(...args),
    });
    const sessionMutationRepository = new SessionMutationRepository({
      getDatabase: () => getDatabase(),
      selectOne: (...args) => ports.selectOne(...args),
      selectAll: (...args) => ports.selectAll(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args),
      getSession: (...args) => ports.getSession(...args),
      listSessions: (...args) => ports.listSessions(...args),
      ensureSessionLog: (...args) => ports.ensureSessionLog(...args),
      assertSessionAssociation: (...args) => ports.assertSessionAssociation(...args),
      getLogicalSessionByLegacySessionId: (...args) => ports.getLogicalSessionByLegacySessionId(...args),
      getLogicalSession: (...args) => ports.getLogicalSession(...args),
    });
    const sessionReadRepository = new SessionReadRepository({
      getItems: (...args) => ports.getItems(...args),
      selectOne: (...args) => ports.selectOne(...args),
      selectAll: (...args) => ports.selectAll(...args)
    });
    const projectCodeReceiptRepository = new ProjectCodeReceiptRepository({
      getDatabase: () => getDatabase(),
      selectOne: (...args) => ports.selectOne(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
    });
    const stateSyncRepository = new StateSyncRepository({
      selectOne: (...args) => ports.selectOne(...args),
      selectAll: (...args) => ports.selectAll(...args),
    });
    const agentRepository = new AgentRepository({
      getDatabase: () => getDatabase(),
      environmentName,
      selectAll: (...args) => ports.selectAll(...args),
      selectOne: (...args) => ports.selectOne(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      getRegistrySkill: (...args) => ports.getRegistrySkill(...args),
      listRegistrySkillIdsForAgent: (...args) => ports.listRegistrySkillIdsForAgent(...args),
      recordSkillRuntimeEvent: (...args) => ports.recordSkillRuntimeEvent(...args),
    });
    const taskRepository = new TaskRepository({
      getDatabase: () => getDatabase(),
      selectOne: (...args) => ports.selectOne(...args),
      selectAll: (...args) => ports.selectAll(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      getWork: (...args) => ports.getWork(...args),
      getWorkspace: (...args) => ports.getWorkspace(...args),
      getGitRepositoryForWorkspace: (...args) => ports.getGitRepositoryForWorkspace(...args),
      listSessionsByTask: (...args) => ports.listSessionsByTask(...args),
      hasPendingScheduledWakeForTask: (...args) => ports.hasPendingScheduledWakeForTask(...args),
      recordRejectedTaskCompletionBypass: (...args) => ports.recordRejectedTaskCompletionBypass(...args),
      getSession: (...args) => ports.getSession(...args),
      getSessionEvent: (...args) => ports.getSessionEvent(...args),
      assertAssignableAgent: (...args) => ports.assertAssignableAgent(...args),
    });
    const taskCompletionRepository = new TaskCompletionRepository({
      getDatabase: () => getDatabase(),
      selectOne: (...args) => ports.selectOne(...args),
      selectAll: (...args) => ports.selectAll(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args),
      getTask: (...args) => ports.getTask(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args)
    });
    const taskDeletionRepository = new TaskDeletionRepository({
      getDatabase: () => getDatabase(),
      selectOne: (...args) => ports.selectOne(...args),
      selectAll: (...args) => ports.selectAll(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args),
      getTask: (...args) => ports.getTask(...args)
    });
    const workRepository = new WorkRepository({
      getDatabase: () => getDatabase(),
      selectAll: (...args) => ports.selectAll(...args),
      selectOne: (...args) => ports.selectOne(...args),
      assertAssignableAgent: (...args) => ports.assertAssignableAgent(...args),
      getWorkspace: (...args) => ports.getWorkspace(...args),
      createWorkspace: (...args) => ports.createWorkspace(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      listTasksByWork: (...args) => ports.listTasksByWork(...args)
    });
    const timelineMutationRepository = new TimelineMutationRepository({
      getDatabase: () => getDatabase(),
      normalizedSessionIdFilter,
      selectOne: (...args) => ports.selectOne(...args),
      selectAll: (...args) => ports.selectAll(...args),
      getSession: (...args) => ports.getSession(...args),
      getSessionItem: (...args) => ports.getSessionItem(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      notifyTimelineDirty: (...args) => ports.notifyTimelineDirty(...args)
    });
    const sessionEventRepository = new SessionEventRepository({
      getDatabase: () => getDatabase(),
      normalizedSessionIdFilter,
      selectOne: (...args) => ports.selectOne(...args),
      selectAll: (...args) => ports.selectAll(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      getSession: (...args) => ports.getSession(...args)
    });
    const sessionContextRepository = new SessionContextRepository({
      getDatabase: () => getDatabase(),
      selectAll: (...args) => ports.selectAll(...args),
      selectOne: (...args) => ports.selectOne(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args)
    });
    const timelineReadRepository = new TimelineReadRepository({
      selectAll: (...args) => ports.selectAll(...args),
      selectOne: (...args) => ports.selectOne(...args),
      getSession: (...args) => ports.getSession(...args)
    });
    const legacyHistoryRepository = new LegacyHistoryRepository({
      getDatabase: () => getDatabase(),
      selectAll: (...args) => ports.selectAll(...args),
      selectOne: (...args) => ports.selectOne(...args),
      rowToSession: (...args) => ports.rowToSession(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args),
      getSession: (...args) => ports.getSession(...args),
      upsertTimelineItemProjection: (...args) => ports.upsertTimelineItemProjection(...args),
      notifyTimelineDirty: (...args) => ports.notifyTimelineDirty(...args)
    });
    const sessionRouteRepository = new SessionRouteRepository({
      getDatabase: () => getDatabase(),
      sessionProjectionSelectSQL,
      sessionPresentationTitle,
      selectOne: (...args) => ports.selectOne(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      getSession: (...args) => ports.getSession(...args),
      selectAll: (...args) => ports.selectAll(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args),
      getGitWorktree: (...args) => ports.getGitWorktree(...args),
      getTask: (...args) => ports.getTask(...args)
    });
    const workspaceTransitionRepository = new WorkspaceTransitionRepository({
      getDatabase: () => getDatabase(),
      toRawStatus,
      getLogicalSession: (...args) => ports.getLogicalSession(...args),
      assertLogicalWorkSessionBinding: (...args) => ports.assertLogicalWorkSessionBinding(...args),
      selectOne: (...args) => ports.selectOne(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      getProviderThreadBinding: (...args) => ports.getProviderThreadBinding(...args),
      getSessionToolCatalogMaterialization: (...args) => ports.getSessionToolCatalogMaterialization(...args),
      insertAppliedSessionToolCatalogMaterialization: (...args) => ports.insertAppliedSessionToolCatalogMaterialization(...args),
      assertLogicalSessionRoute: (...args) => ports.assertLogicalSessionRoute(...args),
      selectAll: (...args) => ports.selectAll(...args)
    });
    const sessionRecoveryRepository = new SessionRecoveryRepository({
      getDatabase: () => getDatabase(),
      selectOne: (...args) => ports.selectOne(...args),
      selectAll: (...args) => ports.selectAll(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args),
      getLogicalSession: (...args) => ports.getLogicalSession(...args),
      getSession: (...args) => ports.getSession(...args),
      assertLogicalSessionRoute: (...args) => ports.assertLogicalSessionRoute(...args),
      assertLogicalWorkSessionBinding: (...args) => ports.assertLogicalWorkSessionBinding(...args),
      getSessionToolCatalogMaterialization: (...args) => ports.getSessionToolCatalogMaterialization(...args),
      listArtifactReferences: (...args) => ports.listArtifactReferences(...args),
      listSessionContextReferences: (...args) => ports.listSessionContextReferences(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      insertAppliedSessionToolCatalogMaterialization: (...args) => ports.insertAppliedSessionToolCatalogMaterialization(...args)
    });
    const messageDeliveryRepository = new MessageDeliveryRepository({
      getDatabase: () => getDatabase(),
      selectAll: (...args) => ports.selectAll(...args),
      selectOne: (...args) => ports.selectOne(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args),
      notifyTimelineDirty: (...args) => ports.notifyTimelineDirty(...args)
    });
    const sessionToolCatalogRepository = new SessionToolCatalogRepository({
      getDatabase: () => getDatabase(),
      selectAll: (...args) => ports.selectAll(...args),
      selectOne: (...args) => ports.selectOne(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args)
    });
    const projectIntegrationRepository = new ProjectIntegrationRepository({
      getDatabase: () => getDatabase(),
      selectAll: (...args) => ports.selectAll(...args),
      selectOne: (...args) => ports.selectOne(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      runInTransaction: (...args) => ports.runInTransaction(...args)
    });
    const workspaceRepository = new WorkspaceRepository({
      getDatabase: () => getDatabase(),
      selectAll: (...args) => ports.selectAll(...args),
      selectOne: (...args) => ports.selectOne(...args),
      scheduleSave: (...args) => ports.scheduleSave(...args),
      getSshWorkspaces: () => getSshWorkspaces()
    });
    const collaborationDirectoryRepository = new CollaborationDirectoryRepository({
      getDatabase: () => getDatabase(),
      selectAll: bound.selectAll,
      selectOne: bound.selectOne,
      scheduleSave: bound.scheduleSave
    });
    const hubRepository = new HubRepository({
      getDatabase: () => getDatabase(),
      selectAll: bound.selectAll,
      selectOne: bound.selectOne,
      scheduleSave: bound.scheduleSave
    });
    const memorySkillRepository = new MemorySkillRepository({
      getDatabase: () => getDatabase(),
      selectAll: bound.selectAll,
      selectOne: bound.selectOne,
      scheduleSave: bound.scheduleSave,
      getTask: bound.getTask,
      getSession: bound.getSession
    });
    const providerEventRepository = new ProviderEventRepository({
      getDatabase: () => getDatabase(),
      selectAll: bound.selectAll,
      selectOne: bound.selectOne
    });
    const skillRegistryRepository = new SkillRegistryRepository({
      getDatabase: () => getDatabase(),
      selectAll: bound.selectAll,
      selectOne: bound.selectOne,
      scheduleSave: bound.scheduleSave
    });
    const agentWorkQueueRepository = new AgentWorkQueueRepository({
      getDatabase: () => getDatabase(),
      selectAll: bound.selectAll,
      selectOne: bound.selectOne,
      scheduleSave: bound.scheduleSave
    });
    const artifactRepository = new ArtifactRepository({
      getDatabase: () => getDatabase(),
      selectAll: bound.selectAll,
      selectOne: bound.selectOne,
      scheduleSave: bound.scheduleSave
    });
    const automationRepository = new AutomationRepository({
      getDatabase: () => getDatabase(),
      selectAll: bound.selectAll,
      selectOne: bound.selectOne,
      runInTransaction: bound.runInTransaction,
      scheduleSave: bound.scheduleSave,
      environmentName
    });
    const feishuRepository = new FeishuRepository({
      getDatabase: () => getDatabase(),
      selectAll: bound.selectAll,
      selectOne: bound.selectOne,
      scheduleSave: bound.scheduleSave
    });
  return {
    sessionCapabilityRepository,
    runtimeStateRepository,
    sessionAssociationRepository,
    associationAuditRepository,
    sessionMutationRepository,
    sessionReadRepository,
    projectCodeReceiptRepository,
    stateSyncRepository,
    agentRepository,
    taskRepository,
    taskCompletionRepository,
    taskDeletionRepository,
    workRepository,
    timelineMutationRepository,
    sessionEventRepository,
    sessionContextRepository,
    timelineReadRepository,
    legacyHistoryRepository,
    sessionRouteRepository,
    workspaceTransitionRepository,
    sessionRecoveryRepository,
    messageDeliveryRepository,
    sessionToolCatalogRepository,
    projectIntegrationRepository,
    workspaceRepository,
    collaborationDirectoryRepository,
    hubRepository,
    memorySkillRepository,
    providerEventRepository,
    skillRegistryRepository,
    agentWorkQueueRepository,
    artifactRepository,
    automationRepository,
    feishuRepository
  };
}

function normalizedSessionIdFilter(sessionIds) {
  if (sessionIds == null) return null;
  const values = typeof sessionIds === "string" ? [sessionIds] : Array.from(sessionIds);
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}
