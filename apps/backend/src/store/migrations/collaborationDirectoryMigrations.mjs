export function ensureCollaborationDirectoryTables({ db }) {
    // --- 合作调度中心（14：协作目录 + 协作会话 + 声誉缓存） ---
    db.run(`
      CREATE TABLE IF NOT EXISTS collaborator_registry (
        entry_type TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'agent',
        capability_tags_json TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        availability TEXT NOT NULL DEFAULT 'idle',
        trust_score REAL NOT NULL DEFAULT 0.5,
        policy_json TEXT NOT NULL DEFAULT '{}',
        endpoint_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (entry_type, entry_id)
      );

      CREATE TABLE IF NOT EXISTS collaboration_sessions (
        id TEXT PRIMARY KEY,
        requester_session_id TEXT,
        requester_work_id TEXT,
        requester_task_id TEXT,
        mode TEXT NOT NULL,
        request_json TEXT NOT NULL DEFAULT '{}',
        candidate_entry_type TEXT,
        candidate_entry_id TEXT,
        status TEXT NOT NULL DEFAULT 'proposed',
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS collab_reputation_cache (
        entry_id TEXT PRIMARY KEY,
        trust_score REAL NOT NULL DEFAULT 0.5,
        sample_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_collaborator_availability
        ON collaborator_registry(entry_type, availability);
    `);
}
