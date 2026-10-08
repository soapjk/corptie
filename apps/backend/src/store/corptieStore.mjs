import { initializeUnifiedSearch } from "./unifiedSearch.mjs";
import { randomUUID } from "node:crypto";
import { createStoreRepositories } from "./createStoreRepositories.mjs";
import { installStoreRepositoryDelegates } from "./storeRepositoryDelegates.mjs";
import { createUserMessageDelivery as commitUserMessageDelivery } from "./storeUserMessageDelivery.mjs";
import { migrateStoreDatabase } from "./migrations/migrateStoreDatabase.mjs";
import { StoreSettings } from "./storeSettings.mjs";
import { StoreDataLocation, environmentName } from "./storeDataLocation.mjs";
export { resolveRunIsolationStorePaths } from "./storeDataLocation.mjs";
import { ensureProjectCodeReceiptTables } from "./migrations/projectCodeMigrations.mjs";
export { normalizedStoredProviderCapabilities } from "./storedSessionProjection.mjs";
import { migrateTaskSummary } from "./taskSummaryRepository.mjs";
import { prepareStoreDatabaseDirectory, configureStoreDatabase, openWritableStoreDatabase } from "./storeDatabaseConnection.mjs";
import { NativeDatabase } from "./nativeDatabase.mjs";
import { StoreTransactionCoordinator } from "./storeTransactionCoordinator.mjs";
import {
  migrateSessionEventAgentMessageFlag, migrateCanonicalCompletionAgentMessageFlag
} from "./migrations/sessionUnreadMigrations.mjs";
import {
  reconcileInterruptedSessionExecutionAtStartup, repairRegressedTerminalSessionTurns
} from "./startupExecutionRepair.mjs";
import {
  migrateWorkspaceCreationRequestAuditReferences,
  migrateTaskMemoryAssociations,
  migrateSessionOwnedArtifacts
} from "./migrations/ownershipMigrations.mjs";
import {
  migrateCanonicalSessionNames,
  migrateCollaborationSessionIdentities,
  migrateSessionProviderBindings,
  migrateWorkspaceTransitionsForDirectoryTargets
} from "./migrations/sessionRoutingMigrations.mjs";
import {
  migrateSessionLogsForeignKey,
  backfillSessionItemPresentation,
  backfillSessionItemBindings,
  pruneHistoricalAutomationTimelineItems,
  migrateSessionRecoverySchema,
  migrateSessionItemIdentity
} from "./migrations/sessionHistoryMigrations.mjs";
import { ensureStateSyncTables } from "./migrations/stateSyncMigrations.mjs";
import { ensureProviderEventPipelineTables } from "./migrations/providerPipelineMigrations.mjs";
import { ensureSkillTables } from "./migrations/skillMigrations.mjs";
import { parseJson } from "./storedJson.mjs";
import {
  migrateScheduledSessionConditionTasks,
  migrateAutomationSchedulerV1,
  migrateScheduledSessionTaskReadIndexes,
  migrateAutomationExpirationV1,
  migrateAutomationCompletedStatusV1,
  migrateAutomationTitlesV1
} from "./migrations/automationMigrations.mjs";
import { createdAtFrom, createdAtFromOrNow } from "../utils/timestamps.mjs";
import {
  associationError
} from "../domain/workTaskValidation.mjs";
import { queryCallerSource } from "./queryObservability.mjs";
import { SshWorkspaceRepository } from "./sshWorkspaceRepository.mjs";
import { migrateSceneDomain } from "../scenes/sceneSchema.mjs";


