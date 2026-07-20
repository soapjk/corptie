import { readFileSync } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import { backup, DatabaseSync } from "node:sqlite";
import { createdAtFrom, createdAtFromOrNow } from "../utils/timestamps.mjs";

const environmentName = normalizeEnvironment(process.env.CORPTIE_ENV);
const appSupportName = environmentName === "development" ? "Corptie Development" : "Corptie";
const legacyAppSupportName = environmentName === "development" ? "Copets Development" : "Copets";
const appSupportDir = join(os.homedir(), "Library", "Application Support", appSupportName);
const legacyAppSupportDir = join(os.homedir(), "Library", "Application Support", legacyAppSupportName);
const legacyDbPath = join(legacyAppSupportDir, "copets.sqlite");
const configPath = join(appSupportDir, "config.json");
const legacyConfigPath = join(legacyAppSupportDir, "config.json");
const fallbackDataDir = appSupportDir;
const fallbackLogDir = join(os.homedir(), "Library", "Logs", appSupportName);
const dbFileName = "corptie.sqlite";

export class CorptieStore {
  constructor(options = {}) {
    this.configPath = options.configPath || process.env.CORPTIE_CONFIG_PATH || configPath;
    this.dataDir = null;
    this.dbPath = options.dbPath || process.env.CORPTIE_DB_PATH || null;
    this.db = null;
    this.config = {};
  }

  async initialize() {
    await this.resolveDataPath();
    await mkdir(dirname(this.dbPath), { recursive: true });
    this.db = new NativeDatabase(this.dbPath);
    try {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA synchronous = FULL");
      this.db.run("PRAGMA busy_timeout = 5000");
      this.migrate();
    } catch (error) {
      this.db.close();
      this.db = null;
      throw error;
    }
  }

  async resolveDataPath() {
    if (this.dbPath) {
      this.dataDir = dirname(this.dbPath);
      return;
    }

    const configured = await this.readConfiguredDataDir();
    this.dataDir = configured || await defaultDataDir();
    this.dbPath = join(this.dataDir, dbFileName);
    const legacyDataDbPath = join(this.dataDir, "copets.sqlite");

    if (this.dbPath !== legacyDataDbPath && await exists(legacyDataDbPath) && !await exists(this.dbPath)) {
      await mkdir(this.dataDir, { recursive: true });
      await copyFile(legacyDataDbPath, this.dbPath);
      if (!configured) {
        await this.writeConfig();
      }
      return;
    }

    if (!configured && this.dbPath !== legacyDbPath && await exists(legacyDbPath) && !await exists(this.dbPath)) {
      await mkdir(this.dataDir, { recursive: true });
      await copyFile(legacyDbPath, this.dbPath);
      await this.writeConfig();
    }
  }

  async readConfiguredDataDir() {
    try {
      this.config = JSON.parse(await readFile(this.configPath, "utf8"));
      return typeof this.config.dataDir === "string" && this.config.dataDir.trim() ? this.config.dataDir.trim() : null;
    } catch {
      try {
        this.config = JSON.parse(await readFile(legacyConfigPath, "utf8"));
        return typeof this.config.dataDir === "string" && this.config.dataDir.trim() ? this.config.dataDir.trim() : null;
      } catch {
        this.config = {};
        return null;
      }
    }
  }

