export function migrateTaskCoordination({ db, ensureColumn }) {
  // Separate executor ownership from the Task's interactive current Session.
  // No transcript archive is created by these recovery/control records.
  db.run(`CREATE TABLE IF NOT EXISTS coordination_shadow_sessions (
    main_session_id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL,
    shadow_session_id TEXT UNIQUE, state TEXT NOT NULL DEFAULT 'pending',
    scope_json TEXT NOT NULL, requirement_revision INTEGER NOT NULL DEFAULT 0,
    processed_revision INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS coordination_shadow_parent ON coordination_shadow_sessions(parent_task_id);
  CREATE TABLE IF NOT EXISTS coordination_shadow_reports (
    report_id TEXT PRIMARY KEY, main_session_id TEXT NOT NULL,
    shadow_session_id TEXT NOT NULL, source_turn_id TEXT NOT NULL,
    requirement_revision INTEGER NOT NULL, body TEXT NOT NULL,
    decision_json TEXT, created_at TEXT NOT NULL,
    UNIQUE(shadow_session_id,source_turn_id)
  );
  CREATE INDEX IF NOT EXISTS coordination_shadow_report_main ON coordination_shadow_reports(main_session_id,created_at);
  CREATE TABLE IF NOT EXISTS coordination_shadow_requests (
    request_id TEXT PRIMARY KEY, main_session_id TEXT NOT NULL, source_turn_id TEXT NOT NULL,
    body TEXT NOT NULL, source_json TEXT NOT NULL, mailbox_message_id TEXT,
    created_at TEXT NOT NULL, UNIQUE(main_session_id,source_turn_id)
  );
  CREATE TABLE IF NOT EXISTS coordination_shadow_reclamation (
    task_id TEXT PRIMARY KEY, main_session_id TEXT NOT NULL,
    shadow_session_id TEXT NOT NULL, report_id TEXT NOT NULL,
    phase TEXT NOT NULL, recovery_json TEXT NOT NULL,
    last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  for (const column of ["sender_operation_id", "sender_turn_id", "sender_provider_session_id", "sender_binding_id"]) {
    ensureColumn("session_collaboration_messages", column, "TEXT");
  }
  db.run(`CREATE INDEX IF NOT EXISTS channel_execution_result ON session_collaboration_messages(recipient_session_id,sender_operation_id,sender_turn_id);
  CREATE TABLE IF NOT EXISTS coordination_result_receipts (
    recipient_session_id TEXT NOT NULL, execution_session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL, final_message_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
    mailbox_message_id TEXT NOT NULL, channel_message_id TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY(recipient_session_id,execution_session_id,turn_id,final_message_id)
  );`);
  ensureColumn("agent_operations", "execution_evidence_json", "TEXT");
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
