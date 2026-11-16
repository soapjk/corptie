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
  db.run(`CREATE TABLE IF NOT EXISTS execution_checklist_plans (
    plan_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    owner_session_id TEXT NOT NULL,instruction_id TEXT NOT NULL,body_json TEXT NOT NULL,updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS execution_plans_instruction ON execution_checklist_plans(task_id,instruction_id,updated_at);
  CREATE INDEX IF NOT EXISTS execution_plans_owner ON execution_checklist_plans(owner_session_id,updated_at);
  CREATE TABLE IF NOT EXISTS execution_checklist_runtime (
    plan_id TEXT PRIMARY KEY REFERENCES execution_checklist_plans(plan_id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'idle',generation INTEGER NOT NULL DEFAULT 0,
    responsible_session_id TEXT NOT NULL,operation_id TEXT,body_json TEXT NOT NULL,updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS execution_runtime_active ON execution_checklist_runtime(enabled,state,plan_id);
  CREATE INDEX IF NOT EXISTS execution_runtime_operation ON execution_checklist_runtime(operation_id);
  CREATE TABLE IF NOT EXISTS execution_checklist_waits (
    plan_id TEXT NOT NULL REFERENCES execution_checklist_plans(plan_id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,kind TEXT NOT NULL,resource_id TEXT NOT NULL,body_json TEXT NOT NULL,
    PRIMARY KEY(plan_id,step_id)
  );
  CREATE INDEX IF NOT EXISTS execution_wait_resource ON execution_checklist_waits(kind,resource_id);
  CREATE TABLE IF NOT EXISTS coordination_decisions (
    decision_id TEXT PRIMARY KEY,main_session_id TEXT NOT NULL,plan_id TEXT REFERENCES execution_checklist_plans(plan_id) ON DELETE CASCADE,
    topic_key TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
    body_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(main_session_id,topic_key)
  );
  CREATE INDEX IF NOT EXISTS coordination_decision_pending ON coordination_decisions(main_session_id,status);
  CREATE INDEX IF NOT EXISTS coordination_decision_plan ON coordination_decisions(plan_id,status);
  CREATE TABLE IF NOT EXISTS execution_plan_batches (
    batch_id TEXT PRIMARY KEY REFERENCES coordination_progress_batches(batch_id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES execution_checklist_plans(plan_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS execution_plan_batch_group ON execution_plan_batches(plan_id,batch_id);`);
}
