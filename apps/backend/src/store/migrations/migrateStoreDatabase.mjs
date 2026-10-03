import { migrateTaskProjectionColumns, migrateTaskCreationOrigins, migrateTaskLifecycleGuards } from "./taskEvolutionMigrations.mjs";
import { migrateArtifactTaxonomy } from "./artifactTaxonomyMigrations.mjs";
import { migrateStartupOperations } from "./startupOperationMigrations.mjs";
import { migrateCollaborationProtocol } from "./collaborationProtocolMigrations.mjs";
import { migrateSessionEventStorage } from "./sessionEventEvolutionMigrations.mjs";
import { ensureMemoryFoundationTables, quarantineLegacyExtractionNoise,
  quarantinePreModelExtractionCandidates } from "./memoryFoundationMigrations.mjs";
import { ensureCollaborationDirectoryTables } from "./collaborationDirectoryMigrations.mjs";
import { ensureHubFoundationTables } from "./hubFoundationMigrations.mjs";
import { migrateSessionAssociationGuards } from "./sessionAssociationMigrations.mjs";
import { sessionRuntimeSchemaSql, workDomainSchemaSql } from "./index.mjs";
import { migrateTaskDomainV1, migrateTaskGoalRemovalV1 } from "../taskSchemaMigration.mjs";
import { migrateSshWorkspaces } from "../sshWorkspaceRepository.mjs";