export class CorptieStore {
  get explicitPaths() { return this.dataLocation.explicitPaths; }
  set explicitPaths(value) { this.dataLocation.explicitPaths = value; }
  get manageProcessEnvironment() { return this.dataLocation.manageProcessEnvironment; }
  set manageProcessEnvironment(value) { this.dataLocation.manageProcessEnvironment = value; }
  get dataRootExplicit() { return this.dataLocation.dataRootExplicit; }
  set dataRootExplicit(value) { this.dataLocation.dataRootExplicit = value; }
  get rootSelectionPath() { return this.dataLocation.rootSelectionPath; }
  set rootSelectionPath(value) { this.dataLocation.rootSelectionPath = value; }
  get configPath() { return this.dataLocation.configPath; }
  set configPath(value) { this.dataLocation.configPath = value; }
  get dataRoot() { return this.dataLocation.dataRoot; }
  set dataRoot(value) { this.dataLocation.dataRoot = value; }
  get layout() { return this.dataLocation.layout; }
  set layout(value) { this.dataLocation.layout = value; }
  get dataDir() { return this.dataLocation.dataDir; }
  set dataDir(value) { this.dataLocation.dataDir = value; }
  get dbPath() { return this.dataLocation.dbPath; }
  set dbPath(value) { this.dataLocation.dbPath = value; }
  get config() { return this.dataLocation.config; }
  set config(value) { this.dataLocation.config = value; }

  constructor(options = {}) {
    this.dataLocation = new StoreDataLocation(options);
    this.db = null;
    Object.assign(this, createStoreRepositories({
      getDatabase: () => this.db,
      getSshWorkspaces: () => this.sshWorkspaces,
      environmentName,
      ports: {
        selectOne: (...args) => this.selectOne(...args),
        selectAll: (...args) => this.selectAll(...args),
        getSession: (...args) => this.getSession(...args),
        scheduleSave: (...args) => this.scheduleSave(...args),
        getTask: (...args) => this.getTask(...args),
        getWork: (...args) => this.getWork(...args),
        getAgent: (...args) => this.getAgent(...args),
        getProjectIntegrationRun: (...args) => this.getProjectIntegrationRun(...args),
        getWorkChatSession: (...args) => this.getWorkChatSession(...args),
        runInTransaction: (...args) => this.runInTransaction(...args),
        listWorks: (...args) => this.listWorks(...args),
        getWorkspace: (...args) => this.getWorkspace(...args),
        listTasks: (...args) => this.listTasks(...args),
        listSessions: (...args) => this.listSessions(...args),
        ensureSessionLog: (...args) => this.ensureSessionLog(...args),
        assertSessionAssociation: (...args) => this.assertSessionAssociation(...args),
        getLogicalSessionByLegacySessionId: (...args) => this.getLogicalSessionByLegacySessionId(...args),
        getLogicalSession: (...args) => this.getLogicalSession(...args),
        getItems: (...args) => this.getItems(...args),
        getRegistrySkill: (...args) => this.getRegistrySkill(...args),
        listRegistrySkillIdsForAgent: (...args) => this.listRegistrySkillIdsForAgent(...args),
        recordSkillRuntimeEvent: (...args) => this.recordSkillRuntimeEvent(...args),
        getGitRepositoryForWorkspace: (...args) => this.getGitRepositoryForWorkspace(...args),
        listSessionsByTask: (...args) => this.listSessionsByTask(...args),
        hasPendingScheduledWakeForTask: (...args) => this.hasPendingScheduledWakeForTask(...args),
        recordRejectedTaskCompletionBypass: (...args) => this.recordRejectedTaskCompletionBypass(...args),
        getSessionEvent: (...args) => this.getSessionEvent(...args),
        assertAssignableAgent: (...args) => this.assertAssignableAgent(...args),
        createWorkspace: (...args) => this.createWorkspace(...args),
        listTasksByWork: (...args) => this.listTasksByWork(...args),
        getSessionItem: (...args) => this.getSessionItem(...args),
        notifyTimelineDirty: (...args) => this.notifyTimelineDirty(...args),
        rowToSession: (...args) => this.rowToSession(...args),
        upsertTimelineItemProjection: (...args) => this.upsertTimelineItemProjection(...args),
        getGitWorktree: (...args) => this.getGitWorktree(...args),
        assertLogicalWorkSessionBinding: (...args) => this.assertLogicalWorkSessionBinding(...args),
        getProviderThreadBinding: (...args) => this.getProviderThreadBinding(...args),
        getSessionToolCatalogMaterialization: (...args) => this.getSessionToolCatalogMaterialization(...args),
        insertAppliedSessionToolCatalogMaterialization: (...args) => this.#insertAppliedSessionToolCatalogMaterialization(...args),
        assertLogicalSessionRoute: (...args) => this.assertLogicalSessionRoute(...args),
        listArtifactReferences: (...args) => this.listArtifactReferences(...args),
        listSessionContextReferences: (...args) => this.listSessionContextReferences(...args)
      },
      bound: {
        selectAll: this.selectAll.bind(this),
        selectOne: this.selectOne.bind(this),
        scheduleSave: this.scheduleSave.bind(this),
        getTask: this.getTask.bind(this),
        getSession: this.getSession.bind(this),
        runInTransaction: this.runInTransaction.bind(this)
      }
    }));
    this.config = {};
    this.storeSettings = new StoreSettings({
      getConfiguration: () => this.config,
      getDataRoot: () => this.dataRoot,
      writeConfig: () => this.writeConfig(),
      environmentName
    });
    this.transactions = new StoreTransactionCoordinator({
      readDatabase: () => this.db,
      sessionTimelineRevision: (sessionId) => this.sessionTimelineRevision(sessionId)
    });
    this.migrationInProgress = false;
    this.canonicalUnreadMigrationAudit = null;
  }

