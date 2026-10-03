import { randomUUID } from "node:crypto";

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

      CREATE TABLE IF NOT EXISTS memory_extraction_progress (
        session_id TEXT PRIMARY KEY,
        last_event_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_extraction_metadata (
        key TEXT PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS memory_backfill_progress (
        session_id TEXT PRIMARY KEY,
        last_event_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_extraction_jobs (
        session_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        retry_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_extraction_jobs_queue
        ON memory_extraction_jobs(state, retry_at, created_at);

      CREATE TABLE IF NOT EXISTS memory_extraction_daily_budget (
        day TEXT PRIMARY KEY,
        calls INTEGER NOT NULL DEFAULT 0
      );

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
      CREATE INDEX IF NOT EXISTS idx_memory_recall_startup_phase
        ON memory_recall_audit(session_id, phase) WHERE phase = 'startup';

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

    // Existing Session history is deliberately excluded from automatic extraction.
    // A later, explicitly scoped backfill may reset a Session's cursor to zero.
    db.run(`
      INSERT OR IGNORE INTO memory_extraction_progress (session_id, last_event_sequence, updated_at)
      SELECT events.session_id, MAX(events.sequence), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM session_events AS events
      JOIN sessions ON sessions.id = events.session_id
      WHERE NOT EXISTS (SELECT 1 FROM memory_extraction_metadata WHERE key = 'initial_baseline')
      GROUP BY events.session_id;
      INSERT OR IGNORE INTO memory_extraction_metadata (key) VALUES ('initial_baseline');
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

export function quarantineLegacyExtractionNoise({ db, selectAll, runDataMigrationOnce }) {
  runDataMigrationOnce("memory-extraction-source-quarantine-v1", () => {
    const rows = selectAll(`SELECT * FROM memories
      WHERE source_type = 'extracted' AND promotion_status = 'candidate'
        AND (CASE WHEN json_valid(structured_json)
          THEN json_extract(structured_json, '$.extraction.eventType') ELSE NULL END)
          NOT IN ('SessionUserMessageCreated', 'user.message.accepted')`);
    const updatedAt = new Date().toISOString();
    for (const before of rows) {
      const after = { ...before, promotion_status: "archived",
        version: Number(before.version ?? 1) + 1, updated_at: updatedAt };
      db.run(`UPDATE memories SET promotion_status = 'archived', version = ?, updated_at = ?
        WHERE id = ? AND promotion_status = 'candidate'`, [after.version, updatedAt, before.id]);
      db.run(`INSERT INTO memory_audit
        (id, memory_id, action, actor_type, reason, before_json, after_json, created_at)
        VALUES (?, ?, 'quarantine_extraction', 'system', ?, ?, ?, ?)`,
      [`memory-audit:${randomUUID()}`, before.id,
        "Legacy automatic extraction used a non-user event; retained for review but excluded from active candidates.",
        JSON.stringify(before), JSON.stringify(after), updatedAt]);
    }
  });
}

export function quarantinePreModelExtractionCandidates({ db, selectAll, runDataMigrationOnce }) {
  runDataMigrationOnce("memory-model-extraction-quarantine-v2", () => {
    const rows = selectAll(`SELECT * FROM memories
      WHERE source_type = 'extracted' AND promotion_status = 'candidate'`);
    const updatedAt = new Date().toISOString();
    for (const before of rows) {
      const after = { ...before, promotion_status: "archived",
        version: Number(before.version ?? 1) + 1, updated_at: updatedAt };
      db.run(`UPDATE memories SET promotion_status = 'archived', version = ?, updated_at = ?
        WHERE id = ? AND promotion_status = 'candidate'`, [after.version, updatedAt, before.id]);
      db.run(`INSERT INTO memory_audit
        (id, memory_id, action, actor_type, reason, before_json, after_json, created_at)
        VALUES (?, ?, 'quarantine_pre_model_extraction', 'system', ?, ?, ?, ?)`,
      [`memory-audit:${randomUUID()}`, before.id,
        "Pre-model automatic candidate retained for audit but excluded from review and recall.",
        JSON.stringify(before), JSON.stringify(after), updatedAt]);
    }
  });
}
