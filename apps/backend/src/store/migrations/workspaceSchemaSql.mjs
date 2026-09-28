// Schema text is ordered by migrations/index.mjs; execution remains owned by CorptieStore.
export const workspaceSchemaSql = `      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('managedLocal', 'linkedLocal', 'cloud')),
        ownership TEXT NOT NULL CHECK (ownership IN ('corptieManaged', 'userManaged', 'externalManaged')),
        root_path TEXT,
        canonical_root_path TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('pending', 'ready', 'unavailable')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_spaces (
        execution_space_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        session_id TEXT,
        logical_session_id TEXT,
        workspace_id TEXT NOT NULL,
        strategy TEXT NOT NULL CHECK (strategy IN ('gitWorktree','managedSandbox','readOnlyDirect','externalConnector')),
        status TEXT NOT NULL CHECK (status IN (
          'pending','preparing','binding','ready','running','awaitingReview','publishing','published',
          'releasing','released','prepareFailed','executionFailed','publishConflict','publishFailed','cleanupFailed'
        )),
        root_path TEXT,
        source_workspace_path TEXT,
        base_workspace_revision TEXT,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        receipt_json TEXT,
        error_code TEXT,
        error_message TEXT,
        resource_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        prepared_at TEXT,
        ready_at TEXT,
        released_at TEXT,
        UNIQUE (task_id, idempotency_key),
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
        FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE SET NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_spaces_active_task
      ON execution_spaces(task_id)
      WHERE status NOT IN ('released','prepareFailed','executionFailed','cleanupFailed');

      CREATE INDEX IF NOT EXISTS idx_execution_spaces_session
      ON execution_spaces(session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS git_repositories (
        repository_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE,
        common_git_dir TEXT NOT NULL UNIQUE,
        discovered_at TEXT NOT NULL,
        last_validated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS git_worktrees (
        worktree_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        path TEXT NOT NULL,
        canonical_path TEXT,
        git_dir TEXT,
        is_main INTEGER NOT NULL DEFAULT 0,
        availability TEXT NOT NULL
          CHECK (availability IN ('available', 'missing', 'invalid', 'permissionDenied')),
        head_oid TEXT,
        branch_ref TEXT,
        branch_name TEXT,
        detached INTEGER NOT NULL DEFAULT 0,
        locked INTEGER NOT NULL DEFAULT 0,
        lock_reason TEXT,
        prunable INTEGER NOT NULL DEFAULT 0,
        prune_reason TEXT,
        inventory_version TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        dedicated INTEGER NOT NULL DEFAULT 0,
        created_by_startup_operation_id TEXT,
        resource_version INTEGER NOT NULL DEFAULT 1,
        raw_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (repository_id) REFERENCES git_repositories(repository_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_git_worktrees_repository
      ON git_worktrees(repository_id, availability, path);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_git_worktrees_git_dir
      ON git_worktrees(repository_id, git_dir) WHERE git_dir IS NOT NULL;

      CREATE TABLE IF NOT EXISTS logical_sessions (
        logical_session_id TEXT PRIMARY KEY,
        legacy_session_id TEXT UNIQUE,
        active_thread_id TEXT,
        active_workspace_id TEXT,
        repository_id TEXT,
        routing_version INTEGER NOT NULL DEFAULT 1,
        transition_state TEXT,
        title TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (repository_id) REFERENCES git_repositories(repository_id) ON DELETE SET NULL,
        FOREIGN KEY (active_workspace_id) REFERENCES git_worktrees(worktree_id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_creation_requests (
        operation_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        actor_agent_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        logical_session_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        task_id TEXT,
        repository_id TEXT NOT NULL,
        target_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
        failure_stage TEXT,
        request_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (logical_session_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_creation_requests_context
      ON workspace_creation_requests(work_id, source_session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS session_name_aliases (
        alias_key TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        logical_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS provider_thread_bindings (
        provider_thread_id TEXT PRIMARY KEY,
        binding_id TEXT,
        provider_id TEXT,
        provider_session_id TEXT,
        logical_session_id TEXT NOT NULL,
        worktree_id TEXT,
        bound_cwd TEXT NOT NULL,
        parent_thread_id TEXT,
        parent_binding_id TEXT,
        forked_at_turn_id TEXT,
        instruction_sources_json TEXT NOT NULL DEFAULT '[]',
        permission_snapshot_json TEXT NOT NULL DEFAULT '{}',
        provider_metadata_json TEXT NOT NULL DEFAULT '{}',
        routing_version INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL
          CHECK (state IN ('active', 'superseded', 'invalid', 'orphaned')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE,
        FOREIGN KEY (worktree_id) REFERENCES git_worktrees(worktree_id) ON DELETE SET NULL,
        FOREIGN KEY (parent_thread_id) REFERENCES provider_thread_bindings(provider_thread_id) ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_thread_bindings_active
      ON provider_thread_bindings(logical_session_id) WHERE state = 'active';

      CREATE INDEX IF NOT EXISTS idx_provider_thread_bindings_worktree
      ON provider_thread_bindings(worktree_id, state);

      CREATE TABLE IF NOT EXISTS session_tool_catalog_materializations (
        logical_session_id TEXT NOT NULL,
        provider_binding_id TEXT NOT NULL,
        desired_version TEXT NOT NULL,
        applied_version TEXT,
        desired_catalog_version TEXT NOT NULL,
        applied_catalog_version TEXT,
        desired_domains_json TEXT NOT NULL DEFAULT '[]',
        applied_domains_json TEXT NOT NULL DEFAULT '[]',
        exposure_plan_json TEXT NOT NULL DEFAULT '{}',
        provider_receipt_json TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('uninitialized', 'stale', 'refreshing', 'applied', 'error', 'canceled')),
        attempt INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        last_error_summary TEXT,
        refresh_requested_at TEXT,
        refresh_started_at TEXT,
        applied_at TEXT,
        resource_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (logical_session_id, provider_binding_id),
        FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_tool_catalog_materializations_status
      ON session_tool_catalog_materializations(status, updated_at);

      CREATE TABLE IF NOT EXISTS provider_thread_lineage (
        child_thread_id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        logical_session_id TEXT NOT NULL,
        transition_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (child_thread_id) REFERENCES provider_thread_bindings(provider_thread_id) ON DELETE CASCADE,
        FOREIGN KEY (parent_thread_id) REFERENCES provider_thread_bindings(provider_thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS workspace_transitions (
        transition_id TEXT PRIMARY KEY,
        logical_session_id TEXT NOT NULL,
        source_thread_id TEXT NOT NULL,
        target_worktree_id TEXT,
        target_cwd TEXT NOT NULL,
        transition_kind TEXT NOT NULL DEFAULT 'workspace'
          CHECK (transition_kind IN ('workspace', 'provider')),
        target_provider_id TEXT,
        source_routing_version INTEGER NOT NULL,
        last_completed_turn_id TEXT,
        new_thread_id TEXT,
        resume_goal_after_transition INTEGER NOT NULL DEFAULT 0,
        continuation_prompt TEXT,
        continuation_state TEXT NOT NULL DEFAULT 'none'
          CHECK (continuation_state IN ('none', 'pending', 'queued', 'running', 'completed', 'failed')),
        continuation_turn_id TEXT,
        handoff_turn_id TEXT,
        tool_confirmation_json TEXT,
        continuation_error TEXT,
        phase TEXT NOT NULL
          CHECK (phase IN (
            'waitingForTurn', 'preflighting', 'forking', 'validatingInstructions',
            'committingRoute', 'committed', 'failed'
          )),
        strategy TEXT NOT NULL DEFAULT 'fork'
          CHECK (strategy IN ('fork', 'handoff', 'settingsUpdate')),
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE,
        FOREIGN KEY (source_thread_id) REFERENCES provider_thread_bindings(provider_thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (target_worktree_id) REFERENCES git_worktrees(worktree_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_transitions_session
      ON workspace_transitions(logical_session_id, created_at DESC);
    `;