  async initialize(options = {}) {
    if (options.resolveDataPath !== false) await this.resolveDataPath();
    if (!this.dbPath) throw new Error("Store data path must be resolved before initialization.");
    const readOnly = options.readOnly === true;
    if (!readOnly) await prepareStoreDatabaseDirectory(this.dbPath, options);
    this.db = new NativeDatabase(this.dbPath, { readOnly });
    try {
      configureStoreDatabase(this.db, options);
      if (!readOnly && options.performMigrations !== false) {
        this.migrate();
        initializeUnifiedSearch(this);
      }
    } catch (error) {
      this.db.close();
      this.db = null;
      throw error;
    }
  }

  reconcileInterruptedSessionExecutionAtStartup(timestamp = new Date().toISOString()) {
    return reconcileInterruptedSessionExecutionAtStartup({
      selectOne: (...args) => this.selectOne(...args),
      runInTransaction: (...args) => this.runInTransaction(...args),
      db: this.db,
      scheduleSave: (...args) => this.scheduleSave(...args)
    }, timestamp);
  }

  async resolveDataPath() {
    return this.dataLocation.resolveDataPath();
  }

  async readRootSelectionAndLegacyConfig() {
    return this.dataLocation.readRootSelectionAndLegacyConfig();
  }

  async migrateLegacyPaths(config) {
    return this.dataLocation.migrateLegacyPaths(config);
  }

  async writeConfig() {
    return this.dataLocation.writeConfig();
  }

  async writeRootSelection() {
    return this.dataLocation.writeRootSelection();
  }

  settings() {
    return this.storeSettings.settings();
  }

  choiceParserSettings() {
    return this.storeSettings.choiceParserSettings();
  }

  codexBackendSettings() {
    return this.storeSettings.codexBackendSettings();
  }

  codeDiffSettings() {
    return this.storeSettings.codeDiffSettings();
  }

  agentProxySettings() {
    return this.storeSettings.agentProxySettings();
  }

  newSessionDefaults() {
    return this.storeSettings.newSessionDefaults();
  }

  gatewaySettings() {
    return this.storeSettings.gatewaySettings();
  }

  logDirectory() {
    return this.dataLocation.logDirectory();
  }

  logPaths() {
    return this.dataLocation.logPaths();
  }

  async updateSettings(input = {}) {
    return this.storeSettings.updateSettings(input);
  }

  openDatabase(path) {
    return openWritableStoreDatabase(path);
  }

  // 事件溯源层（session_logs/session_events）的 session_id 是独立游标键，
  // 不依赖 sessions 元数据（feishu/遥测场景的 sessionId 非真实 sessions 记录）。
  // 历史库中的 session_logs 曾误挂 FOREIGN KEY → 重建以移除。
  migrateSessionLogsForeignKey() {
    return migrateSessionLogsForeignKey({
      selectOne: (...args) => this.selectOne(...args),
      db: this.db
    });
  }

