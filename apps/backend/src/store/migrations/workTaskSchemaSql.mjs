// Schema text is ordered by migrations/index.mjs; execution remains owned by CorptieStore.
export const workTaskSchemaSql = `
      CREATE TABLE IF NOT EXISTS works (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        avatar_path TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        profile TEXT NOT NULL DEFAULT 'general' CHECK (profile IN ('general', 'software', 'office', 'data', 'design')),
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS work_contributors (
        work_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'contributor' CHECK (role IN ('contributor')),
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (work_id, agent_id),
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_contributors_one_primary
      ON work_contributors(work_id) WHERE is_primary = 1;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '',
        verification_criteria TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'medium',
        lifecycle_state TEXT NOT NULL DEFAULT 'todo',
        auto_title_enabled INTEGER NOT NULL DEFAULT 1,
        main_agent_id TEXT,
        execution_status TEXT NOT NULL DEFAULT 'idle',
        acceptance_assessment_json TEXT NOT NULL DEFAULT '{}',
        current_snapshot_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
        FOREIGN KEY (main_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS task_snapshots (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '',
        verification_criteria TEXT NOT NULL DEFAULT '',
        acceptance_assessment_json TEXT NOT NULL DEFAULT '{}',
        completion_evidence_json TEXT NOT NULL DEFAULT '[]',
        execution_summary TEXT NOT NULL DEFAULT '',
        source_message_id TEXT,
        created_by_session_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, version),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by_session_id) REFERENCES sessions(id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_snapshots_hash
      ON task_snapshots(task_id, content_hash);

      CREATE TABLE IF NOT EXISTS task_completion_intents (
        receipt_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN (
          'direct_macos_ui_action', 'direct_session_user_instruction'
        )),
        logical_session_id TEXT,
        user_message_event_id TEXT,
        user_message_sequence INTEGER,
        turn_id TEXT,
        interaction_id TEXT,
        ui_surface TEXT,
        request_id TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_operation_id TEXT UNIQUE,
        consumed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_completion_intent_request
      ON task_completion_intents(source_type, request_id);

      CREATE TABLE IF NOT EXISTS task_completion_authorizations (
        operation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        validated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS task_completion_operations (
        operation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('succeeded', 'rejected')),
        source_type TEXT NOT NULL,
        logical_session_id TEXT,
        user_message_event_id TEXT,
        user_message_sequence INTEGER,
        turn_id TEXT,
        ui_receipt_id TEXT,
        ui_interaction_id TEXT,
        call_surface TEXT NOT NULL,
        request_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        nonce TEXT,
        error_code TEXT,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_completion_idempotency
      ON task_completion_operations(source_type, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_task_completion_task
      ON task_completion_operations(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS task_cancellation_operations (
        operation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        actor_session_id TEXT,
        authority_type TEXT NOT NULL,
        authority_id TEXT,
        reason TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        resource_version_before INTEGER NOT NULL,
        resource_version_after INTEGER NOT NULL,
        canceled_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_cancellation_idempotency
      ON task_cancellation_operations(source_type, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_task_cancellation_task
      ON task_cancellation_operations(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS task_status_repair_audit (
        repair_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        source_task_id TEXT NOT NULL,
        anomaly_code TEXT NOT NULL,
        previous_status TEXT NOT NULL,
        restored_status TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        repaired_at TEXT NOT NULL,
        resource_version_before INTEGER NOT NULL,
        resource_version_after INTEGER NOT NULL,
        UNIQUE (task_id, source_task_id, anomaly_code),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (source_task_id) REFERENCES collaboration_requests(task_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_task_status_repair_task
      ON task_status_repair_audit(task_id, repaired_at DESC);

      CREATE TABLE IF NOT EXISTS task_deletion_operations (
        operation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed')),
        stage TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        retryable INTEGER NOT NULL DEFAULT 1,
        attempt INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (task_id, idempotency_key),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_deletion_active_task
      ON task_deletion_operations(task_id)
      WHERE state IN ('queued','running');

      CREATE INDEX IF NOT EXISTS idx_task_deletion_recovery
      ON task_deletion_operations(state, updated_at);

      CREATE TABLE IF NOT EXISTS work_session_startup_operations (
        startup_operation_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        assignee_agent_id TEXT NOT NULL,
        expected_task_version INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'application',
        requested_title TEXT,
        requested_model TEXT,
        requested_reasoning_level TEXT,
        initial_prompt TEXT,
        replacing_session_id TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'allocated', 'worktree_prepared', 'session_bound', 'provider_bound', 'ready',
          'compensating', 'failed_compensated', 'failed_manual_cleanup'
        )),
        logical_session_id TEXT,
        legacy_session_id TEXT,
        worktree_id TEXT,
        provider_binding_id TEXT,
        binding_generation INTEGER,
        allocation_json TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        resource_version INTEGER NOT NULL DEFAULT 1,
        error_code TEXT,
        error_stage TEXT,
        error_message_redacted TEXT,
        error_retryable INTEGER,
        correlation_id TEXT NOT NULL,
        compensation_state TEXT,
        compensation_result_json TEXT,
        initial_turn_state TEXT NOT NULL DEFAULT 'pending' CHECK (initial_turn_state IN ('pending','accepted','failed')),
        dispatch_initial_turn INTEGER NOT NULL DEFAULT 1 CHECK (dispatch_initial_turn IN (0,1)),
        initial_turn_error_code TEXT,
        allocated_at TEXT NOT NULL,
        worktree_prepared_at TEXT,
        session_bound_at TEXT,
        provider_bound_at TEXT,
        ready_at TEXT,
        failed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (task_id, idempotency_key),
        CHECK ((state='ready' AND ready_at IS NOT NULL) OR (state<>'ready' AND ready_at IS NULL)),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE RESTRICT,
        FOREIGN KEY (assignee_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (repository_id) REFERENCES git_repositories(repository_id) ON DELETE RESTRICT,
        FOREIGN KEY (worktree_id) REFERENCES git_worktrees(worktree_id) ON DELETE RESTRICT,
        FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE RESTRICT,
        FOREIGN KEY (legacy_session_id) REFERENCES sessions(id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_session_startup_active_task
      ON work_session_startup_operations(task_id)
      WHERE state IN ('allocated', 'worktree_prepared', 'session_bound', 'provider_bound', 'compensating');

      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_session_startup_ready_task
      ON work_session_startup_operations(task_id)
      WHERE state='ready';

      CREATE INDEX IF NOT EXISTS idx_work_session_startup_recovery
      ON work_session_startup_operations(state, lease_expires_at, updated_at);

      CREATE TABLE IF NOT EXISTS work_session_startup_bindings (
        provider_binding_id TEXT PRIMARY KEY,
        startup_operation_id TEXT NOT NULL UNIQUE,
        work_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        logical_session_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        canonical_worktree_path TEXT NOT NULL,
        head_kind TEXT NOT NULL CHECK (head_kind IN ('branch', 'detached')),
        branch TEXT,
        detached_commit_oid TEXT,
        base_ref TEXT,
        source_commit_oid TEXT NOT NULL,
        source_tree_oid TEXT NOT NULL,
        repository_inventory_version TEXT NOT NULL,
        workspace_resource_version INTEGER NOT NULL,
        binding_generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('binding', 'ready', 'retired', 'failed')),
        provider_id TEXT NOT NULL,
        provider_resource_id TEXT,
        provider_cwd_proof TEXT,
        tool_contract_hash TEXT,
        instruction_sources_hash TEXT,
        activation_proof_json TEXT,
        provider_context_hash TEXT NOT NULL,
        resource_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        ready_at TEXT,
        retired_at TEXT,
        failure_code TEXT,
        UNIQUE (logical_session_id, binding_generation),
        CHECK ((head_kind='branch' AND branch IS NOT NULL AND detached_commit_oid IS NULL)
          OR (head_kind='detached' AND branch IS NULL AND detached_commit_oid IS NOT NULL)),
        FOREIGN KEY (startup_operation_id) REFERENCES work_session_startup_operations(startup_operation_id) ON DELETE RESTRICT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE RESTRICT,
        FOREIGN KEY (repository_id) REFERENCES git_repositories(repository_id) ON DELETE RESTRICT,
        FOREIGN KEY (worktree_id) REFERENCES git_worktrees(worktree_id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_session_startup_current_generation
      ON work_session_startup_bindings(logical_session_id)
      WHERE status IN ('binding', 'ready');

      CREATE TRIGGER IF NOT EXISTS work_session_startup_binding_path_immutable
      BEFORE UPDATE OF canonical_worktree_path ON work_session_startup_bindings
      WHEN NEW.canonical_worktree_path IS NOT OLD.canonical_worktree_path
      BEGIN
        SELECT RAISE(ABORT, 'START_BINDING_PATH_IMMUTABLE');
      END;

      CREATE TRIGGER IF NOT EXISTS work_session_startup_binding_ready_guard
      BEFORE UPDATE OF status ON work_session_startup_bindings
      WHEN NEW.status='ready' AND (
        NEW.provider_resource_id IS NULL OR TRIM(NEW.provider_resource_id)=''
        OR NEW.provider_cwd_proof IS NULL OR TRIM(NEW.provider_cwd_proof)=''
        OR NEW.tool_contract_hash IS NULL OR TRIM(NEW.tool_contract_hash)=''
        OR NEW.instruction_sources_hash IS NULL OR TRIM(NEW.instruction_sources_hash)=''
        OR NEW.activation_proof_json IS NULL OR TRIM(NEW.activation_proof_json)=''
      )
      BEGIN
        SELECT RAISE(ABORT, 'START_PROVIDER_PROOF_REQUIRED');
      END;

      CREATE TABLE IF NOT EXISTS work_session_startup_receipts (
        startup_operation_id TEXT PRIMARY KEY,
        provider_binding_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL,
        receipt_schema_version INTEGER NOT NULL CHECK (receipt_schema_version=2),
        receipt_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resource_version INTEGER NOT NULL,
        FOREIGN KEY (startup_operation_id) REFERENCES work_session_startup_operations(startup_operation_id) ON DELETE RESTRICT,
        FOREIGN KEY (provider_binding_id) REFERENCES work_session_startup_bindings(provider_binding_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS work_session_startup_audit (
        audit_id TEXT PRIMARY KEY,
        startup_operation_id TEXT NOT NULL,
        event TEXT NOT NULL,
        actor_logical_session_id TEXT,
        correlation_id TEXT NOT NULL,
        previous_resource_version INTEGER,
        resource_version INTEGER NOT NULL,
        binding_generation INTEGER,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (startup_operation_id) REFERENCES work_session_startup_operations(startup_operation_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_work_session_startup_audit_operation
      ON work_session_startup_audit(startup_operation_id, created_at, audit_id);

      CREATE TRIGGER IF NOT EXISTS work_session_startup_operation_ready_guard
      BEFORE UPDATE OF state ON work_session_startup_operations
      WHEN NEW.state='ready' AND NOT EXISTS (
        SELECT 1 FROM work_session_startup_receipts receipt
        WHERE receipt.startup_operation_id=NEW.startup_operation_id
          AND receipt.provider_binding_id=NEW.provider_binding_id
          AND receipt.binding_generation=NEW.binding_generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'START_RECEIPT_REQUIRED');
      END;

      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL,
        target_task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        PRIMARY KEY (task_id, target_task_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (target_task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

`;
