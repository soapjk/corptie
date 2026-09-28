export function ensureMemoryFoundationTables({ db }) {
    // --- 三层记忆（13：Work/Task 工作记忆 + Agent 进化记忆） ---
    db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        task_id TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        structured_json TEXT NOT NULL DEFAULT '{}',
        tags_json TEXT NOT NULL DEFAULT '[]',
        base_confidence REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.5,
        recency_score REAL NOT NULL DEFAULT 0,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        source_type TEXT NOT NULL DEFAULT 'user',
        source_session_id TEXT,
        source_event_sequence INTEGER,
        source_event_seqs_json TEXT,
        promotion_status TEXT NOT NULL DEFAULT 'active',
        promoted_skill_id TEXT,
        access_policy TEXT NOT NULL DEFAULT '{}',
        trust_level TEXT NOT NULL DEFAULT 'untrusted',
        expires_at TEXT,
        replaces_memory_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY,
        vector TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(owner_type, owner_id);
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS idx_memories_updated_page ON memories(updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_owner_updated_page
        ON memories(owner_type, owner_id, updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS memory_remember_operations (
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        work_id TEXT,
        memory_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, idempotency_key),
        UNIQUE (memory_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_remember_operations_work
      ON memory_remember_operations(work_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_audit (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        reason TEXT,
        before_json TEXT,
        after_json TEXT,
        rollback_of TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_audit_memory ON memory_audit(memory_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_recall_audit (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        phase TEXT NOT NULL,
        mode TEXT NOT NULL,
        reason TEXT NOT NULL,
        scope_json TEXT NOT NULL DEFAULT '{}',
        candidate_ids_json TEXT NOT NULL DEFAULT '[]',
        selected_ids_json TEXT NOT NULL DEFAULT '[]',
        diagnostics_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_recall_session ON memory_recall_audit(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS platform_admin_operations (
        operation_id TEXT PRIMARY KEY,
        actor_session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        target_version TEXT,
        idempotency_key TEXT,
        request_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (actor_session_id, idempotency_key),
        FOREIGN KEY (actor_session_id) REFERENCES sessions(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_platform_admin_operations_session
      ON platform_admin_operations(actor_session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS platform_admin_confirmations (
        confirmation_id TEXT PRIMARY KEY,
        actor_session_id TEXT NOT NULL,
        operation_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'consumed', 'rejected')),
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        consumed_at TEXT,
        FOREIGN KEY (actor_session_id) REFERENCES sessions(id) ON DELETE RESTRICT
      );
    `);

    // --- 晋升技能（13.7：Agent 能力类记忆晋升为可发现技能，对接 12 hub） ---
    db.run(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scenario TEXT NOT NULL DEFAULT '',
        trigger_condition TEXT NOT NULL DEFAULT '',
        steps_json TEXT NOT NULL DEFAULT '[]',
        risk_level TEXT NOT NULL DEFAULT 'moderate',
        source_memory_id TEXT,
        source_agent_id TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_memory_id) REFERENCES memories(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_skills_agent ON skills(source_agent_id);
      CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
    `);
}