  // Presentation semantics are part of the product Timeline contract. Older
  // rows retained the Provider phase only inside audited raw metadata; perform
  // a one-time Corptie-local reprojection without consulting Provider history.
  backfillSessionItemPresentation() {
    return backfillSessionItemPresentation({
      runDataMigrationOnce: (...args) => this.runDataMigrationOnce(...args),
      db: this.db
    });
  }

  backfillSessionItemBindings() {
    return backfillSessionItemBindings({
      runDataMigrationOnce: (...args) => this.runDataMigrationOnce(...args),
      db: this.db
    });
  }

  pruneHistoricalAutomationTimelineItems() {
    return pruneHistoricalAutomationTimelineItems({
      runDataMigrationOnce: (...args) => this.runDataMigrationOnce(...args),
      db: this.db
    });
  }

  migrateSessionRecoverySchema() {
    return migrateSessionRecoverySchema({
      ensureColumn: (...args) => this.ensureColumn(...args),
      db: this.db
    });
  }

  runDataMigrationOnce(migrationId, operation) {
    if (this.selectOne(
      "SELECT migration_id FROM data_migrations WHERE migration_id = ?",
      [migrationId]
    )) return false;
    this.runInTransaction(() => {
      operation();
      this.db.run(
        "INSERT INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
        [migrationId, createdAtFromOrNow()]
      );
    });
    return true;
  }

  // Provider item ids are scoped to one Provider Session. Codex histories in
  // particular commonly contain ids such as `item-1`; a database-wide primary
  // key makes background hydration move those rows between unrelated Sessions.
  migrateSessionItemIdentity() {
    return migrateSessionItemIdentity({
      selectAll: (...args) => this.selectAll(...args),
      db: this.db
    });
  }

  migrateWorkspaceCreationRequestAuditReferences() {
    return migrateWorkspaceCreationRequestAuditReferences({
      selectOne: (...args) => this.selectOne(...args),
      selectAll: (...args) => this.selectAll(...args),
      db: this.db
    });
  }

  migrateScheduledSessionConditionTasks() {
    return migrateScheduledSessionConditionTasks({
      ensureColumn: this.ensureColumn.bind(this),
      selectOne: this.selectOne.bind(this),
      db: this.db
    });
  }

  migrateAutomationSchedulerV1() {
    return migrateAutomationSchedulerV1({
      ensureColumn: this.ensureColumn.bind(this),
      db: this.db
    });
  }

  migrateScheduledSessionTaskReadIndexes() {
    return migrateScheduledSessionTaskReadIndexes({
      db: this.db
    });
  }

  migrateAutomationExpirationV1() {
    return migrateAutomationExpirationV1({
      selectOne: this.selectOne.bind(this),
      db: this.db
    });
  }

  migrateAutomationCompletedStatusV1() {
    return migrateAutomationCompletedStatusV1({
      selectOne: this.selectOne.bind(this),
      db: this.db
    });
  }

  migrateAutomationTitlesV1() {
    return migrateAutomationTitlesV1({
      selectOne: this.selectOne.bind(this),
      runInTransaction: this.runInTransaction.bind(this),
      db: this.db
    });
  }

  migrateTaskMemoryAssociations() {
    return migrateTaskMemoryAssociations({
      selectOne: (...args) => this.selectOne(...args),
      runInTransaction: (...args) => this.runInTransaction(...args),
      db: this.db
    });
  }

