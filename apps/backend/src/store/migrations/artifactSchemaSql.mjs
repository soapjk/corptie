// Schema text is ordered by migrations/index.mjs; execution remains owned by CorptieStore.
export const artifactSchemaSql = `      CREATE TABLE IF NOT EXISTS artifact_patch_operations (
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS artifact_ownership_operations (
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        PRIMARY KEY (session_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS artifact_repository_promotions (
        promotion_id TEXT PRIMARY KEY,
        repository_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        session_id TEXT NOT NULL,
        authorization_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifact_promotion_target ON artifact_repository_promotions(repository_path, target_path, content_hash);
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL CHECK (visibility IN (
          'work_private', 'task_private', 'session_private', 'repository_tracked'
        )),
        scope TEXT NOT NULL DEFAULT 'work',
        kind TEXT NOT NULL DEFAULT 'other',
        category_path TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        aliases_json TEXT NOT NULL DEFAULT '[]',
        keywords_json TEXT NOT NULL DEFAULT '[]',
        bound_task_id TEXT,
        bound_session_id TEXT,
        repository_locator TEXT,
        current_version INTEGER NOT NULL DEFAULT 0,
        approved_version INTEGER,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'revoked')),
        source_session_id TEXT,
        source_event_id TEXT,
        created_by_actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resource_version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
        FOREIGN KEY (bound_task_id) REFERENCES tasks(id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_work
      ON artifacts(work_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_artifacts_work_page
      ON artifacts(work_id, updated_at DESC, artifact_id);

      CREATE TABLE IF NOT EXISTS artifact_versions (
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'text/markdown',
        storage_key TEXT,
        source_session_id TEXT,
        source_event_id TEXT,
        supersedes_version INTEGER,
        approval_status TEXT NOT NULL DEFAULT 'approved'
          CHECK (approval_status IN ('draft', 'approved', 'rejected')),
        created_by_actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (artifact_id, version),
        FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
        FOREIGN KEY (artifact_id, supersedes_version)
          REFERENCES artifact_versions(artifact_id, version) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_versions_storage
      ON artifact_versions(artifact_id, content_hash);

      CREATE INDEX IF NOT EXISTS idx_artifact_versions_storage_key
      ON artifact_versions(storage_key)
      WHERE storage_key IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_artifact_versions_pinned_read
      ON artifact_versions(artifact_id, version, content_hash);

      CREATE TABLE IF NOT EXISTS artifact_references (
        reference_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        task_id TEXT,
        session_id TEXT,
        relation TEXT NOT NULL CHECK (relation IN (
          'implementation_spec', 'security_requirement', 'test_plan', 'research_evidence',
          'handoff', 'acceptance_evidence'
        )),
        required INTEGER NOT NULL DEFAULT 0,
        version_policy TEXT NOT NULL CHECK (version_policy IN ('fixed', 'latest_approved')),
        pinned_version INTEGER NOT NULL,
        pinned_hash TEXT NOT NULL,
        pending_version INTEGER,
        pending_hash TEXT,
        authorized_by_actor_id TEXT NOT NULL,
        authorized_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_by_actor_id TEXT,
        revocation_reason TEXT,
        resource_version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (artifact_id, pinned_version)
          REFERENCES artifact_versions(artifact_id, version) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_references_task
      ON artifact_references(task_id, revoked_at, required, relation);

      CREATE INDEX IF NOT EXISTS idx_artifact_references_work_task
      ON artifact_references(work_id, task_id, revoked_at);

      CREATE INDEX IF NOT EXISTS idx_artifact_references_work_session
      ON artifact_references(work_id, session_id, revoked_at);

      CREATE TABLE IF NOT EXISTS task_file_references (
        reference_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        display_name TEXT NOT NULL,
        relation TEXT NOT NULL CHECK (relation IN (
          'implementation_spec', 'security_requirement', 'test_plan', 'research_evidence',
          'handoff', 'acceptance_evidence'
        )),
        required INTEGER NOT NULL DEFAULT 0,
        byte_length INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        authorized_by_actor_id TEXT NOT NULL,
        authorized_by_session_id TEXT NOT NULL,
        authorized_at TEXT NOT NULL,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE (task_id, canonical_path)
      );

      CREATE INDEX IF NOT EXISTS idx_task_file_references_task
      ON task_file_references(task_id, required, relation, authorized_at);

      CREATE TABLE IF NOT EXISTS artifact_worker_create_operations (
        session_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, idempotency_key),
        UNIQUE (artifact_id),
        UNIQUE (reference_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
        FOREIGN KEY (reference_id) REFERENCES artifact_references(reference_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_worker_create_scope
      ON artifact_worker_create_operations(work_id, task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS artifact_worker_publish_operations (
        actor_scope_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        operation_status TEXT NOT NULL DEFAULT 'completed',
        created_at TEXT NOT NULL,
        PRIMARY KEY (actor_scope_id, idempotency_key),
        UNIQUE (artifact_id, version),
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (artifact_id, version) REFERENCES artifact_versions(artifact_id, version) ON DELETE RESTRICT,
        FOREIGN KEY (reference_id) REFERENCES artifact_references(reference_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_worker_publish_scope
      ON artifact_worker_publish_operations(work_id, task_id, artifact_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS artifact_audit_events (
        audit_id TEXT PRIMARY KEY,
        artifact_id TEXT,
        work_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        session_id TEXT,
        task_id TEXT,
        from_version INTEGER,
        to_version INTEGER,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_audit_work
      ON artifact_audit_events(work_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS artifact_content_operations (
        operation_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        temp_path TEXT NOT NULL,
        final_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'file_committed', 'completed', 'rolled_back')),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifact_usage_events (
        usage_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT,
        operation TEXT NOT NULL,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        byte_length INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (artifact_id, version)
          REFERENCES artifact_versions(artifact_id, version) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS artifact_read_receipts (
        read_receipt_id TEXT PRIMARY KEY,
        logical_session_id TEXT NOT NULL,
        provider_binding_id TEXT NOT NULL,
        turn_execution_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('text', 'base64')),
        reference_id TEXT NOT NULL,
        authorization_revision TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (artifact_id, version)
          REFERENCES artifact_versions(artifact_id, version) ON DELETE RESTRICT,
        FOREIGN KEY (reference_id) REFERENCES artifact_references(reference_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS artifact_turn_read_usage (
        logical_session_id TEXT NOT NULL,
        provider_binding_id TEXT NOT NULL,
        turn_execution_id TEXT NOT NULL,
        unique_bytes INTEGER NOT NULL DEFAULT 0,
        unique_pages INTEGER NOT NULL DEFAULT 0,
        resource_version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (logical_session_id, provider_binding_id, turn_execution_id)
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_read_receipts_boundary
      ON artifact_read_receipts(logical_session_id, artifact_id, version, content_hash, byte_offset, byte_length);

      CREATE INDEX IF NOT EXISTS idx_tasks_work_id ON tasks(work_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_lifecycle_state ON tasks(lifecycle_state);

`;
