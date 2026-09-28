export function ensureHubFoundationTables({ db }) {
    // --- 统一检索 hub（12：去抖缓存 + Session 活跃工具集） ---
    db.run(`
      CREATE TABLE IF NOT EXISTS hub_intent_cache (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        task_id TEXT,
        work_id TEXT,
        agent_id TEXT,
        intent_hash TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifact_storage_audit_events (
        audit_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (action, storage_key)
      );

      CREATE TABLE IF NOT EXISTS session_active_tools (
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_def_json TEXT NOT NULL DEFAULT '{}',
        registered_at TEXT NOT NULL,
        PRIMARY KEY (session_id, tool_name)
      );

      CREATE INDEX IF NOT EXISTS idx_hub_intent_cache_hash
        ON hub_intent_cache(agent_id, intent_hash);
    `);
}