  migrate() {
    return migrateStoreDatabase({
      db: this.db,
      selectAll: (...args) => this.selectAll(...args),
      selectOne: (...args) => this.selectOne(...args),
      ensureColumn: (...args) => this.ensureColumn(...args),
      runDataMigrationOnce: (...args) => this.runDataMigrationOnce(...args),
      dropColumnIfExists: (...args) => this.dropColumnIfExists(...args),
      steps: {
        migrateSessionLogsForeignKey: (...args) => this.migrateSessionLogsForeignKey(...args),
        migrateWorkspaceCreationRequestAuditReferences: (...args) => this.migrateWorkspaceCreationRequestAuditReferences(...args),
        migrateScheduledSessionConditionTasks: (...args) => this.migrateScheduledSessionConditionTasks(...args),
        migrateAutomationSchedulerV1: (...args) => this.migrateAutomationSchedulerV1(...args),
        migrateAutomationExpirationV1: (...args) => this.migrateAutomationExpirationV1(...args),
        migrateAutomationCompletedStatusV1: (...args) => this.migrateAutomationCompletedStatusV1(...args),
        migrateScheduledSessionTaskReadIndexes: (...args) => this.migrateScheduledSessionTaskReadIndexes(...args),
        migrateAutomationTitlesV1: (...args) => this.migrateAutomationTitlesV1(...args),
        migrateCanonicalSessionNames: (...args) => this.migrateCanonicalSessionNames(...args),
        migrateCollaborationSessionIdentities: (...args) => this.migrateCollaborationSessionIdentities(...args),
        migrateSessionRecoverySchema: (...args) => this.migrateSessionRecoverySchema(...args),
        migrateSessionProviderBindings: (...args) => this.migrateSessionProviderBindings(...args),
        migrateWorkspaceTransitionsForDirectoryTargets: (...args) => this.migrateWorkspaceTransitionsForDirectoryTargets(...args),
        backfillSessionItemPresentation: (...args) => this.backfillSessionItemPresentation(...args),
        backfillSessionItemBindings: (...args) => this.backfillSessionItemBindings(...args),
        migrateSessionItemIdentity: (...args) => this.migrateSessionItemIdentity(...args),
        pruneHistoricalAutomationTimelineItems: (...args) => this.pruneHistoricalAutomationTimelineItems(...args),
        migrateSessionEventAgentMessageFlag: (...args) => this.migrateSessionEventAgentMessageFlag(...args),
        migrateCanonicalCompletionAgentMessageFlag: (...args) => this.migrateCanonicalCompletionAgentMessageFlag(...args),
        migrateTaskMemoryAssociations: (...args) => this.migrateTaskMemoryAssociations(...args),
        initializeSortOrder: (...args) => this.initializeSortOrder(...args),
        migrateAgentAvailability: (...args) => this.migrateAgentAvailability(...args),
        migrateSessionOwnedArtifacts: (...args) => this.migrateSessionOwnedArtifacts(...args),
        ensureProjectCodeReceiptTables: (...args) => this.ensureProjectCodeReceiptTables(...args),
        ensureSkillTables: (...args) => this.ensureSkillTables(...args),
        ensureStateSyncTables: (...args) => this.ensureStateSyncTables(...args),
        ensureProviderEventPipelineTables: (...args) => this.ensureProviderEventPipelineTables(...args),
        repairRegressedTerminalSessionTurns: (...args) => this.repairRegressedTerminalSessionTurns(...args),
        ensureAssistantAgent: (...args) => this.ensureAssistantAgent(...args),
        migrateSceneDomain: () => migrateSceneDomain(this),
        migrateTaskSummary: () => migrateTaskSummary(this)
      }
    });
  }

  ensureProjectCodeReceiptTables() {
    return ensureProjectCodeReceiptTables({ db: this.db });
  }

  putProjectCodeReceipt(input) {
    return this.projectCodeReceiptRepository.putProjectCodeReceipt(input);
  }

  getProjectCodeReceipt(receiptId, logicalSessionId) {
    return this.projectCodeReceiptRepository.getProjectCodeReceipt(receiptId, logicalSessionId);
  }

  getLatestProjectCodeSnapshot(logicalSessionId) {
    return this.projectCodeReceiptRepository.getLatestProjectCodeSnapshot(logicalSessionId);
  }

  getProjectCodeReceiptById(receiptId) {
    return this.projectCodeReceiptRepository.getProjectCodeReceiptById(receiptId);
  }

