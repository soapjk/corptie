// Schema text is ordered by migrations/index.mjs; execution remains owned by CorptieStore.
export const registrySchemaSql = `      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        agent_kind TEXT NOT NULL DEFAULT 'user',
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'agent',
        status TEXT NOT NULL DEFAULT 'available'
          CHECK (status IN ('available', 'busy', 'offline', 'inactive')),
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        work_dir TEXT,
        avatar_path TEXT,
        current_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_creation_requests (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        device_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_creation_requests_agent
      ON agent_creation_requests(agent_id, created_at);

      CREATE TABLE IF NOT EXISTS data_migrations (
        migration_id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS legacy_history_repairs (
        session_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        binding_id TEXT,
        provider_session_id TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('imported', 'no_history', 'unsupported', 'unavailable', 'failed', 'conflict', 'rolled_back')),
        source_item_count INTEGER NOT NULL DEFAULT 0,
        imported_item_count INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        failure_code TEXT,
        failure_message TEXT,
        first_attempted_at TEXT NOT NULL,
        last_attempted_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS legacy_history_repair_items (
        session_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        inserted_at TEXT NOT NULL,
        PRIMARY KEY (session_id, item_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_legacy_history_repairs_status
      ON legacy_history_repairs(status, last_attempted_at);

      CREATE TABLE IF NOT EXISTS agent_sessions (
        binding_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        bound_at TEXT NOT NULL,
        unbound_at TEXT,
        FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_current_session
      ON agent_sessions(session_id) WHERE unbound_at IS NULL;

`;