// Ordered schema/data upgrade composition. Store retains connection and transaction ownership.
// Steps are explicit migration capabilities, not the Store object.
export function migrateStoreDatabase({ db, selectAll, selectOne, ensureColumn, runDataMigrationOnce, dropColumnIfExists, steps }) {
    db.run("PRAGMA foreign_keys = ON");
    const existingWorkColumns = selectAll("PRAGMA table_info(works)");
    if (existingWorkColumns.length > 0
      && (
        !existingWorkColumns.some((column) => column.name === "workspace_id")
        || existingWorkColumns.some((column) => column.name === "contributor_agent_ids_json")
        || selectAll("PRAGMA table_info(tasks)").some((column) => column.name === "main_workspace_id")
      )) {
      const error = new Error(
        "WORK_DOMAIN_RESET_REQUIRED: this database predates the normalized Work schema and must be reset explicitly."
      );
      error.code = "WORK_DOMAIN_RESET_REQUIRED";
      throw error;
    }
    migrateTaskDomainV1(db);
    steps.migrateSceneDomain();
    steps.migrateSessionLogsForeignKey();
    const hadSessionReadReceipts = Boolean(selectOne(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_read_receipts'"
    ));
    db.run(sessionRuntimeSchemaSql);

    // --- 实体层：Work / Task / 依赖 DAG（净新增，见 15 Phase 1） ---
    db.run(workDomainSchemaSql);
    ensureColumn("worktree_integration_jobs", "fingerprint_version", "INTEGER");
    ensureColumn("worktree_integration_jobs", "idempotency_key", "TEXT");
    ensureColumn("worktree_integration_jobs", "start_request_fingerprint", "TEXT");
    ensureColumn("worktree_integration_jobs", "start_request_fingerprint_version", "INTEGER");
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_integration_jobs_idempotency
      ON worktree_integration_jobs(repository_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL`);
    const duplicateActiveExecutions = selectAll(
      `SELECT repository_id, COUNT(*) AS active_count, GROUP_CONCAT(id) AS job_ids
       FROM worktree_integration_jobs
       WHERE status IN ('queued', 'running', 'paused', 'cancellation_requested', 'replanning')
       GROUP BY repository_id HAVING COUNT(*) > 1`
    );
    if (duplicateActiveExecutions.length > 0) {
      const summary = duplicateActiveExecutions.map((row) =>
        `${row.repository_id}: ${row.active_count} active jobs (${row.job_ids})`).join("; ");
      const error = new Error(
        `WORKTREE_INTEGRATION_ACTIVE_ROWS_CONFLICT: resolve duplicate active Worktree integration jobs before migration: ${summary}`
      );
      error.code = "WORKTREE_INTEGRATION_ACTIVE_ROWS_CONFLICT";
      throw error;
    }
    runDataMigrationOnce("worktree-integration-active-index-v1", () => {
      db.run("DROP INDEX IF EXISTS idx_worktree_integration_jobs_active");
      db.run(`CREATE UNIQUE INDEX idx_worktree_integration_jobs_active
        ON worktree_integration_jobs(repository_id)
        WHERE status IN ('queued', 'running', 'paused', 'cancellation_requested', 'replanning')`);
    });
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_integration_jobs_active
      ON worktree_integration_jobs(repository_id)
      WHERE status IN ('queued', 'running', 'paused', 'cancellation_requested', 'replanning')`);

    ensureMemoryFoundationTables({ db: db });
    quarantineLegacyExtractionNoise({ db, selectAll, runDataMigrationOnce });
    quarantinePreModelExtractionCandidates({ db, selectAll, runDataMigrationOnce });

    ensureCollaborationDirectoryTables({ db: db });

    migrateSshWorkspaces(db);
    steps.migrateWorkspaceCreationRequestAuditReferences();
    steps.migrateScheduledSessionConditionTasks();
    steps.migrateAutomationSchedulerV1();
    steps.migrateAutomationExpirationV1();
    steps.migrateAutomationCompletedStatusV1();
    steps.migrateScheduledSessionTaskReadIndexes();
    steps.migrateAutomationTitlesV1();

    ensureHubFoundationTables({ db: db });

    ensureColumn("sessions", "work_id", "TEXT");
    ensureColumn("sessions", "task_id", "TEXT");
    ensureColumn("sessions", "session_kind", "TEXT NOT NULL DEFAULT 'legacy'");
    ensureColumn("sessions", "agent_id", "TEXT");
    db.run("DROP INDEX IF EXISTS idx_agent_sessions_current_agent");
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_active_pair
      ON agent_sessions(agent_id, session_id) WHERE unbound_at IS NULL`);
    // Legacy compatibility column. Agent role no longer participates in product behavior.
    ensureColumn("agents", "role", "TEXT NOT NULL DEFAULT 'agent'");
    ensureColumn("agents", "agent_kind", "TEXT NOT NULL DEFAULT 'user'");
    ensureColumn("agents", "system_prompt", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("agents", "work_dir", "TEXT");
    ensureColumn("agents", "avatar_path", "TEXT");
    migrateTaskGoalRemovalV1(db);
    ensureColumn(
      "agent_operations",
      "channel_delivery_id",
      "TEXT REFERENCES session_collaboration_deliveries(delivery_id) ON DELETE CASCADE"
    );
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_operations_channel_delivery
      ON agent_operations(channel_delivery_id) WHERE channel_delivery_id IS NOT NULL`);
    migrateTaskProjectionColumns({
      ensureColumn: (...args) => ensureColumn(...args),
      db: db,
      migrateTaskSummary: () => steps.migrateTaskSummary()
    });
    migrateArtifactTaxonomy({
      ensureColumn: (...args) => ensureColumn(...args),
      runDataMigrationOnce: (...args) => runDataMigrationOnce(...args),
      db: db
    });
    migrateTaskCreationOrigins({
      runDataMigrationOnce: (...args) => runDataMigrationOnce(...args),
      db: db
    });
    migrateStartupOperations({
      ensureColumn: (...args) => ensureColumn(...args),
      selectAll: (...args) => selectAll(...args),
      db: db,
      runDataMigrationOnce: (...args) => runDataMigrationOnce(...args),
      dropColumnIfExists: (...args) => dropColumnIfExists(...args)
    });
    migrateTaskLifecycleGuards({
      db: db
    });
    ensureColumn("collaborator_registry", "role", "TEXT NOT NULL DEFAULT 'agent'");
    ensureColumn("hub_intent_cache", "agent_id", "TEXT");
    ensureColumn("sessions", "archived", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("sessions", "archive_dependency_version", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("sessions", "pinned", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("sessions", "sort_order", "REAL");
    ensureColumn("sessions", "active_choice_json", "TEXT");
    // Session is the durable actor identity and its event stream is retained
    // for audit. Deletion therefore tombstones the actor instead of removing
    // the parent row out from under historical session_events.
    ensureColumn("sessions", "deleted_at", "TEXT");
    // Session identity belongs to its Agent. Remove the retired per-session
    // avatar columns without touching agents.avatar_path.
    dropColumnIfExists("sessions", "avatar_path");
    dropColumnIfExists("logical_sessions", "avatar_path");
    ensureColumn("logical_sessions", "session_name", "TEXT");
    ensureColumn("logical_sessions", "session_name_key", "TEXT");
    // Logical Session routing is also an audit identity. Startup and recovery
    // receipts may retain RESTRICT references after the live Session is gone,
    // so deletion tombstones the route instead of removing that identity.
    ensureColumn("logical_sessions", "deleted_at", "TEXT");
    migrateCollaborationProtocol({
      ensureColumn: (...args) => ensureColumn(...args),
      db: db,
      migrateCanonicalSessionNames: (...args) => steps.migrateCanonicalSessionNames(...args),
      migrateCollaborationSessionIdentities: (...args) => steps.migrateCollaborationSessionIdentities(...args)
    });
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_logical_sessions_session_name
      ON logical_sessions(session_name_key) WHERE session_name_key IS NOT NULL`);
    ensureColumn("provider_thread_bindings", "routing_version", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn("provider_thread_bindings", "binding_id", "TEXT");
    ensureColumn("provider_thread_bindings", "provider_id", "TEXT");
    ensureColumn("provider_thread_bindings", "provider_session_id", "TEXT");
    ensureColumn("provider_thread_bindings", "parent_binding_id", "TEXT");
    ensureColumn("provider_thread_bindings", "provider_metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    steps.migrateSessionRecoverySchema();
    steps.migrateSessionProviderBindings();
    steps.migrateWorkspaceTransitionsForDirectoryTargets();
    ensureColumn("workspace_transitions", "resume_goal_after_transition", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("workspace_transitions", "continuation_prompt", "TEXT");
    ensureColumn("workspace_transitions", "continuation_state", "TEXT NOT NULL DEFAULT 'none'");
    ensureColumn("workspace_transitions", "continuation_turn_id", "TEXT");
    ensureColumn("workspace_transitions", "handoff_turn_id", "TEXT");
    ensureColumn("workspace_transitions", "tool_confirmation_json", "TEXT");
    migrateSessionAssociationGuards({
      db: db,
      runDataMigrationOnce: (...args) => runDataMigrationOnce(...args)
    });
    ensureColumn("workspace_transitions", "continuation_error", "TEXT");
    ensureColumn("workspace_transitions", "transition_kind", "TEXT NOT NULL DEFAULT 'workspace'");
    ensureColumn("workspace_transitions", "target_provider_id", "TEXT");
    ensureColumn("session_items", "options_json", "TEXT");
    ensureColumn("session_items", "raw_metadata_json", "TEXT");
    ensureColumn("session_items", "binding_id", "TEXT");
    ensureColumn("session_items", "presentation_role", "TEXT");
    ensureColumn("session_items", "presentation_text", "TEXT");
    steps.backfillSessionItemPresentation();
    steps.backfillSessionItemBindings();
    steps.migrateSessionItemIdentity();
    steps.pruneHistoricalAutomationTimelineItems();
    ensureColumn("feishu_bindings", "chat_id", "TEXT");
    ensureColumn("feishu_bots", "app_id", "TEXT");
    ensureColumn("feishu_bots", "brand", "TEXT NOT NULL DEFAULT 'feishu'");
    ensureColumn("feishu_bots", "managed_profile", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("feishu_bots", "remote_name", "TEXT");
    ensureColumn("feishu_bots", "remote_avatar_url", "TEXT");
    ensureColumn("feishu_bots", "remote_open_id", "TEXT");
    ensureColumn("feishu_bots", "remote_activate_status", "INTEGER");
    ensureColumn("feishu_session_assignments", "delivery_initialized", "INTEGER NOT NULL DEFAULT 0");
    migrateSessionEventStorage({
      ensureColumn: (...args) => ensureColumn(...args),
      migrateSessionEventAgentMessageFlag: (...args) => steps.migrateSessionEventAgentMessageFlag(...args),
      db: db,
      migrateCanonicalCompletionAgentMessageFlag: (...args) => steps.migrateCanonicalCompletionAgentMessageFlag(...args),
      runDataMigrationOnce: (...args) => runDataMigrationOnce(...args),
      hadSessionReadReceipts
    });
    // --- 三层记忆（13）：乐观应用/撤销语义字段 ---
    ensureColumn("memories", "auto_applied", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("memories", "applied_at", "TEXT");
    ensureColumn("memories", "revoked_at", "TEXT");
    ensureColumn("memories", "task_id", "TEXT REFERENCES tasks(id) ON DELETE CASCADE");
    ensureColumn("memories", "source_event_sequence", "INTEGER");
    ensureColumn("memories", "trust_level", "TEXT NOT NULL DEFAULT 'untrusted'");
    ensureColumn("memories", "expires_at", "TEXT");
    ensureColumn("memories", "replaces_memory_id", "TEXT");
    steps.migrateTaskMemoryAssociations();
    steps.initializeSortOrder();
    steps.migrateAgentAvailability();
    steps.migrateSessionOwnedArtifacts();
    steps.ensureProjectCodeReceiptTables();
    steps.ensureSkillTables();
    steps.ensureStateSyncTables();
    steps.ensureProviderEventPipelineTables();
    steps.repairRegressedTerminalSessionTurns();
    dropColumnIfExists("agents", "provider");
    steps.ensureAssistantAgent();
    db.run("DROP INDEX IF EXISTS idx_agents_assistant_work_dir");
    db.run("UPDATE agents SET role = 'agent' WHERE role IS NOT 'agent'");
    // Preserve existing trusted platform Sessions without keeping authorization on Agent.
    db.run(`INSERT OR IGNORE INTO session_capability_grants (
        session_id, capability, granted_at, granted_by_session_id, revoked_at
      )
      SELECT sessions.id, 'platform.manage',
             COALESCE(sessions.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
             NULL, NULL
      FROM sessions
      JOIN agents ON agents.agent_id = sessions.agent_id
      WHERE agents.agent_kind = 'platformAssistant'
        AND sessions.session_kind = 'assistantChat'
        AND sessions.deleted_at IS NULL`);
    db.run("CREATE INDEX IF NOT EXISTS idx_sessions_archived_order ON sessions(archived, pinned DESC, sort_order ASC)");
    // Agent identity owns shared configuration and memory, not an execution slot.
    // Sessions are the concurrency boundary: each Session remains serial while
    // different Sessions bound to the same Agent may run independently.
    db.run("DROP INDEX IF EXISTS idx_agent_operations_one_running");
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_operations_one_running_per_session
      ON agent_operations(session_id) WHERE status = 'running'`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_agent_operations_session_next
      ON agent_operations(session_id, status, priority DESC, created_at ASC)`);

    db.run(
      `UPDATE collaboration_requests
       SET status = 'completed',
           completed_at = COALESCE(
             completed_at,
             (SELECT MAX(m.created_at) FROM collaboration_messages m
              WHERE m.task_id = collaboration_requests.task_id
                AND m.sender_agent_id = collaboration_requests.recipient_agent_id
                AND m.message_type = 'question')
           ),
           updated_at = COALESCE(
             (SELECT MAX(m.created_at) FROM collaboration_messages m
              WHERE m.task_id = collaboration_requests.task_id
                AND m.sender_agent_id = collaboration_requests.recipient_agent_id
                AND m.message_type = 'question'),
             updated_at
           )
       WHERE type = 'question'
         AND status IN ('accepted', 'working')
         AND EXISTS (
           SELECT 1 FROM collaboration_messages m
           WHERE m.task_id = collaboration_requests.task_id
             AND m.sender_agent_id = collaboration_requests.recipient_agent_id
             AND m.message_type = 'question'
         )`
    );
}