  // Durable control-plane revision log. SQLite triggers make every mutation to
  // a client-visible entity participate in the same transaction as the entity
  // write, including writes performed by background/provider callbacks. The
  // transport may coalesce several row revisions into one ChangeSet, but it
  // can never acknowledge a revision whose entity write did not commit.
  ensureStateSyncTables() {
    return ensureStateSyncTables({
      db: this.db
    });
  }
  ensureProviderEventPipelineTables() {
    return ensureProviderEventPipelineTables({
      db: this.db,
      ensureColumn: this.ensureColumn.bind(this)
    });
  }
  repairRegressedTerminalSessionTurns() {
    return repairRegressedTerminalSessionTurns({
      selectAll: (...args) => this.selectAll(...args),
      selectOne: (...args) => this.selectOne(...args),
      db: this.db,
      listUnsettledSessionTurns: (...args) => this.listUnsettledSessionTurns(...args)
    });
  }

  migrateSessionOwnedArtifacts() {
    return migrateSessionOwnedArtifacts({
      selectAll: (...args) => this.selectAll(...args),
      db: this.db,
      selectOne: (...args) => this.selectOne(...args)
    });
  }

  migrateSessionEventAgentMessageFlag() {
    return migrateSessionEventAgentMessageFlag({
      db: this.db,
      selectOne: (...args) => this.selectOne(...args),
      runInTransaction: (...args) => this.runInTransaction(...args)
    });
  }

  migrateCanonicalCompletionAgentMessageFlag() {
    return migrateCanonicalCompletionAgentMessageFlag({
      db: this.db,
      selectOne: (...args) => this.selectOne(...args),
      runDataMigrationOnce: (...args) => this.runDataMigrationOnce(...args),
      recordAudit: (audit) => { this.canonicalUnreadMigrationAudit = audit; }
    });
  }

  stateRevision() {
    return this.stateSyncRepository.stateRevision();
  }

  stateChangesAfter(revision) {
    return this.stateSyncRepository.stateChangesAfter(revision);
  }

  oldestStateChangeRevision() {
    return this.stateSyncRepository.oldestStateChangeRevision();
  }

  stateConsistencyIssues() {
    return this.stateSyncRepository.stateConsistencyIssues();
  }

  // 建立 Skill 维护中心（全局映射表）与 Agent↔Skill 多对多关联。
  // skill_registry：记录所有成功安装过的 Skill（本地目录 / GitHub 仓库克隆缓存），
  //         只维护「指向具体 Skill 位置」的映射，全局共享。
  // agent_skill_links：每个 Agent 启用哪些 Skill 的元数据（启用≠复制，安装物化在运行时目录）。
  // 「Skill 维护中心」使用独立的表名（skill_registry / agent_skill_links），
  // 与旧「晋升技能」的 skills 表彻底分离，避免 schema 与方法名冲突。
  ensureSkillTables() {
    return ensureSkillTables({
      db: this.db,
      selectOne: this.selectOne.bind(this),
      selectAll: this.selectAll.bind(this),
      ensureColumn: this.ensureColumn.bind(this)
    });
  }
  migrateCanonicalSessionNames() {
    return migrateCanonicalSessionNames({
      selectAll: (...args) => this.selectAll(...args),
      db: this.db
    });
  }

  migrateCollaborationSessionIdentities() {
    return migrateCollaborationSessionIdentities({
      db: this.db
    });
  }

  async save() {
    this.db.checkpoint();
  }

  scheduleSave() { return this.transactions.scheduleSave(); }
  setStateDirtyListener(listener) { return this.transactions.setStateDirtyListener(listener); }
  setTimelineDirtyListener(listener) { return this.transactions.setTimelineDirtyListener(listener); }
  notifyTimelineDirty(sessionId) { return this.transactions.notifyTimelineDirty(sessionId); }
  runInTransaction(operation) { return this.transactions.runInTransaction(operation); }
  flushCommittedDirtyNotifications() { return this.transactions.flushCommittedDirtyNotifications(); }

  async close(options = {}) {
    if (!this.db) return;
    if (options.checkpoint !== false) await this.save();
    this.db.close();
    this.db = null;
  }

