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
}
