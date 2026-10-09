// Schema text is ordered by migrations/index.mjs; execution remains owned by CorptieStore.
export const sessionSchemaSql = `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agent TEXT NOT NULL,
        provider TEXT NOT NULL,
        command TEXT,
        args_json TEXT NOT NULL DEFAULT '[]',
        cwd TEXT,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        accent TEXT NOT NULL DEFAULT 'cyan',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        sort_order REAL,
        active_choice_json TEXT,
        raw_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS session_capability_grants (
        session_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        granted_by_session_id TEXT,
        revoked_at TEXT,
        PRIMARY KEY (session_id, capability),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_capability_grants_active
      ON session_capability_grants(session_id, capability)
      WHERE revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS session_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        turn_status TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        options_json TEXT,
        raw_metadata_json TEXT,
        binding_id TEXT,
        presentation_role TEXT,
        presentation_text TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS deleted_user_messages (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        PRIMARY KEY(session_id, message_id)
      );
      CREATE TRIGGER IF NOT EXISTS deleted_user_message_no_reprojection
      BEFORE INSERT ON session_items
      WHEN EXISTS (SELECT 1 FROM deleted_user_messages d
        WHERE d.session_id = NEW.session_id AND d.message_id = NEW.id)
      BEGIN SELECT RAISE(IGNORE); END;

      CREATE TABLE IF NOT EXISTS session_fork_operations (
        request_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_binding_id TEXT NOT NULL,
        source_item_id TEXT NOT NULL,
        target_task_id TEXT UNIQUE,
        target_session_id TEXT,
        state TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_fork_target ON session_fork_operations(target_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_items_session_id ON session_items(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_session_items_latest
      ON session_items(session_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_session_items_turn_window
      ON session_items(session_id, turn_id, created_at, id);

      -- Provider task lists can outlive one turn. Keep their current state
      -- separate from immutable per-turn Timeline placement.
      CREATE TABLE IF NOT EXISTS session_execution_plan_state (
        session_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        plan_key TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, binding_id, plan_key),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_context_references (
        reference_id TEXT PRIMARY KEY,
        owner_session_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_key TEXT NOT NULL,
        target_id TEXT,
        locator TEXT,
        display_name TEXT NOT NULL,
        inclusion_mode TEXT NOT NULL DEFAULT 'default',
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 100,
        status TEXT NOT NULL DEFAULT 'available',
        snapshot_title TEXT,
        snapshot_text TEXT,
        snapshot_at TEXT,
        content_hash TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (owner_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE(owner_session_id, target_type, target_key)
      );

      CREATE INDEX IF NOT EXISTS idx_session_context_references_owner
      ON session_context_references(owner_session_id, enabled, priority, created_at);

      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        source_json TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        storage_version INTEGER NOT NULL DEFAULT 1,
        has_agent_message INTEGER NOT NULL DEFAULT 0 CHECK (has_agent_message IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_cursor
      ON session_events(session_id, sequence);

      CREATE TABLE IF NOT EXISTS session_read_receipts (
        session_id TEXT PRIMARY KEY,
        last_read_agent_message_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_logs_session_id ON session_logs(session_id);

      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_runtime_release_receipts (
        session_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        released_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_runtime_release_receipts_released
        ON session_runtime_release_receipts(released_at DESC);

`;
