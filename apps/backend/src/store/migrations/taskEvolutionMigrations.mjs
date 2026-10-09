export function migrateTaskProjectionColumns({ ensureColumn, db, migrateTaskSummary }) {
    ensureColumn("tasks", "current_session_id", "TEXT");
    ensureColumn("tasks", "acceptance_criteria", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("tasks", "verification_criteria", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("tasks", "lifecycle_state", "TEXT NOT NULL DEFAULT 'todo'");
    ensureColumn("tasks", "auto_title_enabled", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn("tasks", "current_snapshot_id", "TEXT");
    ensureColumn("tasks", "revision", "INTEGER NOT NULL DEFAULT 1");
    migrateTaskSummary();
    ensureColumn("tasks", "execution_status", "TEXT NOT NULL DEFAULT 'idle'");
    ensureColumn("tasks", "acceptance_assessment_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("tasks", "created_by_session_id", "TEXT");
    ensureColumn("tasks", "source_task_id", "TEXT");
    ensureColumn("tasks", "parent_task_id", "TEXT");
    ensureColumn("tasks", "collaboration_relation", "TEXT");
    ensureColumn("tasks", "idempotency_key", "TEXT");
    ensureColumn("tasks", "creation_reference_fingerprint", "TEXT");
    ensureColumn("tasks", "resource_version", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn("tasks", "canceled_at", "TEXT");
    ensureColumn("tasks", "archived", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("tasks", "cancel_reason", "TEXT");
    ensureColumn("tasks", "deletion_status", "TEXT");
    db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_browse_page
      ON tasks(
        CASE WHEN lifecycle_state = 'done' THEN 1 ELSE 0 END,
        updated_at DESC,
        id DESC
      )
      WHERE COALESCE(deletion_status, '') <> 'deleted'`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_work_browse_page
      ON tasks(
        work_id,
        CASE WHEN lifecycle_state = 'done' THEN 1 ELSE 0 END,
        updated_at DESC,
        id DESC
      )
      WHERE COALESCE(deletion_status, '') <> 'deleted'`);
    ensureColumn("tasks", "deletion_error", "TEXT");
    ensureColumn("tasks", "deletion_worktree_removed_at", "TEXT");
    ensureColumn("tasks", "completion_operation_id", "TEXT");
    ensureColumn("tasks", "completion_source_type", "TEXT");
    ensureColumn("tasks", "cancellation_operation_id", "TEXT");
    db.run(`CREATE TRIGGER IF NOT EXISTS task_snapshots_immutable_update
      BEFORE UPDATE ON task_snapshots BEGIN SELECT RAISE(ABORT, 'TASK_SNAPSHOT_IMMUTABLE'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS task_snapshots_immutable_delete
      BEFORE DELETE ON task_snapshots BEGIN SELECT RAISE(ABORT, 'TASK_SNAPSHOT_IMMUTABLE'); END`);
}

export function migrateTaskCreationOrigins({ runDataMigrationOnce, db }) {
    runDataMigrationOnce("task-creation-origins-v1", () => {
      db.run(
        `INSERT OR IGNORE INTO task_creation_origins (
           task_id, origin_type, creator_session_id, creation_context_task_id,
           creation_context_message_id, operation_id, created_at
         )
         SELECT id,
           CASE WHEN created_by_session_id IS NOT NULL THEN 'session' ELSE 'legacy_unattributed' END,
           created_by_session_id,
           CASE WHEN created_by_session_id IS NOT NULL THEN source_task_id ELSE NULL END,
           NULL,
           idempotency_key,
           created_at
         FROM tasks`
      );
    });
}

export function migrateTaskLifecycleGuards({ db }) {
    db.run(`CREATE TRIGGER IF NOT EXISTS task_completion_guard
      BEFORE UPDATE OF lifecycle_state ON tasks
      WHEN NEW.lifecycle_state = 'done'
       AND OLD.lifecycle_state <> 'done'
       AND NOT EXISTS (
         SELECT 1 FROM task_completion_authorizations authorization
         WHERE authorization.operation_id = NEW.completion_operation_id
           AND authorization.task_id = NEW.id
           AND authorization.work_id = NEW.work_id
       )
      BEGIN
        SELECT RAISE(ABORT, 'TASK_COMPLETION_INTENT_REQUIRED');
      END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS task_completion_audit_immutable_update
      BEFORE UPDATE ON task_completion_operations
      BEGIN SELECT RAISE(ABORT, 'TASK_COMPLETION_AUDIT_IMMUTABLE'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS task_completion_audit_immutable_delete
      BEFORE DELETE ON task_completion_operations
      BEGIN SELECT RAISE(ABORT, 'TASK_COMPLETION_AUDIT_IMMUTABLE'); END`);
    db.run("DROP TRIGGER IF EXISTS task_cancellation_guard");
    db.run("DROP TRIGGER IF EXISTS task_canceled_insert_guard");
    db.run(`CREATE TRIGGER IF NOT EXISTS task_lifecycle_state_insert_guard
      BEFORE INSERT ON tasks WHEN NEW.lifecycle_state NOT IN ('todo', 'in_progress', 'done')
      BEGIN SELECT RAISE(ABORT, 'TASK_LIFECYCLE_STATE_INVALID'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS task_lifecycle_state_update_guard
      BEFORE UPDATE OF lifecycle_state ON tasks WHEN NEW.lifecycle_state NOT IN ('todo', 'in_progress', 'done')
      BEGIN SELECT RAISE(ABORT, 'TASK_LIFECYCLE_STATE_INVALID'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS task_cancellation_audit_immutable_update
      BEFORE UPDATE ON task_cancellation_operations
      BEGIN SELECT RAISE(ABORT, 'TASK_CANCELLATION_AUDIT_IMMUTABLE'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS task_cancellation_audit_immutable_delete
      BEFORE DELETE ON task_cancellation_operations
      BEGIN SELECT RAISE(ABORT, 'TASK_CANCELLATION_AUDIT_IMMUTABLE'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS task_status_repair_audit_immutable_update
      BEFORE UPDATE ON task_status_repair_audit
      BEGIN SELECT RAISE(ABORT, 'TASK_STATUS_REPAIR_AUDIT_IMMUTABLE'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS task_status_repair_audit_immutable_delete
      BEFORE DELETE ON task_status_repair_audit
      BEGIN SELECT RAISE(ABORT, 'TASK_STATUS_REPAIR_AUDIT_IMMUTABLE'); END`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_session_idempotency
      ON tasks(created_by_session_id, idempotency_key)
      WHERE created_by_session_id IS NOT NULL AND idempotency_key IS NOT NULL`);
}
