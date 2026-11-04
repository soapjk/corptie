export function migrateTaskCoordination({ db, ensureColumn }) {
  ensureColumn("tasks", "coordination_enabled", "INTEGER NOT NULL DEFAULT 0");
  db.run(`CREATE TABLE IF NOT EXISTS task_coordination_dispatches (
    dispatch_id TEXT PRIMARY KEY, source_session_id TEXT NOT NULL, parent_task_id TEXT NOT NULL,
    source_role_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_json TEXT NOT NULL,
    runtime_json TEXT NOT NULL, mode_at_admission INTEGER NOT NULL,
    target_task_id TEXT, mailbox_message_id TEXT, operation_id TEXT,
    status TEXT NOT NULL DEFAULT 'accepted', error_code TEXT, error_message TEXT,
    report_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(source_session_id,idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS task_coordination_parent ON task_coordination_dispatches(parent_task_id,created_at);
  CREATE INDEX IF NOT EXISTS task_coordination_operation ON task_coordination_dispatches(operation_id) WHERE operation_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS task_coordination_pending ON task_coordination_dispatches(status,report_message_id);`);
  ensureColumn("task_coordination_dispatches", "report_generation", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("task_coordination_dispatches", "progress_batch_id", "TEXT");
  ensureColumn("task_coordination_dispatches", "source_turn_id", "TEXT");
  db.run(`CREATE TABLE IF NOT EXISTS coordination_progress_batches (
    batch_id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, source_session_id TEXT NOT NULL,
    source_turn_id TEXT NOT NULL, created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    focus TEXT NOT NULL DEFAULT '', decision TEXT NOT NULL DEFAULT '', snapshot_json TEXT,
    UNIQUE(source_session_id,source_turn_id));
    CREATE TABLE IF NOT EXISTS coordination_progress_assignments (
    batch_id TEXT NOT NULL REFERENCES coordination_progress_batches(batch_id) ON DELETE CASCADE, assignment_id TEXT NOT NULL,
    dispatch_id TEXT, task_id TEXT, summary TEXT NOT NULL DEFAULT '', report_message_id TEXT,
    created_at TEXT NOT NULL, state_json TEXT, PRIMARY KEY(batch_id,assignment_id));
    CREATE INDEX IF NOT EXISTS progress_dispatch ON coordination_progress_assignments(dispatch_id);
    CREATE INDEX IF NOT EXISTS progress_parent ON coordination_progress_batches(parent_task_id,created_at);
    CREATE INDEX IF NOT EXISTS progress_dispatch_batch ON task_coordination_dispatches(progress_batch_id);`);
  ensureColumn("coordination_progress_assignments", "state_json", "TEXT");
  ensureColumn("coordination_progress_batches", "milestones_json", "TEXT NOT NULL DEFAULT '[]'");
}
