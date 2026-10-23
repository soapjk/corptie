// Creation is a staged operation across database and Provider boundaries.
// Failed/pending rows are recovery evidence, not published Tasks.
export function migrateTaskCreationState({ db, ensureColumn, runDataMigrationOnce }) {
  ensureColumn("tasks", "creation_state", "TEXT NOT NULL DEFAULT 'ready'");
  ensureColumn("tasks", "creation_error_code", "TEXT");
  db.run(`CREATE TRIGGER IF NOT EXISTS task_creation_publish_parent AFTER UPDATE OF creation_state ON tasks
    WHEN NEW.parent_task_id IS NOT NULL AND NEW.creation_state <> OLD.creation_state
    BEGIN UPDATE tasks SET hierarchy_revision=hierarchy_revision+1 WHERE id=NEW.parent_task_id; END`);
  // A failed, unbound staging row is audit evidence, not a published child.
  // Pending children and any child that still owns a Session continue to block
  // retirement. Physical deletion/foreign-key guards remain unchanged.
  runDataMigrationOnce("task-creation-retirement-v1", () => db.run(`
    DROP TRIGGER IF EXISTS task_hierarchy_retire_guard;
    CREATE TRIGGER task_hierarchy_retire_guard BEFORE UPDATE OF deletion_status ON tasks
      WHEN NEW.deletion_status='deleted' AND (
        (OLD.parent_task_id IS NOT NULL AND (OLD.creation_state<>'failed' OR OLD.current_session_id IS NOT NULL))
        OR EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=OLD.id
          AND COALESCE(c.deletion_status,'')<>'deleted'
          AND (c.creation_state<>'failed' OR c.current_session_id IS NOT NULL)))
      BEGIN SELECT RAISE(ABORT, 'TASK_HIERARCHY_DEPENDENCY'); END;`));
  // Classify only proven failures from the canonical creation workflow. Do not
  // infer failure for historical manually-created Tasks or tasks with Sessions.
  runDataMigrationOnce("task-creation-state-v1", () => db.run(`UPDATE tasks SET creation_state='failed', creation_error_code=(
    SELECT error_code FROM work_session_startup_operations op WHERE op.task_id=tasks.id
      AND op.state IN ('failed_compensated','failed_manual_cleanup') ORDER BY op.allocated_at DESC LIMIT 1)
    WHERE creation_state='ready' AND current_session_id IS NULL AND creation_intent_fingerprint IS NOT NULL
      AND EXISTS (SELECT 1 FROM work_session_startup_operations op WHERE op.task_id=tasks.id
        AND op.state IN ('failed_compensated','failed_manual_cleanup'))
      AND NOT EXISTS (SELECT 1 FROM work_session_startup_operations op WHERE op.task_id=tasks.id
        AND op.state IN ('allocated','worktree_prepared','session_bound','provider_bound','compensating','ready'))`));
}
