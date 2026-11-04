export function migrateExecutionChecklist(db) {
  db.run(`CREATE TABLE IF NOT EXISTS execution_checklists (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, body_json TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_execution_checklists_session ON execution_checklists(session_id);
  CREATE TABLE IF NOT EXISTS execution_checklist_operations (
    task_id TEXT NOT NULL REFERENCES execution_checklists(task_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL, request_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
    PRIMARY KEY(task_id, operation_id)
  );
  CREATE TABLE IF NOT EXISTS execution_checklist_continuations (
    task_id TEXT NOT NULL REFERENCES execution_checklists(task_id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL, turn_id TEXT NOT NULL, operation_id TEXT,
    PRIMARY KEY(task_id, binding_id, turn_id)
  );`);
}
