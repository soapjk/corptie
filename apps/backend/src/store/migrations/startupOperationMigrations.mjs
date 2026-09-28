export function migrateStartupOperations({ ensureColumn, selectAll, db, runDataMigrationOnce, dropColumnIfExists }) {
    ensureColumn("git_worktrees", "dedicated", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("git_worktrees", "created_by_startup_operation_id", "TEXT");
    ensureColumn("git_worktrees", "resource_version", "INTEGER NOT NULL DEFAULT 1");
    const startupColumns = selectAll("PRAGMA table_info(work_session_startup_operations)");
    if (startupColumns.some((entry) => entry.name === "requested_agent_id")
      && !startupColumns.some((entry) => entry.name === "assignee_agent_id")) {
      db.run(
        "ALTER TABLE work_session_startup_operations RENAME COLUMN requested_agent_id TO assignee_agent_id"
      );
    }
    if (startupColumns.some((entry) => entry.name === "actor_logical_session_id")
      && !startupColumns.some((entry) => entry.name === "source_session_id")) {
      db.run(
        "ALTER TABLE work_session_startup_operations RENAME COLUMN actor_logical_session_id TO source_session_id"
      );
    }
    ensureColumn(
      "work_session_startup_operations",
      "expected_task_version",
      "INTEGER NOT NULL DEFAULT 1"
    );
    ensureColumn("work_session_startup_operations", "error_stage", "TEXT");
    ensureColumn("work_session_startup_operations", "requested_model", "TEXT");
    ensureColumn("work_session_startup_operations", "requested_reasoning_level", "TEXT");
    ensureColumn(
      "work_session_startup_operations",
      "initial_turn_state",
      "TEXT NOT NULL DEFAULT 'pending'"
    );
    ensureColumn(
      "work_session_startup_operations",
      "dispatch_initial_turn",
      "INTEGER NOT NULL DEFAULT 1"
    );
    ensureColumn("work_session_startup_operations", "initial_turn_error_code", "TEXT");
    ensureColumn("work_session_startup_bindings", "tool_contract_hash", "TEXT");
    ensureColumn("work_session_startup_bindings", "instruction_sources_hash", "TEXT");
    ensureColumn("work_session_startup_bindings", "activation_proof_json", "TEXT");
    db.run("DROP TRIGGER IF EXISTS work_session_startup_binding_ready_guard");
    db.run(`CREATE TRIGGER work_session_startup_binding_ready_guard
      BEFORE UPDATE OF status ON work_session_startup_bindings
      WHEN NEW.status='ready' AND (
        NEW.provider_resource_id IS NULL OR TRIM(NEW.provider_resource_id)=''
        OR NEW.provider_cwd_proof IS NULL OR TRIM(NEW.provider_cwd_proof)=''
        OR NEW.tool_contract_hash IS NULL OR TRIM(NEW.tool_contract_hash)=''
        OR NEW.instruction_sources_hash IS NULL OR TRIM(NEW.instruction_sources_hash)=''
        OR NEW.activation_proof_json IS NULL OR TRIM(NEW.activation_proof_json)=''
      )
      BEGIN SELECT RAISE(ABORT, 'START_PROVIDER_ACTIVATION_PROOF_REQUIRED'); END`);
    runDataMigrationOnce("remove-legacy-task-start-operations-v1", () => {
      db.run("DROP INDEX IF EXISTS idx_task_start_operations_context");
      db.run("DROP TABLE IF EXISTS task_start_operations");
    });
    runDataMigrationOnce("remove-legacy-task-start-projections-v2", () => {
      for (const column of [
        "start_idempotency_key", "start_error", "start_stage", "start_failure_stage",
        "start_error_code", "start_started_at", "start_stage_updated_at", "start_failed_at",
        "start_provider_id", "start_agent_id", "start_worktree_id", "start_worktree_path",
        "start_worktree_branch"
      ]) dropColumnIfExists("tasks", column);
    });
}