  get sshWorkspaces() {
    return new SshWorkspaceRepository(this);
  }

  #insertAppliedSessionToolCatalogMaterialization(input, expected = {}) {
    return this.sessionToolCatalogRepository.insertAppliedSessionToolCatalogMaterialization(input, expected);
  }

  upsertSession(session) {
    return this.sessionMutationRepository.upsertSession(session);
  }

  // 将已有 Session 归属到某个 Task（及其 Work），只更新归属两列，不覆盖其它字段。
  bindSessionToTask(sessionId, taskId, workId) {
    return this.sessionAssociationRepository.bindSessionToTask(sessionId, taskId, workId);
  }

  assertSessionAssociation(input) {
    return this.sessionAssociationRepository.assertSessionAssociation(input);
  }

  sessionAssociationIssues() {
    return this.sessionAssociationRepository.sessionAssociationIssues();
  }

  listUnusableReplacedTaskSessionIds() {
    return this.sessionAssociationRepository.listUnusableReplacedTaskSessionIds();
  }

  finalizeConflictResolutionLaunch(input) {
    return this.sessionAssociationRepository.finalizeConflictResolutionLaunch(input);
  }

  bindSessionToWork(sessionId, workId) {
    return this.sessionAssociationRepository.bindSessionToWork(sessionId, workId);
  }

  setSessionKind(sessionId, sessionKind, agentId = null) {
    return this.sessionAssociationRepository.setSessionKind(sessionId, sessionKind, agentId);
  }

  createSessionContextReference(input = {}) {
    return this.sessionContextRepository.createSessionContextReference(input);
  }

  getSessionContextReference(referenceId) {
    return this.sessionContextRepository.getSessionContextReference(referenceId);
  }

  listSessionContextReferences(ownerSessionId) {
    return this.sessionContextRepository.listSessionContextReferences(ownerSessionId);
  }

  updateSessionContextReference(referenceId, patch = {}) {
    return this.sessionContextRepository.updateSessionContextReference(referenceId, patch);
  }

  deleteSessionContextReference(referenceId) {
    return this.sessionContextRepository.deleteSessionContextReference(referenceId);
  }

  // 创建 Session 记录（绑定 task + agent；1:1 更新 task.current_session_id）。
  createSession(input = {}) {
    return this.sessionMutationRepository.createSession(input);
  }

  // 关闭 Session（置终态 completed）。
  closeSession(id) {
    return this.sessionMutationRepository.closeSession(id);
  }

  listSessions(options = {}) {
    return this.sessionReadRepository.listSessions(options);
  }

  readContextConversationPage(sessionId, options = {}) {
    return this.timelineReadRepository.readContextConversationPage(sessionId, options);
  }

  readContextMessageChunk(sessionId, itemId, offset = 0, length = 2000) {
    return this.timelineReadRepository.readContextMessageChunk(sessionId, itemId, offset, length);
  }

  listSessionTitleIdentities() {
    return this.sessionReadRepository.listSessionTitleIdentities();
  }

  listSessionPage(options = {}) {
    return this.sessionReadRepository.listSessionPage(options);
  }

  getSession(id) {
    return this.sessionReadRepository.getSession(id);
  }

  listSessionsByTask(taskId) {
    return this.sessionReadRepository.listSessionsByTask(taskId);
  }

  listSessionsByWork(workId) {
    return this.sessionReadRepository.listSessionsByWork(workId);
  }

  getWorkChatSession(workId) {
    return this.sessionReadRepository.getWorkChatSession(workId);
  }

  listSessionsByAgent(agentId) {
    return this.sessionReadRepository.listSessionsByAgent(agentId);
  }

  getDetail(id, options = {}) {
    return this.sessionReadRepository.getDetail(id, options);
  }

  archiveSession(id, archived = true) {
    return this.sessionMutationRepository.archiveSession(id, archived);
  }

  listArchivedSessionsPendingRuntimeRelease(options = {}) {
    return this.sessionReadRepository.listArchivedSessionsPendingRuntimeRelease(options);
  }

  markSessionRuntimeReleased(sessionId, reason = "archived", releasedAt = new Date().toISOString()) {
    return this.sessionMutationRepository.markSessionRuntimeReleased(sessionId, reason, releasedAt);
  }

  clearSessionRuntimeReleaseReceipt(sessionId) {
    return this.sessionMutationRepository.clearSessionRuntimeReleaseReceipt(sessionId);
  }

  pinSession(id, pinned = true) {
    return this.sessionMutationRepository.pinSession(id, pinned);
  }

  reorderSessions(sessionIds = []) {
    return this.sessionMutationRepository.reorderSessions(sessionIds);
  }

  renameSession(id, title) {
    return this.sessionMutationRepository.renameSession(id, title);
  }

  setActiveChoicePrompt(sessionId, prompt = "", options = []) {
    return this.sessionMutationRepository.setActiveChoicePrompt(sessionId, prompt, options);
  }

  clearActiveChoicePrompt(sessionId) {
    return this.sessionMutationRepository.clearActiveChoicePrompt(sessionId);
  }

  deleteSession(id) {
    return this.sessionMutationRepository.deleteSession(id);
  }

  listEmptyActiveProviderBindings(providerId) {
    return this.sessionReadRepository.listEmptyActiveProviderBindings(providerId);
  }

  /// Wake the revisioned Session projection when a runtime-only dependency
  /// changes without rewriting conversation ordering timestamps. The legacy
  /// column name predates its broader projection-dependency role.
  touchSessionProjectionDependency(sessionId) {
    return this.sessionMutationRepository.touchSessionProjectionDependency(sessionId);
  }

  claimDispatchingMessageDeliveryForProviderTurn(
    sessionId,
    bindingId,
    providerTurnId,
    acknowledgedAt = createdAtFromOrNow()
  ) {
    return this.messageDeliveryRepository.claimDispatchingMessageDeliveryForProviderTurn(sessionId, bindingId, providerTurnId, acknowledgedAt);
  }

  createUserMessageDelivery(input) {
    return commitUserMessageDelivery(this, input);
  }
  assertAssignableAgent(agentId, field) {
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw associationError(
        "AGENT_NOT_FOUND", field, "existing assignable Agent ID", agentId,
        `Agent not found: ${agentId}`
      );
    }
    if (agent.status !== "available") {
      throw associationError(
        "AGENT_NOT_ASSIGNABLE", field, "available Agent ID", agentId,
        `Agent is not assignable: ${agentId}`
      );
    }
    return agent;
  }

  selectAll(sql, params = []) {
    return this.db.all(sql, params, queryCallerSource());
  }

  selectOne(sql, params = []) {
    return this.db.get(sql, params, queryCallerSource());
  }

  iterate(sql, params = []) {
    return this.db.iterate(sql, params, queryCallerSource());
  }

  queryMetrics(options = {}) {
    return this.db.queryMetrics(options);
  }

  resetEventLoopDelayMetrics() {
    this.db.resetEventLoopDelayMetrics();
  }

  ensureColumn(table, column, definition) {
    const columns = this.selectAll(`PRAGMA table_info(${table})`);
    if (columns.some((entry) => entry.name === column)) {
      return;
    }
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  dropColumnIfExists(table, column) {
    const columns = this.selectAll(`PRAGMA table_info(${table})`);
    if (!columns.some((entry) => entry.name === column)) {
      return;
    }
    this.db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }

  migrateSessionProviderBindings() {
    return migrateSessionProviderBindings({
      db: this.db
    });
  }

  migrateWorkspaceTransitionsForDirectoryTargets() {
    return migrateWorkspaceTransitionsForDirectoryTargets({
      selectAll: (...args) => this.selectAll(...args),
      db: this.db
    });
  }

  initializeSortOrder() {
    return this.sessionMutationRepository.initializeSortOrder();
  }

  nextTopSortOrder(archived = false) {
    return this.sessionMutationRepository.nextTopSortOrder(archived);
  }

  rowToSession(row) {
    return this.sessionReadRepository.rowToSession(row);
  }

}

installStoreRepositoryDelegates(CorptieStore);
