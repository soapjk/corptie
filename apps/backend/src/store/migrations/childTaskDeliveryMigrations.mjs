export function migrateChildTaskDelivery({ db, selectOne, runDataMigrationOnce }) {
  runDataMigrationOnce("completion-native-user-source-v1",()=>{
    const definition=selectOne("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_completion_intents'")?.sql;
    if(!definition || definition.includes("direct_user_ui_action")) return;
    db.run("ALTER TABLE task_completion_intents RENAME TO task_completion_intents_legacy_native");
    db.run(definition.replace(/'direct_macos_ui_action',\s*'direct_session_user_instruction'/,
      "'direct_macos_ui_action', 'direct_session_user_instruction', 'direct_user_ui_action'"));
    db.run("INSERT INTO task_completion_intents SELECT * FROM task_completion_intents_legacy_native");
    db.run("DROP TABLE task_completion_intents_legacy_native");
    db.run("CREATE UNIQUE INDEX idx_task_completion_intent_request ON task_completion_intents(source_type,request_id)");
  });
  db.run(`CREATE TABLE IF NOT EXISTS child_task_delivery_operations (
    operation_id TEXT PRIMARY KEY, child_task_id TEXT NOT NULL REFERENCES tasks(id),
    parent_task_id TEXT NOT NULL REFERENCES tasks(id), work_id TEXT NOT NULL,
    approval_operation_id TEXT NOT NULL UNIQUE, snapshot_json TEXT NOT NULL,
    actor_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', phase TEXT NOT NULL DEFAULT 'code',
    revision INTEGER NOT NULL DEFAULT 1, progress_json TEXT NOT NULL DEFAULT '{}',
    error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS child_delivery_parent ON child_task_delivery_operations(parent_task_id,created_at);
  CREATE INDEX IF NOT EXISTS child_delivery_active ON child_task_delivery_operations(child_task_id,state);
  CREATE UNIQUE INDEX IF NOT EXISTS child_delivery_single_active ON child_task_delivery_operations(child_task_id)
    WHERE state IN ('queued','running','waiting');
  CREATE INDEX IF NOT EXISTS child_delivery_recoverable ON child_task_delivery_operations(state)
    WHERE state IN ('queued','running','waiting');`);
}
