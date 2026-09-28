import { createdAtFromOrNow } from "../../utils/timestamps.mjs";

// Migration functions use the caller-owned connection and transaction boundary.
export function migrateScheduledSessionConditionTasks({ ensureColumn, selectOne, db }) {
  ensureColumn("scheduled_session_runs", "condition_result_json", "TEXT");
  const table = selectOne(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_session_tasks'"
  );
  if (!table?.sql || /schedule_type\s+IN\s*\([^)]*'condition'/i.test(table.sql)) {
    ensureColumn("scheduled_session_tasks", "condition_spec_json", "TEXT");
    ensureColumn("scheduled_session_tasks", "condition_state_json", "TEXT");
    return;
  }

  // SQLite cannot widen a CHECK constraint in place. Rebuild only this
  // independent schedule table while preserving child-table foreign keys.
  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  try {
    db.run(`
      CREATE TABLE scheduled_session_tasks_condition_v1 (
        task_id TEXT PRIMARY KEY,
        logical_session_id TEXT NOT NULL,
        message_json TEXT NOT NULL,
        schedule_type TEXT NOT NULL
          CHECK (schedule_type IN ('once', 'interval', 'condition', 'process')),
        run_at TEXT,
        next_run_at TEXT,
        interval_seconds INTEGER,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'paused', 'completed', 'failed', 'cancelled')),
        missed_policy TEXT NOT NULL DEFAULT 'coalesce_once'
          CHECK (missed_policy IN ('coalesce_once', 'skip')),
        condition_spec_json TEXT,
        condition_state_json TEXT,
        process_spec_json TEXT,
        process_state_json TEXT,
        creator_type TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        work_id TEXT,
        environment TEXT NOT NULL,
        pending_scheduled_for TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 5,
        last_run_id TEXT,
        last_run_status TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        last_run_at TEXT,
        resource_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        paused_at TEXT,
        cancelled_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL
      )
    `);
    db.run(`
      INSERT INTO scheduled_session_tasks_condition_v1 (
        task_id, logical_session_id, message_json, schedule_type, run_at, next_run_at,
        interval_seconds, timezone, status, missed_policy, process_spec_json,
        process_state_json, creator_type, creator_id, work_id, environment,
        pending_scheduled_for, lease_owner, lease_expires_at, retry_count, max_retries,
        last_run_id, last_run_status, last_error_code, last_error_message, last_run_at,
        resource_version, created_at, updated_at, paused_at, cancelled_at, completed_at
      )
      SELECT
        task_id, logical_session_id, message_json, schedule_type, run_at, next_run_at,
        interval_seconds, timezone, status, missed_policy, process_spec_json,
        process_state_json, creator_type, creator_id, work_id, environment,
        pending_scheduled_for, lease_owner, lease_expires_at, retry_count, max_retries,
        last_run_id, last_run_status, last_error_code, last_error_message, last_run_at,
        resource_version, created_at, updated_at, paused_at, cancelled_at, completed_at
      FROM scheduled_session_tasks
    `);
    db.run("DROP TABLE scheduled_session_tasks");
    db.run("ALTER TABLE scheduled_session_tasks_condition_v1 RENAME TO scheduled_session_tasks");
    db.run(`CREATE INDEX idx_scheduled_session_tasks_due
      ON scheduled_session_tasks(environment, status, next_run_at, lease_expires_at)`);
    db.run(`CREATE INDEX idx_scheduled_session_tasks_session
      ON scheduled_session_tasks(logical_session_id, created_at DESC)`);
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}

export function migrateAutomationSchedulerV1({ ensureColumn, db }) {
  const taskColumns = {
    name: "TEXT",
    trigger_spec_json: "TEXT",
    condition_specs_json: "TEXT NOT NULL DEFAULT '[]'",
    actions_json: "TEXT NOT NULL DEFAULT '[]'",
    policy_spec_json: "TEXT NOT NULL DEFAULT '{}'",
    risk_json: "TEXT NOT NULL DEFAULT '{}'",
    max_concurrent_runs: "INTEGER NOT NULL DEFAULT 1",
    timeout_seconds: "INTEGER NOT NULL DEFAULT 3600",
    backpressure_limit: "INTEGER NOT NULL DEFAULT 100"
  };
  for (const [column, definition] of Object.entries(taskColumns)) {
    ensureColumn("scheduled_session_tasks", column, definition);
  }
  ensureColumn("scheduled_session_runs", "stages_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("scheduled_session_runs", "action_results_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("scheduled_session_runs", "deadline_at", "TEXT");
  db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_session_runs_status_deadline
    ON scheduled_session_runs(status, deadline_at)`);
}

export function migrateScheduledSessionTaskReadIndexes({ db }) {
  // Collection reads are ordered exactly this way by both the Session detail
  // card and the global Automation view. Keep both filtered and unfiltered
  // paths index-ordered so a small result never waits on a table scan/sort.
  db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_session_tasks_environment_created
    ON scheduled_session_tasks(environment, created_at DESC, task_id ASC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_session_tasks_environment_session_created
    ON scheduled_session_tasks(environment, logical_session_id, created_at DESC, task_id ASC)`);
}

export function migrateAutomationExpirationV1({ selectOne, db }) {
  const table = selectOne(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_session_tasks'"
  );
  if (table?.sql && /expires_at\s+TEXT\s+NOT\s+NULL/i.test(table.sql)
    && /status\s+IN\s*\([^)]*'expired'[^)]*'error'/i.test(table.sql)) return;

  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  try {
    db.run(`
      CREATE TABLE scheduled_session_tasks_expiration_v1 (
        task_id TEXT PRIMARY KEY, logical_session_id TEXT NOT NULL, message_json TEXT NOT NULL,
        schedule_type TEXT NOT NULL CHECK (schedule_type IN ('once', 'interval', 'condition', 'process')),
        run_at TEXT, next_run_at TEXT, interval_seconds INTEGER, timezone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'completed', 'expired', 'error')),
        missed_policy TEXT NOT NULL DEFAULT 'coalesce_once' CHECK (missed_policy IN ('coalesce_once', 'skip')),
        condition_spec_json TEXT, condition_state_json TEXT, process_spec_json TEXT, process_state_json TEXT,
        creator_type TEXT NOT NULL, creator_id TEXT NOT NULL, work_id TEXT, environment TEXT NOT NULL,
        pending_scheduled_for TEXT, lease_owner TEXT, lease_expires_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 5, last_run_id TEXT, last_run_status TEXT,
        last_error_code TEXT, last_error_message TEXT, last_run_at TEXT,
        resource_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        paused_at TEXT, cancelled_at TEXT, completed_at TEXT, name TEXT, trigger_spec_json TEXT,
        condition_specs_json TEXT NOT NULL DEFAULT '[]', actions_json TEXT NOT NULL DEFAULT '[]',
        policy_spec_json TEXT NOT NULL DEFAULT '{}', risk_json TEXT NOT NULL DEFAULT '{}',
        max_concurrent_runs INTEGER NOT NULL DEFAULT 1, timeout_seconds INTEGER NOT NULL DEFAULT 3600,
        backpressure_limit INTEGER NOT NULL DEFAULT 100, expires_at TEXT NOT NULL,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL
      )
    `);
    db.run(`
      INSERT INTO scheduled_session_tasks_expiration_v1 (
        task_id, logical_session_id, message_json, schedule_type, run_at, next_run_at, interval_seconds,
        timezone, status, missed_policy, condition_spec_json, condition_state_json, process_spec_json,
        process_state_json, creator_type, creator_id, work_id, environment, pending_scheduled_for,
        lease_owner, lease_expires_at, retry_count, max_retries, last_run_id, last_run_status,
        last_error_code, last_error_message, last_run_at, resource_version, created_at, updated_at,
        paused_at, cancelled_at, completed_at, name, trigger_spec_json, condition_specs_json,
        actions_json, policy_spec_json, risk_json, max_concurrent_runs, timeout_seconds,
        backpressure_limit, expires_at
      )
      SELECT
        task_id, logical_session_id, message_json, schedule_type, run_at,
        CASE WHEN status IN ('completed', 'paused', 'cancelled') THEN NULL ELSE next_run_at END,
        interval_seconds, timezone,
        CASE status WHEN 'failed' THEN 'error' WHEN 'cancelled' THEN 'cancelled'
          WHEN 'paused' THEN 'cancelled' WHEN 'completed' THEN 'completed' ELSE 'active' END,
        missed_policy, condition_spec_json, condition_state_json, process_spec_json, process_state_json,
        creator_type, creator_id, work_id, environment, pending_scheduled_for, lease_owner,
        lease_expires_at, retry_count, max_retries, last_run_id, last_run_status, last_error_code,
        last_error_message, last_run_at, resource_version, created_at, updated_at, paused_at,
        cancelled_at, completed_at, name, trigger_spec_json, condition_specs_json, actions_json,
        policy_spec_json, risk_json, max_concurrent_runs, timeout_seconds, backpressure_limit,
        CASE WHEN status = 'completed' THEN COALESCE(completed_at, updated_at)
          ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+1 year') END
      FROM scheduled_session_tasks
    `);
    db.run("DROP TABLE scheduled_session_tasks");
    db.run("ALTER TABLE scheduled_session_tasks_expiration_v1 RENAME TO scheduled_session_tasks");
    db.run(`CREATE INDEX idx_scheduled_session_tasks_due
      ON scheduled_session_tasks(environment, status, next_run_at, lease_expires_at)`);
    db.run(`CREATE INDEX idx_scheduled_session_tasks_expiration
      ON scheduled_session_tasks(environment, status, expires_at)`);
    db.run(`CREATE INDEX idx_scheduled_session_tasks_session
      ON scheduled_session_tasks(logical_session_id, created_at DESC)`);
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}

export function migrateAutomationCompletedStatusV1({ selectOne, db }) {
  const table = selectOne(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_session_tasks'"
  );
  if (table?.sql && /status\s+IN\s*\([^)]*'completed'[^)]*'expired'[^)]*'error'/i.test(table.sql)) return;

  // Existing expiration-v1 databases used a four-state CHECK constraint.
  // SQLite cannot widen it in place, so preserve every persisted field while
  // rebuilding only the plan table; run and event audit tables remain intact.
  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  try {
    db.run(`
      CREATE TABLE scheduled_session_tasks_completed_v1 (
        task_id TEXT PRIMARY KEY, logical_session_id TEXT NOT NULL, message_json TEXT NOT NULL,
        schedule_type TEXT NOT NULL CHECK (schedule_type IN ('once', 'interval', 'condition', 'process')),
        run_at TEXT, next_run_at TEXT, interval_seconds INTEGER, timezone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'completed', 'expired', 'error')),
        missed_policy TEXT NOT NULL DEFAULT 'coalesce_once' CHECK (missed_policy IN ('coalesce_once', 'skip')),
        condition_spec_json TEXT, condition_state_json TEXT, process_spec_json TEXT, process_state_json TEXT,
        creator_type TEXT NOT NULL, creator_id TEXT NOT NULL, work_id TEXT, environment TEXT NOT NULL,
        pending_scheduled_for TEXT, lease_owner TEXT, lease_expires_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 5, last_run_id TEXT, last_run_status TEXT,
        last_error_code TEXT, last_error_message TEXT, last_run_at TEXT,
        resource_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        paused_at TEXT, cancelled_at TEXT, completed_at TEXT, name TEXT, trigger_spec_json TEXT,
        condition_specs_json TEXT NOT NULL DEFAULT '[]', actions_json TEXT NOT NULL DEFAULT '[]',
        policy_spec_json TEXT NOT NULL DEFAULT '{}', risk_json TEXT NOT NULL DEFAULT '{}',
        max_concurrent_runs INTEGER NOT NULL DEFAULT 1, timeout_seconds INTEGER NOT NULL DEFAULT 3600,
        backpressure_limit INTEGER NOT NULL DEFAULT 100, expires_at TEXT NOT NULL,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL
      )
    `);
    db.run(`
      INSERT INTO scheduled_session_tasks_completed_v1 (
        task_id, logical_session_id, message_json, schedule_type, run_at, next_run_at, interval_seconds,
        timezone, status, missed_policy, condition_spec_json, condition_state_json, process_spec_json,
        process_state_json, creator_type, creator_id, work_id, environment, pending_scheduled_for,
        lease_owner, lease_expires_at, retry_count, max_retries, last_run_id, last_run_status,
        last_error_code, last_error_message, last_run_at, resource_version, created_at, updated_at,
        paused_at, cancelled_at, completed_at, name, trigger_spec_json, condition_specs_json,
        actions_json, policy_spec_json, risk_json, max_concurrent_runs, timeout_seconds,
        backpressure_limit, expires_at
      )
      SELECT
        task_id, logical_session_id, message_json, schedule_type, run_at, next_run_at, interval_seconds,
        timezone, status, missed_policy, condition_spec_json, condition_state_json, process_spec_json,
        process_state_json, creator_type, creator_id, work_id, environment, pending_scheduled_for,
        lease_owner, lease_expires_at, retry_count, max_retries, last_run_id, last_run_status,
        last_error_code, last_error_message, last_run_at, resource_version, created_at, updated_at,
        paused_at, cancelled_at, completed_at, name, trigger_spec_json, condition_specs_json,
        actions_json, policy_spec_json, risk_json, max_concurrent_runs, timeout_seconds,
        backpressure_limit, expires_at
      FROM scheduled_session_tasks
    `);
    db.run("DROP TABLE scheduled_session_tasks");
    db.run("ALTER TABLE scheduled_session_tasks_completed_v1 RENAME TO scheduled_session_tasks");
    db.run(`CREATE INDEX idx_scheduled_session_tasks_due
      ON scheduled_session_tasks(environment, status, next_run_at, lease_expires_at)`);
    db.run(`CREATE INDEX idx_scheduled_session_tasks_expiration
      ON scheduled_session_tasks(environment, status, expires_at)`);
    db.run(`CREATE INDEX idx_scheduled_session_tasks_session
      ON scheduled_session_tasks(logical_session_id, created_at DESC)`);
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}

export function migrateAutomationTitlesV1({ selectOne, runInTransaction, db }) {
  const migrationId = "automation-titles-v1";
  if (selectOne("SELECT migration_id FROM data_migrations WHERE migration_id = ?", [migrationId])) return;
  const appliedAt = createdAtFromOrNow();
  runInTransaction(() => {
    db.run(`
      UPDATE scheduled_session_tasks
      SET name = CASE
        WHEN length(trim(COALESCE(json_extract(message_json, '$.text'), ''))) <= 48
          THEN trim(COALESCE(json_extract(message_json, '$.text'), task_id))
        ELSE substr(trim(COALESCE(json_extract(message_json, '$.text'), task_id)), 1, 47) || '…'
      END
      WHERE name IS NULL OR trim(name) = ''
    `);
    db.run(
      "INSERT INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
      [migrationId, appliedAt]
    );
  });
}
