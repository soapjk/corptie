// Uses the caller-owned migration connection; no transaction or startup reordering.
export function ensureSkillTables({ db, selectOne, selectAll, ensureColumn }) {
  db.run(`
    CREATE TABLE IF NOT EXISTS mcp_server_registry (
      server_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      transport TEXT NOT NULL CHECK (transport IN ('http', 'sse', 'stdio')),
      command TEXT,
      args_json TEXT NOT NULL DEFAULT '[]',
      cwd TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      tool_count INTEGER NOT NULL,
      verified_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_mcp_assignments (
      agent_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, server_id),
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
      FOREIGN KEY (server_id) REFERENCES mcp_server_registry(server_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_mcp_assignments_server
      ON agent_mcp_assignments(server_id);

    CREATE TABLE IF NOT EXISTS skill_registry (
      skill_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL CHECK (source_type IN ('local', 'git')),
      source TEXT NOT NULL,
      source_subpath TEXT NOT NULL DEFAULT '',
      package_subpath TEXT NOT NULL DEFAULT '',
      mcp_descriptor_subpath TEXT NOT NULL DEFAULT '',
      package_discovery_method TEXT NOT NULL DEFAULT '',
      cache_path TEXT,
      manifest_name TEXT NOT NULL DEFAULT '',
      manifest_description TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_skill_links (
      agent_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, skill_id),
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
      FOREIGN KEY (skill_id) REFERENCES skill_registry(skill_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_skill_links_skill ON agent_skill_links(skill_id);

    CREATE TABLE IF NOT EXISTS skill_deletion_operations (
      operation_id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'cleanup_failed', 'database_failed', 'completed')),
      affected_agents_json TEXT NOT NULL DEFAULT '[]',
      active_sessions_json TEXT NOT NULL DEFAULT '[]',
      cleanup_json TEXT NOT NULL DEFAULT '[]',
      recovery_json TEXT NOT NULL DEFAULT '[]',
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_skill_deletion_operations_skill
    ON skill_deletion_operations(skill_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS skill_runtime_events (
      event_id TEXT PRIMARY KEY,
      stage TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('info', 'success', 'failed', 'denied')),
      error_code TEXT,
      reason TEXT NOT NULL DEFAULT '',
      skill_id TEXT,
      agent_id TEXT,
      session_id TEXT,
      provider_id TEXT,
      server_names_json TEXT NOT NULL DEFAULT '[]',
      tool_count INTEGER,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skill_registry(skill_id) ON DELETE SET NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_runtime_events_skill
    ON skill_runtime_events(skill_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_skill_runtime_events_agent
    ON skill_runtime_events(agent_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_skill_runtime_events_session
    ON skill_runtime_events(session_id, created_at DESC);
  `);
  // Development databases created by the first standalone-HTTP slice have
  // a narrower CHECK constraint. Rebuild only this new registry table so
  // existing remote registrations and Agent links survive the stdio upgrade.
  const mcpSchema = selectOne(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_server_registry'"
  )?.sql ?? "";
  if (!mcpSchema.includes("'stdio'")) {
    db.run("PRAGMA foreign_keys = OFF");
    db.run("BEGIN IMMEDIATE");
    try {
      db.run(`CREATE TABLE mcp_server_registry_stdio_v1 (
        server_id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
        transport TEXT NOT NULL CHECK (transport IN ('http', 'sse', 'stdio')),
        command TEXT, args_json TEXT NOT NULL DEFAULT '[]', cwd TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        tool_count INTEGER NOT NULL, verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      db.run(`INSERT INTO mcp_server_registry_stdio_v1
        (server_id, name, url, transport, enabled, tool_count, verified_at, created_at, updated_at)
        SELECT server_id, name, url, transport, enabled, tool_count, verified_at, created_at, updated_at
        FROM mcp_server_registry`);
      db.run("DROP TABLE mcp_server_registry");
      db.run("ALTER TABLE mcp_server_registry_stdio_v1 RENAME TO mcp_server_registry");
      if (selectAll("PRAGMA foreign_key_check").length > 0) {
        throw new Error("MCP_REGISTRY_MIGRATION_FOREIGN_KEY_FAILURE");
      }
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    } finally {
      db.run("PRAGMA foreign_keys = ON");
    }
  }
  ensureColumn("mcp_server_registry", "last_checked_at", "TEXT");
  ensureColumn("mcp_server_registry", "last_check_status", "TEXT NOT NULL DEFAULT 'available'");
  ensureColumn("mcp_server_registry", "last_error_code", "TEXT");
  ensureColumn("mcp_server_registry", "observed_tool_names_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("mcp_server_registry", "source_kind", "TEXT NOT NULL DEFAULT 'direct'");
  ensureColumn("mcp_server_registry", "source_locator", "TEXT");
  ensureColumn("mcp_server_registry", "source_revision", "TEXT");
  ensureColumn("mcp_server_registry", "package_root", "TEXT");
  ensureColumn("mcp_server_registry", "package_hash", "TEXT");
  ensureColumn("mcp_server_registry", "descriptor_path", "TEXT");
  ensureColumn("mcp_server_registry", "config_revision", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("mcp_server_registry", "credential_ref", "TEXT");
  ensureColumn("mcp_server_registry", "credential_names_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("mcp_server_registry", "install_request_id", "TEXT");
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_server_install_request
    ON mcp_server_registry(install_request_id) WHERE install_request_id IS NOT NULL`);
  ensureColumn("agent_mcp_assignments", "credential_ref", "TEXT");
  ensureColumn("agent_mcp_assignments", "credential_names_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("agent_mcp_assignments", "credential_revision", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("agent_mcp_assignments", "tool_allowlist_json", "TEXT");
  db.run(`CREATE TABLE IF NOT EXISTS mcp_server_package_versions (
    server_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    transport TEXT NOT NULL,
    command TEXT,
    args_json TEXT NOT NULL,
    cwd TEXT,
    tool_count INTEGER NOT NULL,
    verified_at TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_locator TEXT,
    source_revision TEXT,
    package_root TEXT NOT NULL,
    package_hash TEXT NOT NULL,
    descriptor_path TEXT,
    credential_ref TEXT,
    credential_names_json TEXT NOT NULL DEFAULT '[]',
    retained_at TEXT NOT NULL,
    PRIMARY KEY (server_id, revision),
    FOREIGN KEY (server_id) REFERENCES mcp_server_registry(server_id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS mcp_cleanup_queue (
    cleanup_kind TEXT NOT NULL CHECK (cleanup_kind IN ('package_path', 'credential_ref')),
    target TEXT NOT NULL,
    server_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (cleanup_kind, target)
  )`);
  db.run(`CREATE TRIGGER IF NOT EXISTS mcp_assignment_credential_cleanup
    AFTER DELETE ON agent_mcp_assignments
    WHEN OLD.credential_ref IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO mcp_cleanup_queue
        (cleanup_kind, target, server_id, created_at)
      VALUES ('credential_ref', OLD.credential_ref, OLD.server_id,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END`);
  db.run(`CREATE TABLE IF NOT EXISTS mcp_runtime_events (
    event_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    agent_id TEXT,
    provider_id TEXT,
    logical_session_id TEXT,
    provider_binding_id TEXT,
    stage TEXT NOT NULL CHECK (stage IN ('tools-list', 'tool-call')),
    status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
    error_code TEXT,
    tool_name TEXT,
    tool_count INTEGER,
    created_at TEXT NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mcp_runtime_events_server
    ON mcp_runtime_events(server_id, created_at DESC, event_id DESC)`);

  ensureColumn("skill_registry", "source_subpath", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("skill_registry", "package_subpath", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("skill_registry", "mcp_descriptor_subpath", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("skill_registry", "package_discovery_method", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("skill_registry", "manifest_name", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("skill_registry", "manifest_description", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("skill_registry", "content_hash", "TEXT NOT NULL DEFAULT ''");

  // 迁移：删除旧「晋升技能」遗留的 agent_skills 关联表。
  // 该表带 FOREIGN KEY (skill_id) REFERENCES skills(skill_id) ON DELETE CASCADE，
  // 在 PRAGMA foreign_keys=ON 下删除 agents 时会触发 foreign key mismatch，
  // 且其 schema（skills 表）已与 Skill 维护中心彻底分离、无任何调用者，属死表。
  db.run(`DROP TABLE IF EXISTS agent_skills`);
}