  async writeConfig() {
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, JSON.stringify({
      ...this.config,
      dataDir: this.dataDir
    }, null, 2));
  }

  settings() {
    return {
      environment: environmentName,
      configPath: this.configPath,
      dataDir: this.dataDir,
      dbPath: this.dbPath,
      logDir: this.logDirectory(),
      logPaths: this.logPaths(),
      legacyDbPath,
      choiceParser: this.choiceParserSettings(),
      codexBackend: this.codexBackendSettings(),
      codeDiff: this.codeDiffSettings(),
      agentProxy: this.agentProxySettings(),
      gateway: this.gatewaySettings()
    };
  }

  choiceParserSettings() {
    const configured = this.config.choiceParser ?? {};
    return normalizeChoiceParserSettings(configured);
  }

  codexBackendSettings() {
    return normalizeCodexBackendSettings(this.config.codexBackend ?? {});
  }

  codeDiffSettings() {
    return normalizeCodeDiffSettings(this.config.codeDiff ?? {});
  }

  agentProxySettings() {
    const configured = this.config.agentProxy ?? {};
    return normalizeAgentProxySettings(configured);
  }

  gatewaySettings() {
    return normalizeGatewaySettings(this.config.gateway ?? {});
  }

  logDirectory() {
    return typeof this.config.logDir === "string" && this.config.logDir.trim()
      ? this.config.logDir.trim()
      : fallbackLogDir;
  }

  logPaths() {
    const directory = this.logDirectory();
    return {
      stdout: join(directory, "backend.out.log"),
      stderr: join(directory, "backend.err.log")
    };
  }

  async updateSettings(input = {}) {
    if (typeof input.dataDir === "string" && input.dataDir.trim()) {
      await this.setDataDirectory(input.dataDir);
    }
    if (typeof input.logDir === "string" && input.logDir.trim()) {
      await this.setLogDirectory(input.logDir);
    }
    if (input.choiceParser && typeof input.choiceParser === "object") {
      this.config.choiceParser = normalizeChoiceParserSettings(input.choiceParser);
      await this.writeConfig();
    }
    if (input.codexBackend && typeof input.codexBackend === "object") {
      this.config.codexBackend = normalizeCodexBackendSettings(input.codexBackend);
      await this.writeConfig();
    }
    if (input.codeDiff && typeof input.codeDiff === "object") {
      this.config.codeDiff = normalizeCodeDiffSettings(input.codeDiff);
      await this.writeConfig();
    }
    if (input.agentProxy && typeof input.agentProxy === "object") {
      this.config.agentProxy = normalizeAgentProxySettings(input.agentProxy);
      await this.writeConfig();
    }
    if (input.gateway && typeof input.gateway === "object") {
      this.config.gateway = normalizeGatewaySettings(input.gateway);
      await this.writeConfig();
    }
    return this.settings();
  }

  async setDataDirectory(dataDir) {
    const nextDir = dataDir.trim();
    if (!nextDir) {
      throw new Error("Data directory is required.");
    }

    await mkdir(nextDir, { recursive: true });
    const nextDbPath = join(nextDir, dbFileName);
    if (nextDbPath === this.dbPath) return this.settings();

    await backup(this.db.database, nextDbPath);
    this.db.close();
    this.dataDir = nextDir;
    this.dbPath = nextDbPath;
    this.db = new NativeDatabase(this.dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = FULL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA foreign_keys = ON");
    await this.writeConfig();
    return this.settings();
  }

  async setLogDirectory(logDir) {
    const nextDir = logDir.trim();
    if (!nextDir) throw new Error("Log directory is required.");
    await mkdir(nextDir, { recursive: true });
    this.config.logDir = nextDir;
    await this.writeConfig();
    return this.settings();
  }

  migrate() {
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`
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
        avatar_path TEXT,
        active_choice_json TEXT,
        raw_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS session_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        turn_status TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        options_json TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_items_session_id ON session_items(session_id, created_at);

      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        source_json TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_cursor
      ON session_events(session_id, sequence);

      CREATE TABLE IF NOT EXISTS feishu_bots (
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
        FOREIGN KEY (bot_id) REFERENCES feishu_bots(id) ON DELETE CASCADE,
        FOREIGN KEY (binding_id) REFERENCES feishu_bindings(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_feishu_pairing_bot
      ON feishu_pairing_codes(bot_id, expires_at);

      CREATE TABLE IF NOT EXISTS feishu_inbound_events (
        event_id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'available'
          CHECK (status IN ('available', 'busy', 'offline', 'inactive')),
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        current_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        binding_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        bound_at TEXT NOT NULL,
        unbound_at TEXT,
        FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_current_agent
      ON agent_sessions(agent_id) WHERE unbound_at IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_current_session
      ON agent_sessions(session_id) WHERE unbound_at IS NULL;

      CREATE TABLE IF NOT EXISTS services (
        service_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner_agent_id TEXT NOT NULL,
        current_version TEXT,
        status TEXT NOT NULL DEFAULT 'unknown'
          CHECK (status IN ('unknown', 'stopped', 'starting', 'running', 'degraded', 'failed', 'inactive')),
        endpoint TEXT,
        repository_root TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (owner_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS service_consumers (
        service_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (service_id, agent_id),
        FOREIGN KEY (service_id) REFERENCES services(service_id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS collaboration_contexts (
        context_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collaboration_tasks (
        task_id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        parent_task_id TEXT,
        initiator_agent_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        service_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('question', 'change_request')),
        status TEXT NOT NULL DEFAULT 'proposed'
          CHECK (status IN ('proposed', 'needs_information', 'accepted', 'working', 'delivered', 'verifying', 'revision_requested', 'completed', 'rejected', 'canceled', 'escalated')),
        iteration INTEGER NOT NULL DEFAULT 1 CHECK (iteration >= 1),
        max_iterations INTEGER NOT NULL DEFAULT 3 CHECK (max_iterations >= 1),
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (context_id) REFERENCES collaboration_contexts(context_id) ON DELETE RESTRICT,
        FOREIGN KEY (parent_task_id) REFERENCES collaboration_tasks(task_id) ON DELETE SET NULL,
        FOREIGN KEY (initiator_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (recipient_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (service_id) REFERENCES services(service_id) ON DELETE RESTRICT,
        UNIQUE (initiator_agent_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_tasks_inbox
      ON collaboration_tasks(recipient_agent_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_collaboration_tasks_outbox
      ON collaboration_tasks(initiator_agent_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS collaboration_request_confirmations (
        confirmation_id TEXT PRIMARY KEY,
        initiator_agent_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        source_session_id TEXT,
        source_turn_id TEXT,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'confirmed', 'rejected')),
        task_id TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (initiator_agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
        FOREIGN KEY (recipient_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (task_id) REFERENCES collaboration_tasks(task_id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_request_confirmations_session
      ON collaboration_request_confirmations(source_session_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS collaboration_participants (
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('initiator', 'recipient')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, agent_id),
        FOREIGN KEY (task_id) REFERENCES collaboration_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS collaboration_messages (
        message_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        sender_agent_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        message_type TEXT NOT NULL
          CHECK (message_type IN ('question', 'change_request', 'needs_information', 'update_ready', 'verification_result')),
        body TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        resource_version TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES collaboration_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (sender_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (recipient_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        UNIQUE (sender_agent_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_messages_task
      ON collaboration_messages(task_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS collaboration_artifacts (
        artifact_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        producer_agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        uri TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES collaboration_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (producer_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_artifacts_task
      ON collaboration_artifacts(task_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS collaboration_deliveries (
        delivery_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'queued', 'delivering', 'delivered', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        delivered_at TEXT,
        target_turn_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES collaboration_messages(message_id) ON DELETE CASCADE,
        FOREIGN KEY (recipient_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        UNIQUE (message_id, recipient_agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_deliveries_pending
      ON collaboration_deliveries(status, next_attempt_at, created_at ASC);

      CREATE TABLE IF NOT EXISTS agent_work_items (
        work_item_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'collaboration')),
        priority INTEGER NOT NULL,
        text TEXT NOT NULL,
        source_json TEXT NOT NULL DEFAULT '{}',
        local_visibility TEXT NOT NULL DEFAULT 'normal'
          CHECK (local_visibility IN ('normal', 'status_only')),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        delivery_id TEXT,
        target_turn_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
        FOREIGN KEY (delivery_id) REFERENCES collaboration_deliveries(delivery_id) ON DELETE CASCADE,
        UNIQUE (delivery_id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_work_items_next
      ON agent_work_items(agent_id, status, priority DESC, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_agent_work_items_session_turn
      ON agent_work_items(session_id, target_turn_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_work_items_one_running
      ON agent_work_items(agent_id) WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS collaboration_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        actor_agent_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES collaboration_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (actor_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        UNIQUE (task_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_events_task
      ON collaboration_events(task_id, sequence ASC);
    `);

    this.ensureColumn("sessions", "archived", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "pinned", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "sort_order", "REAL");
    this.ensureColumn("sessions", "avatar_path", "TEXT");
    this.ensureColumn("sessions", "active_choice_json", "TEXT");
    this.ensureColumn("session_items", "options_json", "TEXT");
    this.ensureColumn("feishu_bindings", "chat_id", "TEXT");
    this.ensureColumn("feishu_bots", "app_id", "TEXT");
    this.ensureColumn("feishu_bots", "brand", "TEXT NOT NULL DEFAULT 'feishu'");
    this.ensureColumn("feishu_bots", "managed_profile", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("feishu_bots", "remote_name", "TEXT");
    this.ensureColumn("feishu_bots", "remote_avatar_url", "TEXT");
    this.ensureColumn("feishu_bots", "remote_open_id", "TEXT");
    this.ensureColumn("feishu_bots", "remote_activate_status", "INTEGER");
    this.initializeSortOrder();
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sessions_archived_order ON sessions(archived, pinned DESC, sort_order ASC)");

    this.db.run(
      `UPDATE sessions
       SET status = CASE
             WHEN provider = 'codex-pty' THEN 'blocked'
             ELSE 'cancelled'
           END,
           summary = CASE
             WHEN provider = 'codex-pty' THEN 'Codex is waiting for your next instruction.'
             WHEN summary = '' THEN 'Terminal process is no longer attached.'
             ELSE summary
           END
       WHERE status = 'running'`
    );
    const restartTimestamp = new Date().toISOString();
    this.db.run(
      `UPDATE agent_work_items
       SET status = 'cancelled', completed_at = ?,
           last_error = COALESCE(last_error, 'Execution interrupted by process restart after dispatch; message was not resent.'),
           updated_at = ?
       WHERE status = 'running'
         AND kind = 'user'
         AND target_turn_id IS NOT NULL`,
      [restartTimestamp, restartTimestamp]
    );
    this.db.run(
      `UPDATE agent_work_items
       SET status = 'queued', started_at = NULL, target_turn_id = NULL,
           last_error = COALESCE(last_error, 'Execution interrupted by process restart before dispatch.'),
           updated_at = ?
       WHERE status = 'running'`,
      [restartTimestamp]
    );
    this.db.run(
      `UPDATE collaboration_tasks
       SET status = 'completed',
           completed_at = COALESCE(
             completed_at,
             (SELECT MAX(m.created_at) FROM collaboration_messages m
              WHERE m.task_id = collaboration_tasks.task_id
                AND m.sender_agent_id = collaboration_tasks.recipient_agent_id
                AND m.message_type = 'question')
           ),
           updated_at = COALESCE(
             (SELECT MAX(m.created_at) FROM collaboration_messages m
              WHERE m.task_id = collaboration_tasks.task_id
                AND m.sender_agent_id = collaboration_tasks.recipient_agent_id
                AND m.message_type = 'question'),
             updated_at
           )
       WHERE type = 'question'
         AND status IN ('accepted', 'working')
         AND EXISTS (
           SELECT 1 FROM collaboration_messages m
           WHERE m.task_id = collaboration_tasks.task_id
             AND m.sender_agent_id = collaboration_tasks.recipient_agent_id
             AND m.message_type = 'question'
         )`
    );
  }

  async save() {
    this.db.checkpoint();
  }

  scheduleSave() {
    // Native SQLite commits each statement directly to the WAL. This method is
    // kept as a compatibility hook for callers that previously scheduled a
    // full in-memory database export.
  }

  async close() {
    if (!this.db) return;
    await this.save();
    this.db.close();
    this.db = null;
  }

  upsertSession(session) {
    const summary = toSessionSummary(session);
    this.db.run(
      `INSERT INTO sessions (
        id, title, agent, provider, command, args_json, cwd, status, progress, summary, accent, created_at, updated_at, archived, pinned, sort_order, avatar_path, active_choice_json, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        agent=excluded.agent,
        provider=excluded.provider,
        command=excluded.command,
        args_json=excluded.args_json,
        cwd=excluded.cwd,
        status=excluded.status,
        progress=excluded.progress,
        summary=excluded.summary,
        accent=excluded.accent,
        updated_at=excluded.updated_at,
        archived=excluded.archived,
        pinned=excluded.pinned,
        sort_order=excluded.sort_order,
        avatar_path=excluded.avatar_path,
        active_choice_json=excluded.active_choice_json,
        raw_json=excluded.raw_json`,
      [
        session.id,
        session.title,
        session.agentName || session.agent || "Agent",
        session.provider || session.external?.provider || "unknown",
        session.command || session.external?.source || null,
        JSON.stringify(session.args || []),
        session.cwd || session.external?.cwd || null,
        summary.status,
        summary.progress,
        summary.summary,
        session.accent || summary.accent || "cyan",
        createdAtFromOrNow(session.createdAt, session.updatedAt),
        createdAtFromOrNow(session.updatedAt),
        session.archived ? 1 : 0,
        session.pinned ? 1 : 0,
        Number.isFinite(session.sortOrder) ? session.sortOrder : this.nextTopSortOrder(session.archived === true),
        session.avatarPath ?? session.external?.avatarPath ?? null,
        serializeActiveChoicePrompt(summary.suggestedOptions, summary.summary, session.activeChoicePrompt),
        JSON.stringify(toRawStatus(session))
      ]
    );
    this.scheduleSave();
  }

  appendItem(sessionId, item) {
    const createdAt = createdAtFromOrNow(item);
    this.db.run(
      `INSERT OR REPLACE INTO session_items (
        id, session_id, turn_id, turn_status, type, title, text, options_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        sessionId,
        item.turnId || sessionId,
        item.turnStatus || "running",
        item.type || "terminalOutput",
        item.title || "Agent",
        item.text || "",
        Array.isArray(item.options) ? JSON.stringify(item.options) : null,
        item.status || null,
        createdAt
      ]
    );
    this.scheduleSave();
  }

  removeItem(sessionId, itemId) {
    this.db.run("DELETE FROM session_items WHERE session_id = ? AND id = ?", [sessionId, itemId]);
    this.scheduleSave();
  }

  getQueuedItems(sessionId) {
    return this.selectAll(
      `SELECT * FROM session_items
       WHERE session_id = ? AND status = 'queued'
       ORDER BY created_at ASC`,
      [sessionId]
    ).map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      turnStatus: row.turn_status,
      type: row.type,
      title: row.title,
      text: row.text,
      status: row.status,
      createdAt: row.created_at
    }));
  }

  enqueueAgentWorkItem(item) {
    const timestamp = createdAtFromOrNow(item.createdAt);
    this.db.run(
      `INSERT OR IGNORE INTO agent_work_items (
        work_item_id, agent_id, session_id, kind, priority, text, source_json,
        local_visibility, status, delivery_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      [
        item.workItemId,
        item.agentId,
        item.sessionId,
        item.kind,
        Number(item.priority),
        item.text,
        JSON.stringify(item.source ?? {}),
        item.localVisibility ?? "normal",
        item.deliveryId ?? null,
        timestamp,
        timestamp
      ]
    );
    const inserted = this.db.getRowsModified() > 0;
    if (inserted) this.scheduleSave();
    return inserted
      ? this.getAgentWorkItem(item.workItemId)
      : (item.deliveryId ? this.getAgentWorkItemForDelivery(item.deliveryId) : this.getAgentWorkItem(item.workItemId));
  }

  getAgentWorkItem(workItemId) {
    const row = this.selectOne("SELECT * FROM agent_work_items WHERE work_item_id = ?", [workItemId]);
    return row ? agentWorkItemFromRow(row) : null;
  }

  getAgentWorkItemForDelivery(deliveryId) {
    const row = this.selectOne("SELECT * FROM agent_work_items WHERE delivery_id = ?", [deliveryId]);
    return row ? agentWorkItemFromRow(row) : null;
  }

  getAgentWorkItemForTurn(sessionId, turnId) {
    if (!turnId) return null;
    const row = this.selectOne(
      "SELECT * FROM agent_work_items WHERE session_id = ? AND target_turn_id = ? ORDER BY created_at DESC LIMIT 1",
      [sessionId, turnId]
    );
    return row ? agentWorkItemFromRow(row) : null;
  }

  getRunningAgentWorkItemForSession(sessionId) {
    const row = this.selectOne(
      "SELECT * FROM agent_work_items WHERE session_id = ? AND status = 'running' ORDER BY started_at ASC LIMIT 1",
      [sessionId]
    );
    return row ? agentWorkItemFromRow(row) : null;
  }

  listAgentWorkItemsForSession(sessionId, options = {}) {
    const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
      ? options.statuses
      : ["queued", "running", "completed", "failed", "cancelled"];
    const placeholders = statuses.map(() => "?").join(", ");
    return this.selectAll(
      `SELECT * FROM agent_work_items WHERE session_id = ? AND status IN (${placeholders})
       ORDER BY created_at ASC`,
      [sessionId, ...statuses]
    ).map(agentWorkItemFromRow);
  }

  listQueuedAgentWorkItems(agentId, limit = 100) {
    return this.selectAll(
      `SELECT * FROM agent_work_items WHERE agent_id = ? AND status = 'queued'
       ORDER BY priority DESC, created_at ASC, work_item_id ASC LIMIT ?`,
      [agentId, Math.max(1, Math.min(1000, Number(limit) || 100))]
    ).map(agentWorkItemFromRow);
  }

  listAgentIdsWithQueuedWork() {
    return this.selectAll(
      "SELECT DISTINCT agent_id FROM agent_work_items WHERE status = 'queued' ORDER BY agent_id ASC"
    ).map((row) => row.agent_id);
  }

  claimAgentWorkItem(workItemId) {
    const item = this.getAgentWorkItem(workItemId);
    if (!item) return null;
    const timestamp = new Date().toISOString();
    this.db.run(
      `UPDATE agent_work_items SET status = 'running', started_at = ?, updated_at = ?, last_error = NULL
       WHERE work_item_id = ? AND status = 'queued'
         AND NOT EXISTS (
           SELECT 1 FROM agent_work_items running
           WHERE running.agent_id = ? AND running.status = 'running'
         )`,
      [timestamp, timestamp, workItemId, item.agentId]
    );
    if (this.db.getRowsModified() === 0) return null;
    this.scheduleSave();
    return this.getAgentWorkItem(workItemId);
  }

  updateAgentWorkItem(workItemId, patch = {}) {
    const item = this.getAgentWorkItem(workItemId);
    if (!item) return null;
    const status = patch.status ?? item.status;
    const timestamp = new Date().toISOString();
    const completedAt = Object.hasOwn(patch, "completedAt")
      ? patch.completedAt
      : (["completed", "failed", "cancelled"].includes(status) ? timestamp : item.completedAt);
    this.db.run(
      `UPDATE agent_work_items SET status = ?, target_turn_id = ?, last_error = ?,
       started_at = ?, completed_at = ?, updated_at = ? WHERE work_item_id = ?`,
      [
        status,
        Object.hasOwn(patch, "targetTurnId") ? patch.targetTurnId : item.targetTurnId,
        Object.hasOwn(patch, "lastError") ? patch.lastError : item.lastError,
        Object.hasOwn(patch, "startedAt") ? patch.startedAt : item.startedAt,
        completedAt,
        timestamp,
        workItemId
      ]
    );
    this.scheduleSave();
    return this.getAgentWorkItem(workItemId);
  }

  listSessions(options = {}) {
    const archived = options.archived === true ? 1 : 0;
    const rows = this.selectAll(
      "SELECT * FROM sessions WHERE archived = ? ORDER BY pinned DESC, sort_order ASC, updated_at DESC",
      [archived]
    );
    return rows.map((row) => this.rowToSession(row));
  }

  getSession(id) {
    const row = this.selectOne("SELECT * FROM sessions WHERE id = ?", [id]);
    return row ? this.rowToSession(row) : null;
  }

  getItems(sessionId, limit = 240, provider = "") {
    const rows = this.selectAll(
      `SELECT * FROM session_items WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
      [sessionId, limit]
    );
    const items = rows
      .map((row) => ({
        id: row.id,
        turnId: row.turn_id,
        turnStatus: row.turn_status,
        type: row.type,
        title: row.title,
        text: normalizeStoredText(row.text, provider),
        options: parseJson(row.options_json, null),
        status: row.status,
        createdAt: row.created_at
      }))
      .filter((item) => item.text)
      .filter((item) => !isAgentNoise(item.text))
      .filter((item) => !(provider === "codex-pty" && item.type === "userMessage" && item.status !== "sent"))
      .map((item) => normalizeStoredItem(item, provider))
      .filter((item, index, items) => !isAdjacentDuplicateUserMessage(item, items[index - 1]));
    return cleanReplayItems(items, provider);
  }

  getDetail(id) {
    const session = this.getSession(id);
    if (!session) {
      return null;
    }

    return {
      id,
      title: session.title,
      status: session.external?.provider === "claude-sdk" && session.status === "running" ? "failed" : session.status,
      source: session.external?.provider,
      connectionStatus: session.external?.provider === "claude-sdk" ? "disconnected" : "pty disconnected",
      currentModel: session.external?.currentModel ?? session.rawStatus?.currentModel ?? session.rawStatus?.resume?.currentModel ?? null,
      cwd: session.external?.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      rawStatus: session.rawStatus,
      capabilities: session.external?.provider === "claude-sdk"
        ? capabilitiesForStoredProvider(session.external?.provider, session.status)
        : session.rawStatus?.capabilities ?? capabilitiesForStoredProvider(session.external?.provider, session.status),
      canSend: false,
      sendUnavailableReason: session.external?.provider === "codex-pty" && session.rawStatus?.canResume === false
        ? "This Codex PTY session was not bound to a Codex session id and cannot be reconnected."
        : session.external?.provider === "claude-sdk"
          ? "This Claude Code session is no longer connected. Start a new Claude session to continue."
        : "This session is not currently attached to a running terminal process.",
      turnCount: 1,
      items: canonicalCodexItems(id, session) ?? this.getItems(id, 240, session.external?.provider)
    };
  }

  archiveSession(id, archived = true) {
    const updatedAt = new Date().toISOString();
    this.db.run(
      "UPDATE sessions SET archived = ?, sort_order = ?, updated_at = ? WHERE id = ?",
      [archived ? 1 : 0, this.nextTopSortOrder(archived), updatedAt, id]
    );
    this.scheduleSave();
    return this.getSession(id);
  }

  pinSession(id, pinned = true) {
    this.db.run("UPDATE sessions SET pinned = ? WHERE id = ?", [pinned ? 1 : 0, id]);
    this.scheduleSave();
    return this.getSession(id);
  }

  reorderSessions(sessionIds = []) {
    const ids = sessionIds.map((id) => String(id).replace(/^pty:/, "")).filter(Boolean);
    ids.forEach((id, index) => {
      this.db.run("UPDATE sessions SET sort_order = ? WHERE id = ?", [index, id]);
    });
    this.scheduleSave();
    return this.listSessions({ archived: false });
  }

  renameSession(id, title) {
    const updatedAt = new Date().toISOString();
    this.db.run("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", [title, updatedAt, id]);
    this.scheduleSave();
    return this.getSession(id);
  }

  updateSessionAvatar(id, avatarPath = null) {
    const nextAvatarPath = typeof avatarPath === "string" && avatarPath.trim() ? avatarPath.trim() : null;
    this.db.run("UPDATE sessions SET avatar_path = ? WHERE id = ?", [nextAvatarPath, id]);
    this.scheduleSave();
    return this.getSession(id);
  }

  setActiveChoicePrompt(sessionId, prompt = "", options = []) {
    const rawId = String(sessionId);
    const id = rawId.startsWith("pty:") ? rawId.replace(/^pty:/, "") : rawId;
    const activeChoice = serializeActiveChoicePrompt(options, prompt);
    this.db.run(
      "UPDATE sessions SET active_choice_json = ?, updated_at = ? WHERE id = ?",
      [activeChoice, new Date().toISOString(), id]
    );
    this.scheduleSave();
    return this.getSession(rawId);
  }

  clearActiveChoicePrompt(sessionId) {
    const rawId = String(sessionId);
    const id = rawId.startsWith("pty:") ? rawId.replace(/^pty:/, "") : rawId;
    this.db.run(
      "UPDATE sessions SET active_choice_json = NULL, updated_at = ? WHERE id = ?",
      [new Date().toISOString(), id]
    );
    this.scheduleSave();
    return this.getSession(rawId);
  }

  deleteSession(id) {
    this.db.run("DELETE FROM session_items WHERE session_id = ?", [id]);
    this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
    this.scheduleSave();
  }

  appendSessionEvent(event) {
    const sessionId = String(event.sessionId || "").trim();
    if (!sessionId) {
      return null;
    }
    const row = this.selectOne(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_events WHERE session_id = ?",
      [sessionId]
    );
    const sequence = Number(row?.sequence ?? 0) + 1;
    this.db.run(
      `INSERT OR IGNORE INTO session_events (
        event_id, session_id, sequence, type, source_json, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.eventId,
        sessionId,
        sequence,
        event.type,
        event.source ? JSON.stringify(event.source) : null,
        JSON.stringify(event.payload ?? {}),
        event.createdAt || new Date().toISOString()
      ]
    );
    this.scheduleSave();
    return {
      ...event,
      sessionId,
      sequence
    };
  }

  listSessionEvents(sessionId, after = 0, limit = 200) {
    const rows = this.selectAll(
      `SELECT * FROM session_events
       WHERE session_id = ? AND sequence > ?
       ORDER BY sequence ASC LIMIT ?`,
      [sessionId, Math.max(0, Number(after) || 0), Math.max(1, Math.min(1000, Number(limit) || 200))]
    );
    return rows.map((row) => ({
      eventId: row.event_id,
      sessionId: row.session_id,
      sequence: Number(row.sequence),
      type: row.type,
      source: parseJson(row.source_json, null),
      payload: parseJson(row.payload_json, {}),
      createdAt: row.created_at
    }));
  }

  lastSessionEventSequence(sessionId) {
    const row = this.selectOne(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_events WHERE session_id = ?",
      [sessionId]
    );
    return Number(row?.sequence ?? 0);
  }

  listFeishuBots() {
    return this.selectAll("SELECT * FROM feishu_bots ORDER BY created_at ASC").map(feishuBotFromRow);
  }

  getFeishuBot(id) {
    const row = this.selectOne("SELECT * FROM feishu_bots WHERE id = ?", [id]);
    return row ? feishuBotFromRow(row) : null;
  }

  createFeishuBot(bot) {
    const createdAt = bot.createdAt || new Date().toISOString();
    this.db.run(
      `INSERT INTO feishu_bots (
        id, name, profile, app_id, brand, managed_profile, transport_type, enabled, connection_status, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bot.id,
        bot.name,
        bot.profile,
        bot.appId || null,
        bot.brand || "feishu",
        bot.managedProfile ? 1 : 0,
        bot.transportType || "lark-cli",
        bot.enabled ? 1 : 0,
        bot.enabled ? "connecting" : "disabled",
        null,
        createdAt,
        createdAt
      ]
    );
    this.scheduleSave();
    return this.getFeishuBot(bot.id);
  }

  updateFeishuBot(id, patch = {}) {
    const current = this.getFeishuBot(id);
    if (!current) {
      return null;
    }
    const next = {
      ...current,
      name: typeof patch.name === "string" && patch.name.trim() ? patch.name.trim() : current.name,
      profile: typeof patch.profile === "string" && patch.profile.trim() ? patch.profile.trim() : current.profile,
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
      transportType: patch.transportType || current.transportType,
      connectionStatus: patch.connectionStatus || current.connectionStatus,
      lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : current.lastError,
      remoteName: Object.hasOwn(patch, "remoteName") ? patch.remoteName : current.remoteName,
      remoteAvatarURL: Object.hasOwn(patch, "remoteAvatarURL") ? patch.remoteAvatarURL : current.remoteAvatarURL,
      remoteOpenId: Object.hasOwn(patch, "remoteOpenId") ? patch.remoteOpenId : current.remoteOpenId,
      remoteActivateStatus: Object.hasOwn(patch, "remoteActivateStatus") ? patch.remoteActivateStatus : current.remoteActivateStatus,
      updatedAt: new Date().toISOString()
    };
    this.db.run(
      `UPDATE feishu_bots SET
        name = ?, profile = ?, transport_type = ?, enabled = ?, connection_status = ?, last_error = ?,
        remote_name = ?, remote_avatar_url = ?, remote_open_id = ?, remote_activate_status = ?, updated_at = ?
       WHERE id = ?`,
      [
        next.name,
        next.profile,
        next.transportType,
        next.enabled ? 1 : 0,
        next.connectionStatus,
        next.lastError,
        next.remoteName,
        next.remoteAvatarURL,
        next.remoteOpenId,
        next.remoteActivateStatus != null && Number.isFinite(Number(next.remoteActivateStatus))
          ? Number(next.remoteActivateStatus)
          : null,
        next.updatedAt,
        id
      ]
    );
    this.scheduleSave();
    return this.getFeishuBot(id);
  }

  deleteFeishuBot(id) {
    this.db.run("DELETE FROM feishu_session_assignments WHERE bot_id = ?", [id]);
    this.db.run("DELETE FROM feishu_pairing_codes WHERE bot_id = ?", [id]);
    this.db.run("DELETE FROM feishu_bindings WHERE bot_id = ?", [id]);
    this.db.run("DELETE FROM feishu_bots WHERE id = ?", [id]);
    this.scheduleSave();
  }

  replaceFeishuPairingCode(code) {
    this.db.run("DELETE FROM feishu_pairing_codes WHERE bot_id = ? AND consumed_at IS NULL", [code.botId]);
    this.db.run(
      `INSERT INTO feishu_pairing_codes (
        id, bot_id, code_hash, expires_at, consumed_at, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?)`,
      [code.id, code.botId, code.codeHash, code.expiresAt, code.createdAt]
    );
    this.scheduleSave();
  }

  consumeFeishuPairingCode(codeHash, binding) {
    const code = this.selectOne(
      `SELECT * FROM feishu_pairing_codes
       WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      [codeHash, new Date().toISOString()]
    );
    if (!code || code.bot_id !== binding.botId) {
      return null;
    }
    const verifiedAt = new Date().toISOString();
    this.db.run("BEGIN TRANSACTION");
    try {
      this.db.run(
        `INSERT INTO feishu_bindings (id, bot_id, open_id, chat_id, tenant_key, verified_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(bot_id, open_id) DO UPDATE SET
           chat_id = excluded.chat_id,
           tenant_key = excluded.tenant_key,
           verified_at = excluded.verified_at,
           revoked_at = NULL`,
        [binding.id, binding.botId, binding.openId, binding.chatId || null, binding.tenantKey || null, verifiedAt]
      );
      this.db.run("UPDATE feishu_pairing_codes SET consumed_at = ? WHERE id = ?", [verifiedAt, code.id]);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getFeishuBinding(binding.botId, binding.openId);
  }

  getFeishuBinding(botId, openId) {
    const row = this.selectOne(
      "SELECT * FROM feishu_bindings WHERE bot_id = ? AND open_id = ? AND revoked_at IS NULL",
      [botId, openId]
    );
    return row ? feishuBindingFromRow(row) : null;
  }

  listFeishuBindings(botId) {
    return this.selectAll(
      "SELECT * FROM feishu_bindings WHERE bot_id = ? AND revoked_at IS NULL ORDER BY verified_at ASC",
      [botId]
    ).map(feishuBindingFromRow);
  }

  updateFeishuBindingChat(id, chatId) {
    this.db.run("UPDATE feishu_bindings SET chat_id = ? WHERE id = ?", [chatId, id]);
    this.scheduleSave();
  }

  claimFeishuInboundEvent(botId, eventId) {
    if (!eventId) {
      return true;
    }
    if (this.selectOne("SELECT event_id FROM feishu_inbound_events WHERE event_id = ?", [eventId])) {
      return false;
    }
    this.db.run(
      "INSERT INTO feishu_inbound_events (event_id, bot_id, received_at) VALUES (?, ?, ?)",
      [eventId, botId, new Date().toISOString()]
    );
    this.db.run(
      `DELETE FROM feishu_inbound_events
       WHERE received_at < ?`,
      [new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()]
    );
    this.scheduleSave();
    return true;
  }

  revokeFeishuBinding(id) {
    const revokedAt = new Date().toISOString();
    this.db.run("DELETE FROM feishu_session_assignments WHERE binding_id = ?", [id]);
    this.db.run("UPDATE feishu_bindings SET revoked_at = ? WHERE id = ?", [revokedAt, id]);
    this.scheduleSave();
  }

  getFeishuAssignmentForBot(botId) {
    const row = this.selectOne("SELECT * FROM feishu_session_assignments WHERE bot_id = ?", [botId]);
    return row ? feishuAssignmentFromRow(row) : null;
  }

  getFeishuAssignmentForSession(sessionId) {
    const row = this.selectOne("SELECT * FROM feishu_session_assignments WHERE session_id = ?", [sessionId]);
    return row ? feishuAssignmentFromRow(row) : null;
  }

  listFeishuAssignments() {
    return this.selectAll("SELECT * FROM feishu_session_assignments ORDER BY assigned_at ASC").map(feishuAssignmentFromRow);
  }

  assignFeishuSession(assignment) {
    const occupied = this.getFeishuAssignmentForSession(assignment.sessionId);
    if (occupied && occupied.botId !== assignment.botId) {
      const error = new Error("Session is already assigned to another Feishu bot.");
      error.code = "FEISHU_SESSION_OCCUPIED";
      error.assignment = occupied;
      throw error;
    }
    this.db.run("BEGIN TRANSACTION");
    try {
      this.db.run("DELETE FROM feishu_session_assignments WHERE bot_id = ?", [assignment.botId]);
      this.db.run(
        `INSERT INTO feishu_session_assignments (
          id, bot_id, binding_id, session_id, assigned_at, last_event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [assignment.id, assignment.botId, assignment.bindingId, assignment.sessionId, assignment.assignedAt, Number(assignment.lastEventSequence) || 0]
      );
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      if (/UNIQUE constraint failed: feishu_session_assignments\.session_id/.test(error.message)) {
        error.code = "FEISHU_SESSION_OCCUPIED";
      }
      throw error;
    }
    this.scheduleSave();
    return this.getFeishuAssignmentForBot(assignment.botId);
  }

  releaseFeishuSession(botId) {
    this.db.run("DELETE FROM feishu_session_assignments WHERE bot_id = ?", [botId]);
    this.scheduleSave();
  }

  updateFeishuAssignmentCursor(botId, sequence) {
    this.db.run(
      `UPDATE feishu_session_assignments
       SET last_event_sequence = MAX(last_event_sequence, ?)
       WHERE bot_id = ?`,
      [Number(sequence) || 0, botId]
    );
    this.scheduleSave();
  }

  selectAll(sql, params = []) {
    const stmt = this.db.prepare(sql, params);
    const rows = [];
    try {
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  selectOne(sql, params = []) {
    return this.selectAll(sql, params)[0] ?? null;
  }

  ensureColumn(table, column, definition) {
    const columns = this.selectAll(`PRAGMA table_info(${table})`);
    if (columns.some((entry) => entry.name === column)) {
      return;
    }
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  initializeSortOrder() {
    const rows = this.selectAll(
      "SELECT id FROM sessions WHERE sort_order IS NULL ORDER BY archived ASC, updated_at DESC"
    );
    rows.forEach((row, index) => {
      this.db.run("UPDATE sessions SET sort_order = ? WHERE id = ?", [index, row.id]);
    });
  }

  nextTopSortOrder(archived = false) {
    const row = this.selectOne(
      "SELECT MIN(sort_order) AS min_order FROM sessions WHERE archived = ?",
      [archived ? 1 : 0]
    );
    const minOrder = Number(row?.min_order);
    return Number.isFinite(minOrder) ? minOrder - 1 : 0;
  }

  rowToSession(row) {
    const rawStatus = parseJson(row.raw_json, {});
    const args = parseJson(row.args_json, []);
    const status = row.status;
    const isCodexAppServer = row.provider === "codex-app-server";
    const publicId = isCodexAppServer || String(row.id).startsWith("codex:") ? row.id : `pty:${row.id}`;
    const threadId = isCodexAppServer ? String(row.id).replace(/^codex:/, "") : row.id;
    const isUnsafeLegacyCodexResume = row.provider === "codex-pty"
      && rawStatus.resume?.strategy === "codex-resume-last"
      && !rawStatus.resume?.agentSessionId
      && !rawStatus.agentSessionId;
    const isMissingCodexSessionId = row.provider === "codex-pty"
      && !rawStatus.resume?.agentSessionId
      && !rawStatus.agentSessionId;
    if (isUnsafeLegacyCodexResume || isMissingCodexSessionId) {
      rawStatus.canResume = false;
    }
    const isWaitingForUser = row.provider === "codex-pty"
      && (status === "running" || status === "blocked")
      && (rawStatus.phase === "waiting_approval" || rawStatus.phase === "ready" || rawStatus.phase === "blocked");
    const displayStatus = (isUnsafeLegacyCodexResume || isMissingCodexSessionId) ? "failed" : (isWaitingForUser ? "blocked" : status);
    const latestAssistantSummary = latestCodexAssistantText(row.id, rawStatus, row.provider);
    const activeChoicePrompt = parseActiveChoicePrompt(row.active_choice_json);
    const suggestedOptions = activeChoicePrompt?.options ?? null;
    return {
      id: publicId,
      title: row.title,
      agent: row.agent,
      status: displayStatus,
      progress: displayStatus === "running" || displayStatus === "blocked" ? Number(row.progress) : 1,
      summary: isUnsafeLegacyCodexResume || isMissingCodexSessionId
        ? "Codex session id was not bound; delete this task and start a new Codex session."
        : latestAssistantSummary || row.summary,
      suggestedOptions,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      accent: row.accent,
      archived: Boolean(row.archived),
      pinned: Boolean(row.pinned),
      sortOrder: Number(row.sort_order ?? 0),
      avatarPath: row.avatar_path || null,
      capabilities: row.provider === "claude-sdk"
        ? capabilitiesForStoredProvider(row.provider, displayStatus)
        : rawStatus.capabilities ?? capabilitiesForStoredProvider(row.provider, displayStatus),
      rawStatus,
      external: {
        provider: row.provider,
        threadId,
        sessionId: rawStatus.sessionId ?? threadId,
        activeTurnId: rawStatus.activeTurnId ?? null,
        sandbox: rawStatus.sandbox ?? rawStatus.sandboxMode ?? null,
        approvalPolicy: rawStatus.approvalPolicy ?? null,
        agentSessionId: rawStatus.agentSessionId ?? rawStatus.resume?.agentSessionId ?? null,
        connectionStatus: isCodexAppServer ? null : "pty disconnected",
        currentModel: rawStatus.currentModel ?? rawStatus.resume?.currentModel ?? modelFromArgs(args),
        currentReasoningLevel: rawStatus.currentReasoningLevel ?? rawStatus.resume?.currentReasoningLevel ?? reasoningFromArgs(args),
        cwd: row.cwd,
        source: rawStatus.source ?? row.command,
        args
      }
    };
  }

}

class NativeDatabase {
  constructor(path) {
    this.database = new DatabaseSync(path);
    this.rowsModified = 0;
  }

  run(sql, params = []) {
    const bindings = normalizeSqliteBindings(params);
    if (bindings.length > 0) {
      const result = this.database.prepare(sql).run(...bindings);
      this.rowsModified = Number(result.changes);
      return;
    }

    this.database.exec(sql);
    const result = this.database.prepare("SELECT changes() AS changes").get();
    this.rowsModified = Number(result?.changes ?? 0);
  }

  prepare(sql, params = []) {
    return new NativeStatement(this.database.prepare(sql), params);
  }

  getRowsModified() {
    return this.rowsModified;
  }

  checkpoint() {
    this.database.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  close() {
    this.database.close();
  }
}

class NativeStatement {
  constructor(statement, params) {
    this.rows = statement.all(...normalizeSqliteBindings(params)).map((row) => ({ ...row }));
    this.index = -1;
  }

  step() {
    this.index += 1;
    return this.index < this.rows.length;
  }

  getAsObject() {
    return this.rows[this.index] ?? {};
  }

  free() {}
}

function normalizeSqliteBindings(params) {
  return (Array.isArray(params) ? params : [params]).map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  });
}

function feishuBotFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    profile: row.profile,
    appId: row.app_id || null,
    brand: row.brand || "feishu",
    managedProfile: Boolean(row.managed_profile),
    remoteName: row.remote_name || null,
    remoteAvatarURL: row.remote_avatar_url || null,
    remoteOpenId: row.remote_open_id || null,
    remoteActivateStatus: row.remote_activate_status == null ? null : Number(row.remote_activate_status),
    transportType: row.transport_type,
    enabled: Boolean(row.enabled),
    connectionStatus: row.connection_status,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function feishuBindingFromRow(row) {
  return {
    id: row.id,
    botId: row.bot_id,
    openId: row.open_id,
    chatId: row.chat_id || null,
    tenantKey: row.tenant_key || null,
    verifiedAt: row.verified_at,
    revokedAt: row.revoked_at || null
  };
}

function feishuAssignmentFromRow(row) {
  return {
    id: row.id,
    botId: row.bot_id,
    bindingId: row.binding_id,
    sessionId: row.session_id,
    assignedAt: row.assigned_at,
    lastEventSequence: Number(row.last_event_sequence ?? 0)
  };
}

function agentWorkItemFromRow(row) {
  return {
    workItemId: row.work_item_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    kind: row.kind,
    priority: Number(row.priority),
    text: row.text,
    source: parseJson(row.source_json, {}),
    localVisibility: row.local_visibility,
    status: row.status,
    deliveryId: row.delivery_id || null,
    targetTurnId: row.target_turn_id || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    updatedAt: row.updated_at
  };
}

function normalizeChoiceParserSettings(input = {}) {
  const provider = ["disabled", "openai", "local-agent"].includes(input.provider) ? input.provider : "local-agent";
  return {
    provider,
    openaiBaseURL: normalizeOpenAiCompatibleBaseURL(input.openaiBaseURL),
    openaiApiKey: typeof input.openaiApiKey === "string" ? input.openaiApiKey : "",
    openaiModel: typeof input.openaiModel === "string" && input.openaiModel.trim() ? input.openaiModel.trim() : "gpt-4o-mini",
    localCommand: typeof input.localCommand === "string" && input.localCommand.trim() ? input.localCommand.trim() : "codex",
    localArgs: typeof input.localArgs === "string" ? input.localArgs : "",
    localModel: typeof input.localModel === "string" ? input.localModel : "",
    timeoutMs: Number.isFinite(Number(input.timeoutMs)) ? Math.max(1000, Math.min(60000, Number(input.timeoutMs))) : 12000
  };
}

function normalizeCodexBackendSettings(input = {}) {
  const mode = input.mode === "pty" ? "pty" : "app-server";
  return { mode };
}

function normalizeCodeDiffSettings(input = {}) {
  const tools = new Set(["automatic", "git-difftool", "filemerge", "vscode", "kaleidoscope", "beyond-compare", "sublime-merge"]);
  return {
    tool: tools.has(input.tool) ? input.tool : "automatic"
  };
}

function normalizeOpenAiCompatibleBaseURL(value) {
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : "https://api.openai.com/v1";
  return raw.replace(/\/+$/, "");
}

function normalizeAgentProxySettings(input = {}) {
  return {
    codex: normalizeProxyProfile(input.codex),
    choiceParser: normalizeProxyProfile(input.choiceParser),
    pty: normalizeProxyProfile(input.pty)
  };
}

function normalizeGatewaySettings(input = {}) {
  const paths = Array.isArray(input.trustedWorkspaces) ? input.trustedWorkspaces : [];
  return {
    trustedWorkspaces: Array.from(new Set(paths
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim())))
  };
}

function normalizeProxyProfile(input = {}) {
  return {
    enabled: input.enabled === true,
    httpProxy: normalizeProxyValue(input.httpProxy),
    httpsProxy: normalizeProxyValue(input.httpsProxy),
    allProxy: normalizeProxyValue(input.allProxy),
    noProxy: normalizeNoProxyValue(input.noProxy)
  };
}

function normalizeProxyValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNoProxyValue(value) {
  const fallback = "localhost,127.0.0.1,::1,.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function serializeActiveChoicePrompt(options = null, prompt = "", existing = null) {
  const source = existing && typeof existing === "object"
    ? existing
    : { prompt, options };
  const activeOptions = Array.isArray(source.options) ? source.options : options;
  if (!Array.isArray(activeOptions) || activeOptions.length < 2) {
    return null;
  }
  const normalizedOptions = activeOptions.map((option, index) => ({
    id: option.id || `option-${index}`,
    label: String(option.label ?? "").trim(),
    role: option.role ?? "message-choice",
    index: Number.isFinite(option.index) ? option.index : index,
    selected: option.selected === true
  })).filter((option) => option.label);
  if (normalizedOptions.length < 2) {
    return null;
  }
  return JSON.stringify({
    id: source.id || `choice:${Date.now()}`,
    prompt: typeof source.prompt === "string" && source.prompt.trim() ? source.prompt.trim() : prompt,
    options: normalizedOptions,
    status: "active",
    createdAt: createdAtFromOrNow(source)
  });
}

function parseActiveChoicePrompt(value) {
  const parsed = parseJson(value, null);
  if (!parsed || parsed.status !== "active" || !Array.isArray(parsed.options) || parsed.options.length < 2) {
    return null;
  }
  return parsed;
}

function toSessionSummary(session) {
  if (typeof session.toSessionSummary === "function") {
    return session.toSessionSummary(session);
  }

  const latest = lastMeaningfulText(session.items ?? []);
  const status = session.status === "running" && session.items?.at(-1)?.type === "approval"
    ? "blocked"
    : session.status;

  return {
    status,
    progress: status === "running" || status === "blocked" ? 0.5 : 1,
    summary: latest || session.summary || `${session.command ?? ""} ${(session.args ?? []).join(" ")}`.trim(),
    suggestedOptions: session.suggestedOptions ?? latestSuggestedOptionsFromItems(session.items ?? []),
    accent: session.accent || "cyan"
  };
}

function toRawStatus(session) {
  const agentSessionId = session.agentSessionId ?? session.resume?.agentSessionId ?? null;
  return {
    command: session.command ?? null,
    args: session.args ?? [],
    provider: session.provider ?? session.external?.provider ?? null,
    resume: session.resume ?? null,
    agentSessionId,
    initialPrompt: session.initialPrompt ?? "",
    phase: session.phase ?? null,
    connectionReady: session.connectionReady === true,
    currentModel: session.currentModel ?? session.external?.currentModel ?? session.resume?.currentModel ?? modelFromArgs(session.args ?? []),
    currentReasoningLevel: session.currentReasoningLevel ?? session.external?.currentReasoningLevel ?? session.resume?.currentReasoningLevel ?? reasoningFromArgs(session.args ?? []),
    lastInputAt: session.lastInputAt ?? null,
    lastOutputAt: session.lastOutputAt ?? null,
    nextItemSeq: session.nextItemSeq ?? null,
    canResume: session.provider === "codex-pty" && session.canResume === true && Boolean(agentSessionId),
    threadId: session.external?.threadId ?? null,
    sessionId: session.external?.sessionId ?? null,
    activeTurnId: session.external?.activeTurnId ?? null,
    source: session.external?.source ?? null,
    sandbox: session.external?.sandbox ?? session.sandbox ?? null,
    approvalPolicy: session.external?.approvalPolicy ?? session.approvalPolicy ?? null,
    capabilities: session.capabilities ?? null,
    exitCode: session.exitCode ?? null,
    signal: session.signal ?? null
  };
}

function capabilitiesForStoredProvider(provider = "", status = "") {
  if (provider === "codex-app-server") {
    return {
      canSend: status !== "failed" && status !== "cancelled",
      canSwitchModel: true,
      canSwitchReasoning: false,
      canInterrupt: status === "running",
      canReconnect: false
    };
  }
  if (provider === "codex-pty") {
    return {
      canSend: status === "running" || status === "blocked" || status === "complete",
      canSwitchModel: true,
      canSwitchReasoning: true,
      canInterrupt: status === "running",
      canReconnect: true
    };
  }
  if (provider === "claude-sdk") {
    return {
      canSend: status !== "failed" && status !== "cancelled",
      canSwitchModel: true,
      canSwitchReasoning: false,
      canInterrupt: false,
      canReconnect: true
    };
  }
  return null;
}

function lastMeaningfulText(items) {
  for (const item of items.slice().reverse()) {
    if (item.text && item.type !== "userMessage") {
      return item.text;
    }
  }
  return "";
}

function latestSuggestedOptionsFromItems(items) {
  for (const item of items.slice().reverse()) {
    if (item.type === "userMessage") {
      return null;
    }
    if ((item.type === "choice" || item.type === "agentMessage") && item.status !== "selected" && Array.isArray(item.options) && item.options.length >= 2) {
      return item.options;
    }
  }
  return null;
}

function choiceOptionsFromAgentMessage(text = "") {
  if (!isAgentMessageChoicePrompt(text)) {
    return null;
  }
  const options = numberedChoiceOptionsFromLines(text);
  if (options.length < 2) {
    options.push(...numberedChoiceOptionsFromInlineText(text));
  }
  return options.length >= 2 ? options.slice(0, 8) : null;
}

function numberedChoiceOptionsFromLines(text = "") {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const options = [];
  for (const line of lines) {
    const match = line.match(/^(?:[-*]\s*)?(\d{1,2})[.)、]\s+(.+)$/);
    if (!match) {
      continue;
    }
    const label = cleanAgentChoiceLabel(match[2]);
    if (!label || label.length > 120 || isAgentNoise(label)) {
      continue;
    }
    options.push({
      id: `content-choice-${options.length}`,
      label,
      role: "message-choice",
      index: options.length,
      selected: false
    });
  }
  return options;
}

function numberedChoiceOptionsFromInlineText(text = "") {
  const normalized = text.replace(/\s+/g, " ").trim();
  const pattern = /(?:^|\s)(\d{1,2})[.)、]\s+(.+?)(?=\s+\d{1,2}[.)、]\s+|$)/g;
  const options = [];
  let match;
  while ((match = pattern.exec(normalized))) {
    const label = cleanAgentChoiceLabel(match[2]);
    if (!label || label.length > 180 || isAgentNoise(label)) {
      continue;
    }
    options.push({
      id: `content-choice-${options.length}`,
      label,
      role: "message-choice",
      index: options.length,
      selected: false
    });
  }
  return options;
}

function isAgentMessageChoicePrompt(text = "") {
  return /你可以选择|请选择|你选择几|你要做什么|你要怎么做|接下来做什么|选择哪|选哪|前方有.{0,12}方向|which do you choose|choose one|you can choose|pick one|what do you do/i.test(text);
}

function cleanAgentChoiceLabel(label = "") {
  return label
    .replace(/\s{2,}$/g, "")
    .replace(/^\*\*(.+)\*\*$/s, "$1")
    .replace(/\*\*/g, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function modelFromArgs(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === "-m" || args[index] === "--model") && args[index + 1]) {
      return args[index + 1];
    }
  }
  return null;
}

function reasoningFromArgs(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === "-c" || args[index] === "--config") && args[index + 1]) {
      const match = String(args[index + 1]).match(/^model_reasoning_effort\s*=\s*["']?([^"']+)["']?$/);
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  return null;
}

function isAgentNoise(text = "") {
  return /^现$|^your config\.toml:?$|^Started codex resume |You have \d+ usage limit resets available|10;\?11;\?.*>_ OpenAI Codex|^(?:10;\?11;\?|\[[0-9;?]*[a-zA-Z])$|^>_ OpenAI Codex|^model:\s|^directory:\s|features?.*web[_\s-]?search[_\s-]?request.*deprecated|web[_\s-]?search[_\s-]?request.*deprecated|set [`'"]?web[_\s-]?search[`'"]?.*(live|true|enabled)|falling back from web ?sockets? to https|websocket.*fallback|under a profile\) in config\.toml|Tip: Try the Codex App|HooksLifecycle hooks|EventInstalledActiveReviewDescription|MCP startup incomplete|MCP client .* timed out|Starting MCP servers|startup_timeout_sec|\[mcp_servers\.|0;[⠼⠴⠦⠧⠇⠏⠋⠙⠹⠸]/i.test(text);
}

function cleanReplayItems(items, provider) {
  if (provider !== "codex-pty") {
    return items;
  }
  const userTexts = new Set(
    items
      .filter((item) => item.type === "userMessage")
      .map((item) => normalizeUserText(item.text))
      .filter(Boolean)
  );
  const seenAgentTexts = new Set();
  const cleaned = [];

  for (const item of items) {
    const normalizedText = normalizeUserText(item.text);
    if (item.type !== "userMessage" && userTexts.has(normalizedText)) {
      continue;
    }
    if (item.type !== "userMessage" && item.type !== "system") {
      if (seenAgentTexts.has(normalizedText)) {
        continue;
      }
      seenAgentTexts.add(normalizedText);
    }
    cleaned.push(item);
  }

  return cleaned;
}

function canonicalCodexItems(sessionId, session) {
  const rolloutPath = session.rawStatus?.resume?.rolloutPath;
  if (session.external?.provider !== "codex-pty" || !rolloutPath) {
    return null;
  }

  let content = "";
  try {
    content = readFileSync(rolloutPath, "utf8");
  } catch {
    return null;
  }

  const completedCallIds = new Set();
  const completedTurnIds = new Set();
  let latestTaskStartedTurnId = null;
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry.payload ?? {};
    if (entry.type === "event_msg" && payload.type === "task_started") {
      latestTaskStartedTurnId = payload.turn_id ?? latestTaskStartedTurnId;
    }
    if (entry.type === "event_msg" && payload.type === "task_complete" && payload.turn_id) {
      completedTurnIds.add(payload.turn_id);
    }
    if (entry.type === "response_item" && payload.type === "function_call_output" && payload.call_id) {
      completedCallIds.add(payload.call_id);
    }
  }
  const activeTurnId = latestTaskStartedTurnId && !completedTurnIds.has(latestTaskStartedTurnId)
    ? latestTaskStartedTurnId
    : null;

  const items = [];
  const seen = new Set();
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry.payload ?? {};
    if (entry.type === "response_item" && payload.type === "function_call") {
      const approval = approvalItemFromFunctionCall(sessionId, session, payload, index, completedCallIds, activeTurnId);
      if (approval) {
        items.push(approval);
      }
      continue;
    }
    const eventType = entry.type === "event_msg" ? payload.type : null;
    if (eventType !== "user_message" && eventType !== "agent_message") {
      continue;
    }
    const text = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!text || isAgentNoise(text)) {
      continue;
    }
    const role = eventType === "user_message" ? "user" : "assistant";
    const key = `${role}:${text}`;
    if (role === "assistant") {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    items.push({
      id: `${sessionId}:rollout:${index}`,
      turnId: payload.turn_id ?? sessionId,
      turnStatus: payload.phase === "final_answer" ? "complete" : "running",
      type: role === "user" ? "userMessage" : "agentMessage",
      title: role === "user" ? "User" : "Codex",
      text,
      status: role === "user" ? "sent" : payload.phase ?? null,
      createdAt: createdAtFrom(entry, payload)
    });
  }

  return items.length > 0 ? items.slice(-240) : null;
}

function approvalItemFromFunctionCall(sessionId, session, payload, index, completedCallIds, activeTurnId = null) {
  if (!payload.call_id || completedCallIds.has(payload.call_id)) {
    return null;
  }
  const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id ?? sessionId;
  if (activeTurnId && turnId !== activeTurnId) {
    return null;
  }
  const args = parseToolArguments(payload.arguments);
  if (args.sandbox_permissions !== "require_escalated") {
    return null;
  }
  const command = typeof args.command === "string" ? args.command.trim() : "";
  const reason = typeof args.justification === "string" ? args.justification.trim() : "";
  const body = [
    command ? `Codex wants approval to run this command:\n${command}` : "Codex wants approval to run a command.",
    reason ? `Reason:\n${reason}` : ""
  ].filter(Boolean).join("\n\n");
  return {
    id: `${sessionId}:approval:${payload.call_id}`,
    turnId,
    turnStatus: "waiting_approval",
    type: "approval",
    title: "Codex approval",
    text: body,
    options: [
      { id: "approve", label: "Approve", role: "approve", index: 0, selected: true },
      { id: "deny", label: "Deny", role: "deny", index: 1, selected: false }
    ],
    status: "pending",
    createdAt: createdAtFrom(payload)
  };
}

function parseToolArguments(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value ?? {};
  } catch {
    return {};
  }
}

function latestCodexAssistantText(sessionId, rawStatus, provider) {
  const items = canonicalCodexItems(sessionId, {
    rawStatus,
    external: { provider }
  });
  for (const item of (items ?? []).slice().reverse()) {
    if (item.type === "agentMessage" && item.text && !isAgentNoise(item.text)) {
      return item.text.trim();
    }
  }
  return "";
}

function normalizeStoredItem(item, provider) {
  if (provider === "codex-pty" && item.type === "approval" && !isApprovalPrompt(item.text ?? "")) {
    return {
      ...item,
      type: "agentMessage",
      title: "Codex"
    };
  }
  if (provider === "codex-pty" && item.title === "Codex approval" && !isApprovalPrompt(item.text ?? "")) {
    return {
      ...item,
      title: "Codex"
    };
  }
  return item;
}

function normalizeStoredText(text = "", provider = "") {
  if (provider !== "codex-pty") {
    return text;
  }
  return text
    .replace(/›[\s\S]*?(?:gpt-[\w.-]+.*?·\s*~?\/[^\n]*)$/i, "")
    .replace(/\b(?:gpt-[\w.-]+.*?·\s*~?\/[^\n]*)$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isAdjacentDuplicateUserMessage(item, previous) {
  return previous?.type === "userMessage"
    && item.type === "userMessage"
    && normalizeUserText(previous.text) === normalizeUserText(item.text);
}

function normalizeUserText(text = "") {
  return text.replace(/^›\s*/, "").replace(/\s+/g, " ").trim();
}

function isApprovalPrompt(text = "") {
  const compact = text.replace(/\s+/g, " ").trim();
  return /requires? (your )?approval|needs? (your )?approval|permission required|wants to (run|execute)|run this command|execute this command|allow .*command|approve\?|confirm\?|proceed\?|continue\?|do you want .*\?|would you like .*\?|are you sure .*\?|\[y\/n\]|yes\/no|批准.*\?|允许.*\?|是否.*(批准|允许|继续)/i.test(compact);
}

async function defaultDataDir() {
  return process.env.CORPTIE_DEFAULT_DATA_DIR || fallbackDataDir;
}

function normalizeEnvironment(value = "") {
  const normalized = String(value || "").toLowerCase();
  return normalized === "dev" || normalized === "development" ? "development" : "production";
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
