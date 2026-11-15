export function migrateVerificationBudget(db) {
  // Instruction identities reference existing operation/dispatch records. No
  // command bodies, stdout, test reports or copied conversation are stored.
  db.run(`CREATE TABLE IF NOT EXISTS verification_budgets (
    instruction_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, limit_count INTEGER NOT NULL CHECK(limit_count > 0),
    stopped INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS verification_budget_task ON verification_budgets(task_id,created_at);
  CREATE TABLE IF NOT EXISTS verification_budget_charges (
    instruction_id TEXT NOT NULL REFERENCES verification_budgets(instruction_id) ON DELETE CASCADE,
    execution_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(instruction_id,execution_id)
  );
  CREATE TABLE IF NOT EXISTS verification_budget_extensions (
    instruction_id TEXT NOT NULL REFERENCES verification_budgets(instruction_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(instruction_id,request_id)
  );
  CREATE TABLE IF NOT EXISTS verification_budget_defaults (
    id INTEGER PRIMARY KEY CHECK(id=1), limit_count INTEGER NOT NULL CHECK(limit_count > 0)
  );`);
  const add = (table, name, type) => {
    if (db.all(`PRAGMA table_info(${table})`).some(row => row.name === name)) return false;
    db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`); return true;
  };
  if (add("verification_budget_defaults", "enabled", "INTEGER NOT NULL DEFAULT 0")) {
    // Only explicit old user-default writes created this row.
    db.run("UPDATE verification_budget_defaults SET enabled=1");
  }
  if (add("verification_budgets", "enabled", "INTEGER NOT NULL DEFAULT 0")) {
    db.run("UPDATE verification_budgets SET enabled=1 WHERE EXISTS(SELECT 1 FROM verification_budget_extensions e WHERE e.instruction_id=verification_budgets.instruction_id)");
  }
  for (const [name,type] of Object.entries({policy_source:"TEXT NOT NULL DEFAULT 'legacy_auto'",revision:"INTEGER NOT NULL DEFAULT 0",pause_reason:"TEXT",pause_generation:"INTEGER NOT NULL DEFAULT 0",pause_targets_json:"TEXT NOT NULL DEFAULT '[]'",resume_ids_json:"TEXT NOT NULL DEFAULT '[]'",resume_requested:"INTEGER NOT NULL DEFAULT 0"})) add("verification_budgets",name,type);
  for (const [name,type] of Object.entries({operation_id:"TEXT",executor_session_id:"TEXT",executor_task_id:"TEXT"})) add("verification_budget_charges",name,type);
  add("verification_budget_extensions","resume","INTEGER NOT NULL DEFAULT 0");
  db.run("CREATE INDEX IF NOT EXISTS verification_budget_paused ON verification_budgets(session_id,instruction_id) WHERE enabled=1 AND pause_reason='budget'");
  db.run(`CREATE TABLE IF NOT EXISTS verification_budget_policies (
    session_id TEXT PRIMARY KEY REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0, limit_count INTEGER NOT NULL DEFAULT 3,
    revision INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'user');`);

}
