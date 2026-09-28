// Schema text is ordered by migrations/index.mjs; execution remains owned by CorptieStore.
export const feishuSchemaSql = `      CREATE TABLE IF NOT EXISTS feishu_bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        profile TEXT NOT NULL UNIQUE,
        app_id TEXT,
        brand TEXT NOT NULL DEFAULT 'feishu',
        managed_profile INTEGER NOT NULL DEFAULT 0,
        remote_name TEXT,
        remote_avatar_url TEXT,
        remote_open_id TEXT,
        remote_activate_status INTEGER,
        transport_type TEXT NOT NULL DEFAULT 'lark-cli',
        enabled INTEGER NOT NULL DEFAULT 0,
        connection_status TEXT NOT NULL DEFAULT 'disabled',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feishu_bindings (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        open_id TEXT NOT NULL,
        chat_id TEXT,
        tenant_key TEXT,
        verified_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(bot_id, open_id),
        FOREIGN KEY (bot_id) REFERENCES feishu_bots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS feishu_pairing_codes (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (bot_id) REFERENCES feishu_bots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS feishu_session_assignments (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL UNIQUE,
        binding_id TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        assigned_at TEXT NOT NULL,
        last_event_sequence INTEGER NOT NULL DEFAULT 0,
        delivery_initialized INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (bot_id) REFERENCES feishu_bots(id) ON DELETE CASCADE,
        FOREIGN KEY (binding_id) REFERENCES feishu_bindings(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS feishu_delivered_items (
        assignment_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY (assignment_id, item_id),
        FOREIGN KEY (assignment_id) REFERENCES feishu_session_assignments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_feishu_pairing_bot
      ON feishu_pairing_codes(bot_id, expires_at);

      CREATE TABLE IF NOT EXISTS feishu_inbound_events (
        event_id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

`;
