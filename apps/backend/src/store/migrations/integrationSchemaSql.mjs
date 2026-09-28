// Schema text is ordered by migrations/index.mjs; execution remains owned by CorptieStore.
export const integrationSchemaSql = `      CREATE TABLE IF NOT EXISTS project_integration_runs (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        status TEXT NOT NULL,
        main_head_before TEXT NOT NULL,
        main_head_after TEXT,
        integration_worktree_id TEXT,
        integration_worktree_path TEXT,
        integration_branch TEXT,
        conflict_task_id TEXT,
        conflict_session_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_project_integration_runs_scope
      ON project_integration_runs(repository_id, work_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_project_integration_runs_recent
      ON project_integration_runs(created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS project_integration_items (
        run_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        branch_name TEXT,
        source_head_oid TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        conflict_files_json TEXT NOT NULL DEFAULT '[]',
        merged_main_head TEXT,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, worktree_id),
        FOREIGN KEY (run_id) REFERENCES project_integration_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_project_integration_items_status
      ON project_integration_items(run_id, status, ordinal);

      CREATE TABLE IF NOT EXISTS worktree_integration_jobs (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        plan_fingerprint TEXT NOT NULL,
        details_json TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (repository_id) REFERENCES git_repositories(repository_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_worktree_integration_jobs_repository
      ON worktree_integration_jobs(repository_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS work_task_association_audit (
        audit_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        received_value TEXT,
        status TEXT NOT NULL CHECK (status IN ('migrated', 'unresolved')),
        reason TEXT NOT NULL,
        migrated_value TEXT,
        first_audited_at TEXT NOT NULL,
        last_audited_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entity_association_audit_status
      ON work_task_association_audit(status, entity_type, entity_id);

      CREATE TABLE IF NOT EXISTS session_association_repair_audit (
        audit_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        anomaly_code TEXT NOT NULL,
        previous_work_id TEXT,
        previous_task_id TEXT,
        repaired_work_id TEXT NOT NULL,
        repaired_task_id TEXT NOT NULL,
        source_operation_id TEXT NOT NULL,
        repaired_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        repaired_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_association_repair_audit_session
      ON session_association_repair_audit(session_id, repaired_at DESC);
    `;
