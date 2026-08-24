import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import { backup, DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { normalizeNewSessionDefaults } from "../utils/newSessionDefaults.mjs";
import { normalizeSessionTitle } from "../utils/sessionTitles.mjs";
import { createdAtFrom, createdAtFromOrNow } from "../utils/timestamps.mjs";
import { resolveAgentWorkDir } from "../runtime/agentWorkDir.mjs";
import {
  assertExplicitSessionKind,
  inferSessionKind,
  SESSION_KIND
} from "../utils/sessionKinds.mjs";
import {
  AGENT_KIND,
  PLATFORM_ASSISTANT_ID,
  PLATFORM_ASSISTANT_MANIFEST,
  assertPlatformAssistantPatch,
  isPlatformAssistant,
  platformAssistantProtectionError
} from "../utils/platformAssistantIdentity.mjs";
import {
  associationError,
  assertRepositoryId,
  validateObjectiveInput,
  validateWorkItemInput
} from "../domain/objectiveWorkItemValidation.mjs";
import { queryCallerSource, SqliteQueryObservability } from "./queryObservability.mjs";

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
    this.stateDirtyListener = null;
    this.performanceMigrationBackupPath = null;
  }

  async initialize() {
    await this.resolveDataPath();
    await mkdir(dirname(this.dbPath), { recursive: true });
    this.db = new NativeDatabase(this.dbPath);
    try {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA synchronous = FULL");
      this.db.run("PRAGMA busy_timeout = 5000");
      await this.ensurePerformanceMigrationBackup();
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

  async ensurePerformanceMigrationBackup() {
    const sessionEvents = this.db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ["session_events"],
      "CorptieStore.ensurePerformanceMigrationBackup"
    );
    if (!sessionEvents) return;
    const columns = this.db.all(
      "PRAGMA table_info(session_events)",
      [],
      "CorptieStore.ensurePerformanceMigrationBackup"
    );
    if (columns.some((column) => column.name === "has_agent_message")) return;

    const backupPath = `${this.dbPath}.pre-sqlite-performance-v1.backup`;
    if (!await exists(backupPath)) {
      await backup(this.db.database, backupPath);
    }
    const verification = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const result = verification.prepare("PRAGMA quick_check").get();
      if (result?.quick_check !== "ok") {
        throw new Error("SQLite performance migration backup failed integrity verification.");
      }
    } finally {
      verification.close();
    }
    this.performanceMigrationBackupPath = backupPath;
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
      newSessionDefaults: this.newSessionDefaults(),
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

  newSessionDefaults() {
    return normalizeNewSessionDefaults(this.config.newSessionDefaults ?? {});
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
    if (input.newSessionDefaults && typeof input.newSessionDefaults === "object") {
      this.config.newSessionDefaults = normalizeNewSessionDefaults({
        ...(this.config.newSessionDefaults ?? {}),
        ...input.newSessionDefaults
      });
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

  // 事件溯源层（session_logs/session_events）的 session_id 是独立游标键，
  // 不依赖 sessions 元数据（feishu/遥测场景的 sessionId 非真实 sessions 记录）。
  // 历史库中的 session_logs 曾误挂 FOREIGN KEY → 重建以移除。
  migrateSessionLogsForeignKey() {
    const table = this.selectOne(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_logs'"
    );
    if (!table?.sql || !/REFERENCES\s+sessions/i.test(table.sql)) return;

    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run("ALTER TABLE session_logs RENAME TO session_logs_legacy");
      this.db.run(`
        CREATE TABLE session_logs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      this.db.run(`
        INSERT INTO session_logs (id, session_id, created_at)
        SELECT id, session_id, created_at FROM session_logs_legacy
      `);
      this.db.run("DROP TABLE session_logs_legacy");
      this.db.run("CREATE INDEX IF NOT EXISTS idx_session_logs_session_id ON session_logs(session_id)");
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  migrateWorkspaceCreationRequestAuditReferences() {
    const table = this.selectOne(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_creation_requests'"
    );
    if (!table || this.selectAll("PRAGMA foreign_key_list(workspace_creation_requests)").length === 0) return;
    // Audit rows retain the identities observed at request time. They must not
    // own or block deletion of live Agent/Session/Objective/Workspace records.
    this.db.run("PRAGMA foreign_keys = OFF");
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(`
        CREATE TABLE workspace_creation_requests_audit_v1 (
          operation_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL,
          input_fingerprint TEXT NOT NULL,
          actor_agent_id TEXT NOT NULL,
          source_session_id TEXT NOT NULL,
          logical_session_id TEXT NOT NULL,
          objective_id TEXT NOT NULL,
          work_item_id TEXT,
          repository_id TEXT NOT NULL,
          target_path TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
          failure_stage TEXT,
          request_json TEXT NOT NULL DEFAULT '{}',
          result_json TEXT,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (logical_session_id, idempotency_key)
        )
      `);
      this.db.run(`
        INSERT INTO workspace_creation_requests_audit_v1
        SELECT * FROM workspace_creation_requests
      `);
      this.db.run("DROP TABLE workspace_creation_requests");
      this.db.run("ALTER TABLE workspace_creation_requests_audit_v1 RENAME TO workspace_creation_requests");
      this.db.run(`CREATE INDEX idx_workspace_creation_requests_context
        ON workspace_creation_requests(objective_id, source_session_id, created_at DESC)`);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    } finally {
      this.db.run("PRAGMA foreign_keys = ON");
    }
  }

  migrateScheduledSessionConditionTasks() {
    this.ensureColumn("scheduled_session_runs", "condition_result_json", "TEXT");
    const table = this.selectOne(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_session_tasks'"
    );
    if (!table?.sql || /schedule_type\s+IN\s*\([^)]*'condition'/i.test(table.sql)) {
      this.ensureColumn("scheduled_session_tasks", "condition_spec_json", "TEXT");
      this.ensureColumn("scheduled_session_tasks", "condition_state_json", "TEXT");
      return;
    }

    // SQLite cannot widen a CHECK constraint in place. Rebuild only this
    // independent schedule table while preserving child-table foreign keys.
    this.db.run("PRAGMA foreign_keys = OFF");
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(`
        CREATE TABLE scheduled_session_tasks_condition_v1 (
          task_id TEXT PRIMARY KEY,
          logical_session_id TEXT NOT NULL,
          message_json TEXT NOT NULL,
          schedule_type TEXT NOT NULL
            CHECK (schedule_type IN ('once', 'interval', 'condition', 'process')),
          run_at TEXT,
          next_run_at TEXT,
          interval_seconds INTEGER,
          timezone TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'paused', 'completed', 'failed', 'cancelled')),
          missed_policy TEXT NOT NULL DEFAULT 'coalesce_once'
            CHECK (missed_policy IN ('coalesce_once', 'skip')),
          condition_spec_json TEXT,
          condition_state_json TEXT,
          process_spec_json TEXT,
          process_state_json TEXT,
          creator_type TEXT NOT NULL,
          creator_id TEXT NOT NULL,
          objective_id TEXT,
          environment TEXT NOT NULL,
          pending_scheduled_for TEXT,
          lease_owner TEXT,
          lease_expires_at TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 5,
          last_run_id TEXT,
          last_run_status TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          last_run_at TEXT,
          resource_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          paused_at TEXT,
          cancelled_at TEXT,
          completed_at TEXT,
          FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE SET NULL
        )
      `);
      this.db.run(`
        INSERT INTO scheduled_session_tasks_condition_v1 (
          task_id, logical_session_id, message_json, schedule_type, run_at, next_run_at,
          interval_seconds, timezone, status, missed_policy, process_spec_json,
          process_state_json, creator_type, creator_id, objective_id, environment,
          pending_scheduled_for, lease_owner, lease_expires_at, retry_count, max_retries,
          last_run_id, last_run_status, last_error_code, last_error_message, last_run_at,
          resource_version, created_at, updated_at, paused_at, cancelled_at, completed_at
        )
        SELECT
          task_id, logical_session_id, message_json, schedule_type, run_at, next_run_at,
          interval_seconds, timezone, status, missed_policy, process_spec_json,
          process_state_json, creator_type, creator_id, objective_id, environment,
          pending_scheduled_for, lease_owner, lease_expires_at, retry_count, max_retries,
          last_run_id, last_run_status, last_error_code, last_error_message, last_run_at,
          resource_version, created_at, updated_at, paused_at, cancelled_at, completed_at
        FROM scheduled_session_tasks
      `);
      this.db.run("DROP TABLE scheduled_session_tasks");
      this.db.run("ALTER TABLE scheduled_session_tasks_condition_v1 RENAME TO scheduled_session_tasks");
      this.db.run(`CREATE INDEX idx_scheduled_session_tasks_due
        ON scheduled_session_tasks(environment, status, next_run_at, lease_expires_at)`);
      this.db.run(`CREATE INDEX idx_scheduled_session_tasks_session
        ON scheduled_session_tasks(logical_session_id, created_at DESC)`);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    } finally {
      this.db.run("PRAGMA foreign_keys = ON");
    }
  }

  migrateAutomationSchedulerV1() {
    const taskColumns = {
      name: "TEXT",
      trigger_spec_json: "TEXT",
      condition_specs_json: "TEXT NOT NULL DEFAULT '[]'",
      actions_json: "TEXT NOT NULL DEFAULT '[]'",
      policy_spec_json: "TEXT NOT NULL DEFAULT '{}'",
      risk_json: "TEXT NOT NULL DEFAULT '{}'",
      max_concurrent_runs: "INTEGER NOT NULL DEFAULT 1",
      timeout_seconds: "INTEGER NOT NULL DEFAULT 3600",
      backpressure_limit: "INTEGER NOT NULL DEFAULT 100"
    };
    for (const [column, definition] of Object.entries(taskColumns)) {
      this.ensureColumn("scheduled_session_tasks", column, definition);
    }
    this.ensureColumn("scheduled_session_runs", "stages_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("scheduled_session_runs", "action_results_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("scheduled_session_runs", "deadline_at", "TEXT");
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_session_runs_status_deadline
      ON scheduled_session_runs(status, deadline_at)`);
  }

  migrateWorkItemMemoryAssociations() {
    const migrationId = "work-item-memory-association-v1";
    if (this.selectOne("SELECT migration_id FROM data_migrations WHERE migration_id = ?", [migrationId])) {
      return;
    }
    const appliedAt = createdAtFromOrNow();
    this.runInTransaction(() => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS quarantined_work_item_memories (
          memory_id TEXT PRIMARY KEY,
          owner_id TEXT,
          source_session_id TEXT,
          reason TEXT NOT NULL,
          record_json TEXT NOT NULL,
          quarantined_at TEXT NOT NULL
        )
      `);
      this.db.run(
        `INSERT OR IGNORE INTO quarantined_work_item_memories (
           memory_id, owner_id, source_session_id, reason, record_json, quarantined_at
         )
         SELECT m.id, m.owner_id, m.source_session_id,
           CASE
             WHEN wi.id IS NULL THEN 'work_item_missing'
             WHEN wi.current_session_id IS NULL THEN 'work_item_not_started'
             WHEN s.id IS NULL THEN 'source_session_missing'
             ELSE 'source_session_binding_mismatch'
           END,
           json_object(
             'id', m.id, 'owner_type', m.owner_type, 'owner_id', m.owner_id,
             'kind', m.kind, 'content', m.content, 'structured_json', m.structured_json,
             'tags_json', m.tags_json, 'base_confidence', m.base_confidence,
             'confidence', m.confidence, 'recency_score', m.recency_score,
             'usage_count', m.usage_count, 'last_accessed_at', m.last_accessed_at,
             'source_type', m.source_type, 'source_session_id', m.source_session_id,
             'source_event_seqs_json', m.source_event_seqs_json,
             'promotion_status', m.promotion_status, 'promoted_skill_id', m.promoted_skill_id,
             'access_policy', m.access_policy, 'version', m.version,
             'auto_applied', m.auto_applied, 'applied_at', m.applied_at,
             'revoked_at', m.revoked_at, 'created_at', m.created_at, 'updated_at', m.updated_at
           ), ?
         FROM memories m
         LEFT JOIN work_items wi ON wi.id = m.owner_id
         LEFT JOIN sessions s ON s.id = m.source_session_id
         WHERE m.owner_type = 'work_item'
           AND (
             wi.id IS NULL OR wi.current_session_id IS NULL OR s.id IS NULL
             OR s.work_item_id IS NOT wi.id OR s.objective_id IS NOT wi.objective_id
           )`,
        [appliedAt]
      );
      this.db.run(`
        DELETE FROM memories
        WHERE owner_type = 'work_item'
          AND id IN (SELECT memory_id FROM quarantined_work_item_memories)
      `);
      this.db.run(`
        UPDATE memories
        SET work_item_id = CASE WHEN owner_type = 'work_item' THEN owner_id ELSE NULL END,
            source_event_sequence = CASE
              WHEN json_valid(source_event_seqs_json)
               AND json_array_length(source_event_seqs_json) = 1
              THEN json_extract(source_event_seqs_json, '$[0]')
              ELSE NULL
            END
      `);
      this.db.run(
        "INSERT INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
        [migrationId, appliedAt]
      );
    });
    this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_source_event
      ON memories(owner_type, owner_id, source_session_id, source_event_sequence)
      WHERE source_session_id IS NOT NULL AND source_event_sequence IS NOT NULL`);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memories_work_item_insert_guard
      BEFORE INSERT ON memories
      WHEN (NEW.owner_type = 'work_item' AND (NEW.work_item_id IS NULL OR NEW.work_item_id IS NOT NEW.owner_id))
        OR (NEW.owner_type <> 'work_item' AND NEW.work_item_id IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'invalid work item memory association');
      END
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memories_work_item_update_guard
      BEFORE UPDATE OF owner_type, owner_id, work_item_id ON memories
      WHEN (NEW.owner_type = 'work_item' AND (NEW.work_item_id IS NULL OR NEW.work_item_id IS NOT NEW.owner_id))
        OR (NEW.owner_type <> 'work_item' AND NEW.work_item_id IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'invalid work item memory association');
      END
    `);
  }

  migrate() {
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrateSessionLogsForeignKey();
    const hadSessionReadReceipts = Boolean(this.selectOne(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_read_receipts'"
    ));
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
        raw_metadata_json TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_items_session_id ON session_items(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_session_items_latest
      ON session_items(session_id, created_at DESC, id DESC);

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
        agent_kind TEXT NOT NULL DEFAULT 'user',
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'independentContributor',
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
        protocol_version TEXT NOT NULL DEFAULT '2.0',
        source_objective_id TEXT,
        target_objective_id TEXT,
        source_work_item_id TEXT,
        work_item_id TEXT,
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
        FOREIGN KEY (source_objective_id) REFERENCES objectives(id) ON DELETE RESTRICT,
        FOREIGN KEY (target_objective_id) REFERENCES objectives(id) ON DELETE RESTRICT,
        FOREIGN KEY (source_work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT,
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
        protocol_version TEXT NOT NULL DEFAULT '2.0',
        source_objective_id TEXT,
        target_objective_id TEXT,
        source_work_item_id TEXT,
        work_item_id TEXT,
        sender_agent_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        message_type TEXT NOT NULL
          CHECK (message_type IN ('question', 'change_request', 'needs_information', 'update_ready', 'verification_result')),
        body TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT NOT NULL DEFAULT '{}',
        error_json TEXT,
        resource_version TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES collaboration_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (source_objective_id) REFERENCES objectives(id) ON DELETE RESTRICT,
        FOREIGN KEY (target_objective_id) REFERENCES objectives(id) ON DELETE RESTRICT,
        FOREIGN KEY (source_work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT,
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

      CREATE TABLE IF NOT EXISTS collaboration_channels (
        channel_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        initiator_agent_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        initiator_session_id TEXT NOT NULL,
        recipient_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'invalid', 'closed')),
        established_delivery_id TEXT NOT NULL,
        last_delivery_id TEXT NOT NULL,
        invalidated_reason TEXT,
        established_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        invalidated_at TEXT,
        closed_at TEXT,
        FOREIGN KEY (task_id) REFERENCES collaboration_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (initiator_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (recipient_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (established_delivery_id) REFERENCES collaboration_deliveries(delivery_id) ON DELETE RESTRICT,
        FOREIGN KEY (last_delivery_id) REFERENCES collaboration_deliveries(delivery_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_channels_sessions
      ON collaboration_channels(status, initiator_session_id, recipient_session_id);

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

      CREATE INDEX IF NOT EXISTS idx_agent_work_items_session_next
      ON agent_work_items(session_id, status, priority DESC, created_at ASC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_work_items_one_running_per_session
      ON agent_work_items(session_id) WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS scheduled_session_tasks (
        task_id TEXT PRIMARY KEY,
        logical_session_id TEXT NOT NULL,
        message_json TEXT NOT NULL,
        schedule_type TEXT NOT NULL
          CHECK (schedule_type IN ('once', 'interval', 'condition', 'process')),
        run_at TEXT,
        next_run_at TEXT,
        interval_seconds INTEGER,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'paused', 'completed', 'failed', 'cancelled')),
        missed_policy TEXT NOT NULL DEFAULT 'coalesce_once'
          CHECK (missed_policy IN ('coalesce_once', 'skip')),
        condition_spec_json TEXT,
        condition_state_json TEXT,
        process_spec_json TEXT,
        process_state_json TEXT,
        creator_type TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        objective_id TEXT,
        environment TEXT NOT NULL,
        pending_scheduled_for TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 5,
        last_run_id TEXT,
        last_run_status TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        last_run_at TEXT,
        resource_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        paused_at TEXT,
        cancelled_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_session_tasks_due
      ON scheduled_session_tasks(environment, status, next_run_at, lease_expires_at);

      CREATE INDEX IF NOT EXISTS idx_scheduled_session_tasks_session
      ON scheduled_session_tasks(logical_session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS scheduled_session_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_key TEXT NOT NULL UNIQUE,
        scheduled_for TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        trigger_reason TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('missed', 'claimed', 'retry_wait', 'queued', 'running', 'completed', 'failed', 'cancelled', 'skipped')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        agent_work_item_id TEXT,
        target_turn_id TEXT,
        binding_id TEXT,
        provider_session_id TEXT,
        routing_version INTEGER,
        exit_status_json TEXT,
        condition_result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        claimed_at TEXT,
        queued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES scheduled_session_tasks(task_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_session_runs_task
      ON scheduled_session_runs(task_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_scheduled_session_runs_work_item
      ON scheduled_session_runs(agent_work_item_id) WHERE agent_work_item_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS scheduled_session_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        actor_type TEXT,
        actor_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        environment TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES scheduled_session_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES scheduled_session_runs(run_id) ON DELETE SET NULL,
        UNIQUE (task_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_session_events_task
      ON scheduled_session_events(task_id, sequence ASC);

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

      CREATE TABLE IF NOT EXISTS git_repositories (
        repository_id TEXT PRIMARY KEY,
        common_git_dir TEXT NOT NULL UNIQUE,
        discovered_at TEXT NOT NULL,
        last_validated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS git_worktrees (
        worktree_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        path TEXT NOT NULL,
        canonical_path TEXT,
        git_dir TEXT,
        is_main INTEGER NOT NULL DEFAULT 0,
        availability TEXT NOT NULL
          CHECK (availability IN ('available', 'missing', 'invalid', 'permissionDenied')),
        head_oid TEXT,
        branch_ref TEXT,
        branch_name TEXT,
        detached INTEGER NOT NULL DEFAULT 0,
        locked INTEGER NOT NULL DEFAULT 0,
        lock_reason TEXT,
        prunable INTEGER NOT NULL DEFAULT 0,
        prune_reason TEXT,
        inventory_version TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        raw_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (repository_id) REFERENCES git_repositories(repository_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_git_worktrees_repository
      ON git_worktrees(repository_id, availability, path);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_git_worktrees_git_dir
      ON git_worktrees(repository_id, git_dir) WHERE git_dir IS NOT NULL;

      CREATE TABLE IF NOT EXISTS logical_sessions (
        logical_session_id TEXT PRIMARY KEY,
        legacy_session_id TEXT UNIQUE,
        active_thread_id TEXT,
        active_workspace_id TEXT,
        repository_id TEXT,
        routing_version INTEGER NOT NULL DEFAULT 1,
        transition_state TEXT,
        title TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (repository_id) REFERENCES git_repositories(repository_id) ON DELETE SET NULL,
        FOREIGN KEY (active_workspace_id) REFERENCES git_worktrees(worktree_id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_creation_requests (
        operation_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        actor_agent_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        logical_session_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        work_item_id TEXT,
        repository_id TEXT NOT NULL,
        target_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
        failure_stage TEXT,
        request_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (logical_session_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_creation_requests_context
      ON workspace_creation_requests(objective_id, source_session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS session_name_aliases (
        alias_key TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        logical_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS provider_thread_bindings (
        provider_thread_id TEXT PRIMARY KEY,
        binding_id TEXT,
        provider_id TEXT,
        provider_session_id TEXT,
        logical_session_id TEXT NOT NULL,
        worktree_id TEXT,
        bound_cwd TEXT NOT NULL,
        parent_thread_id TEXT,
        parent_binding_id TEXT,
        forked_at_turn_id TEXT,
        instruction_sources_json TEXT NOT NULL DEFAULT '[]',
        permission_snapshot_json TEXT NOT NULL DEFAULT '{}',
        provider_metadata_json TEXT NOT NULL DEFAULT '{}',
        routing_version INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL
          CHECK (state IN ('active', 'superseded', 'invalid', 'orphaned')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE,
        FOREIGN KEY (worktree_id) REFERENCES git_worktrees(worktree_id) ON DELETE SET NULL,
        FOREIGN KEY (parent_thread_id) REFERENCES provider_thread_bindings(provider_thread_id) ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_thread_bindings_active
      ON provider_thread_bindings(logical_session_id) WHERE state = 'active';

      CREATE INDEX IF NOT EXISTS idx_provider_thread_bindings_worktree
      ON provider_thread_bindings(worktree_id, state);

      CREATE TABLE IF NOT EXISTS provider_thread_lineage (
        child_thread_id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        logical_session_id TEXT NOT NULL,
        transition_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (child_thread_id) REFERENCES provider_thread_bindings(provider_thread_id) ON DELETE CASCADE,
        FOREIGN KEY (parent_thread_id) REFERENCES provider_thread_bindings(provider_thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS workspace_transitions (
        transition_id TEXT PRIMARY KEY,
        logical_session_id TEXT NOT NULL,
        source_thread_id TEXT NOT NULL,
        target_worktree_id TEXT,
        target_cwd TEXT NOT NULL,
        transition_kind TEXT NOT NULL DEFAULT 'workspace'
          CHECK (transition_kind IN ('workspace', 'provider')),
        target_provider_id TEXT,
        source_routing_version INTEGER NOT NULL,
        last_completed_turn_id TEXT,
        new_thread_id TEXT,
        resume_goal_after_transition INTEGER NOT NULL DEFAULT 0,
        continuation_prompt TEXT,
        continuation_state TEXT NOT NULL DEFAULT 'none'
          CHECK (continuation_state IN ('none', 'pending', 'queued', 'running', 'completed', 'failed')),
        continuation_turn_id TEXT,
        continuation_error TEXT,
        phase TEXT NOT NULL
          CHECK (phase IN (
            'waitingForTurn', 'preflighting', 'forking', 'validatingInstructions',
            'committingRoute', 'committed', 'failed'
          )),
        strategy TEXT NOT NULL DEFAULT 'fork'
          CHECK (strategy IN ('fork', 'handoff', 'settingsUpdate')),
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE,
        FOREIGN KEY (source_thread_id) REFERENCES provider_thread_bindings(provider_thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (target_worktree_id) REFERENCES git_worktrees(worktree_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_transitions_session
      ON workspace_transitions(logical_session_id, created_at DESC);
    `);

    // --- 实体层：Objective / WorkItem / 依赖 DAG（净新增，见 15 Phase 1） ---
    this.db.run(`
      CREATE TABLE IF NOT EXISTS objectives (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        ideal_state TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        budget_config TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'todo',
        main_workspace_id TEXT,
        main_agent_id TEXT,
        execution_status TEXT NOT NULL DEFAULT 'idle',
        acceptance_assessment_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS work_item_start_operations (
        operation_id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        repository_id TEXT,
        provider_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        failure_stage TEXT,
        error_code TEXT,
        error_summary TEXT,
        worktree_id TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        session_id TEXT,
        logical_session_id TEXT,
        provider_binding_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (work_item_id, idempotency_key),
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_work_item_start_operations_context
      ON work_item_start_operations(objective_id, work_item_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS work_item_dependencies (
        work_item_id TEXT NOT NULL,
        target_work_item_id TEXT NOT NULL,
        type TEXT NOT NULL,
        PRIMARY KEY (work_item_id, target_work_item_id),
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
        FOREIGN KEY (target_work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL CHECK (visibility IN (
          'objective_private', 'work_item_private', 'session_private', 'repository_tracked'
        )),
        bound_work_item_id TEXT,
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
        FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE,
        FOREIGN KEY (bound_work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_objective
      ON artifacts(objective_id, status, updated_at DESC);

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

      CREATE TABLE IF NOT EXISTS artifact_references (
        reference_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        work_item_id TEXT,
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
        FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
        FOREIGN KEY (artifact_id, pinned_version)
          REFERENCES artifact_versions(artifact_id, version) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_references_work_item
      ON artifact_references(work_item_id, revoked_at, required, relation);

      CREATE TABLE IF NOT EXISTS artifact_audit_events (
        audit_id TEXT PRIMARY KEY,
        artifact_id TEXT,
        objective_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        session_id TEXT,
        work_item_id TEXT,
        from_version INTEGER,
        to_version INTEGER,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
        FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_audit_objective
      ON artifact_audit_events(objective_id, created_at DESC);

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
        work_item_id TEXT,
        operation TEXT NOT NULL,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        byte_length INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (artifact_id, version)
          REFERENCES artifact_versions(artifact_id, version) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_work_items_objective_id ON work_items(objective_id);
      CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);

      CREATE TABLE IF NOT EXISTS project_integration_runs (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        status TEXT NOT NULL,
        main_head_before TEXT NOT NULL,
        main_head_after TEXT,
        integration_worktree_id TEXT,
        integration_worktree_path TEXT,
        integration_branch TEXT,
        conflict_work_item_id TEXT,
        conflict_session_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_project_integration_runs_scope
      ON project_integration_runs(repository_id, objective_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS project_integration_items (
        run_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        branch_name TEXT,
        source_head_oid TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        conflict_files_json TEXT NOT NULL DEFAULT '[]',
        merged_main_head TEXT,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, worktree_id),
        FOREIGN KEY (run_id) REFERENCES project_integration_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_project_integration_items_status
      ON project_integration_items(run_id, status, ordinal);

      CREATE TABLE IF NOT EXISTS worktree_integration_jobs (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        plan_fingerprint TEXT NOT NULL,
        details_json TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (repository_id) REFERENCES git_repositories(repository_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_worktree_integration_jobs_repository
      ON worktree_integration_jobs(repository_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS objective_work_item_association_audit (
        audit_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        received_value TEXT,
        status TEXT NOT NULL CHECK (status IN ('migrated', 'unresolved')),
        reason TEXT NOT NULL,
        migrated_value TEXT,
        first_audited_at TEXT NOT NULL,
        last_audited_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entity_association_audit_status
      ON objective_work_item_association_audit(status, entity_type, entity_id);

      CREATE TABLE IF NOT EXISTS session_association_repair_audit (
        audit_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        anomaly_code TEXT NOT NULL,
        previous_objective_id TEXT,
        previous_work_item_id TEXT,
        repaired_objective_id TEXT NOT NULL,
        repaired_work_item_id TEXT NOT NULL,
        source_operation_id TEXT NOT NULL,
        repaired_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        repaired_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_association_repair_audit_session
      ON session_association_repair_audit(session_id, repaired_at DESC);
    `);

    // --- 三层记忆（13：Objective/WorkItem 工作记忆 + Agent 进化记忆） ---
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        work_item_id TEXT,
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
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY,
        vector TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(owner_type, owner_id);
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);

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
    `);

    // --- 晋升技能（13.7：Agent 能力类记忆晋升为可发现技能，对接 12 hub） ---
    this.db.run(`
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

    // --- 合作调度中心（14：协作目录 + 协作会话 + 声誉缓存） ---
    this.db.run(`
      CREATE TABLE IF NOT EXISTS collaborator_registry (
        entry_type TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'independentContributor',
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
        requester_objective_id TEXT,
        requester_work_item_id TEXT,
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

    this.migrateWorkspaceCreationRequestAuditReferences();
    this.migrateScheduledSessionConditionTasks();
    this.migrateAutomationSchedulerV1();

    // --- 统一检索 hub（12：去抖缓存 + Session 活跃工具集） ---
    this.db.run(`
      CREATE TABLE IF NOT EXISTS hub_intent_cache (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        work_item_id TEXT,
        objective_id TEXT,
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

    this.ensureColumn("sessions", "objective_id", "TEXT");
    this.ensureColumn("sessions", "work_item_id", "TEXT");
    this.ensureColumn("sessions", "session_kind", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("sessions", "agent_id", "TEXT");
    this.db.run("DROP INDEX IF EXISTS idx_agent_sessions_current_agent");
    this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_active_pair
      ON agent_sessions(agent_id, session_id) WHERE unbound_at IS NULL`);
    this.ensureColumn("agents", "role", "TEXT NOT NULL DEFAULT 'independentContributor'");
    this.ensureColumn("agents", "agent_kind", "TEXT NOT NULL DEFAULT 'user'");
    this.ensureColumn("agents", "system_prompt", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("agents", "work_dir", "TEXT");
    this.ensureColumn("agents", "avatar_path", "TEXT");
    this.ensureColumn("objectives", "priority", "TEXT");
    this.ensureColumn("objectives", "ideal_state", "TEXT NOT NULL DEFAULT ''");
    const objectiveColumns = this.selectAll("PRAGMA table_info(objectives)");
    if (objectiveColumns.some((entry) => entry.name === "acceptance_criteria")) {
      this.db.run(
        `UPDATE objectives SET ideal_state = acceptance_criteria
         WHERE ideal_state = '' AND acceptance_criteria <> ''`
      );
      this.dropColumnIfExists("objectives", "acceptance_criteria");
    }
    this.ensureColumn("objectives", "target_date", "TEXT");
    this.ensureColumn("objectives", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("objectives", "workspace_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("objectives", "related_objective_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("objectives", "contributor_agent_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("work_items", "current_session_id", "TEXT");
    this.ensureColumn("work_items", "acceptance_criteria", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("work_items", "execution_status", "TEXT NOT NULL DEFAULT 'idle'");
    this.ensureColumn("work_items", "acceptance_assessment_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("work_items", "created_by_session_id", "TEXT");
    this.ensureColumn("work_items", "source_work_item_id", "TEXT");
    this.ensureColumn("work_items", "parent_work_item_id", "TEXT");
    this.ensureColumn("work_items", "collaboration_relation", "TEXT");
    this.ensureColumn("work_items", "idempotency_key", "TEXT");
    this.ensureColumn("work_items", "resource_version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("work_items", "canceled_at", "TEXT");
    this.ensureColumn("work_items", "cancel_reason", "TEXT");
    this.ensureColumn("work_items", "start_idempotency_key", "TEXT");
    this.ensureColumn("work_items", "start_error", "TEXT");
    this.ensureColumn("work_items", "start_stage", "TEXT");
    this.ensureColumn("work_items", "start_failure_stage", "TEXT");
    this.ensureColumn("work_items", "start_error_code", "TEXT");
    this.ensureColumn("work_items", "start_started_at", "TEXT");
    this.ensureColumn("work_items", "start_stage_updated_at", "TEXT");
    this.ensureColumn("work_items", "start_failed_at", "TEXT");
    this.ensureColumn("work_items", "start_provider_id", "TEXT");
    this.ensureColumn("work_items", "start_agent_id", "TEXT");
    this.ensureColumn("work_items", "start_worktree_id", "TEXT");
    this.ensureColumn("work_items", "start_worktree_path", "TEXT");
    this.ensureColumn("work_items", "start_worktree_branch", "TEXT");
    this.ensureColumn("work_items", "deletion_status", "TEXT");
    this.ensureColumn("work_items", "deletion_error", "TEXT");
    this.ensureColumn("work_items", "deletion_worktree_removed_at", "TEXT");
    this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_session_idempotency
      ON work_items(created_by_session_id, idempotency_key)
      WHERE created_by_session_id IS NOT NULL AND idempotency_key IS NOT NULL`);
    this.ensureColumn("collaborator_registry", "role", "TEXT NOT NULL DEFAULT 'independentContributor'");
    this.ensureColumn("hub_intent_cache", "agent_id", "TEXT");
    this.ensureColumn("sessions", "archived", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "pinned", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "sort_order", "REAL");
    this.ensureColumn("sessions", "active_choice_json", "TEXT");
    // Session identity belongs to its Agent. Remove the retired per-session
    // avatar columns without touching agents.avatar_path.
    this.dropColumnIfExists("sessions", "avatar_path");
    this.dropColumnIfExists("logical_sessions", "avatar_path");
    this.ensureColumn("logical_sessions", "session_name", "TEXT");
    this.ensureColumn("logical_sessions", "session_name_key", "TEXT");
    this.ensureColumn("collaboration_tasks", "initiator_session_id", "TEXT");
    this.ensureColumn("collaboration_tasks", "recipient_session_id", "TEXT");
    this.ensureColumn("collaboration_tasks", "initiator_name_at_send", "TEXT");
    this.ensureColumn("collaboration_tasks", "recipient_name_at_send", "TEXT");
    this.ensureColumn("collaboration_tasks", "routing_version", "INTEGER");
    this.ensureColumn("collaboration_tasks", "route_status", "TEXT NOT NULL DEFAULT 'unresolved'");
    this.ensureColumn("collaboration_tasks", "routing_intent", "TEXT");
    this.ensureColumn("collaboration_tasks", "artifact_status", "TEXT NOT NULL DEFAULT 'pending'");
    this.ensureColumn("collaboration_tasks", "acceptance_status", "TEXT NOT NULL DEFAULT 'pending'");
    this.ensureColumn("collaboration_tasks", "initiator_binding_id", "TEXT");
    this.ensureColumn("collaboration_tasks", "recipient_binding_id", "TEXT");
    this.ensureColumn("collaboration_tasks", "protocol_version", "TEXT NOT NULL DEFAULT '1.0'");
    this.ensureColumn("collaboration_tasks", "source_objective_id", "TEXT");
    this.ensureColumn("collaboration_tasks", "target_objective_id", "TEXT");
    this.ensureColumn("collaboration_tasks", "source_work_item_id", "TEXT");
    this.ensureColumn("collaboration_tasks", "work_item_id", "TEXT");
    this.ensureColumn("collaboration_messages", "protocol_version", "TEXT NOT NULL DEFAULT '1.0'");
    this.ensureColumn("collaboration_messages", "source_objective_id", "TEXT");
    this.ensureColumn("collaboration_messages", "target_objective_id", "TEXT");
    this.ensureColumn("collaboration_messages", "source_work_item_id", "TEXT");
    this.ensureColumn("collaboration_messages", "work_item_id", "TEXT");
    this.ensureColumn("collaboration_messages", "payload_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("collaboration_messages", "error_json", "TEXT");
    this.ensureColumn("collaboration_messages", "sender_session_id", "TEXT");
    this.ensureColumn("collaboration_messages", "recipient_session_id", "TEXT");
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_collaboration_tasks_objective_work_item
      ON collaboration_tasks(source_objective_id, target_objective_id, work_item_id, updated_at DESC)`);
    this.ensureColumn("collaboration_request_confirmations", "initiator_session_id", "TEXT");
    this.ensureColumn("collaboration_request_confirmations", "recipient_session_id", "TEXT");
    this.ensureColumn("collaboration_request_confirmations", "initiator_name_at_send", "TEXT");
    this.ensureColumn("collaboration_request_confirmations", "recipient_name_at_send", "TEXT");
    this.migrateCanonicalSessionNames();
    this.migrateCollaborationSessionIdentities();
    this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_logical_sessions_session_name
      ON logical_sessions(session_name_key) WHERE session_name_key IS NOT NULL`);
    this.ensureColumn("provider_thread_bindings", "routing_version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("provider_thread_bindings", "binding_id", "TEXT");
    this.ensureColumn("provider_thread_bindings", "provider_id", "TEXT");
    this.ensureColumn("provider_thread_bindings", "provider_session_id", "TEXT");
    this.ensureColumn("provider_thread_bindings", "parent_binding_id", "TEXT");
    this.ensureColumn("provider_thread_bindings", "provider_metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    this.migrateSessionProviderBindings();
    this.migrateWorkspaceTransitionsForDirectoryTargets();
    this.ensureColumn("workspace_transitions", "resume_goal_after_transition", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("workspace_transitions", "continuation_prompt", "TEXT");
    this.ensureColumn("workspace_transitions", "continuation_state", "TEXT NOT NULL DEFAULT 'none'");
    this.ensureColumn("workspace_transitions", "continuation_turn_id", "TEXT");
    this.db.run(`UPDATE sessions SET agent_id = (
        SELECT bindings.agent_id FROM agent_sessions bindings
        WHERE bindings.session_id = sessions.id
        ORDER BY bindings.bound_at DESC LIMIT 1
      ) WHERE agent_id IS NULL OR TRIM(agent_id) = ''`);
    this.db.run(`UPDATE sessions SET session_kind = 'worker'
      WHERE work_item_id IS NOT NULL AND TRIM(work_item_id) <> ''
        AND (session_kind IS NULL OR TRIM(session_kind) = ''
          OR session_kind NOT IN ('assistantChat', 'objectiveChat', 'worker'))`);
    this.db.run(`UPDATE sessions SET session_kind = 'objectiveChat'
      WHERE objective_id IS NOT NULL AND TRIM(objective_id) <> ''
        AND (work_item_id IS NULL OR TRIM(work_item_id) = '')
        AND (session_kind IS NULL OR TRIM(session_kind) = ''
          OR session_kind NOT IN ('assistantChat', 'objectiveChat', 'worker'))`);
    // Objective discussion is a one-to-one association. Preserve the oldest
    // discussion as canonical and retain historical duplicates as ordinary,
    // unbound chats before installing the durable uniqueness guard.
    this.db.run(`UPDATE sessions AS duplicate
      SET objective_id = NULL, session_kind = 'assistantChat'
      WHERE duplicate.session_kind = 'objectiveChat'
        AND duplicate.objective_id IS NOT NULL
        AND TRIM(duplicate.objective_id) <> ''
        AND EXISTS (
          SELECT 1 FROM sessions AS canonical
          WHERE canonical.session_kind = 'objectiveChat'
            AND canonical.objective_id = duplicate.objective_id
            AND (
              canonical.created_at < duplicate.created_at
              OR (canonical.created_at = duplicate.created_at AND canonical.id < duplicate.id)
            )
        )`);
    this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_objective_chat
      ON sessions(objective_id)
      WHERE session_kind = 'objectiveChat' AND objective_id IS NOT NULL`);
    this.db.run(`UPDATE sessions SET session_kind = 'assistantChat'
      WHERE (session_kind IS NULL OR TRIM(session_kind) = ''
          OR session_kind NOT IN ('assistantChat', 'objectiveChat', 'worker'))
        AND EXISTS (SELECT 1 FROM agents
          WHERE agents.agent_id = sessions.agent_id AND agents.role = 'assistant')`);
    this.db.run(`UPDATE sessions SET session_kind = 'legacy'
      WHERE session_kind IS NULL OR TRIM(session_kind) = ''
        OR session_kind NOT IN ('assistantChat', 'objectiveChat', 'worker', 'legacy')`);
    const historicalSessionRepair = this.repairOrphanedWorkSessions({
      repairedBy: "store-migration",
      reason: "Recovered a historical Worker Session before installing association guards."
    });
    if (historicalSessionRepair.repaired.length > 0) {
      console.info(`[session-association] repaired=${historicalSessionRepair.repaired.length} source=store-migration`);
    }
    if (historicalSessionRepair.unresolved.length > 0) {
      console.warn(`[session-association] unresolved=${historicalSessionRepair.unresolved.length} source=store-migration`);
    }
    this.db.run("DROP TRIGGER IF EXISTS sessions_worker_association_insert_guard");
    this.db.run("DROP TRIGGER IF EXISTS sessions_worker_association_update_guard");
    this.db.run(`CREATE TRIGGER sessions_worker_association_insert_guard
      BEFORE INSERT ON sessions
      WHEN NEW.session_kind = 'worker'
      BEGIN
        SELECT CASE
          WHEN NEW.objective_id IS NULL OR TRIM(NEW.objective_id) = ''
            OR NEW.work_item_id IS NULL OR TRIM(NEW.work_item_id) = ''
          THEN RAISE(ABORT, 'WORKER_SESSION_ASSOCIATION_REQUIRED')
          WHEN NOT EXISTS (
            SELECT 1 FROM work_items wi
            JOIN objectives o ON o.id = wi.objective_id
            WHERE wi.id = NEW.work_item_id AND wi.objective_id = NEW.objective_id
          )
          THEN RAISE(ABORT, 'SESSION_WORK_ITEM_OBJECTIVE_MISMATCH')
        END;
      END`);
    this.db.run(`CREATE TRIGGER sessions_worker_association_update_guard
      BEFORE UPDATE OF session_kind, objective_id, work_item_id ON sessions
      WHEN NEW.session_kind = 'worker' AND (
        OLD.session_kind IS NOT NEW.session_kind
        OR OLD.objective_id IS NOT NEW.objective_id
        OR OLD.work_item_id IS NOT NEW.work_item_id
      )
      BEGIN
        SELECT CASE
          WHEN NEW.objective_id IS NULL OR TRIM(NEW.objective_id) = ''
            OR NEW.work_item_id IS NULL OR TRIM(NEW.work_item_id) = ''
          THEN RAISE(ABORT, 'WORKER_SESSION_ASSOCIATION_REQUIRED')
          WHEN NOT EXISTS (
            SELECT 1 FROM work_items wi
            JOIN objectives o ON o.id = wi.objective_id
            WHERE wi.id = NEW.work_item_id AND wi.objective_id = NEW.objective_id
          )
          THEN RAISE(ABORT, 'SESSION_WORK_ITEM_OBJECTIVE_MISMATCH')
        END;
      END`);
    this.ensureColumn("workspace_transitions", "continuation_error", "TEXT");
    this.ensureColumn("workspace_transitions", "transition_kind", "TEXT NOT NULL DEFAULT 'workspace'");
    this.ensureColumn("workspace_transitions", "target_provider_id", "TEXT");
    this.ensureColumn("session_items", "options_json", "TEXT");
    this.ensureColumn("session_items", "raw_metadata_json", "TEXT");
    this.ensureColumn("feishu_bindings", "chat_id", "TEXT");
    this.ensureColumn("feishu_bots", "app_id", "TEXT");
    this.ensureColumn("feishu_bots", "brand", "TEXT NOT NULL DEFAULT 'feishu'");
    this.ensureColumn("feishu_bots", "managed_profile", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("feishu_bots", "remote_name", "TEXT");
    this.ensureColumn("feishu_bots", "remote_avatar_url", "TEXT");
    this.ensureColumn("feishu_bots", "remote_open_id", "TEXT");
    this.ensureColumn("feishu_bots", "remote_activate_status", "INTEGER");
    // --- 会话日志事件溯源（10）：补 session_logs + session_events 语义列 ---
    this.ensureColumn("session_events", "log_id", "TEXT");
    this.ensureColumn("session_events", "producer", "TEXT");
    this.ensureColumn("session_events", "surface", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("session_events", "source_event_seqs_json", "TEXT");
    this.ensureColumn("session_events", "call_id", "TEXT");
    this.ensureColumn("session_events", "has_agent_message", "INTEGER NOT NULL DEFAULT 0");
    this.migrateSessionEventAgentMessageFlag();
    this.db.run("CREATE INDEX IF NOT EXISTS idx_session_events_producer ON session_events(session_id, producer)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_session_events_call_id ON session_events(session_id, call_id)");
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_session_events_latest_message
      ON session_events(session_id, created_at DESC)
      WHERE surface = 1
         OR type IN ('SessionUserMessageCreated', 'CodexThreadCompleted')
    `);
    this.db.run("DROP INDEX IF EXISTS idx_session_events_agent_message");
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_session_events_agent_message
      ON session_events(session_id, sequence DESC)
      WHERE has_agent_message = 1
    `);
    // 回填：为每个已有 session 建立 1:1 的 session_log；并让既有事件指向该 log。
    this.db.run(`
      INSERT INTO session_logs (id, session_id, created_at)
      SELECT 'log:' || id, id, COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      FROM sessions
      WHERE NOT EXISTS (SELECT 1 FROM session_logs WHERE session_logs.session_id = sessions.id)
    `);
    this.db.run(`
      UPDATE session_events
      SET log_id = 'log:' || session_id
      WHERE log_id IS NULL
    `);
    // Introducing server-side receipts must not make every historical Session
    // unread at once. Bootstrap only when the table is first created; future
    // Sessions deliberately have no receipt until the user opens their detail.
    if (!hadSessionReadReceipts) {
      this.db.run(`
        INSERT OR IGNORE INTO session_read_receipts (
          session_id, last_read_agent_message_sequence, updated_at
        )
        SELECT sessions.id, COALESCE(MAX(session_events.sequence), 0),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM sessions
        LEFT JOIN session_events ON session_events.session_id = sessions.id
          AND ${agentMessageEventSQL("session_events")}
        GROUP BY sessions.id
      `);
    }
    // --- 三层记忆（13）：乐观应用/撤销语义字段 ---
    this.ensureColumn("memories", "auto_applied", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("memories", "applied_at", "TEXT");
    this.ensureColumn("memories", "revoked_at", "TEXT");
    this.ensureColumn("memories", "work_item_id", "TEXT REFERENCES work_items(id) ON DELETE CASCADE");
    this.ensureColumn("memories", "source_event_sequence", "INTEGER");
    this.ensureColumn("memories", "trust_level", "TEXT NOT NULL DEFAULT 'untrusted'");
    this.ensureColumn("memories", "expires_at", "TEXT");
    this.ensureColumn("memories", "replaces_memory_id", "TEXT");
    this.migrateWorkItemMemoryAssociations();
    this.initializeSortOrder();
    this.migrateAgentAvailability();
    this.ensureSkillTables();
    this.ensureStateSyncTables();
    this.dropColumnIfExists("agents", "provider");
    this.ensureAssistantAgent();
    this.migrateAssistantWorkDirs();
    this.auditObjectiveWorkItemAssociations({ migrate: true });
    this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_assistant_work_dir
      ON agents(work_dir COLLATE NOCASE)
      WHERE role = 'assistant' AND work_dir IS NOT NULL AND TRIM(work_dir) <> ''`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sessions_archived_order ON sessions(archived, pinned DESC, sort_order ASC)");
    // Agent identity owns shared configuration and memory, not an execution slot.
    // Sessions are the concurrency boundary: each Session remains serial while
    // different Sessions bound to the same Agent may run independently.
    this.db.run("DROP INDEX IF EXISTS idx_agent_work_items_one_running");
    this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_work_items_one_running_per_session
      ON agent_work_items(session_id) WHERE status = 'running'`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_agent_work_items_session_next
      ON agent_work_items(session_id, status, priority DESC, created_at ASC)`);

    this.db.run(
      `UPDATE sessions
       SET status = 'cancelled',
           summary = CASE
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

  // Durable control-plane revision log. SQLite triggers make every mutation to
  // a client-visible entity participate in the same transaction as the entity
  // write, including writes performed by background/provider callbacks. The
  // transport may coalesce several row revisions into one ChangeSet, but it
  // can never acknowledge a revision whose entity write did not commit.
  ensureStateSyncTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS state_sync_clock (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO state_sync_clock (singleton, revision) VALUES (1, 0);

      CREATE TABLE IF NOT EXISTS state_change_log (
        revision INTEGER PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
        changed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_state_change_log_entity
      ON state_change_log(entity_type, entity_id, revision DESC);
    `);

    const tracked = [
      ["sessions", "session", "id"],
      ["work_items", "workItem", "id"],
      ["objectives", "objective", "id"],
      ["agents", "agent", "agent_id"],
      ["skill_registry", "skill", "skill_id"],
      ["git_repositories", "repository", "repository_id"],
      ["project_integration_runs", "integrationRun", "id"]
    ];
    for (const [table, entityType, idColumn] of tracked) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const suffix = operation.toLowerCase();
        const row = operation === "DELETE" ? "OLD" : "NEW";
        const changeOperation = operation === "DELETE" ? "delete" : "upsert";
        this.db.run(`
          CREATE TRIGGER IF NOT EXISTS state_sync_${table}_${suffix}
          AFTER ${operation} ON ${table}
          BEGIN
            UPDATE state_sync_clock SET revision = revision + 1 WHERE singleton = 1;
            INSERT INTO state_change_log (revision, entity_type, entity_id, operation, changed_at)
            SELECT revision, '${entityType}', ${row}.${idColumn}, '${changeOperation}',
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            FROM state_sync_clock WHERE singleton = 1;
            DELETE FROM state_change_log
            WHERE revision < MAX(0, (SELECT revision FROM state_sync_clock WHERE singleton = 1) - 10000);
          END;
        `);
      }
    }
    // Read-receipt mutations change the client-visible Session projection but
    // must never rewrite sessions.updated_at (which drives conversation order).
    for (const operation of ["INSERT", "UPDATE"]) {
      const suffix = operation.toLowerCase();
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS state_sync_session_read_receipts_${suffix}
        AFTER ${operation} ON session_read_receipts
        BEGIN
          UPDATE state_sync_clock SET revision = revision + 1 WHERE singleton = 1;
          INSERT INTO state_change_log (revision, entity_type, entity_id, operation, changed_at)
          SELECT revision, 'session', NEW.session_id, 'upsert',
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          FROM state_sync_clock WHERE singleton = 1;
        END;
      `);
    }
    // A completed Agent message advances the unread cursor even when no
    // sessions column changes in the same transaction.
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS state_sync_session_events_agent_message_insert
      AFTER INSERT ON session_events
      WHEN NEW.has_agent_message = 1
      BEGIN
        UPDATE state_sync_clock SET revision = revision + 1 WHERE singleton = 1;
        INSERT INTO state_change_log (revision, entity_type, entity_id, operation, changed_at)
        SELECT revision, 'session', NEW.session_id, 'upsert',
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM state_sync_clock WHERE singleton = 1;
      END;
    `);
    // A bounded durable replay window is sufficient because clients fall back
    // to /state/snapshot when their cursor predates it.
    this.db.run(`
      DELETE FROM state_change_log
      WHERE revision < MAX(0, (SELECT revision FROM state_sync_clock WHERE singleton = 1) - 10000)
    `);

    // Agent↔Skill assignments are part of the Agent wire model. Link changes
    // therefore publish Agent upserts even though the agents row itself is not
    // rewritten. Cascade deletes from skill_registry use the same triggers.
    for (const operation of ["INSERT", "DELETE"]) {
      const suffix = operation.toLowerCase();
      const row = operation === "DELETE" ? "OLD" : "NEW";
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS state_sync_agent_skill_links_${suffix}
        AFTER ${operation} ON agent_skill_links
        BEGIN
          UPDATE state_sync_clock SET revision = revision + 1 WHERE singleton = 1;
          INSERT INTO state_change_log (revision, entity_type, entity_id, operation, changed_at)
          SELECT revision, 'agent', ${row}.agent_id, 'upsert',
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          FROM state_sync_clock WHERE singleton = 1;
        END;
      `);
    }
  }

  migrateSessionEventAgentMessageFlag() {
    const migrationId = "session-events-has-agent-message-v1";
    if (this.selectOne("SELECT migration_id FROM data_migrations WHERE migration_id = ?", [migrationId])) {
      return;
    }
    this.runInTransaction(() => {
      this.db.run(`
        UPDATE session_events
        SET has_agent_message = CASE
          WHEN type IN ('CodexThreadCompleted', 'AgentTurnCompleted')
           AND COALESCE(json_extract(payload_json, '$.hasAgentMessage'), 0) = 1
          THEN 1 ELSE 0 END
      `);
      this.db.run(
        "INSERT INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
        [migrationId, createdAtFromOrNow()]
      );
    });
  }

  stateRevision() {
    return Number(this.selectOne(
      "SELECT revision FROM state_sync_clock WHERE singleton = 1"
    )?.revision ?? 0);
  }

  stateChangesAfter(revision) {
    return this.selectAll(
      `SELECT revision, entity_type, entity_id, operation, changed_at
       FROM state_change_log WHERE revision > ? ORDER BY revision ASC`,
      [Number(revision) || 0]
    ).map((row) => ({
      revision: Number(row.revision),
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation,
      changedAt: row.changed_at
    }));
  }

  oldestStateChangeRevision() {
    const row = this.selectOne("SELECT MIN(revision) AS revision FROM state_change_log");
    return row?.revision == null ? this.stateRevision() : Number(row.revision);
  }

  stateConsistencyIssues() {
    return this.selectAll(`
      SELECT 'worker_session_objective_missing' AS code, s.id AS entity_id,
             s.work_item_id AS reference_id
      FROM sessions s
      WHERE s.session_kind='worker' AND (s.objective_id IS NULL OR TRIM(s.objective_id)='')
      UNION ALL
      SELECT 'worker_session_work_item_missing', s.id, s.objective_id
      FROM sessions s
      WHERE s.session_kind='worker' AND (s.work_item_id IS NULL OR TRIM(s.work_item_id)='')
      UNION ALL
      SELECT 'work_item_current_session_missing', wi.id,
             wi.current_session_id AS reference_id
      FROM work_items wi
      LEFT JOIN sessions s ON s.id = wi.current_session_id
      WHERE wi.current_session_id IS NOT NULL AND s.id IS NULL
      UNION ALL
      SELECT 'work_item_session_binding_mismatch', wi.id, wi.current_session_id
      FROM work_items wi
      JOIN sessions s ON s.id = wi.current_session_id
      WHERE s.work_item_id IS NOT wi.id OR s.objective_id IS NOT wi.objective_id
      UNION ALL
      SELECT 'session_work_item_missing', s.id, s.work_item_id
      FROM sessions s
      LEFT JOIN work_items wi ON wi.id = s.work_item_id
      WHERE s.work_item_id IS NOT NULL AND wi.id IS NULL
      UNION ALL
      SELECT 'session_objective_mismatch', s.id, s.work_item_id
      FROM sessions s
      JOIN work_items wi ON wi.id = s.work_item_id
      WHERE s.objective_id IS NOT wi.objective_id
      UNION ALL
      SELECT 'memory_work_item_association_mismatch', m.id, m.work_item_id
      FROM memories m
      LEFT JOIN work_items wi ON wi.id = m.work_item_id
      WHERE m.owner_type = 'work_item'
        AND (wi.id IS NULL OR m.work_item_id IS NOT m.owner_id)
      UNION ALL
      SELECT 'memory_source_session_binding_mismatch', m.id, m.source_session_id
      FROM memories m
      LEFT JOIN sessions s ON s.id = m.source_session_id
      LEFT JOIN work_items wi ON wi.id = m.work_item_id
      WHERE m.owner_type = 'work_item'
        AND (s.id IS NULL OR s.work_item_id IS NOT wi.id OR s.objective_id IS NOT wi.objective_id)
      UNION ALL
      SELECT 'integration_conflict_work_item_missing', r.id, r.conflict_work_item_id
      FROM project_integration_runs r
      LEFT JOIN work_items wi ON wi.id = r.conflict_work_item_id
      WHERE r.conflict_work_item_id IS NOT NULL AND wi.id IS NULL
      UNION ALL
      SELECT 'integration_conflict_session_missing', r.id, r.conflict_session_id
      FROM project_integration_runs r
      LEFT JOIN sessions s ON s.id = r.conflict_session_id
      WHERE r.conflict_session_id IS NOT NULL AND s.id IS NULL
      UNION ALL
      SELECT 'integration_conflict_binding_mismatch', r.id, r.conflict_session_id
      FROM project_integration_runs r
      JOIN sessions s ON s.id = r.conflict_session_id
      WHERE r.conflict_work_item_id IS NULL OR s.work_item_id IS NOT r.conflict_work_item_id
    `).map((row) => ({
      code: row.code,
      entityId: row.entity_id,
      referenceId: row.reference_id
    }));
  }

  // 建立 Skill 维护中心（全局映射表）与 Agent↔Skill 多对多关联。
  // skill_registry：记录所有成功安装过的 Skill（本地目录 / GitHub 仓库克隆缓存），
  //         只维护「指向具体 Skill 位置」的映射，全局共享。
  // agent_skill_links：每个 Agent 启用哪些 Skill 的元数据（启用≠复制，安装物化在运行时目录）。
  // 「Skill 维护中心」使用独立的表名（skill_registry / agent_skill_links），
  // 与旧「晋升技能」的 skills 表彻底分离，避免 schema 与方法名冲突。
  ensureSkillTables() {
    this.db.run(`
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

    this.ensureColumn("skill_registry", "source_subpath", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("skill_registry", "package_subpath", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("skill_registry", "mcp_descriptor_subpath", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("skill_registry", "package_discovery_method", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("skill_registry", "manifest_name", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("skill_registry", "manifest_description", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("skill_registry", "content_hash", "TEXT NOT NULL DEFAULT ''");

    // 迁移：删除旧「晋升技能」遗留的 agent_skills 关联表。
    // 该表带 FOREIGN KEY (skill_id) REFERENCES skills(skill_id) ON DELETE CASCADE，
    // 在 PRAGMA foreign_keys=ON 下删除 agents 时会触发 foreign key mismatch，
    // 且其 schema（skills 表）已与 Skill 维护中心彻底分离、无任何调用者，属死表。
    this.db.run(`DROP TABLE IF EXISTS agent_skills`);
  }

  // ===== Skill 维护中心 =====

  listRegistrySkills() {
    return this.selectAll(`SELECT * FROM skill_registry ORDER BY name ASC`).map(skillFromRow);
  }

  getRegistrySkill(skillId) {
    const row = this.selectOne(`SELECT * FROM skill_registry WHERE skill_id = ?`, [skillId]);
    return row ? skillFromRow(row) : null;
  }

  createRegistrySkill(input = {}) {
    const id = input.id ?? `skill:${randomUUID()}`;
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO skill_registry (
         skill_id, name, description, source_type, source, source_subpath, package_subpath,
         mcp_descriptor_subpath, package_discovery_method, cache_path,
         manifest_name, manifest_description, content_hash, installed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.description ?? "",
        input.sourceType ?? "local",
        input.source,
        input.sourceSubpath ?? "",
        input.packageSubpath ?? "",
        input.mcpDescriptorSubpath ?? "",
        input.packageDiscoveryMethod ?? "",
        input.cachePath ?? null,
        input.manifestName ?? input.name ?? "",
        input.manifestDescription ?? input.description ?? "",
        input.contentHash ?? "",
        now,
        now
      ]
    );
    this.scheduleSave();
    return this.getRegistrySkill(id);
  }

  updateRegistrySkill(skillId, input = {}) {
    const existing = this.getRegistrySkill(skillId);
    if (!existing) return null;
    const now = createdAtFromOrNow();
    this.db.run(
      `UPDATE skill_registry
       SET name = ?, description = ?, source_type = ?, source = ?, source_subpath = ?, package_subpath = ?,
           mcp_descriptor_subpath = ?, package_discovery_method = ?, cache_path = ?,
           manifest_name = ?, manifest_description = ?, content_hash = ?, updated_at = ?
       WHERE skill_id = ?`,
      [
        input.name ?? existing.name,
        input.description ?? existing.description,
        input.sourceType ?? existing.sourceType,
        input.source ?? existing.source,
        input.sourceSubpath ?? existing.sourceSubpath ?? "",
        input.packageSubpath ?? existing.packageSubpath ?? "",
        input.mcpDescriptorSubpath ?? existing.mcpDescriptorSubpath ?? "",
        input.packageDiscoveryMethod ?? existing.packageDiscoveryMethod ?? "",
        input.cachePath ?? existing.cachePath,
        input.manifestName ?? existing.manifestName ?? existing.name,
        input.manifestDescription ?? existing.manifestDescription ?? existing.description,
        input.contentHash ?? existing.contentHash ?? "",
        now,
        skillId
      ]
    );
    this.scheduleSave();
    return this.getRegistrySkill(skillId);
  }

  deleteRegistrySkill(skillId) {
    const existing = this.getRegistrySkill(skillId);
    if (!existing) return false;
    this.db.run("BEGIN IMMEDIATE");
    try {
      const impact = this.registrySkillDeletionImpact(skillId);
      if (impact?.activeSessionCount > 0) {
        const error = new Error(`Skill has active Sessions: ${skillId}`);
        error.code = "SKILL_HAS_ACTIVE_SESSIONS";
        error.impact = impact;
        throw error;
      }
      this.db.run(`DELETE FROM skill_registry WHERE skill_id = ?`, [skillId]);
      const remainingLinks = this.selectOne(
        `SELECT COUNT(*) AS count FROM agent_skill_links WHERE skill_id = ?`,
        [skillId]
      );
      if (this.getRegistrySkill(skillId) || Number(remainingLinks?.count ?? 0) !== 0) {
        const error = new Error(`Skill deletion did not remove all references: ${skillId}`);
        error.code = "SKILL_DELETE_INTEGRITY_FAILED";
        throw error;
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return true;
  }

  registrySkillDeletionImpact(skillId) {
    const skill = this.getRegistrySkill(skillId);
    if (!skill) return null;
    const affectedAgents = this.selectAll(
      `SELECT a.agent_id, a.name
       FROM agent_skill_links links
       JOIN agents a ON a.agent_id = links.agent_id
       WHERE links.skill_id = ?
       ORDER BY a.name COLLATE NOCASE, a.agent_id`,
      [skillId]
    ).map((row) => ({ agentId: row.agent_id, name: row.name }));
    const activeSessions = this.selectAll(
      `SELECT DISTINCT s.id, s.title, s.status, a.agent_id, a.name AS agent_name
       FROM agent_skill_links links
       JOIN agents a ON a.agent_id = links.agent_id
       JOIN sessions s ON (
         s.agent_id = a.agent_id OR EXISTS (
           SELECT 1 FROM agent_sessions bindings
           WHERE bindings.session_id = s.id
             AND bindings.agent_id = a.agent_id
             AND bindings.unbound_at IS NULL
         )
       )
       WHERE links.skill_id = ? AND s.status IN ('running', 'blocked')
       ORDER BY s.created_at, s.id`,
      [skillId]
    ).map((row) => ({
      sessionId: row.id,
      title: row.title,
      status: row.status,
      agentId: row.agent_id,
      agentName: row.agent_name
    }));
    return {
      skillId,
      skillName: skill.name,
      affectedAgents,
      affectedAgentCount: affectedAgents.length,
      activeSessions,
      activeSessionCount: activeSessions.length,
      canDelete: activeSessions.length === 0,
      policy: "blockWhileAssignedAgentSessionActive"
    };
  }

  createSkillDeletionOperation({ skill, impact, cleanup = [] }) {
    const operationId = `skill-deletion:${randomUUID()}`;
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO skill_deletion_operations (
         operation_id, skill_id, skill_name, status, affected_agents_json,
         active_sessions_json, cleanup_json, recovery_json, created_at, updated_at
       ) VALUES (?, ?, ?, 'pending', ?, ?, ?, '[]', ?, ?)`,
      [
        operationId,
        skill.skillId,
        skill.name,
        JSON.stringify(impact.affectedAgents ?? []),
        JSON.stringify(impact.activeSessions ?? []),
        JSON.stringify(cleanup),
        now,
        now
      ]
    );
    this.scheduleSave();
    return this.getSkillDeletionOperation(operationId);
  }

  updateSkillDeletionOperation(operationId, input = {}) {
    const existing = this.getSkillDeletionOperation(operationId);
    if (!existing) return null;
    const status = input.status ?? existing.status;
    const now = createdAtFromOrNow();
    this.db.run(
      `UPDATE skill_deletion_operations
       SET status = ?, cleanup_json = ?, recovery_json = ?, error_code = ?,
           error_message = ?, updated_at = ?, completed_at = ?
       WHERE operation_id = ?`,
      [
        status,
        JSON.stringify(input.cleanup ?? existing.cleanup),
        JSON.stringify(input.recovery ?? existing.recovery),
        input.errorCode ?? existing.errorCode,
        input.errorMessage ?? existing.errorMessage,
        now,
        status === "completed" ? now : existing.completedAt,
        operationId
      ]
    );
    this.scheduleSave();
    return this.getSkillDeletionOperation(operationId);
  }

  getSkillDeletionOperation(operationId) {
    const row = this.selectOne(
      `SELECT * FROM skill_deletion_operations WHERE operation_id = ?`,
      [operationId]
    );
    return row ? skillDeletionOperationFromRow(row) : null;
  }

  // ===== Agent ↔ Skill 关联 =====

  listRegistrySkillIdsForAgent(agentId) {
    return this.selectAll(
      `SELECT skill_id FROM agent_skill_links WHERE agent_id = ? ORDER BY added_at ASC`,
      [agentId]
    ).map((row) => row.skill_id);
  }

  listRegistrySkillsForAgent(agentId) {
    const ids = this.listRegistrySkillIdsForAgent(agentId);
    return ids.map((id) => this.getRegistrySkill(id)).filter(Boolean);
  }

  recordSkillRuntimeEvent(input = {}) {
    const eventId = input.eventId ?? `skill_event:${randomUUID()}`;
    const stage = String(input.stage ?? "").trim();
    const status = String(input.status ?? "").trim();
    if (!stage) throw new TypeError("Skill runtime event stage is required.");
    if (!new Set(["info", "success", "failed", "denied"]).has(status)) {
      throw new TypeError(`Invalid Skill runtime event status: ${status || "(empty)"}`);
    }
    const createdAt = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO skill_runtime_events (
         event_id, stage, status, error_code, reason, skill_id, agent_id, session_id,
         provider_id, server_names_json, tool_count, details_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        stage,
        status,
        input.errorCode ? String(input.errorCode) : null,
        String(input.reason ?? ""),
        input.skillId ?? null,
        input.agentId ?? null,
        input.sessionId ?? null,
        input.providerId ?? null,
        JSON.stringify(Array.isArray(input.serverNames) ? [...new Set(input.serverNames.map(String))] : []),
        Number.isInteger(input.toolCount) ? input.toolCount : null,
        JSON.stringify(input.details && typeof input.details === "object" ? input.details : {}),
        createdAt
      ]
    );
    this.scheduleSave();
    return this.getSkillRuntimeEvent(eventId);
  }

  getSkillRuntimeEvent(eventId) {
    const row = this.selectOne(`SELECT * FROM skill_runtime_events WHERE event_id = ?`, [eventId]);
    return row ? skillRuntimeEventFromRow(row) : null;
  }

  listSkillRuntimeEvents(filters = {}) {
    const clauses = [];
    const values = [];
    for (const [column, value] of [
      ["skill_id", filters.skillId],
      ["agent_id", filters.agentId],
      ["session_id", filters.sessionId],
      ["provider_id", filters.providerId],
      ["stage", filters.stage]
    ]) {
      const normalized = typeof value === "string" ? value.trim() : "";
      if (!normalized) continue;
      clauses.push(`${column} = ?`);
      values.push(normalized);
    }
    const requestedLimit = Number(filters.limit ?? 100);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(500, requestedLimit)) : 100;
    values.push(limit);
    return this.selectAll(
      `SELECT * FROM skill_runtime_events${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC, event_id DESC LIMIT ?`,
      values
    ).map(skillRuntimeEventFromRow);
  }

  createAgentWithRegistrySkills(agentInput, skillIds = []) {
    const normalized = this.#validateRegistrySkillIds(skillIds);
    this.db.run("BEGIN IMMEDIATE");
    try {
      const agent = this.createAgent(agentInput);
      this.#replaceAgentRegistrySkills(agent.agentId, normalized);
      this.#recordSkillAssignmentDelta(agent.agentId, [], normalized);
      this.db.run("COMMIT");
      this.scheduleSave();
      return agent;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  createAgentWithRegistrySkillsIdempotently(agentInput, skillIds = [], request = {}) {
    const normalized = this.#validateRegistrySkillIds(skillIds);
    const idempotencyKey = String(request.idempotencyKey ?? "").trim();
    const requestHash = String(request.requestHash ?? "").trim();
    const requestId = String(request.requestId ?? "").trim();
    if (!idempotencyKey || !requestHash || !requestId) {
      const error = new Error("Agent creation idempotency metadata is required.");
      error.code = "INVALID_INPUT";
      throw error;
    }

    this.db.run("BEGIN IMMEDIATE");
    try {
      const existing = this.selectOne(
        `SELECT idempotency_key, request_hash, agent_id, request_id, device_id, created_at
         FROM agent_creation_requests WHERE idempotency_key = ?`,
        [idempotencyKey]
      );
      if (existing) {
        if (existing.request_hash !== requestHash) {
          const error = new Error("Idempotency key was already used for different Agent creation parameters.");
          error.code = "IDEMPOTENCY_CONFLICT";
          error.existingRequestId = existing.request_id;
          throw error;
        }
        const agent = this.getAgent(existing.agent_id);
        if (!agent) {
          const error = new Error("The Agent created by this idempotency key no longer exists.");
          error.code = "IDEMPOTENCY_RESOURCE_GONE";
          error.existingRequestId = existing.request_id;
          throw error;
        }
        this.db.run("COMMIT");
        return { agent, replayed: true, originalRequestId: existing.request_id };
      }

      const agent = this.createAgent(agentInput);
      this.#replaceAgentRegistrySkills(agent.agentId, normalized);
      this.#recordSkillAssignmentDelta(agent.agentId, [], normalized);
      this.db.run(
        `INSERT INTO agent_creation_requests (
           idempotency_key, request_hash, agent_id, request_id, device_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          idempotencyKey,
          requestHash,
          agent.agentId,
          requestId,
          typeof request.deviceId === "string" && request.deviceId.trim() ? request.deviceId.trim() : null,
          createdAtFromOrNow()
        ]
      );
      this.db.run("COMMIT");
      this.scheduleSave();
      return { agent, replayed: false, originalRequestId: requestId };
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  updateAgentWithRegistrySkills(agentId, agentInput, skillIds) {
    if (isPlatformAssistant(agentId) && skillIds != null) {
      throw platformAssistantProtectionError("The built-in Corptie Assistant Skill assignment is managed by the product.");
    }
    const normalized = skillIds == null ? null : this.#validateRegistrySkillIds(skillIds);
    const previous = normalized ? this.listRegistrySkillIdsForAgent(agentId) : null;
    this.db.run("BEGIN IMMEDIATE");
    try {
      const agent = this.updateAgent(agentId, agentInput);
      if (!agent) {
        const error = new Error(`Agent not found: ${agentId}`);
        error.code = "AGENT_NOT_FOUND";
        throw error;
      }
      if (normalized) this.#replaceAgentRegistrySkills(agentId, normalized);
      if (normalized) this.#recordSkillAssignmentDelta(agentId, previous, normalized);
      this.db.run("COMMIT");
      this.scheduleSave();
      return agent;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  setAgentRegistrySkills(agentId, skillIds = []) {
    if (isPlatformAssistant(agentId)) {
      throw platformAssistantProtectionError("The built-in Corptie Assistant Skill assignment is managed by the product.");
    }
    const normalized = this.#validateRegistrySkillIds(skillIds);
    const previous = this.listRegistrySkillIdsForAgent(agentId);
    if (!this.getAgent(agentId)) {
      const error = new Error(`Agent not found: ${agentId}`);
      error.code = "AGENT_NOT_FOUND";
      throw error;
    }
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.#replaceAgentRegistrySkills(agentId, normalized);
      this.#recordSkillAssignmentDelta(agentId, previous, normalized);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return normalized;
  }

  #recordSkillAssignmentDelta(agentId, previous = [], next = []) {
    const before = new Set(previous);
    const after = new Set(next);
    for (const skillId of after) {
      if (before.has(skillId)) continue;
      this.recordSkillRuntimeEvent({
        stage: "assignment",
        status: "success",
        skillId,
        agentId,
        reason: "Skill assigned to Agent."
      });
    }
    for (const skillId of before) {
      if (after.has(skillId)) continue;
      this.recordSkillRuntimeEvent({
        stage: "assignment",
        status: "denied",
        skillId,
        agentId,
        reason: "Skill assignment removed from Agent."
      });
    }
  }

  #validateRegistrySkillIds(skillIds) {
    const normalized = [...new Set((skillIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
    const missing = normalized.filter((skillId) => !this.getRegistrySkill(skillId));
    if (missing.length > 0) {
      const error = new Error(`Skill not found: ${missing.join(", ")}`);
      error.code = "SKILL_NOT_FOUND";
      throw error;
    }
    return normalized;
  }

  #replaceAgentRegistrySkills(agentId, skillIds) {
    const now = createdAtFromOrNow();
    this.db.run(`DELETE FROM agent_skill_links WHERE agent_id = ?`, [agentId]);
    for (const skillId of skillIds) {
      this.db.run(
        `INSERT INTO agent_skill_links (agent_id, skill_id, added_at) VALUES (?, ?, ?)`,
        [agentId, skillId, now]
      );
    }
    this.db.run(`DELETE FROM hub_intent_cache WHERE agent_id = ?`, [agentId]);
  }

  migrateCanonicalSessionNames() {
    const rows = this.selectAll(
      `SELECT ls.logical_session_id, ls.legacy_session_id, ls.title, ls.session_name,
              s.title AS legacy_title
       FROM logical_sessions ls
       LEFT JOIN sessions s ON s.id = ls.legacy_session_id
       ORDER BY ls.created_at ASC, ls.logical_session_id ASC`
    );
    const used = new Set();
    for (const row of rows) {
      const base = String(row.session_name || row.legacy_title || row.title || "Agent").trim() || "Agent";
      let sessionName = base;
      let suffix = 1;
      while (used.has(normalizeSessionTitle(sessionName))) {
        sessionName = `${base} ${suffix}`;
        suffix += 1;
      }
      const sessionNameKey = normalizeSessionTitle(sessionName);
      used.add(sessionNameKey);
      this.db.run(
        `UPDATE logical_sessions
         SET session_name = ?, session_name_key = ?, title = ?
         WHERE logical_session_id = ?`,
        [sessionName, sessionNameKey, sessionName, row.logical_session_id]
      );
      if (row.legacy_session_id) {
        this.db.run("UPDATE sessions SET title = ? WHERE id = ?", [sessionName, row.legacy_session_id]);
      }
    }
  }

  migrateCollaborationSessionIdentities() {
    for (const table of ["collaboration_tasks", "collaboration_request_confirmations"]) {
      this.db.run(
        `UPDATE ${table}
         SET initiator_session_id = COALESCE(initiator_session_id, (
               SELECT MIN(ls.logical_session_id)
               FROM agent_sessions binding
               JOIN logical_sessions ls
                 ON ls.legacy_session_id = binding.session_id
                    OR ls.logical_session_id = binding.session_id
               WHERE binding.agent_id = ${table}.initiator_agent_id
               HAVING COUNT(DISTINCT ls.logical_session_id) = 1
             )),
             recipient_session_id = COALESCE(recipient_session_id, (
               SELECT MIN(ls.logical_session_id)
               FROM agent_sessions binding
               JOIN logical_sessions ls
                 ON ls.legacy_session_id = binding.session_id
                    OR ls.logical_session_id = binding.session_id
               WHERE binding.agent_id = ${table}.recipient_agent_id
               HAVING COUNT(DISTINCT ls.logical_session_id) = 1
             ))`
      );
      this.db.run(
        `UPDATE ${table}
         SET initiator_name_at_send = COALESCE(initiator_name_at_send, (
               SELECT ls.session_name FROM logical_sessions ls
               WHERE ls.logical_session_id = initiator_session_id
             )),
             recipient_name_at_send = COALESCE(recipient_name_at_send, (
               SELECT ls.session_name FROM logical_sessions ls
               WHERE ls.logical_session_id = recipient_session_id
             ))`
      );
      if (table === "collaboration_tasks") {
        this.db.run(
          `UPDATE collaboration_tasks
           SET route_status = 'unresolved'
           WHERE initiator_session_id IS NULL OR recipient_session_id IS NULL`
        );
      }
    }
  }

  async save() {
    this.db.checkpoint();
  }

  scheduleSave() {
    // Native SQLite commits each statement directly to the WAL. This method is
    // kept as a compatibility hook for callers that previously scheduled a
    // full in-memory database export.
    this.stateDirtyListener?.();
  }

  setStateDirtyListener(listener) {
    this.stateDirtyListener = typeof listener === "function" ? listener : null;
  }

  runInTransaction(operation) {
    this.db.run("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.run("COMMIT");
      return result;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  async close() {
    if (!this.db) return;
    await this.save();
    this.db.close();
    this.db = null;
  }

  upsertGitWorkspaceSnapshot(snapshot) {
    const repository = snapshot?.repository;
    if (!repository?.id || !repository.commonGitDirCanonicalPath) {
      throw new Error("A valid Git repository snapshot is required.");
    }
    const observedAt = snapshot.observedAt || new Date().toISOString();
    this.db.run("BEGIN IMMEDIATE");
    try {
      // Change-detection: the frontend polls workspace status every few seconds,
      // and each poll previously rewrote `last_validated_at` with a fresh
      // timestamp, bumping the state_sync_clock revision via the git_repositories
      // trigger and fanning a change-set back to every client even when nothing
      // about the repository changed. Persist the repository row only when it is
      // new or its canonical git dir actually moved; a routine re-validation that
      // changes nothing must stay a silent no-op.
      const existingRepo = this.selectOne(
        "SELECT common_git_dir FROM git_repositories WHERE repository_id = ?",
        [repository.id]
      );
      if (!existingRepo || existingRepo.common_git_dir !== repository.commonGitDirCanonicalPath) {
        this.db.run(
          `INSERT INTO git_repositories (
            repository_id, common_git_dir, discovered_at, last_validated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(repository_id) DO UPDATE SET
            common_git_dir=excluded.common_git_dir,
            last_validated_at=excluded.last_validated_at`,
          [
            repository.id,
            repository.commonGitDirCanonicalPath,
            repository.discoveredAt || observedAt,
            repository.lastValidatedAt || observedAt
          ]
        );
      }
      this.db.run(
        `UPDATE git_worktrees
         SET availability = 'missing', observed_at = ?, inventory_version = ?
         WHERE repository_id = ?`,
        [observedAt, snapshot.inventoryVersion, repository.id]
      );
      for (const worktree of snapshot.worktrees ?? []) {
        const prior = worktree.gitDirCanonicalPath ? null : this.selectOne(
          "SELECT worktree_id FROM git_worktrees WHERE repository_id = ? AND path = ?",
          [repository.id, worktree.path]
        );
        const worktreeId = prior?.worktree_id ?? worktree.worktreeId;
        this.db.run(
          `INSERT INTO git_worktrees (
            worktree_id, repository_id, path, canonical_path, git_dir, is_main,
            availability, head_oid, branch_ref, branch_name, detached, locked,
            lock_reason, prunable, prune_reason, inventory_version, observed_at, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(worktree_id) DO UPDATE SET
            path=excluded.path,
            canonical_path=excluded.canonical_path,
            git_dir=excluded.git_dir,
            is_main=excluded.is_main,
            availability=excluded.availability,
            head_oid=excluded.head_oid,
            branch_ref=excluded.branch_ref,
            branch_name=excluded.branch_name,
            detached=excluded.detached,
            locked=excluded.locked,
            lock_reason=excluded.lock_reason,
            prunable=excluded.prunable,
            prune_reason=excluded.prune_reason,
            inventory_version=excluded.inventory_version,
            observed_at=excluded.observed_at,
            raw_json=excluded.raw_json`,
          [
            worktreeId,
            repository.id,
            worktree.path,
            worktree.canonicalPath,
            worktree.gitDirCanonicalPath,
            worktree.isMain ? 1 : 0,
            worktree.availability,
            worktree.headOid,
            worktree.branchRef,
            worktree.branchName,
            worktree.isDetached ? 1 : 0,
            worktree.isLocked ? 1 : 0,
            worktree.lockReason,
            worktree.isPrunable ? 1 : 0,
            worktree.pruneReason,
            snapshot.inventoryVersion,
            worktree.observedAt || observedAt,
            JSON.stringify(worktree)
          ]
        );
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    this.auditObjectiveWorkItemAssociations({ migrate: true });
    return this.listGitWorktrees(repository.id);
  }

  listGitRepositories() {
    return this.selectAll("SELECT * FROM git_repositories ORDER BY discovered_at ASC").map((row) => {
      const path = row.common_git_dir ?? "";
      const segments = path.split("/").filter(Boolean);
      let name = segments[segments.length - 1] ?? "";
      // common_git_dir 通常指向 <repo>/.git，basename 为 ".git"，展示名取仓库目录名
      if (name === ".git" || name === "worktrees") {
        name = segments[segments.length - 2] ?? name;
      }
      return {
        id: row.repository_id,
        path,
        name: name || row.repository_id,
        discoveredAt: row.discovered_at,
        lastValidatedAt: row.last_validated_at
      };
    });
  }

  getGitRepository(repositoryId) {
    const row = this.selectOne(
      "SELECT * FROM git_repositories WHERE repository_id = ?",
      [repositoryId]
    );
    return row ? {
      id: row.repository_id,
      commonGitDirCanonicalPath: row.common_git_dir,
      discoveredAt: row.discovered_at,
      lastValidatedAt: row.last_validated_at
    } : null;
  }

  // 解析仓库的真实工作目录（cwd）：优先主 worktree 的 path，退回 common_git_dir 去掉 /.git 后缀。
  resolveWorkspacePath(repositoryId) {
    const worktree = this.selectOne(
      "SELECT path FROM git_worktrees WHERE repository_id = ? AND is_main = 1 LIMIT 1",
      [repositoryId]
    );
    if (worktree?.path) return worktree.path;
    const repo = this.getGitRepository(repositoryId);
    if (!repo?.commonGitDirCanonicalPath) return null;
    return repo.commonGitDirCanonicalPath.replace(/\/\.git$/, "") || null;
  }

  listGitWorktrees(repositoryId) {
    return this.selectAll(
      "SELECT * FROM git_worktrees WHERE repository_id = ? ORDER BY is_main DESC, path ASC",
      [repositoryId]
    ).map((row) => ({
      worktreeId: row.worktree_id,
      repositoryId: row.repository_id,
      path: row.path,
      canonicalPath: row.canonical_path,
      gitDirCanonicalPath: row.git_dir,
      isMain: Boolean(row.is_main),
      availability: row.availability,
      headOid: row.head_oid,
      branchRef: row.branch_ref,
      branchName: row.branch_name,
      isDetached: Boolean(row.detached),
      isLocked: Boolean(row.locked),
      lockReason: row.lock_reason,
      isPrunable: Boolean(row.prunable),
      pruneReason: row.prune_reason,
      inventoryVersion: row.inventory_version,
      observedAt: row.observed_at
    }));
  }

  listAllGitWorktrees() {
    return this.selectAll(
      "SELECT worktree_id FROM git_worktrees ORDER BY availability ASC, path ASC"
    ).map((row) => this.getGitWorktree(row.worktree_id));
  }

  getGitWorktree(worktreeId) {
    const row = this.selectOne(
      "SELECT * FROM git_worktrees WHERE worktree_id = ?",
      [worktreeId]
    );
    return row ? {
      worktreeId: row.worktree_id,
      repositoryId: row.repository_id,
      path: row.path,
      canonicalPath: row.canonical_path,
      gitDirCanonicalPath: row.git_dir,
      isMain: Boolean(row.is_main),
      availability: row.availability,
      headOid: row.head_oid,
      branchRef: row.branch_ref,
      branchName: row.branch_name,
      isDetached: Boolean(row.detached),
      isLocked: Boolean(row.locked),
      lockReason: row.lock_reason,
      isPrunable: Boolean(row.prunable),
      pruneReason: row.prune_reason,
      inventoryVersion: row.inventory_version,
      observedAt: row.observed_at
    } : null;
  }

  createLogicalSessionRoute(input) {
    const logicalSessionId = requiredText(input?.logicalSessionId, "logicalSessionId");
    const providerThreadId = requiredText(input?.providerThreadId, "providerThreadId");
    const providerId = requiredText(input?.providerId ?? "codex-app-server", "providerId");
    const providerSessionId = requiredText(input?.providerSessionId ?? providerThreadId, "providerSessionId");
    const bindingId = requiredText(input?.bindingId ?? `binding:${randomUUID()}`, "bindingId");
    const boundCwd = requiredText(input?.boundCwd, "boundCwd");
    const timestamp = input.createdAt || new Date().toISOString();
    const sessionName = requiredText(input.sessionName ?? input.title ?? logicalSessionId, "sessionName");
    const sessionNameKey = normalizeSessionTitle(sessionName);
    const nameOwner = this.selectOne(
      `SELECT logical_session_id FROM logical_sessions WHERE session_name_key = ?
       UNION ALL
       SELECT logical_session_id FROM session_name_aliases WHERE alias_key = ?
       LIMIT 1`,
      [sessionNameKey, sessionNameKey]
    );
    if (nameOwner && nameOwner.logical_session_id !== logicalSessionId) {
      const error = new Error(`A session named "${sessionName}" already exists.`);
      error.code = "SESSION_TITLE_CONFLICT";
      error.statusCode = 409;
      error.conflictingSessionId = nameOwner.logical_session_id;
      throw error;
    }
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `INSERT INTO logical_sessions (
          logical_session_id, legacy_session_id, active_thread_id, active_workspace_id,
          repository_id, routing_version, transition_state, title, pinned,
          archived, created_at, updated_at, session_name, session_name_key
        ) VALUES (?, ?, NULL, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        [
          logicalSessionId,
          input.legacySessionId || null,
          input.worktreeId || null,
          input.repositoryId || null,
          input.title || null,
          input.pinned ? 1 : 0,
          input.archived ? 1 : 0,
          timestamp,
          timestamp,
          sessionName,
          sessionNameKey
        ]
      );
      this.db.run(
        `INSERT INTO provider_thread_bindings (
          provider_thread_id, binding_id, provider_id, provider_session_id,
          logical_session_id, worktree_id, bound_cwd,
          parent_thread_id, parent_binding_id, forked_at_turn_id, instruction_sources_json,
          permission_snapshot_json, provider_metadata_json,
          routing_version, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, 1, 'active', ?, ?)`,
        [
          providerThreadId,
          bindingId,
          providerId,
          providerSessionId,
          logicalSessionId,
          input.worktreeId || null,
          boundCwd,
          JSON.stringify(input.instructionSources ?? []),
          JSON.stringify(input.permissionSnapshot ?? {}),
          JSON.stringify(input.providerMetadata ?? {}),
          timestamp,
          timestamp
        ]
      );
      this.db.run(
        "UPDATE logical_sessions SET active_thread_id = ? WHERE logical_session_id = ?",
        [providerThreadId, logicalSessionId]
      );
      this.assertLogicalSessionRoute(logicalSessionId);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getLogicalSession(logicalSessionId);
  }

  getLogicalSession(logicalSessionId) {
    const row = this.selectOne(
      "SELECT * FROM logical_sessions WHERE logical_session_id = ?",
      [logicalSessionId]
    );
    if (!row) return null;
    const sessionName = row.session_name || row.title || row.logical_session_id;
    return {
      logicalSessionId: row.logical_session_id,
      legacySessionId: row.legacy_session_id,
      activeThreadId: row.active_thread_id,
      activeWorkspaceId: row.active_workspace_id,
      repositoryId: row.repository_id,
      routingVersion: Number(row.routing_version),
      transitionState: row.transition_state,
      sessionName,
      title: sessionName,
      pinned: Boolean(row.pinned),
      archived: Boolean(row.archived),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activeBinding: row.active_thread_id
        ? this.getProviderThreadBinding(row.active_thread_id)
        : null
    };
  }

  getLogicalSessionByLegacySessionId(legacySessionId) {
    const row = this.selectOne(
      "SELECT logical_session_id FROM logical_sessions WHERE legacy_session_id = ?",
      [legacySessionId]
    );
    return row ? this.getLogicalSession(row.logical_session_id) : null;
  }

  getLogicalSessionByName(sessionName) {
    const key = normalizeSessionTitle(sessionName);
    if (!key) return null;
    const row = this.selectOne(
      `SELECT logical_session_id FROM logical_sessions WHERE session_name_key = ?
       UNION ALL
       SELECT logical_session_id FROM session_name_aliases WHERE alias_key = ?
       LIMIT 1`,
      [key, key]
    );
    return row ? this.getLogicalSession(row.logical_session_id) : null;
  }

  getLogicalSessionByProviderThreadId(providerThreadId) {
    const row = this.selectOne(
      "SELECT logical_session_id FROM provider_thread_bindings WHERE provider_thread_id = ?",
      [providerThreadId]
    );
    return row ? this.getLogicalSession(row.logical_session_id) : null;
  }

  getLogicalSessionByProviderSessionId(providerId, providerSessionId) {
    const row = this.selectOne(
      `SELECT logical_session_id FROM provider_thread_bindings
       WHERE provider_id = ? AND provider_session_id = ? AND state = 'active'`,
      [providerId, providerSessionId]
    );
    return row ? this.getLogicalSession(row.logical_session_id) : null;
  }

  deleteLogicalSessionByLegacySessionId(legacySessionId) {
    const row = this.selectOne(
      "SELECT logical_session_id FROM logical_sessions WHERE legacy_session_id = ?",
      [legacySessionId]
    );
    if (!row) return false;
    this.db.run("DELETE FROM logical_sessions WHERE logical_session_id = ?", [row.logical_session_id]);
    this.scheduleSave();
    return true;
  }

  listLogicalSessionsByWorkspaceId(worktreeId) {
    return this.selectAll(
      "SELECT logical_session_id FROM logical_sessions WHERE active_workspace_id = ?",
      [worktreeId]
    ).map((row) => this.getLogicalSession(row.logical_session_id));
  }

  rebindActiveWorkspacePath(input) {
    const logicalSessionId = requiredText(input?.logicalSessionId, "logicalSessionId");
    const providerThreadId = requiredText(input?.providerThreadId, "providerThreadId");
    const worktreeId = requiredText(input?.worktreeId, "worktreeId");
    const boundCwd = requiredText(input?.boundCwd, "boundCwd");
    const routingVersion = Number(input.routingVersion);
    const timestamp = input.updatedAt || new Date().toISOString();
    const target = this.getGitWorktree(worktreeId);
    if (!target || target.availability !== "available") {
      throw new Error(`Worktree ${worktreeId} is not available.`);
    }
    if (boundCwd !== (target.canonicalPath || target.path)) {
      throw new Error("The rebound cwd does not match the registered worktree path.");
    }
    this.db.run("BEGIN IMMEDIATE");
    try {
      const logical = this.selectOne(
        "SELECT * FROM logical_sessions WHERE logical_session_id = ?",
        [logicalSessionId]
      );
      if (!logical
        || logical.active_thread_id !== providerThreadId
        || logical.active_workspace_id !== worktreeId
        || Number(logical.routing_version) !== routingVersion) {
        throw new Error("The logical session route changed before its workspace path could be rebound.");
      }
      this.db.run(
        `UPDATE provider_thread_bindings
         SET bound_cwd = ?, instruction_sources_json = ?, permission_snapshot_json = ?,
             routing_version = ?, updated_at = ?
         WHERE provider_thread_id = ? AND state = 'active'`,
        [
          boundCwd,
          JSON.stringify(input.instructionSources ?? []),
          JSON.stringify(input.permissionSnapshot ?? {}),
          routingVersion + 1,
          timestamp,
          providerThreadId
        ]
      );
      this.db.run(
        `UPDATE logical_sessions
         SET routing_version = routing_version + 1, updated_at = ?
         WHERE logical_session_id = ?`,
        [timestamp, logicalSessionId]
      );
      this.db.run(
        `UPDATE sessions SET cwd = ?, updated_at = ?
         WHERE id = (SELECT legacy_session_id FROM logical_sessions WHERE logical_session_id = ?)`,
        [boundCwd, timestamp, logicalSessionId]
      );
      this.assertLogicalSessionRoute(logicalSessionId);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getLogicalSession(logicalSessionId);
  }

  getProviderThreadBinding(providerThreadId) {
    const row = this.selectOne(
      "SELECT * FROM provider_thread_bindings WHERE provider_thread_id = ?",
      [providerThreadId]
    );
    return row ? providerThreadBindingFromRow(row) : null;
  }

  getAgentSessionBinding(bindingId) {
    const row = this.selectOne(
      "SELECT * FROM provider_thread_bindings WHERE binding_id = ?",
      [bindingId]
    );
    return row ? providerThreadBindingFromRow(row) : null;
  }

  getAgentSessionBindingByProviderSession(providerId, providerSessionId) {
    const row = this.selectOne(
      `SELECT * FROM provider_thread_bindings
       WHERE provider_id = ? AND provider_session_id = ?
       ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, routing_version DESC
       LIMIT 1`,
      [providerId, providerSessionId]
    );
    return row ? providerThreadBindingFromRow(row) : null;
  }

  listProviderThreadBindings(logicalSessionId) {
    return this.selectAll(
      `SELECT * FROM provider_thread_bindings
       WHERE logical_session_id = ?
       ORDER BY created_at ASC, provider_thread_id ASC`,
      [logicalSessionId]
    ).map(providerThreadBindingFromRow);
  }

  listActiveProviderSessionIds(providerId) {
    const normalizedProviderId = requiredText(providerId, "providerId");
    return this.selectAll(
      `SELECT DISTINCT provider_session_id FROM provider_thread_bindings
       WHERE provider_id = ? AND state = 'active' AND provider_session_id IS NOT NULL
       ORDER BY provider_session_id ASC`,
      [normalizedProviderId]
    ).map((row) => row.provider_session_id);
  }

  recordProviderThreadBinding(input) {
    const providerThreadId = requiredText(input?.providerThreadId, "providerThreadId");
    const providerId = requiredText(input?.providerId ?? "codex-app-server", "providerId");
    const providerSessionId = requiredText(input?.providerSessionId ?? providerThreadId, "providerSessionId");
    const bindingId = requiredText(input?.bindingId ?? `binding:${randomUUID()}`, "bindingId");
    if (providerSessionId !== providerThreadId) {
      throw new Error("providerSessionId must match providerThreadId during the compatibility migration.");
    }
    const logicalSessionId = requiredText(input?.logicalSessionId, "logicalSessionId");
    const boundCwd = requiredText(input?.boundCwd, "boundCwd");
    const state = input.state || "orphaned";
    if (!["invalid", "orphaned"].includes(state)) {
      throw new Error("Detached provider bindings must be invalid or orphaned.");
    }
    const timestamp = input.createdAt || new Date().toISOString();
    this.db.run(
      `INSERT INTO provider_thread_bindings (
        provider_thread_id, binding_id, provider_id, provider_session_id,
        logical_session_id, worktree_id, bound_cwd,
        parent_thread_id, parent_binding_id, forked_at_turn_id, instruction_sources_json,
        permission_snapshot_json, provider_metadata_json,
        routing_version, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_thread_id) DO UPDATE SET
        provider_id=excluded.provider_id,
        provider_session_id=excluded.provider_session_id,
        instruction_sources_json=excluded.instruction_sources_json,
        permission_snapshot_json=excluded.permission_snapshot_json,
        provider_metadata_json=excluded.provider_metadata_json,
        state=excluded.state,
        updated_at=excluded.updated_at`,
      [
        providerThreadId,
        bindingId,
        providerId,
        providerSessionId,
        logicalSessionId,
        input.worktreeId || null,
        boundCwd,
        input.parentThreadId || null,
        input.parentBindingId || null,
        input.forkedAtTurnId || null,
        JSON.stringify(input.instructionSources ?? []),
        JSON.stringify(input.permissionSnapshot ?? {}),
        JSON.stringify(input.providerMetadata ?? {}),
        Number(input.routingVersion) || 1,
        state,
        timestamp,
        timestamp
      ]
    );
    this.scheduleSave();
    return this.getProviderThreadBinding(providerThreadId);
  }

  beginWorkspaceTransition(input) {
    const transitionId = requiredText(input?.transitionId, "transitionId");
    const logicalSessionId = requiredText(input?.logicalSessionId, "logicalSessionId");
    const transitionKind = input.transitionKind === "provider" ? "provider" : "workspace";
    const targetWorktreeId = typeof input?.targetWorktreeId === "string"
      && input.targetWorktreeId.trim()
      ? input.targetWorktreeId.trim()
      : null;
    let targetCwd = typeof input?.targetCwd === "string" && input.targetCwd.trim()
      ? input.targetCwd.trim()
      : null;
    const timestamp = input.createdAt || new Date().toISOString();
    const logicalSession = this.getLogicalSession(logicalSessionId);
    if (!logicalSession?.activeBinding) {
      throw new Error(`Logical session ${logicalSessionId} has no active binding.`);
    }
    this.assertLogicalWorkSessionBinding(logicalSessionId);
    const sourceRoutingVersion = Number(input.sourceRoutingVersion);
    if (sourceRoutingVersion !== logicalSession.routingVersion) {
      throw new Error(`Logical session routing version changed from ${sourceRoutingVersion} to ${logicalSession.routingVersion}.`);
    }
    if (transitionKind === "workspace") {
      if (targetWorktreeId) {
        const target = this.selectOne(
          "SELECT availability, path, canonical_path FROM git_worktrees WHERE worktree_id = ?",
          [targetWorktreeId]
        );
        if (!target || target.availability !== "available") {
          throw new Error(`Target worktree ${targetWorktreeId} is not available.`);
        }
        targetCwd ??= target.canonical_path || target.path;
        if (targetCwd !== (target.canonical_path || target.path)) {
          throw new Error("The target cwd does not match the target worktree.");
        }
      }
      targetCwd = requiredText(targetCwd, "targetCwd");
    } else {
      if (typeof input.targetProviderId !== "string" || !input.targetProviderId.trim()) {
        throw new Error("targetProviderId is required for a Provider transition.");
      }
      // A Provider switch does not move the workspace; reuse the active binding's cwd
      // so the non-null target_cwd constraint stays satisfied without workspace semantics.
      targetCwd = targetCwd ?? logicalSession.activeBinding.boundCwd;
      if (!targetCwd) {
        throw new Error(`Logical session ${logicalSessionId} has no bound cwd for the Provider transition.`);
      }
    }
    const unfinished = this.selectOne(
      `SELECT transition_id FROM workspace_transitions
       WHERE logical_session_id = ? AND phase NOT IN ('committed', 'failed')`,
      [logicalSessionId]
    );
    if (unfinished) {
      throw new Error(`Logical session ${logicalSessionId} already has transition ${unfinished.transition_id}.`);
    }
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `INSERT INTO workspace_transitions (
          transition_id, logical_session_id, source_thread_id, target_worktree_id, target_cwd,
          transition_kind, target_provider_id, source_routing_version, last_completed_turn_id, resume_goal_after_transition,
          continuation_prompt, continuation_state, phase, strategy,
          error_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          transitionId,
          logicalSessionId,
          logicalSession.activeThreadId,
          targetWorktreeId,
          targetCwd,
          transitionKind,
          transitionKind === "provider" ? input.targetProviderId.trim() : null,
          sourceRoutingVersion,
          input.lastCompletedTurnId || null,
          input.resumeGoalAfterTransition ? 1 : 0,
          input.continuationPrompt || null,
          input.continuationPrompt ? "pending" : "none",
          input.phase || "waitingForTurn",
          input.strategy || "fork",
          timestamp,
          timestamp
        ]
      );
      this.db.run(
        `UPDATE logical_sessions SET transition_state = ?, updated_at = ?
         WHERE logical_session_id = ?`,
        [input.phase || "waitingForTurn", timestamp, logicalSessionId]
      );
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getWorkspaceTransition(transitionId);
  }

  updateWorkspaceTransition(transitionId, update = {}) {
    const allowedPhases = new Set([
      "waitingForTurn", "preflighting", "forking", "validatingInstructions",
      "committingRoute", "committed", "failed"
    ]);
    if (!allowedPhases.has(update.phase)) {
      throw new Error(`Unsupported workspace transition phase: ${update.phase}`);
    }
    const allowedStrategies = new Set(["fork", "handoff", "settingsUpdate"]);
    if (update.strategy !== undefined && !allowedStrategies.has(update.strategy)) {
      throw new Error(`Unsupported workspace transition strategy: ${update.strategy}`);
    }
    const transition = this.getWorkspaceTransition(transitionId);
    if (!transition) throw new Error(`Workspace transition ${transitionId} was not found.`);
    const timestamp = update.updatedAt || new Date().toISOString();
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `UPDATE workspace_transitions
         SET phase = ?, strategy = ?, last_completed_turn_id = ?, new_thread_id = ?,
             error_json = ?,
             continuation_state = CASE
               WHEN ? = 'failed' AND continuation_state = 'pending' THEN 'failed'
               ELSE continuation_state
             END,
             continuation_error = CASE
               WHEN ? = 'failed' AND continuation_state = 'pending' THEN ?
               ELSE continuation_error
             END,
             updated_at = ?
         WHERE transition_id = ?`,
        [
          update.phase,
          update.strategy ?? transition.strategy,
          update.lastCompletedTurnId ?? transition.lastCompletedTurnId,
          update.newThreadId ?? transition.newThreadId,
          update.error === undefined ? (transition.error ? JSON.stringify(transition.error) : null) : JSON.stringify(update.error),
          update.phase,
          update.phase,
          update.error?.message ?? null,
          timestamp,
          transitionId
        ]
      );
      this.db.run(
        `UPDATE logical_sessions SET transition_state = ?, updated_at = ?
         WHERE logical_session_id = ?`,
        [["committed", "failed"].includes(update.phase) ? null : update.phase, timestamp, transition.logicalSessionId]
      );
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getWorkspaceTransition(transitionId);
  }

  commitWorkspaceTransition(transitionId, binding) {
    const transition = this.getWorkspaceTransition(transitionId);
    if (!transition) throw new Error(`Workspace transition ${transitionId} was not found.`);
    if (transition.phase === "failed") throw new Error(`Workspace transition ${transitionId} has failed.`);
    if (transition.phase === "committed") {
      const current = this.getLogicalSession(transition.logicalSessionId);
      if (current?.activeThreadId === transition.newThreadId) return current;
      throw new Error(`Committed workspace transition ${transitionId} has an inconsistent route.`);
    }
    const newThreadId = requiredText(binding?.providerThreadId, "providerThreadId");
    const sourceBinding = this.getProviderThreadBinding(transition.sourceThreadId);
    const providerId = requiredText(binding?.providerId ?? sourceBinding?.providerId ?? "codex-app-server", "providerId");
    const providerSessionId = requiredText(binding?.providerSessionId ?? newThreadId, "providerSessionId");
    const bindingId = requiredText(binding?.bindingId ?? `binding:${randomUUID()}`, "bindingId");
    const isProviderSwitch = transition.transitionKind === "provider";
    const boundCwd = isProviderSwitch
      ? (binding?.boundCwd || sourceBinding?.boundCwd || transition.targetCwd)
      : requiredText(binding?.boundCwd, "boundCwd");
    const target = transition.targetWorktreeId
      ? this.selectOne(
        "SELECT * FROM git_worktrees WHERE worktree_id = ?",
        [transition.targetWorktreeId]
      )
      : null;
    if (!isProviderSwitch) {
      if (transition.targetWorktreeId && (!target || target.availability !== "available")) {
        throw new Error(`Target worktree ${transition.targetWorktreeId} is not available.`);
      }
      if (boundCwd !== transition.targetCwd
        || (target && boundCwd !== (target.canonical_path || target.path))) {
        throw new Error("The new thread cwd does not match the transition target.");
      }
    }
    const timestamp = binding.createdAt || new Date().toISOString();
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.assertLogicalWorkSessionBinding(transition.logicalSessionId);
      const logical = this.selectOne(
        "SELECT * FROM logical_sessions WHERE logical_session_id = ?",
        [transition.logicalSessionId]
      );
      if (!logical
        || logical.active_thread_id !== transition.sourceThreadId
        || Number(logical.routing_version) !== transition.sourceRoutingVersion) {
        throw new Error("The logical session route changed before the workspace transition committed.");
      }
      this.db.run(
        `UPDATE provider_thread_bindings SET state = 'superseded', updated_at = ?
         WHERE provider_thread_id = ? AND state = 'active'`,
        [timestamp, transition.sourceThreadId]
      );
      this.db.run(
        `INSERT INTO provider_thread_bindings (
          provider_thread_id, binding_id, provider_id, provider_session_id,
          logical_session_id, worktree_id, bound_cwd,
          parent_thread_id, parent_binding_id, forked_at_turn_id, instruction_sources_json,
          permission_snapshot_json, provider_metadata_json,
          routing_version, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          newThreadId,
          bindingId,
          providerId,
          providerSessionId,
          transition.logicalSessionId,
          isProviderSwitch ? (sourceBinding?.worktreeId ?? null) : transition.targetWorktreeId,
          boundCwd,
          transition.sourceThreadId,
          sourceBinding?.bindingId ?? null,
          binding.forkedAtTurnId || transition.lastCompletedTurnId,
          JSON.stringify(binding.instructionSources ?? []),
          JSON.stringify(binding.permissionSnapshot ?? {}),
          JSON.stringify(binding.providerMetadata ?? {}),
          Number(logical.routing_version) + 1,
          timestamp,
          timestamp
        ]
      );
      this.db.run(
        `INSERT INTO provider_thread_lineage (
          child_thread_id, parent_thread_id, logical_session_id, transition_id, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          newThreadId,
          transition.sourceThreadId,
          transition.logicalSessionId,
          transitionId,
          timestamp
        ]
      );
      this.db.run(
        `UPDATE logical_sessions
         SET active_thread_id = ?, active_workspace_id = ?, repository_id = ?,
             routing_version = routing_version + 1, transition_state = NULL, updated_at = ?
         WHERE logical_session_id = ?`,
        [
          newThreadId,
          isProviderSwitch ? logical.active_workspace_id : transition.targetWorktreeId,
          isProviderSwitch ? logical.repository_id : (target?.repository_id ?? null),
          timestamp,
          transition.logicalSessionId
        ]
      );
      if (!isProviderSwitch) {
        this.db.run(
          `UPDATE sessions SET cwd = ?, updated_at = ?
           WHERE id = (SELECT legacy_session_id FROM logical_sessions WHERE logical_session_id = ?)`,
          [boundCwd, timestamp, transition.logicalSessionId]
        );
      } else {
        const targetSession = binding.sessionProjection ?? {};
        const targetExternal = targetSession.external ?? {};
        const routedTargetSession = {
          ...targetSession,
          provider: providerId,
          command: targetSession.command ?? targetExternal.source ?? providerId,
          args: targetSession.args ?? targetExternal.args ?? [],
          external: {
            ...targetExternal,
            provider: providerId,
            threadId: newThreadId,
            sessionId: providerSessionId,
            logicalSessionId: transition.logicalSessionId,
            routingVersion: Number(logical.routing_version) + 1
          }
        };
        const targetStatus = targetSession.status ?? null;
        const targetProgress = Number.isFinite(targetSession.progress) ? targetSession.progress : null;
        const targetSummary = targetSession.summary ?? null;
        this.db.run(
          `UPDATE sessions
           SET provider = ?, command = ?, args_json = ?, cwd = COALESCE(?, cwd),
               status = COALESCE(?, status), progress = COALESCE(?, progress),
               summary = COALESCE(?, summary), raw_json = ?, updated_at = ?
           WHERE id = (SELECT legacy_session_id FROM logical_sessions WHERE logical_session_id = ?)`,
          [
            providerId,
            routedTargetSession.command,
            JSON.stringify(routedTargetSession.args),
            targetExternal.cwd ?? boundCwd ?? null,
            targetStatus,
            targetProgress,
            targetSummary,
            JSON.stringify(toRawStatus(routedTargetSession)),
            timestamp,
            transition.logicalSessionId
          ]
        );
      }
      this.db.run(
        `UPDATE workspace_transitions
         SET new_thread_id = ?, phase = 'committed', error_json = NULL, updated_at = ?
         WHERE transition_id = ?`,
        [newThreadId, timestamp, transitionId]
      );
      this.assertLogicalSessionRoute(transition.logicalSessionId);
      this.assertLogicalWorkSessionBinding(transition.logicalSessionId);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getLogicalSession(transition.logicalSessionId);
  }

  getWorkspaceTransition(transitionId) {
    const row = this.selectOne(
      "SELECT * FROM workspace_transitions WHERE transition_id = ?",
      [transitionId]
    );
    return row ? workspaceTransitionFromRow(row) : null;
  }

  getPendingWorkspaceTransition(logicalSessionId) {
    const row = this.selectOne(
      `SELECT * FROM workspace_transitions
       WHERE logical_session_id = ? AND phase NOT IN ('committed', 'failed')
       ORDER BY created_at DESC LIMIT 1`,
      [logicalSessionId]
    );
    return row ? workspaceTransitionFromRow(row) : null;
  }

  getLatestCommittedWorkspaceTransition(logicalSessionId) {
    const row = this.selectOne(
      `SELECT transition.* FROM workspace_transitions transition
       JOIN logical_sessions logical
         ON logical.logical_session_id = transition.logical_session_id
       WHERE transition.logical_session_id = ?
         AND transition.phase = 'committed'
         AND transition.new_thread_id = logical.active_thread_id
         AND transition.source_routing_version + 1 = logical.routing_version
       ORDER BY transition.created_at DESC LIMIT 1`,
      [logicalSessionId]
    );
    return row ? workspaceTransitionFromRow(row) : null;
  }

  listWorkspaceTransitionsAwaitingContinuation() {
    return this.selectAll(
      `SELECT * FROM workspace_transitions
       WHERE phase = 'committed' AND continuation_state IN ('pending', 'queued', 'running', 'failed')
       ORDER BY created_at ASC`
    ).map(workspaceTransitionFromRow);
  }

  updateWorkspaceTransitionContinuation(transitionId, update = {}) {
    const transition = this.getWorkspaceTransition(transitionId);
    if (!transition) throw new Error(`Workspace transition ${transitionId} was not found.`);
    const states = new Set(["none", "pending", "queued", "running", "completed", "failed"]);
    const state = update.state ?? transition.continuationState;
    if (!states.has(state)) throw new Error(`Unsupported workspace continuation state: ${state}`);
    const timestamp = update.updatedAt || new Date().toISOString();
    this.db.run(
      `UPDATE workspace_transitions
       SET continuation_state = ?, continuation_turn_id = ?, continuation_error = ?, updated_at = ?
       WHERE transition_id = ?`,
      [
        state,
        Object.hasOwn(update, "turnId") ? update.turnId : transition.continuationTurnId,
        Object.hasOwn(update, "error") ? update.error : transition.continuationError,
        timestamp,
        transitionId
      ]
    );
    this.scheduleSave();
    return this.getWorkspaceTransition(transitionId);
  }

  listPendingWorkspaceTransitions() {
    return this.selectAll(
      `SELECT * FROM workspace_transitions
       WHERE phase NOT IN ('committed', 'failed')
       ORDER BY created_at ASC`
    ).map(workspaceTransitionFromRow);
  }

  assertLogicalSessionRoute(logicalSessionId) {
    const row = this.selectOne(
      `SELECT ls.active_thread_id, ls.active_workspace_id, binding.worktree_id, binding.state
       FROM logical_sessions ls
       LEFT JOIN provider_thread_bindings binding
         ON binding.provider_thread_id = ls.active_thread_id
       WHERE ls.logical_session_id = ?`,
      [logicalSessionId]
    );
    if (!row?.active_thread_id || row.state !== "active") {
      throw new Error(`Logical session ${logicalSessionId} has no valid active thread.`);
    }
    if ((row.active_workspace_id ?? null) !== (row.worktree_id ?? null)) {
      throw new Error(`Logical session ${logicalSessionId} has mismatched thread and workspace bindings.`);
    }
    return true;
  }

  retireLogicalSessionWorkspace(logicalSessionId, expectedWorktreeId) {
    const logical = this.getLogicalSession(logicalSessionId);
    if (!logical?.activeBinding || logical.activeWorkspaceId !== expectedWorktreeId) {
      const error = new Error(`Logical Session ${logicalSessionId} is no longer bound to the selected Worktree.`);
      error.code = "WORKSPACE_ROUTE_CHANGED";
      throw error;
    }
    const timestamp = new Date().toISOString();
    const session = logical.legacySessionId ? this.getSession(logical.legacySessionId) : null;
    const rawStatus = {
      ...(session?.rawStatus ?? {}),
      capabilities: {
        ...(session?.rawStatus?.capabilities ?? session?.capabilities ?? {}),
        canSend: false,
        canInterrupt: false,
        canReconnect: false
      },
      workspaceRetired: {
        worktreeId: expectedWorktreeId,
        path: logical.activeBinding.boundCwd,
        retiredAt: timestamp
      }
    };
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `UPDATE provider_thread_bindings
         SET worktree_id = NULL, updated_at = ?
         WHERE provider_thread_id = ? AND state = 'active'`,
        [timestamp, logical.activeThreadId]
      );
      this.db.run(
        `UPDATE logical_sessions
         SET active_workspace_id = NULL, archived = 1, updated_at = ?
         WHERE logical_session_id = ?`,
        [timestamp, logicalSessionId]
      );
      if (logical.legacySessionId) {
        this.db.run(
          `UPDATE sessions
           SET archived = 1, status = 'complete', raw_json = ?, updated_at = ?
           WHERE id = ?`,
          [JSON.stringify(rawStatus), timestamp, logical.legacySessionId]
        );
      }
      this.assertLogicalSessionRoute(logicalSessionId);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getLogicalSession(logicalSessionId);
  }

  restoreLogicalSessionWorkspace(logicalSessionId) {
    const logical = this.getLogicalSession(logicalSessionId);
    if (!logical?.activeBinding || !logical.activeWorkspaceId) {
      const error = new Error(`Logical Session ${logicalSessionId} has no active Workspace to restore.`);
      error.code = "WORKSPACE_ROUTE_UNAVAILABLE";
      throw error;
    }
    const timestamp = new Date().toISOString();
    const session = logical.legacySessionId ? this.getSession(logical.legacySessionId) : null;
    const rawStatus = { ...(session?.rawStatus ?? {}) };
    delete rawStatus.workspaceRetired;
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `UPDATE logical_sessions SET archived = 0, updated_at = ? WHERE logical_session_id = ?`,
        [timestamp, logicalSessionId]
      );
      if (logical.legacySessionId) {
        this.db.run(
          `UPDATE sessions SET archived = 0, raw_json = ?, updated_at = ? WHERE id = ?`,
          [JSON.stringify(rawStatus), timestamp, logical.legacySessionId]
        );
      }
      this.assertLogicalSessionRoute(logicalSessionId);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getLogicalSession(logicalSessionId);
  }

  // A Work Session keeps one stable product Session identity while its Provider
  // binding is replaced during a workspace transition. The WorkItem ownership
  // must therefore remain intact before and after every route commit.
  assertLogicalWorkSessionBinding(logicalSessionId) {
    const logical = this.getLogicalSession(logicalSessionId);
    if (!logical?.legacySessionId) {
      // Provider-only routes can exist during migration/recovery. They are not
      // Work Sessions and therefore have no WorkItem ownership to preserve.
      return { logicalSessionId, sessionId: null, workItemId: null, agentId: null };
    }
    const session = this.getSession(logical.legacySessionId);
    if (!session) {
      const error = new Error(`Product Session not found: ${logical.legacySessionId}`);
      error.code = "WORK_SESSION_BINDING_INVALID";
      throw error;
    }
    const isWorkSession = session.sessionKind === SESSION_KIND.worker || Boolean(session.workItemId);
    if (!isWorkSession) {
      return { logicalSessionId, sessionId: session.id, workItemId: null };
    }
    if (!session.workItemId) {
      const error = new Error(`Worker Session ${session.id} is not bound to a WorkItem.`);
      error.code = "WORK_SESSION_BINDING_INVALID";
      throw error;
    }
    const workItem = this.getWorkItem(session.workItemId);
    if (!workItem) {
      const error = new Error(`WorkItem not found for Worker Session ${session.id}: ${session.workItemId}`);
      error.code = "WORK_SESSION_BINDING_INVALID";
      throw error;
    }
    if (workItem.current_session_id !== session.id) {
      const error = new Error(
        `WorkItem ${workItem.id} points to ${workItem.current_session_id ?? "no Session"}, not active Worker Session ${session.id}.`
      );
      error.code = "WORK_SESSION_BINDING_STALE";
      throw error;
    }
    if (session.objectiveId !== workItem.objective_id) {
      const error = new Error(`Worker Session ${session.id} and WorkItem ${workItem.id} have different Objectives.`);
      error.code = "WORK_SESSION_BINDING_INVALID";
      throw error;
    }
    if (workItem.main_agent_id && session.agentId !== workItem.main_agent_id) {
      const error = new Error(`Worker Session ${session.id} and WorkItem ${workItem.id} have different Agents.`);
      error.code = "WORK_SESSION_BINDING_INVALID";
      throw error;
    }
    return {
      logicalSessionId,
      sessionId: session.id,
      workItemId: workItem.id,
      objectiveId: workItem.objective_id,
      agentId: workItem.main_agent_id ?? session.agentId ?? null
    };
  }

  upsertSession(session) {
    const persistedAssociation = this.selectOne(
      "SELECT objective_id, work_item_id, session_kind FROM sessions WHERE id = ?",
      [session.id]
    );
    const suppliedSessionKind = session.sessionKind == null
      ? inferSessionKind({ objectiveId: session.objectiveId, workItemId: session.workItemId })
      : assertExplicitSessionKind(session.sessionKind, { allowLegacy: true });
    const effectiveSessionKind = suppliedSessionKind === "legacy"
      ? persistedAssociation?.session_kind ?? "legacy"
      : suppliedSessionKind;
    const effectiveObjectiveId = effectiveSessionKind === "worker"
      ? session.objectiveId ?? persistedAssociation?.objective_id ?? null
      : session.objectiveId ?? null;
    const effectiveWorkItemId = effectiveSessionKind === "worker"
      ? session.workItemId ?? persistedAssociation?.work_item_id ?? null
      : session.workItemId ?? null;
    this.assertSessionAssociation({
      sessionId: session.id,
      sessionKind: effectiveSessionKind,
      objectiveId: effectiveObjectiveId,
      workItemId: effectiveWorkItemId
    });
    const summary = toSessionSummary(session);
    const values = [
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
      serializeActiveChoicePrompt(summary.suggestedOptions, summary.summary, session.activeChoicePrompt),
      JSON.stringify(toRawStatus(session)),
      effectiveObjectiveId,
      effectiveWorkItemId,
      effectiveSessionKind,
      session.agentId ?? null
    ];

    // Change-detection: an UPDATE bumps the state_sync_clock revision (via the
    // sessions trigger) and fans out a change-set to every connected client, so a
    // no-op write is a real source of idle churn. Compare the normalized row against
    // what is already persisted and skip the write entirely when nothing changed.
    const existing = this.selectOne(
      `SELECT title, agent, provider, command, args_json, cwd, status, progress,
              summary, accent, created_at, updated_at, archived, pinned, sort_order,
              active_choice_json, raw_json, objective_id, work_item_id, session_kind, agent_id
       FROM sessions WHERE id = ?`,
      [session.id]
    );
    if (existing) {
      // Fields omitted by Provider polling retain their persisted storage
      // identity/order. Generating a fresh fallback here turns every poll into
      // a semantic UPDATE even though the visible Session is unchanged.
      values[11] = existing.created_at;
      if (!Number.isFinite(session.sortOrder)) values[15] = existing.sort_order;
      if (session.objectiveId == null) values[18] = existing.objective_id;
      if (session.workItemId == null) values[19] = existing.work_item_id;
      if (values[20] === SESSION_KIND.legacy) values[20] = existing.session_kind;
      if (session.agentId == null) values[21] = existing.agent_id;
      const columns = [
        "title", "agent", "provider", "command", "args_json", "cwd", "status", "progress",
        "summary", "accent", "created_at", "updated_at", "archived", "pinned", "sort_order",
        "active_choice_json", "raw_json", "objective_id", "work_item_id", "session_kind", "agent_id"
      ];
      let changed = false;
      for (let i = 0; i < columns.length; i++) {
        if (columns[i] === "updated_at") continue;
        const next = values[i + 1];
        const prev = existing[columns[i]];
        // SQLite returns integers/bools as numbers and NULL for absent values;
        // normalize both sides so `0` matches `false` and `null` matches `undefined`.
        const a = next == null ? null : next;
        const b = prev == null ? null : prev;
        if (a !== b) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        this.ensureSessionLog(session.id);
        return;
      }
    }

    this.db.run(
      `INSERT INTO sessions (
        id, title, agent, provider, command, args_json, cwd, status, progress, summary, accent, created_at, updated_at, archived, pinned, sort_order, active_choice_json, raw_json, objective_id, work_item_id, session_kind, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        active_choice_json=excluded.active_choice_json,
        raw_json=excluded.raw_json,
        objective_id=COALESCE(excluded.objective_id, sessions.objective_id),
        work_item_id=COALESCE(excluded.work_item_id, sessions.work_item_id),
        agent_id=COALESCE(excluded.agent_id, sessions.agent_id),
        session_kind=CASE
          WHEN excluded.session_kind = 'legacy' THEN sessions.session_kind
          ELSE excluded.session_kind
        END`,
      values
    );
    this.ensureSessionLog(session.id);
    this.scheduleSave();
  }

  // 将已有 Session 归属到某个 WorkItem（及其 Objective），只更新归属两列，不覆盖其它字段。
  bindSessionToWorkItem(sessionId, workItemId, objectiveId) {
    const session = this.getSession(sessionId);
    if (!session) {
      const error = new Error(`Session not found: ${sessionId}`);
      error.name = "SessionNotFoundError";
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    const workItem = workItemId ? this.getWorkItem(workItemId) : null;
    if (workItemId && !workItem) {
      const error = new Error(`WorkItem not found: ${workItemId}`);
      error.name = "WorkItemNotFoundError";
      error.code = "WORK_ITEM_NOT_FOUND";
      throw error;
    }
    if (!workItemId || !objectiveId || workItem.objective_id !== objectiveId) {
      const error = new Error(`Worker Session ${sessionId} must use the Objective owned by WorkItem ${workItemId ?? "<missing>"}.`);
      error.name = "SessionAssociationError";
      error.code = "SESSION_WORK_ITEM_OBJECTIVE_MISMATCH";
      throw error;
    }
    const timestamp = createdAtFromOrNow();
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `UPDATE sessions SET objective_id = ?, work_item_id = ?, session_kind = 'worker', updated_at = ? WHERE id = ?`,
        [objectiveId ?? null, workItemId ?? null, timestamp, sessionId]
      );
      // 1:1 语义：work_item 记录当前活跃 session（换 Agent/重来时覆盖为新的）
      if (workItemId) {
        this.db.run(
          `UPDATE work_items SET current_session_id = ?, updated_at = ? WHERE id = ?`,
          [sessionId, timestamp, workItemId]
        );
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getSession(sessionId);
  }

  assertSessionAssociation({ sessionId, sessionKind, objectiveId, workItemId }) {
    if (sessionKind !== "worker") return;
    if (!objectiveId || !workItemId) {
      const error = new Error(`Worker Session ${sessionId ?? "<unknown>"} requires objectiveId and workItemId.`);
      error.name = "SessionAssociationError";
      error.code = "WORKER_SESSION_ASSOCIATION_REQUIRED";
      throw error;
    }
    const workItem = this.getWorkItem(workItemId);
    if (!workItem) {
      const error = new Error(`WorkItem not found for Worker Session ${sessionId ?? "<unknown>"}: ${workItemId}`);
      error.name = "SessionAssociationError";
      error.code = "SESSION_WORK_ITEM_NOT_FOUND";
      throw error;
    }
    if (workItem.objective_id !== objectiveId || !this.getObjective(objectiveId)) {
      const error = new Error(`Worker Session ${sessionId ?? "<unknown>"} Objective does not match WorkItem ${workItemId}.`);
      error.name = "SessionAssociationError";
      error.code = "SESSION_WORK_ITEM_OBJECTIVE_MISMATCH";
      throw error;
    }
  }

  // Finalize every durable relationship established by a WorkItem start in one
  // transaction. Provider creation may already have persisted the Session,
  // logical route, Provider binding, and Agent binding; this method refuses to
  // publish `running` unless that complete graph is present and consistent.
  finalizeWorkItemStart({
    sessionId, workItemId, objectiveId, agentId, operationId, workspace,
    repairedBy = "work-item-start-finalizer",
    repairReason = "Recovered a Provider-created Worker Session from its authoritative start operation."
  }) {
    const session = this.getSession(sessionId);
    const workItem = this.getWorkItem(workItemId);
    const logical = this.getLogicalSessionByLegacySessionId(sessionId);
    const activeBinding = logical?.activeBinding ?? null;
    const agentBinding = this.selectOne(
      `SELECT binding_id FROM agent_sessions
       WHERE agent_id=? AND session_id=? AND unbound_at IS NULL`,
      [agentId, sessionId]
    );
    const associationMissing = session
      && !session.objectiveId && !session.workItemId && session.sessionKind === "worker";
    const associationMatches = session?.objectiveId === objectiveId
      && session?.workItemId === workItemId && session?.sessionKind === "worker";
    if (!session || !workItem || workItem.objective_id !== objectiveId
      || (!associationMissing && !associationMatches)
      || session.agentId !== agentId || !logical || !activeBinding || !agentBinding) {
      const error = new Error("Worker Session graph is incomplete; WorkItem start was not published as running.");
      error.code = "WORK_ITEM_START_INVARIANT_VIOLATION";
      throw error;
    }
    const expectedPath = typeof workspace?.path === "string" ? resolve(workspace.path) : null;
    const boundPath = typeof activeBinding.boundCwd === "string" ? resolve(activeBinding.boundCwd) : null;
    if (expectedPath && boundPath !== expectedPath) {
      const error = new Error("Worker Session Provider binding points to a different Worktree.");
      error.code = "WORK_ITEM_WORKTREE_BINDING_MISMATCH";
      throw error;
    }
    const timestamp = createdAtFromOrNow();
    this.runInTransaction(() => {
      this.db.run(
        `UPDATE sessions SET objective_id=?, work_item_id=?, session_kind='worker', agent_id=?, updated_at=?
         WHERE id=?`,
        [objectiveId, workItemId, agentId, timestamp, sessionId]
      );
      this.db.run(
        `UPDATE work_items SET current_session_id=?, status='in_progress', execution_status='running',
         main_agent_id=?, acceptance_assessment_json='{}', start_stage='running',
         start_failure_stage=NULL, start_error_code=NULL, start_error=NULL, start_failed_at=NULL,
         start_stage_updated_at=?, resource_version=resource_version+1, updated_at=? WHERE id=?`,
        [sessionId, agentId, timestamp, timestamp, workItemId]
      );
      this.db.run(
        `UPDATE agents SET current_session_id=?, updated_at=? WHERE agent_id=?`,
        [sessionId, timestamp, agentId]
      );
      this.db.run(
        `UPDATE work_item_start_operations SET status='succeeded', stage='running', failure_stage=NULL,
         error_code=NULL, error_summary=NULL, session_id=?, logical_session_id=?,
         provider_binding_id=?, updated_at=?, completed_at=? WHERE operation_id=?`,
        [sessionId, logical.logicalSessionId, activeBinding.bindingId, timestamp, timestamp, operationId]
      );
      if (associationMissing) {
        this.db.run(
          `INSERT INTO session_association_repair_audit (
             audit_id, session_id, anomaly_code, previous_objective_id, previous_work_item_id,
             repaired_objective_id, repaired_work_item_id, source_operation_id,
             repaired_by, reason, repaired_at
           ) VALUES (?, ?, 'worker_association_missing', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
          [randomUUID(), sessionId, objectiveId, workItemId, operationId, repairedBy, repairReason, timestamp]
        );
      }
      const invariant = this.selectOne(
        `SELECT wi.id FROM work_items wi
         JOIN sessions s ON s.id=wi.current_session_id
         JOIN agents a ON a.agent_id=wi.main_agent_id
         JOIN agent_sessions ab ON ab.agent_id=a.agent_id AND ab.session_id=s.id AND ab.unbound_at IS NULL
         JOIN logical_sessions ls ON ls.legacy_session_id=s.id
         JOIN provider_thread_bindings pb ON pb.logical_session_id=ls.logical_session_id
         JOIN work_item_start_operations op ON op.operation_id=?
         WHERE wi.id=? AND wi.objective_id=? AND s.objective_id=wi.objective_id
           AND s.work_item_id=wi.id AND s.agent_id=a.agent_id
           AND pb.binding_id=op.provider_binding_id AND pb.state='active'`,
        [operationId, workItemId, objectiveId]
      );
      if (!invariant) {
        const error = new Error("WorkItem start finalization violated persisted relationship invariants.");
        error.code = "WORK_ITEM_START_INVARIANT_VIOLATION";
        throw error;
      }
    });
    this.scheduleSave();
    return {
      session: this.getSession(sessionId),
      workItem: this.getWorkItem(workItemId),
      logicalSession: this.getLogicalSession(logical.logicalSessionId)
    };
  }

  sessionAssociationIssues() {
    return this.selectAll(`
      SELECT 'worker_objective_missing' AS code, s.id AS session_id,
             s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s
      WHERE s.session_kind='worker' AND (s.objective_id IS NULL OR TRIM(s.objective_id)='')
      UNION ALL
      SELECT 'worker_work_item_missing', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s
      WHERE s.session_kind='worker' AND (s.work_item_id IS NULL OR TRIM(s.work_item_id)='')
      UNION ALL
      SELECT 'session_objective_not_found', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s LEFT JOIN objectives o ON o.id=s.objective_id
      WHERE s.objective_id IS NOT NULL AND TRIM(s.objective_id)<>'' AND o.id IS NULL
      UNION ALL
      SELECT 'session_work_item_not_found', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s LEFT JOIN work_items wi ON wi.id=s.work_item_id
      WHERE s.work_item_id IS NOT NULL AND TRIM(s.work_item_id)<>'' AND wi.id IS NULL
      UNION ALL
      SELECT 'session_work_item_objective_mismatch', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s JOIN work_items wi ON wi.id=s.work_item_id
      WHERE s.objective_id IS NOT wi.objective_id
      UNION ALL
      SELECT 'bound_session_kind_not_worker', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s
      WHERE s.work_item_id IS NOT NULL AND TRIM(s.work_item_id)<>'' AND s.session_kind<>'worker'
      UNION ALL
      SELECT 'objective_chat_objective_missing', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s
      WHERE s.session_kind='objectiveChat' AND (s.objective_id IS NULL OR TRIM(s.objective_id)='')
      UNION ALL
      SELECT 'objective_chat_has_work_item', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s
      WHERE s.session_kind='objectiveChat' AND s.work_item_id IS NOT NULL AND TRIM(s.work_item_id)<>''
      UNION ALL
      SELECT 'work_item_current_session_not_found', wi.current_session_id, wi.objective_id, wi.id, NULL, wi.title
      FROM work_items wi LEFT JOIN sessions s ON s.id=wi.current_session_id
      WHERE wi.current_session_id IS NOT NULL AND TRIM(wi.current_session_id)<>'' AND s.id IS NULL
      UNION ALL
      SELECT 'work_item_current_session_binding_mismatch', wi.current_session_id, wi.objective_id, wi.id, s.session_kind, wi.title
      FROM work_items wi JOIN sessions s ON s.id=wi.current_session_id
      WHERE s.work_item_id IS NOT wi.id OR s.objective_id IS NOT wi.objective_id OR s.session_kind<>'worker'
      ORDER BY code, session_id
    `).map((row) => ({
      code: row.code,
      sessionId: row.session_id,
      objectiveId: row.objective_id ?? null,
      workItemId: row.work_item_id ?? null,
      sessionKind: row.session_kind ?? null,
      title: row.title
    }));
  }

  repairOrphanedWorkSessions(options = {}) {
    const repaired = [];
    const unresolved = [];
    const sessionIds = [...new Set(this.sessionAssociationIssues()
      .filter((issue) => issue.code === "worker_objective_missing" || issue.code === "worker_work_item_missing")
      .map((issue) => issue.sessionId))];
    for (const sessionId of sessionIds) {
      const candidates = this.selectAll(
        `SELECT op.* FROM work_item_start_operations op
         JOIN work_items wi ON wi.id=op.work_item_id AND wi.objective_id=op.objective_id
         JOIN sessions s ON s.id=op.session_id AND s.agent_id=op.agent_id
         WHERE op.session_id=? ORDER BY op.created_at DESC`,
        [sessionId]
      );
      if (candidates.length !== 1) {
        unresolved.push({
          sessionId,
          reason: candidates.length === 0 ? "authoritative_start_operation_not_found" : "ambiguous_start_operations",
          candidateOperationIds: candidates.map((candidate) => candidate.operation_id)
        });
        continue;
      }
      const candidate = candidates[0];
      try {
        const result = this.finalizeWorkItemStart({
          sessionId,
          workItemId: candidate.work_item_id,
          objectiveId: candidate.objective_id,
          agentId: candidate.agent_id,
          operationId: candidate.operation_id,
          workspace: { path: candidate.worktree_path },
          repairedBy: options.repairedBy ?? "session-association-integrity",
          repairReason: options.reason ?? "Repaired historical Worker Session association from its unique WorkItem start operation."
        });
        repaired.push({
          sessionId,
          objectiveId: candidate.objective_id,
          workItemId: candidate.work_item_id,
          operationId: candidate.operation_id,
          logicalSessionId: result.logicalSession.logicalSessionId
        });
      } catch (error) {
        unresolved.push({ sessionId, reason: error.code ?? "repair_failed", detail: error.message });
      }
    }
    return { repaired, unresolved, remainingIssues: this.sessionAssociationIssues() };
  }

  finalizeConflictResolutionLaunch({ sessionId, workItemId, objectiveId, agentId, integrationRunId }) {
    if (!this.getSession(sessionId)) {
      const error = new Error(`Session not found: ${sessionId}`);
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    const workItem = this.getWorkItem(workItemId);
    if (!workItem) {
      const error = new Error(`WorkItem not found: ${workItemId}`);
      error.code = "WORK_ITEM_NOT_FOUND";
      throw error;
    }
    if (!this.getObjective(objectiveId) || workItem.objective_id !== objectiveId) {
      const error = new Error(`Objective does not match WorkItem: ${objectiveId}`);
      error.code = "OBJECTIVE_MISMATCH";
      throw error;
    }
    if (!this.getAgent(agentId)) {
      const error = new Error(`Agent not found: ${agentId}`);
      error.code = "AGENT_NOT_FOUND";
      throw error;
    }
    if (!this.getProjectIntegrationRun(integrationRunId)) {
      const error = new Error(`Integration Run not found: ${integrationRunId}`);
      error.code = "INTEGRATION_NOT_FOUND";
      throw error;
    }
    const timestamp = createdAtFromOrNow();
    this.runInTransaction(() => {
      this.db.run(
        `UPDATE sessions SET objective_id=?, work_item_id=?, session_kind='worker', agent_id=?, updated_at=? WHERE id=?`,
        [objectiveId, workItemId, agentId, timestamp, sessionId]
      );
      this.db.run(
        `UPDATE work_items SET current_session_id=?, status='in_progress', execution_status='running',
         main_agent_id=?, acceptance_assessment_json='{}', updated_at=? WHERE id=?`,
        [sessionId, agentId, timestamp, workItemId]
      );
      this.db.run(
        `UPDATE project_integration_runs SET status='conflict_resolution_running',
         conflict_work_item_id=?, conflict_session_id=?, updated_at=? WHERE id=?`,
        [workItemId, sessionId, timestamp, integrationRunId]
      );
      const finalized = this.selectOne(
        `SELECT wi.id
         FROM work_items wi
         JOIN sessions s ON s.id = wi.current_session_id
         JOIN project_integration_runs r ON r.id = ?
         WHERE wi.id = ? AND wi.objective_id = ? AND wi.main_agent_id = ?
           AND s.id = ? AND s.work_item_id = wi.id AND s.objective_id = wi.objective_id
           AND s.agent_id = wi.main_agent_id
           AND r.conflict_work_item_id = wi.id AND r.conflict_session_id = s.id`,
        [integrationRunId, workItemId, objectiveId, agentId, sessionId]
      );
      if (!finalized) {
        const error = new Error("Conflict-resolution launch violated state invariants.");
        error.code = "STATE_INVARIANT_VIOLATION";
        throw error;
      }
    });
    this.scheduleSave();
    return {
      session: this.getSession(sessionId),
      workItem: this.getWorkItem(workItemId),
      integrationRun: this.getProjectIntegrationRun(integrationRunId)
    };
  }

  bindSessionToObjective(sessionId, objectiveId) {
    if (!this.getSession(sessionId)) {
      const error = new Error(`Session not found: ${sessionId}`);
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    if (!this.getObjective(objectiveId)) {
      const error = new Error(`Objective not found: ${objectiveId}`);
      error.code = "OBJECTIVE_NOT_FOUND";
      throw error;
    }
    const existing = this.getObjectiveChatSession(objectiveId);
    if (existing && existing.id !== sessionId) return existing;
    this.db.run(
      "UPDATE sessions SET objective_id = ?, work_item_id = NULL, session_kind = 'objectiveChat', updated_at = ? WHERE id = ?",
      [objectiveId, createdAtFromOrNow(), sessionId]
    );
    this.scheduleSave();
    return this.getSession(sessionId);
  }

  setSessionKind(sessionId, sessionKind, agentId = null) {
    const normalized = assertExplicitSessionKind(sessionKind);
    this.db.run(
      "UPDATE sessions SET session_kind = ?, agent_id = COALESCE(?, agent_id), updated_at = ? WHERE id = ?",
      [normalized, agentId, createdAtFromOrNow(), sessionId]
    );
    this.scheduleSave();
    return this.getSession(sessionId);
  }

  createSessionContextReference(input = {}) {
    const referenceId = input.referenceId ?? `context_ref:${randomUUID()}`;
    const timestamp = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO session_context_references (
        reference_id, owner_session_id, target_type, target_key, target_id, locator,
        display_name, inclusion_mode, enabled, priority, status,
        snapshot_title, snapshot_text, snapshot_at, content_hash, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        referenceId,
        input.ownerSessionId,
        input.targetType,
        input.targetKey,
        input.targetId ?? null,
        input.locator ?? null,
        input.displayName,
        input.inclusionMode ?? "default",
        input.enabled === false ? 0 : 1,
        Number.isFinite(input.priority) ? input.priority : 100,
        input.status ?? "available",
        input.snapshotTitle ?? null,
        input.snapshotText ?? null,
        input.snapshotAt ?? null,
        input.contentHash ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp
      ]
    );
    this.scheduleSave();
    return this.getSessionContextReference(referenceId);
  }

  getSessionContextReference(referenceId) {
    const row = this.selectOne(
      "SELECT * FROM session_context_references WHERE reference_id = ?",
      [referenceId]
    );
    return row ? sessionContextReferenceFromRow(row) : null;
  }

  listSessionContextReferences(ownerSessionId) {
    return this.selectAll(
      `SELECT * FROM session_context_references
       WHERE owner_session_id = ?
       ORDER BY enabled DESC, priority DESC, created_at ASC`,
      [ownerSessionId]
    ).map(sessionContextReferenceFromRow);
  }

  updateSessionContextReference(referenceId, patch = {}) {
    const current = this.getSessionContextReference(referenceId);
    if (!current) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE session_context_references SET
        display_name = ?, inclusion_mode = ?, enabled = ?, priority = ?, status = ?,
        snapshot_title = ?, snapshot_text = ?, snapshot_at = ?, content_hash = ?,
        metadata_json = ?, updated_at = ?
       WHERE reference_id = ?`,
      [
        has("displayName") ? patch.displayName : current.displayName,
        has("inclusionMode") ? patch.inclusionMode : current.inclusionMode,
        has("enabled") ? (patch.enabled ? 1 : 0) : (current.enabled ? 1 : 0),
        has("priority") ? patch.priority : current.priority,
        has("status") ? patch.status : current.status,
        has("snapshotTitle") ? patch.snapshotTitle : current.snapshotTitle,
        has("snapshotText") ? patch.snapshotText : current.snapshotText,
        has("snapshotAt") ? patch.snapshotAt : current.snapshotAt,
        has("contentHash") ? patch.contentHash : current.contentHash,
        JSON.stringify(has("metadata") ? (patch.metadata ?? {}) : current.metadata),
        createdAtFromOrNow(),
        referenceId
      ]
    );
    this.scheduleSave();
    return this.getSessionContextReference(referenceId);
  }

  deleteSessionContextReference(referenceId) {
    this.db.run(
      "DELETE FROM session_context_references WHERE reference_id = ?",
      [referenceId]
    );
    const deleted = this.db.getRowsModified() > 0;
    this.scheduleSave();
    return deleted;
  }

  // 创建 Session 记录（绑定 work_item + agent；1:1 更新 work_item.current_session_id）。
  createSession(input = {}) {
    const id = input.id ?? `session:${randomUUID()}`;
    const now = createdAtFromOrNow();
    const sessionKind = input.sessionKind == null
      ? inferSessionKind({ objectiveId: input.objectiveId, workItemId: input.workItemId })
      : assertExplicitSessionKind(input.sessionKind);
    this.db.run(
      `INSERT INTO sessions (
        id, title, agent, provider, command, args_json, cwd, status, progress, summary, accent,
        created_at, updated_at, archived, pinned, sort_order, active_choice_json, raw_json,
        objective_id, work_item_id, session_kind, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.title ?? "新会话",
        input.agentName ?? "Agent",
        input.provider ?? "codex-app-server",
        input.command ?? null,
        JSON.stringify(input.args ?? []),
        input.cwd ?? null,
        input.status ?? "running",
        input.progress ?? 0,
        input.summary ?? "",
        input.accent ?? "cyan",
        now,
        now,
        input.archived ? 1 : 0,
        input.pinned ? 1 : 0,
        input.sortOrder ?? null,
        input.activeChoiceJson ?? null,
        JSON.stringify(input.raw ?? {}),
        input.objectiveId ?? null,
        input.workItemId ?? null,
        input.workItemId ? SESSION_KIND.worker : sessionKind,
        input.agentId ?? null
      ]
    );
    if (input.workItemId) {
      this.db.run(
        `UPDATE work_items SET current_session_id = ?, updated_at = ? WHERE id = ?`,
        [id, now, input.workItemId]
      );
    }
    // 会话日志事件溯源（10）：新 session 建立 1:1 的 session_log。
    this.ensureSessionLog(id);
    this.scheduleSave();
    return this.getSession(id);
  }

  // 关闭 Session（置终态 completed）。
  closeSession(id) {
    this.db.run(
      `UPDATE sessions SET status = 'completed', updated_at = ? WHERE id = ?`,
      [createdAtFromOrNow(), id]
    );
    this.scheduleSave();
    return this.getSession(id);
  }

  appendItem(sessionId, item) {
    const createdAt = createdAtFromOrNow(item);
    const existing = this.selectOne(
      "SELECT 1 FROM session_items WHERE session_id = ? AND id = ?",
      [sessionId, item.id]
    );
    this.db.run(
      `INSERT OR REPLACE INTO session_items (
        id, session_id, turn_id, turn_status, type, title, text, options_json, raw_metadata_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        sessionId,
        item.turnId || sessionId,
        item.turnStatus || "running",
        item.type || "terminalOutput",
        item.title || "Agent",
        item.text || "",
        Array.isArray(item.options) ? JSON.stringify(item.options) : null,
        typeof item.rawMetadataJSON === "string" ? item.rawMetadataJSON : null,
        item.status || null,
        createdAt
      ]
    );
    // 单一真相源（10）：模型可见消息在写入 session_items 的同时，同步进事件流。
    // 仅在「新建」时写事件（append-only），同 id 的更新覆盖不产生重复正文事件。
    if (!existing) {
      const mapped = itemTypeToEventType(item.type);
      if (mapped) {
        try {
          this.appendSessionEvent({
            eventId: `item:${item.id}`,
            sessionId,
            type: mapped.type,
            producer: mapped.producer,
            surface: true,
            payload: { text: item.text, itemType: item.type, title: item.title, status: item.status },
            createdAt
          });
        } catch (error) {
          // 事件流写入失败不得阻断消息列表写入；记录告警供对账。
          console.error(`[session-events] item mirror failed for session=${sessionId} item=${item.id}: ${error.message}`);
        }
      }
    }
    this.scheduleSave();
  }

  // Provider history snapshots are a materialized read model, not new chat
  // activity. Persist them without mirroring assistant/user events; mirroring
  // would advance unread cursors every time an old transcript is refreshed.
  upsertItemSnapshot(sessionId, item) {
    const createdAt = createdAtFromOrNow(item);
    this.db.run(
      `INSERT INTO session_items (
        id, session_id, turn_id, turn_status, type, title, text, options_json, raw_metadata_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id=excluded.session_id,
        turn_id=excluded.turn_id,
        turn_status=excluded.turn_status,
        type=excluded.type,
        title=excluded.title,
        text=excluded.text,
        options_json=excluded.options_json,
        raw_metadata_json=excluded.raw_metadata_json,
        status=excluded.status,
        created_at=excluded.created_at
      WHERE session_items.session_id IS NOT excluded.session_id
         OR session_items.turn_id IS NOT excluded.turn_id
         OR session_items.turn_status IS NOT excluded.turn_status
         OR session_items.type IS NOT excluded.type
         OR session_items.title IS NOT excluded.title
         OR session_items.text IS NOT excluded.text
         OR session_items.options_json IS NOT excluded.options_json
         OR session_items.raw_metadata_json IS NOT excluded.raw_metadata_json
         OR session_items.status IS NOT excluded.status
         OR session_items.created_at IS NOT excluded.created_at`,
      [
        item.id,
        sessionId,
        item.turnId || sessionId,
        item.turnStatus || "completed",
        item.type || "terminalOutput",
        item.title || "Agent",
        item.text || "",
        Array.isArray(item.options) ? JSON.stringify(item.options) : null,
        typeof item.rawMetadataJSON === "string" ? item.rawMetadataJSON : null,
        item.status || null,
        createdAt
      ]
    );
    if (this.db.getRowsModified() > 0) this.scheduleSave();
  }

  removeItem(sessionId, itemId) {
    this.db.run("DELETE FROM session_items WHERE session_id = ? AND id = ?", [sessionId, itemId]);
    this.scheduleSave();
  }

  clearItems(sessionId) {
    this.db.run("DELETE FROM session_items WHERE session_id = ?", [sessionId]);
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

  createScheduledSessionTask(input) {
    const timestamp = createdAtFromOrNow(input.createdAt);
    this.db.run(
      `INSERT INTO scheduled_session_tasks (
        task_id, logical_session_id, message_json, schedule_type, run_at, next_run_at,
        interval_seconds, timezone, status, missed_policy, condition_spec_json,
        condition_state_json, process_spec_json, process_state_json,
        creator_type, creator_id, objective_id, environment,
        max_retries, name, trigger_spec_json, condition_specs_json, actions_json,
        policy_spec_json, risk_json, max_concurrent_runs, timeout_seconds, backpressure_limit,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.logicalSessionId,
        JSON.stringify(input.message),
        input.scheduleType,
        input.runAt ?? null,
        input.nextRunAt ?? null,
        input.intervalSeconds ?? null,
        input.timezone,
        input.missedPolicy,
        input.conditionSpec ? JSON.stringify(input.conditionSpec) : null,
        input.conditionState ? JSON.stringify(input.conditionState) : null,
        input.processSpec ? JSON.stringify(input.processSpec) : null,
        input.processState ? JSON.stringify(input.processState) : null,
        input.creatorType,
        input.creatorId,
        input.objectiveId ?? null,
        input.environment,
        input.maxRetries ?? 5,
        input.name ?? null,
        input.triggerSpec ? JSON.stringify(input.triggerSpec) : null,
        JSON.stringify(input.conditionSpecs ?? []),
        JSON.stringify(input.actions ?? []),
        JSON.stringify(input.policySpec ?? {}),
        JSON.stringify(input.risk ?? {}),
        input.maxConcurrentRuns ?? 1,
        input.timeoutSeconds ?? 3600,
        input.backpressureLimit ?? 100,
        timestamp,
        timestamp
      ]
    );
    this.scheduleSave();
    return this.getScheduledSessionTask(input.taskId);
  }

  getScheduledSessionTask(taskId) {
    const row = this.selectOne("SELECT * FROM scheduled_session_tasks WHERE task_id = ?", [taskId]);
    return row ? scheduledSessionTaskFromRow(row) : null;
  }

  listScheduledSessionTasks(options = {}) {
    const clauses = ["environment = ?"];
    const params = [options.environment];
    if (options.logicalSessionId) {
      clauses.push("logical_session_id = ?");
      params.push(options.logicalSessionId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    return this.selectAll(
      `SELECT * FROM scheduled_session_tasks WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, task_id ASC`,
      params
    ).map(scheduledSessionTaskFromRow);
  }

  updateScheduledSessionTask(taskId, patch = {}, expectedVersion = null) {
    const task = this.getScheduledSessionTask(taskId);
    if (!task) return null;
    if (expectedVersion != null && Number(expectedVersion) !== task.resourceVersion) {
      const error = new Error(`计划任务 ${taskId} was modified by another request.`);
      error.code = "RESOURCE_VERSION_CONFLICT";
      throw error;
    }
    const value = (key, fallback) => Object.hasOwn(patch, key) ? patch[key] : fallback;
    const timestamp = new Date().toISOString();
    this.db.run(
      `UPDATE scheduled_session_tasks SET
         name = ?, message_json = ?, trigger_spec_json = ?, condition_specs_json = ?, actions_json = ?,
         policy_spec_json = ?, risk_json = ?, run_at = ?, next_run_at = ?, interval_seconds = ?, timezone = ?,
         status = ?, missed_policy = ?, condition_spec_json = ?, condition_state_json = ?,
         process_spec_json = ?, process_state_json = ?,
         pending_scheduled_for = ?, lease_owner = ?, lease_expires_at = ?, retry_count = ?,
         max_retries = ?, last_run_id = ?, last_run_status = ?, last_error_code = ?,
         last_error_message = ?, last_run_at = ?, resource_version = resource_version + 1,
         max_concurrent_runs = ?, timeout_seconds = ?, backpressure_limit = ?,
         paused_at = ?, cancelled_at = ?, completed_at = ?, updated_at = ?
       WHERE task_id = ?`,
      [
        value("name", task.name),
        JSON.stringify(value("message", task.message)),
        value("triggerSpec", task.triggerSpec) ? JSON.stringify(value("triggerSpec", task.triggerSpec)) : null,
        JSON.stringify(value("conditionSpecs", task.conditionSpecs) ?? []),
        JSON.stringify(value("actions", task.actions) ?? []),
        JSON.stringify(value("policySpec", task.policySpec) ?? {}),
        JSON.stringify(value("risk", task.risk) ?? {}),
        value("runAt", task.runAt),
        value("nextRunAt", task.nextRunAt),
        value("intervalSeconds", task.intervalSeconds),
        value("timezone", task.timezone),
        value("status", task.status),
        value("missedPolicy", task.missedPolicy),
        value("conditionSpec", task.conditionSpec) ? JSON.stringify(value("conditionSpec", task.conditionSpec)) : null,
        value("conditionState", task.conditionState) ? JSON.stringify(value("conditionState", task.conditionState)) : null,
        value("processSpec", task.processSpec) ? JSON.stringify(value("processSpec", task.processSpec)) : null,
        value("processState", task.processState) ? JSON.stringify(value("processState", task.processState)) : null,
        value("pendingScheduledFor", task.pendingScheduledFor),
        value("leaseOwner", task.leaseOwner),
        value("leaseExpiresAt", task.leaseExpiresAt),
        value("retryCount", task.retryCount),
        value("maxRetries", task.maxRetries),
        value("lastRunId", task.lastRunId),
        value("lastRunStatus", task.lastRunStatus),
        value("lastErrorCode", task.lastErrorCode),
        value("lastErrorMessage", task.lastErrorMessage),
        value("lastRunAt", task.lastRunAt),
        value("maxConcurrentRuns", task.maxConcurrentRuns),
        value("timeoutSeconds", task.timeoutSeconds),
        value("backpressureLimit", task.backpressureLimit),
        value("pausedAt", task.pausedAt),
        value("cancelledAt", task.cancelledAt),
        value("completedAt", task.completedAt),
        timestamp,
        taskId
      ]
    );
    this.scheduleSave();
    return this.getScheduledSessionTask(taskId);
  }

  claimDueScheduledSessionTasks(input = {}) {
    const now = input.now;
    const leaseUntil = input.leaseUntil;
    const owner = input.leaseOwner;
    const environment = input.environment;
    const limit = Math.max(1, Math.min(100, Number(input.limit) || 25));
    return this.runInTransaction(() => {
      const rows = this.selectAll(
        `SELECT task_id FROM scheduled_session_tasks
         WHERE environment = ? AND status = 'active' AND next_run_at IS NOT NULL
           AND next_run_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         ORDER BY next_run_at ASC, task_id ASC LIMIT ?`,
        [environment, now, now, limit]
      );
      const claimed = [];
      for (const row of rows) {
        this.db.run(
          `UPDATE scheduled_session_tasks SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE task_id = ? AND status = 'active'
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
          [owner, leaseUntil, now, row.task_id, now]
        );
        if (this.db.getRowsModified() > 0) claimed.push(this.getScheduledSessionTask(row.task_id));
      }
      return claimed;
    });
  }

  createScheduledSessionRun(input) {
    const timestamp = input.createdAt ?? new Date().toISOString();
    this.db.run(
      `INSERT OR IGNORE INTO scheduled_session_runs (
         run_id, task_id, run_key, scheduled_for, trigger_kind, trigger_reason,
         status, attempt_count, exit_status_json, condition_result_json,
         stages_json, action_results_json, deadline_at, claimed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.runId,
        input.taskId,
        input.runKey,
        input.scheduledFor,
        input.triggerKind,
        input.triggerReason,
        input.status ?? "claimed",
        input.attemptCount ?? 1,
        input.exitStatus ? JSON.stringify(input.exitStatus) : null,
        input.conditionResult ? JSON.stringify(input.conditionResult) : null,
        JSON.stringify(input.stages ?? []),
        JSON.stringify(input.actionResults ?? []),
        input.deadlineAt ?? null,
        input.claimedAt ?? timestamp,
        timestamp,
        timestamp
      ]
    );
    if (this.db.getRowsModified() > 0) this.scheduleSave();
    return this.getScheduledSessionRunByKey(input.runKey);
  }

  getScheduledSessionRun(runId) {
    const row = this.selectOne("SELECT * FROM scheduled_session_runs WHERE run_id = ?", [runId]);
    return row ? scheduledSessionRunFromRow(row) : null;
  }

  getScheduledSessionRunByKey(runKey) {
    const row = this.selectOne("SELECT * FROM scheduled_session_runs WHERE run_key = ?", [runKey]);
    return row ? scheduledSessionRunFromRow(row) : null;
  }

  getScheduledSessionRunForAgentWorkItem(workItemId) {
    const row = this.selectOne(
      "SELECT * FROM scheduled_session_runs WHERE agent_work_item_id = ? ORDER BY created_at DESC LIMIT 1",
      [workItemId]
    );
    return row ? scheduledSessionRunFromRow(row) : null;
  }

  listScheduledSessionRuns(taskId, limit = 100) {
    return this.selectAll(
      "SELECT * FROM scheduled_session_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?",
      [taskId, Math.max(1, Math.min(1000, Number(limit) || 100))]
    ).map(scheduledSessionRunFromRow);
  }

  countActiveScheduledSessionRuns(taskId) {
    return Number(this.selectOne(
      `SELECT COUNT(*) AS count FROM scheduled_session_runs
       WHERE task_id = ? AND status IN ('claimed', 'running')`,
      [taskId]
    )?.count ?? 0);
  }

  countPendingScheduledSessionRunsForLogicalSession(logicalSessionId) {
    return Number(this.selectOne(
      `SELECT COUNT(*) AS count FROM scheduled_session_runs r
       JOIN scheduled_session_tasks t ON t.task_id = r.task_id
       WHERE t.logical_session_id = ? AND r.status IN ('claimed', 'queued', 'running', 'retry_wait')`,
      [logicalSessionId]
    )?.count ?? 0);
  }

  listExpiredScheduledSessionRuns(now, environment) {
    return this.selectAll(
      `SELECT r.* FROM scheduled_session_runs r
       JOIN scheduled_session_tasks t ON t.task_id = r.task_id
       WHERE t.environment = ? AND r.status IN ('claimed', 'queued', 'running')
         AND r.deadline_at IS NOT NULL AND r.deadline_at <= ?`,
      [environment, now]
    ).map(scheduledSessionRunFromRow);
  }

  updateScheduledSessionRun(runId, patch = {}) {
    const run = this.getScheduledSessionRun(runId);
    if (!run) return null;
    const value = (key, fallback) => Object.hasOwn(patch, key) ? patch[key] : fallback;
    const timestamp = new Date().toISOString();
    this.db.run(
      `UPDATE scheduled_session_runs SET status = ?, attempt_count = ?, agent_work_item_id = ?,
         target_turn_id = ?, binding_id = ?, provider_session_id = ?, routing_version = ?,
         exit_status_json = ?, condition_result_json = ?, stages_json = ?, action_results_json = ?, deadline_at = ?,
         error_code = ?, error_message = ?, claimed_at = ?, queued_at = ?,
         started_at = ?, completed_at = ?, updated_at = ? WHERE run_id = ?`,
      [
        value("status", run.status),
        value("attemptCount", run.attemptCount),
        value("agentWorkItemId", run.agentWorkItemId),
        value("targetTurnId", run.targetTurnId),
        value("bindingId", run.bindingId),
        value("providerSessionId", run.providerSessionId),
        value("routingVersion", run.routingVersion),
        value("exitStatus", run.exitStatus) ? JSON.stringify(value("exitStatus", run.exitStatus)) : null,
        value("conditionResult", run.conditionResult) ? JSON.stringify(value("conditionResult", run.conditionResult)) : null,
        JSON.stringify(value("stages", run.stages) ?? []),
        JSON.stringify(value("actionResults", run.actionResults) ?? []),
        value("deadlineAt", run.deadlineAt),
        value("errorCode", run.errorCode),
        value("errorMessage", run.errorMessage),
        value("claimedAt", run.claimedAt),
        value("queuedAt", run.queuedAt),
        value("startedAt", run.startedAt),
        value("completedAt", run.completedAt),
        timestamp,
        runId
      ]
    );
    this.scheduleSave();
    return this.getScheduledSessionRun(runId);
  }

  recordScheduledSessionEvent(input) {
    const sequence = Number(this.selectOne(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM scheduled_session_events WHERE task_id = ?",
      [input.taskId]
    )?.sequence ?? 1);
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.run(
      `INSERT INTO scheduled_session_events (
        event_id, task_id, run_id, sequence, type, actor_type, actor_id,
        payload_json, environment, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.eventId ?? randomUUID(), input.taskId, input.runId ?? null, sequence, input.type,
        input.actorType ?? null, input.actorId ?? null, JSON.stringify(input.payload ?? {}),
        input.environment, createdAt
      ]
    );
    this.scheduleSave();
    return { ...input, sequence, createdAt };
  }

  listScheduledSessionEvents(taskId, limit = 200) {
    return this.selectAll(
      `SELECT * FROM scheduled_session_events WHERE task_id = ?
       ORDER BY sequence DESC LIMIT ?`,
      [taskId, Math.max(1, Math.min(1000, Number(limit) || 200))]
    ).map(scheduledSessionEventFromRow).reverse();
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

  getRunningAgentWorkItem(agentId) {
    const row = this.selectOne(
      "SELECT * FROM agent_work_items WHERE agent_id = ? AND status = 'running' ORDER BY started_at ASC LIMIT 1",
      [agentId]
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

  listQueuedAgentWorkItemsForSession(sessionId, limit = 100) {
    return this.selectAll(
      `SELECT * FROM agent_work_items WHERE session_id = ? AND status = 'queued'
       ORDER BY priority DESC, created_at ASC, work_item_id ASC LIMIT ?`,
      [sessionId, Math.max(1, Math.min(1000, Number(limit) || 100))]
    ).map(agentWorkItemFromRow);
  }

  listAgentIdsWithQueuedWork() {
    return this.selectAll(
      "SELECT DISTINCT agent_id FROM agent_work_items WHERE status = 'queued' ORDER BY agent_id ASC"
    ).map((row) => row.agent_id);
  }

  listAgentIdsWithUnsettledWork() {
    return this.selectAll(
      "SELECT DISTINCT agent_id FROM agent_work_items WHERE status IN ('queued', 'running') ORDER BY agent_id ASC"
    ).map((row) => row.agent_id);
  }

  listSessionIdsWithUnsettledAgentWork() {
    return this.selectAll(
      "SELECT DISTINCT session_id FROM agent_work_items WHERE status IN ('queued', 'running') ORDER BY session_id ASC"
    ).map((row) => row.session_id);
  }

  claimAgentWorkItem(workItemId) {
    const item = this.getAgentWorkItem(workItemId);
    if (!item) return null;
    // Older Corptie processes sharing a development database can recreate the
    // retired Agent-wide uniqueness index after this process has migrated it.
    // Remove that compatibility artifact at the claim boundary as well, so it
    // cannot silently restore cross-Session serialization.
    if (this.selectOne(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_work_items_one_running'"
    )) {
      this.db.run("DROP INDEX idx_agent_work_items_one_running");
    }
    const timestamp = new Date().toISOString();
    this.db.run(
      `UPDATE agent_work_items SET status = 'running', started_at = ?, updated_at = ?, last_error = NULL
       WHERE work_item_id = ? AND status = 'queued'
         AND NOT EXISTS (
           SELECT 1 FROM agent_work_items running
           WHERE running.session_id = ? AND running.status = 'running'
         )`,
      [timestamp, timestamp, workItemId, item.sessionId]
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
      `UPDATE agent_work_items SET status = ?, session_id = ?, target_turn_id = ?, last_error = ?,
       started_at = ?, completed_at = ?, source_json = ?, updated_at = ? WHERE work_item_id = ?`,
      [
        status,
        Object.hasOwn(patch, "sessionId") ? patch.sessionId : item.sessionId,
        Object.hasOwn(patch, "targetTurnId") ? patch.targetTurnId : item.targetTurnId,
        Object.hasOwn(patch, "lastError") ? patch.lastError : item.lastError,
        Object.hasOwn(patch, "startedAt") ? patch.startedAt : item.startedAt,
        completedAt,
        JSON.stringify(Object.hasOwn(patch, "source") ? (patch.source ?? {}) : item.source),
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
      `${sessionProjectionSelectSQL()}
       WHERE sessions.archived = ?
       ORDER BY sessions.pinned DESC, sessions.sort_order ASC, sessions.updated_at DESC`,
      [archived]
    );
    return rows.map((row) => this.rowToSession(row));
  }

  getSession(id) {
    const row = this.selectOne(
      `${sessionProjectionSelectSQL()} WHERE sessions.id = ?`,
      [id]
    );
    return row ? this.rowToSession(row) : null;
  }

  listSessionsByWorkItem(workItemId) {
    const rows = this.selectAll(
      "SELECT * FROM sessions WHERE work_item_id = ? ORDER BY created_at ASC",
      [workItemId]
    );
    return rows.map((row) => this.rowToSession(row));
  }

  listSessionsByObjective(objectiveId) {
    const rows = this.selectAll(
      "SELECT * FROM sessions WHERE objective_id = ? ORDER BY created_at ASC",
      [objectiveId]
    );
    return rows.map((row) => this.rowToSession(row));
  }

  getObjectiveChatSession(objectiveId) {
    const row = this.selectOne(
      `SELECT * FROM sessions
       WHERE objective_id = ? AND session_kind = 'objectiveChat'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [objectiveId]
    );
    return row ? this.rowToSession(row) : null;
  }

  listSessionsByAgent(agentId) {
    const rows = this.selectAll(
      `SELECT s.* FROM sessions s
       WHERE s.agent_id = ? OR EXISTS (
         SELECT 1 FROM agent_sessions bindings
         WHERE bindings.session_id = s.id AND bindings.agent_id = ?
       )
       ORDER BY s.created_at ASC`,
      [agentId, agentId]
    );
    return rows.map((row) => this.rowToSession(row));
  }

  getItems(sessionId, limit = 240, provider = "") {
    const pageLimit = Math.max(1, Math.min(500, Number.isFinite(limit) && Number(limit) > 0
      ? Math.floor(Number(limit))
      : 240));
    const rows = this.selectAll(
      `SELECT id, turn_id, turn_status, type, title, text, options_json,
              raw_metadata_json, status, created_at
       FROM (
         SELECT id, turn_id, turn_status, type, title, text, options_json,
                raw_metadata_json, status, created_at
         FROM session_items
         WHERE session_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, id ASC`,
      [sessionId, pageLimit]
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
        rawMetadataJSON: row.raw_metadata_json ?? null,
        status: row.status,
        createdAt: row.created_at
      }))
      .filter((item) => item.text)
      .filter((item) => !isAgentNoise(item.text))
      .map((item) => normalizeStoredItem(item, provider))
      .filter((item, index, items) => !isAdjacentDuplicateUserMessage(item, items[index - 1]));
    return items;
  }

  listStoredTimelineEvents(sessionId, { beforeSequence = null, limit = 400 } = {}) {
    const pageLimit = Math.max(1, Math.min(500, Number(limit) || 400));
    const before = Number(beforeSequence);
    const hasBefore = Number.isSafeInteger(before) && before > 0;
    return this.selectAll(
      `SELECT event_id, session_id, log_id, sequence, type, producer, surface,
              source_event_seqs_json, call_id, source_json, payload_json, created_at
       FROM (
         SELECT event_id, session_id, log_id, sequence, type, producer, surface,
                source_event_seqs_json, call_id, source_json, payload_json, created_at
         FROM session_events
         WHERE session_id = ?
           ${hasBefore ? "AND sequence < ?" : ""}
           AND type IN (
             'user/message', 'assistant/message', 'SessionUserMessageCreated',
             'CodexThreadCompleted', 'TaskCompleted', 'AgentTurnCompleted'
           )
         ORDER BY sequence DESC LIMIT ?
       )
       ORDER BY sequence ASC`,
      hasBefore ? [sessionId, before, pageLimit] : [sessionId, pageLimit]
    ).map(sessionEventFromRow);
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
      connectionStatus: "disconnected",
      currentModel: session.external?.currentModel ?? session.rawStatus?.currentModel ?? session.rawStatus?.resume?.currentModel ?? null,
      cwd: session.external?.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      rawStatus: session.rawStatus,
      capabilities: session.external?.provider === "claude-sdk"
        ? capabilitiesForStoredProvider(session.external?.provider, session.status)
        : session.rawStatus?.capabilities ?? capabilitiesForStoredProvider(session.external?.provider, session.status),
      canSend: false,
      sendUnavailableReason: session.external?.provider === "claude-sdk"
          ? "This Claude Code session is no longer connected. Start a new Claude session to continue."
        : "This session is not currently attached to a running process.",
      turnCount: 1,
      items: this.getItems(id, 240, session.external?.provider)
    };
  }

  getRuntimeState(key) {
    const row = this.selectOne(
      "SELECT value_json FROM runtime_state WHERE key = ?",
      [String(key)]
    );
    return row ? parseJson(row.value_json, null) : null;
  }

  setRuntimeState(key, value) {
    this.db.run(
      `INSERT INTO runtime_state (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json=excluded.value_json,
         updated_at=excluded.updated_at`,
      [String(key), JSON.stringify(value ?? null), new Date().toISOString()]
    );
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
    const ids = sessionIds.map((id) => String(id)).filter(Boolean);
    ids.forEach((id, index) => {
      this.db.run("UPDATE sessions SET sort_order = ? WHERE id = ?", [index, id]);
    });
    this.scheduleSave();
    return this.listSessions({ archived: false });
  }

  renameSession(id, title) {
    const sessionName = requiredText(title, "title");
    const sessionNameKey = normalizeSessionTitle(sessionName);
    const updatedAt = new Date().toISOString();
    const logical = this.getLogicalSessionByLegacySessionId(id) ?? this.getLogicalSession(id);
    const storageSessionId = logical?.legacySessionId ?? id;
    if (logical) {
      const conflict = this.selectOne(
        `SELECT logical_session_id FROM logical_sessions
         WHERE session_name_key = ? AND logical_session_id <> ?`,
        [sessionNameKey, logical.logicalSessionId]
      );
      const aliasConflict = this.selectOne(
        `SELECT logical_session_id FROM session_name_aliases
         WHERE alias_key = ? AND logical_session_id <> ?`,
        [sessionNameKey, logical.logicalSessionId]
      );
      if (conflict || aliasConflict) {
        const error = new Error(`A session named "${sessionName}" already exists.`);
        error.code = "SESSION_TITLE_CONFLICT";
        error.statusCode = 409;
        error.conflictingSessionId = conflict?.logical_session_id ?? aliasConflict.logical_session_id;
        throw error;
      }
    }
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", [sessionName, updatedAt, storageSessionId]);
      if (logical) {
        const previousName = logical.sessionName;
        const previousKey = normalizeSessionTitle(previousName);
        if (previousKey && previousKey !== sessionNameKey) {
          this.db.run(
            `INSERT INTO session_name_aliases (alias_key, alias, logical_session_id, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(alias_key) DO NOTHING`,
            [previousKey, previousName, logical.logicalSessionId, updatedAt]
          );
        }
        this.db.run(
          "DELETE FROM session_name_aliases WHERE alias_key = ? AND logical_session_id = ?",
          [sessionNameKey, logical.logicalSessionId]
        );
        this.db.run(
          `UPDATE logical_sessions
           SET session_name = ?, session_name_key = ?, title = ?, updated_at = ?
           WHERE logical_session_id = ?`,
          [sessionName, sessionNameKey, sessionName, updatedAt, logical.logicalSessionId]
        );
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getSession(storageSessionId);
  }

  setActiveChoicePrompt(sessionId, prompt = "", options = []) {
    const rawId = String(sessionId);
    const activeChoice = serializeActiveChoicePrompt(options, prompt);
    this.db.run(
      "UPDATE sessions SET active_choice_json = ?, updated_at = ? WHERE id = ?",
      [activeChoice, new Date().toISOString(), rawId]
    );
    this.scheduleSave();
    return this.getSession(rawId);
  }

  clearActiveChoicePrompt(sessionId) {
    const rawId = String(sessionId);
    this.db.run(
      "UPDATE sessions SET active_choice_json = NULL, updated_at = ? WHERE id = ?",
      [new Date().toISOString(), rawId]
    );
    this.scheduleSave();
    return this.getSession(rawId);
  }

  deleteSession(id) {
    const timestamp = new Date().toISOString();
    this.db.run(
      `UPDATE agent_work_items
       SET status = 'cancelled', completed_at = ?, updated_at = ?,
           last_error = COALESCE(last_error, 'Target Session was cleared or deleted before this message was processed.')
       WHERE session_id = ? AND status IN ('queued', 'running')`,
      [timestamp, timestamp, id]
    );
    this.db.run("DELETE FROM session_items WHERE session_id = ?", [id]);
    this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
    this.scheduleSave();
  }

  hasSessionEvent(eventId) {
    const normalizedEventId = String(eventId || "").trim();
    if (!normalizedEventId) return false;
    return Boolean(this.selectOne(
      "SELECT 1 FROM session_events WHERE event_id = ?",
      [normalizedEventId]
    ));
  }

  appendSessionEvent(event) {
    const sessionId = String(event.sessionId || "").trim();
    if (!sessionId) {
      return null;
    }
    // 确保 session_log 存在（新 session 未经 migrate 回填时兜底建立 1:1 log）
    this.ensureSessionLog(sessionId);

    const surface = event.surface == null
      ? surfaceForEventType(event.type)
      : (event.surface ? 1 : 0);
    const sourceEventSeqs = event.sourceEventSeqs ?? null;
    const callId = event.callId ?? null;
    const producer = event.producer ?? producerFromSource(event.source);

    // 原子分配 sequence：BEGIN IMMEDIATE 取写锁，消除并发 seq 竞态。
    // event_id 冲突时显式抛错，绝不静默丢弃或返回虚假 sequence。
    this.db.run("BEGIN IMMEDIATE");
    try {
      const existing = this.selectOne(
        "SELECT 1 FROM session_events WHERE event_id = ?",
        [event.eventId]
      );
      if (existing) {
        throw new Error(`Duplicate event_id: ${event.eventId}`);
      }
      const row = this.selectOne(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_events WHERE session_id = ?",
        [sessionId]
      );
      const sequence = Number(row?.sequence ?? 0) + 1;
      this.db.run(
        `INSERT INTO session_events (
          event_id, session_id, log_id, sequence, type, producer, surface,
          source_event_seqs_json, call_id, source_json, payload_json, has_agent_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.eventId,
          sessionId,
          `log:${sessionId}`,
          sequence,
          event.type,
          producer,
          surface,
          sourceEventSeqs ? JSON.stringify(sourceEventSeqs) : null,
          callId,
          event.source ? JSON.stringify(event.source) : null,
          JSON.stringify(event.payload ?? {}),
          eventHasAgentMessage(event) ? 1 : 0,
          event.createdAt || new Date().toISOString()
        ]
      );
      this.db.run("COMMIT");
      this.scheduleSave();
      return {
        ...event,
        sessionId,
        logId: `log:${sessionId}`,
        sequence,
        producer,
        surface: surface === 1,
        sourceEventSeqs,
        callId
      };
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  ensureSessionLog(sessionId) {
    this.db.run(
      `INSERT INTO session_logs (id, session_id, created_at)
       SELECT 'log:' || ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE NOT EXISTS (SELECT 1 FROM session_logs WHERE session_logs.session_id = ?)`,
      [sessionId, sessionId, sessionId]
    );
  }

  listSessionEvents(sessionId, after = 0, limit = 200) {
    const rows = this.selectAll(
      `SELECT event_id, session_id, log_id, sequence, type, producer, surface,
              source_event_seqs_json, call_id, source_json, payload_json, created_at
       FROM session_events
       WHERE session_id = ? AND sequence > ?
       ORDER BY sequence ASC LIMIT ?`,
      [sessionId, Math.max(0, Number(after) || 0), Math.max(1, Math.min(1000, Number(limit) || 200))]
    );
    return rows.map(sessionEventFromRow);
  }

  listSessionEventPage(sessionId, { beforeSequence = null, limit = 200 } = {}) {
    const pageLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    const before = Number(beforeSequence);
    const hasBefore = Number.isSafeInteger(before) && before > 0;
    const rows = this.selectAll(
      `SELECT event_id, session_id, log_id, sequence, type, producer, surface,
              source_event_seqs_json, call_id, source_json, payload_json, created_at
       FROM (
         SELECT event_id, session_id, log_id, sequence, type, producer, surface,
                source_event_seqs_json, call_id, source_json, payload_json, created_at
         FROM session_events
         WHERE session_id = ? ${hasBefore ? "AND sequence < ?" : ""}
         ORDER BY sequence DESC LIMIT ?
       )
       ORDER BY sequence ASC`,
      hasBefore ? [sessionId, before, pageLimit] : [sessionId, pageLimit]
    );
    return rows.map(sessionEventFromRow);
  }

  listLatestSessionMessageTimes() {
    const rows = this.selectAll(
      `SELECT session_id, MAX(created_at) AS last_message_at
       FROM session_events
       WHERE surface = 1
          OR type IN ('SessionUserMessageCreated', 'CodexThreadCompleted')
       GROUP BY session_id`
    );
    return new Map(rows.map((row) => [row.session_id, row.last_message_at]));
  }

  listSessionMessageCursors() {
    const rows = this.selectAll(`
      SELECT sessions.id AS session_id,
             COALESCE(agent_messages.last_agent_message_sequence, 0)
               AS last_agent_message_sequence,
             COALESCE(session_read_receipts.last_read_agent_message_sequence, 0)
               AS last_read_message_sequence
      FROM sessions
      LEFT JOIN (
        SELECT session_id, MAX(sequence) AS last_agent_message_sequence
        FROM session_events
        WHERE ${agentMessageEventSQL("session_events")}
        GROUP BY session_id
      ) AS agent_messages ON agent_messages.session_id = sessions.id
      LEFT JOIN session_read_receipts ON session_read_receipts.session_id = sessions.id
    `);
    return new Map(rows.map((row) => [row.session_id, {
      lastAgentMessageSequence: Number(row.last_agent_message_sequence ?? 0),
      lastReadMessageSequence: Number(row.last_read_message_sequence ?? 0)
    }]));
  }

  lastAgentMessageSequence(sessionId) {
    const row = this.selectOne(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM session_events
      WHERE session_id = ? AND ${agentMessageEventSQL("session_events")}
    `, [sessionId]);
    return Number(row?.sequence ?? 0);
  }

  markSessionMessagesRead(sessionId, throughSequence) {
    if (!this.getSession(sessionId)) {
      const error = new Error("Session not found.");
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    const latest = this.lastAgentMessageSequence(sessionId);
    const through = Number(throughSequence);
    if (!Number.isSafeInteger(through) || through < 0 || through > latest) {
      const error = new Error(`Invalid read sequence: expected an integer from 0 through ${latest}.`);
      error.code = "INVALID_READ_SEQUENCE";
      throw error;
    }
    const existing = this.selectOne(
      "SELECT last_read_agent_message_sequence FROM session_read_receipts WHERE session_id = ?",
      [sessionId]
    );
    const alreadyRead = Number(existing?.last_read_agent_message_sequence ?? 0);
    if (alreadyRead >= through) {
      return {
        lastAgentMessageSequence: latest,
        lastReadMessageSequence: alreadyRead
      };
    }
    const timestamp = new Date().toISOString();
    this.db.run(`
      INSERT INTO session_read_receipts (
        session_id, last_read_agent_message_sequence, updated_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_read_agent_message_sequence = MAX(
          session_read_receipts.last_read_agent_message_sequence,
          excluded.last_read_agent_message_sequence
        ),
        updated_at = CASE
          WHEN excluded.last_read_agent_message_sequence > session_read_receipts.last_read_agent_message_sequence
          THEN excluded.updated_at ELSE session_read_receipts.updated_at END
    `, [sessionId, through, timestamp]);
    this.scheduleSave();
    return this.listSessionMessageCursors().get(sessionId);
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

  // ===== Agent（设计：通用角色化执行主体，role ∈ {independentContributor, assistant}）=====

  listAgents() {
    return this.selectAll(`SELECT * FROM agents ORDER BY created_at ASC`).map(agentFromRow);
  }

  getAgent(agentId) {
    const row = this.selectOne(`SELECT * FROM agents WHERE agent_id = ?`, [agentId]);
    return row ? agentFromRow(row) : null;
  }

  // 预种并自愈固定 id 的平台助手。名称和头像属于用户外观配置；
  // 角色、Prompt、capabilities、Workspace 和 Skill 则以代码 manifest 为权威来源。
  ensureAssistantAgent() {
    // 迁移：修正历史遗留的平台助手旧名（仅限 "Copilot" 等已知旧值），幂等。
    // 注意：不能对任意非 "Corptie" 名称做统一改写，否则会覆盖用户对助手的合法重命名。
    this.db.run(
      `UPDATE agents SET name = ? WHERE agent_id = ? AND name IN ('Copilot')`,
      [PLATFORM_ASSISTANT_MANIFEST.defaultName, PLATFORM_ASSISTANT_ID]
    );
    const existing = this.selectOne(`SELECT * FROM agents WHERE agent_id = ?`, [PLATFORM_ASSISTANT_ID]);
    const defaultDir = resolveAgentWorkDir({ agentId: PLATFORM_ASSISTANT_ID, role: "assistant" }, { environmentName });
    if (existing) {
      this.db.run(
        `UPDATE agents SET
           agent_kind = ?, description = ?, role = ?, status = 'available',
           capabilities_json = ?, system_prompt = ?, work_dir = ?
         WHERE agent_id = ?`,
        [
          AGENT_KIND.PLATFORM_ASSISTANT,
          PLATFORM_ASSISTANT_MANIFEST.description,
          PLATFORM_ASSISTANT_MANIFEST.role,
          JSON.stringify(PLATFORM_ASSISTANT_MANIFEST.capabilities),
          PLATFORM_ASSISTANT_MANIFEST.systemPrompt,
          defaultDir,
          PLATFORM_ASSISTANT_ID
        ]
      );
      this.db.run("DELETE FROM agent_skill_links WHERE agent_id = ?", [PLATFORM_ASSISTANT_ID]);
      return this.getAgent(PLATFORM_ASSISTANT_ID);
    }
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO agents (agent_id, agent_kind, name, description, role, status, capabilities_json, system_prompt, work_dir, current_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        PLATFORM_ASSISTANT_ID,
        AGENT_KIND.PLATFORM_ASSISTANT,
        PLATFORM_ASSISTANT_MANIFEST.defaultName,
        PLATFORM_ASSISTANT_MANIFEST.description,
        PLATFORM_ASSISTANT_MANIFEST.role,
        "available",
        JSON.stringify(PLATFORM_ASSISTANT_MANIFEST.capabilities),
        PLATFORM_ASSISTANT_MANIFEST.systemPrompt,
        defaultDir,
        null,
        now,
        now
      ]
    );
    this.scheduleSave();
    return this.getAgent(PLATFORM_ASSISTANT_ID);
  }

  // 旧版本把所有 Assistant 指向同一路径。升级时保留第一个占用者的目录，
  // 其余冲突者切换到各自的默认目录；不复制共享目录内容，避免把一个助手的
  // 历史文件继续扩散给其他助手。旧目录本身不会被删除。
  migrateAssistantWorkDirs() {
    const assistants = this.selectAll(
      `SELECT * FROM agents WHERE role = 'assistant' ORDER BY created_at ASC, agent_id ASC`
    );
    const defaults = new Map(assistants.map((row) => [
      row.agent_id,
      resolveAgentWorkDir({ agentId: row.agent_id, role: "assistant" }, { environmentName })
    ]));
    const reservedDefaults = new Map(
      Array.from(defaults, ([agentId, path]) => [path.toLowerCase(), agentId])
    );
    const claimed = new Set();

    for (const row of assistants) {
      const configured = typeof row.work_dir === "string" && row.work_dir.trim()
        ? resolve(row.work_dir.trim())
        : defaults.get(row.agent_id);
      const configuredKey = configured.toLowerCase();
      const reservedFor = reservedDefaults.get(configuredKey);
      const target = claimed.has(configuredKey) || (reservedFor && reservedFor !== row.agent_id)
        ? defaults.get(row.agent_id)
        : configured;
      const targetKey = target.toLowerCase();
      if (claimed.has(targetKey)) {
        throw new Error(`Unable to isolate workspace for Assistant ${row.agent_id}.`);
      }
      claimed.add(targetKey);
      if (row.work_dir !== target) {
        this.db.run(
          `UPDATE agents SET work_dir = ?, updated_at = ? WHERE agent_id = ?`,
          [target, createdAtFromOrNow(), row.agent_id]
        );
      }
    }
  }

  // Agent 是可复用的执行配置，不以 Session 是否存在、运行或结束作为生命周期。
  // 旧版可能把 busy/offline/inactive 写入持久化状态，甚至在 current_session_id
  // 仍指向已完成 Session 时遗留 inactive。新迁移无条件清理这些历史值；
  // 真正的不可用由运行时诊断动态呈现，不写回该列。
  migrateAgentAvailability() {
    const migrationId = "agent-always-available-v1";
    if (this.selectOne("SELECT migration_id FROM data_migrations WHERE migration_id = ?", [migrationId])) {
      return [];
    }
    const affected = this.selectAll(
      `SELECT agent_id FROM agents WHERE status <> 'available'`
    ).map((row) => row.agent_id);
    const appliedAt = createdAtFromOrNow();
    this.db.run("BEGIN IMMEDIATE");
    try {
      if (affected.length > 0) {
        const placeholders = affected.map(() => "?").join(",");
        this.db.run(
          `UPDATE agents SET status = 'available', updated_at = ?
           WHERE agent_id IN (${placeholders})`,
          [appliedAt, ...affected]
        );
      }
      this.db.run(
        "INSERT INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
        [migrationId, appliedAt]
      );
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    return affected;
  }

  // 创建 Agent（role 默认 independentContributor）。
  // work_dir：显式指定则用显式值；否则按角色和 agentId 生成隔离的默认目录。
  // 目录物理创建由启动期 / 会话创建期的 ensureAgentWorkDir 完成（store 仅存路径元数据）。
  createAgent(input = {}) {
    const id = input.id ?? `agent:${randomUUID()}`;
    const role = input.role === "assistant" ? "assistant" : "independentContributor";
    const workDir = typeof input.workDir === "string" && input.workDir.trim()
      ? resolve(input.workDir.trim())
      : resolveAgentWorkDir({ agentId: id, role }, { environmentName });
    if (role === "assistant") this.assertAssistantWorkDirAvailable(workDir);
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO agents (agent_id, agent_kind, name, description, role, status, capabilities_json, system_prompt, work_dir, avatar_path, current_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        AGENT_KIND.USER,
        input.name,
        input.description ?? "",
        role,
        "available",
        JSON.stringify(input.capabilities ?? []),
        input.systemPrompt ?? "",
        workDir,
        typeof input.avatarPath === "string" && input.avatarPath.trim() ? input.avatarPath.trim() : null,
        input.currentSessionId ?? null,
        now,
        now
      ]
    );
    this.scheduleSave();
    return this.getAgent(id);
  }

  // 更新 Agent 资源包（name/description/systemPrompt/capabilities/workDir）。
  // status 是旧版兼容列，不再是可编辑字段；Agent 持久化状态恒为 available。
  // 强约束：role 在创建后不可变更（assistant ↔ independentContributor 定型后不可切换），
  // 因此这里忽略任何传入的 role，始终沿用 existing.role。
  updateAgent(agentId, input = {}) {
    const existing = this.getAgent(agentId);
    if (!existing) return null;
    if (isPlatformAssistant(existing)) assertPlatformAssistantPatch(input);
    const now = createdAtFromOrNow();
    const role = existing.role;
    const workDir = typeof input.workDir === "string" && input.workDir.trim()
      ? resolve(input.workDir.trim())
      : existing.workDir;
    if (role === "assistant") this.assertAssistantWorkDirAvailable(workDir, agentId);
    // avatarPath 需区分「未传」与「显式置空」：传入 null / 空串表示清除头像，
    // 未传（不含该键）则保持原值。其余字段沿用 ?? 回退。
    const avatarPath = Object.prototype.hasOwnProperty.call(input, "avatarPath")
      ? (typeof input.avatarPath === "string" && input.avatarPath.trim() ? input.avatarPath.trim() : null)
      : existing.avatarPath;
    this.db.run(
      `UPDATE agents SET name = ?, description = ?, role = ?, status = ?, system_prompt = ?, capabilities_json = ?, work_dir = ?, avatar_path = ?, updated_at = ? WHERE agent_id = ?`,
      [
        input.name ?? existing.name,
        input.description ?? existing.description,
        role,
        "available",
        input.systemPrompt ?? existing.systemPrompt ?? "",
        input.capabilities != null ? JSON.stringify(input.capabilities) : JSON.stringify(existing.capabilities ?? []),
        workDir,
        avatarPath,
        now,
        agentId
      ]
    );
    this.scheduleSave();
    return this.getAgent(agentId);
  }

  assertAssistantWorkDirAvailable(workDir, excludingAgentId = null) {
    const existing = this.selectOne(
      `SELECT agent_id FROM agents
       WHERE role = 'assistant' AND work_dir = ? COLLATE NOCASE
         AND (? IS NULL OR agent_id <> ?)
       LIMIT 1`,
      [resolve(workDir), excludingAgentId, excludingAgentId]
    );
    if (!existing) return;
    const error = new Error("每个 Assistant 必须使用独立的 Workspace，该目录已被另一个 Assistant 占用。");
    error.code = "ASSISTANT_WORKSPACE_CONFLICT";
    throw error;
  }

  // 删除 Agent：有活跃（running）session 时抛错阻止；无则解绑保留历史 session（agent_sessions 级联删除）
  deleteAgent(agentId) {
    if (isPlatformAssistant(agentId)) {
      throw platformAssistantProtectionError("The built-in Corptie Assistant cannot be deleted.");
    }
    const sessionIds = this.selectAll(
      `SELECT session_id FROM agent_sessions WHERE agent_id = ? AND unbound_at IS NULL`,
      [agentId]
    ).map((row) => row.session_id);
    if (sessionIds.length > 0) {
      const placeholders = sessionIds.map(() => "?").join(",");
      const active = this.selectOne(
        `SELECT COUNT(*) AS count FROM sessions WHERE id IN (${placeholders}) AND status = 'running'`,
        sessionIds
      );
      if (active && active.count > 0) {
        const error = new Error("Agent has running sessions; stop them before deleting.");
        error.code = "AGENT_HAS_RUNNING_SESSIONS";
        throw error;
      }
    }
    this.db.run(`DELETE FROM agents WHERE agent_id = ?`, [agentId]);
    this.scheduleSave();
    return true;
  }

  // ===== 实体层：Objective / WorkItem / 依赖 DAG（15 Phase 1，净新增）=====

  auditObjectiveWorkItemAssociations(options = {}) {
    const migrate = options.migrate !== false;
    const auditedAt = createdAtFromOrNow();
    this.runInTransaction(() => {
      // Unresolved rows describe the current state and are recomputed. Migrated rows are retained as an audit trail.
      this.db.run("DELETE FROM objective_work_item_association_audit WHERE status = 'unresolved'");

      const objectives = this.selectAll(
        `SELECT id, workspace_ids_json, related_objective_ids_json, contributor_agent_ids_json
         FROM objectives ORDER BY id ASC`
      );
      for (const row of objectives) {
        let workspaceIds;
        try {
          workspaceIds = JSON.parse(row.workspace_ids_json ?? "[]");
        } catch {
          workspaceIds = null;
        }
        if (!Array.isArray(workspaceIds)) {
          this.recordAssociationAudit({
            entityType: "objective", entityId: row.id, field: "workspaceIds",
            receivedValue: row.workspace_ids_json, status: "unresolved", reason: "invalid_json_type", auditedAt
          });
          continue;
        }

        let changed = false;
        const migratedWorkspaceIds = [];
        for (const workspaceId of workspaceIds) {
          if (typeof workspaceId !== "string") {
            this.recordAssociationAudit({
              entityType: "objective", entityId: row.id, field: "workspaceIds",
              receivedValue: workspaceId, status: "unresolved", reason: "invalid_id_type", auditedAt
            });
            migratedWorkspaceIds.push(workspaceId);
            continue;
          }
          if (workspaceId.startsWith("worktree:")) {
            const worktree = this.getGitWorktree(workspaceId);
            if (worktree?.repositoryId && this.getGitRepository(worktree.repositoryId)) {
              migratedWorkspaceIds.push(worktree.repositoryId);
              changed = true;
              this.recordAssociationAudit({
                entityType: "objective", entityId: row.id, field: "workspaceIds",
                receivedValue: workspaceId, status: "migrated", reason: "worktree_resolved",
                migratedValue: worktree.repositoryId, auditedAt
              });
            } else {
              migratedWorkspaceIds.push(workspaceId);
              this.recordAssociationAudit({
                entityType: "objective", entityId: row.id, field: "workspaceIds",
                receivedValue: workspaceId, status: "unresolved", reason: "worktree_not_registered", auditedAt
              });
            }
            continue;
          }
          migratedWorkspaceIds.push(workspaceId);
          if (!workspaceId.startsWith("repository:") || !this.getGitRepository(workspaceId)) {
            this.recordAssociationAudit({
              entityType: "objective", entityId: row.id, field: "workspaceIds",
              receivedValue: workspaceId, status: "unresolved", reason: "repository_not_registered", auditedAt
            });
          }
        }
        const deduped = [...new Set(migratedWorkspaceIds)];
        if (migrate && (changed || deduped.length !== workspaceIds.length)) {
          this.db.run(
            "UPDATE objectives SET workspace_ids_json = ?, updated_at = ? WHERE id = ?",
            [JSON.stringify(deduped), auditedAt, row.id]
          );
        }

        for (const [field, rawJson, resourceType] of [
          ["relatedObjectiveIds", row.related_objective_ids_json, "objective"],
          ["contributorAgentIds", row.contributor_agent_ids_json, "agent"]
        ]) {
          let ids;
          try {
            ids = JSON.parse(rawJson ?? "[]");
          } catch {
            ids = null;
          }
          if (!Array.isArray(ids)) {
            this.recordAssociationAudit({
              entityType: "objective", entityId: row.id, field,
              receivedValue: rawJson, status: "unresolved", reason: "invalid_json_type", auditedAt
            });
            continue;
          }
          for (const id of ids) {
            if (typeof id !== "string" || !id.trim()) {
              this.recordAssociationAudit({
                entityType: "objective", entityId: row.id, field,
                receivedValue: id, status: "unresolved", reason: "invalid_id_type", auditedAt
              });
              continue;
            }
            const resource = resourceType === "objective" ? this.getObjective(id) : this.getAgent(id);
            const assignable = resourceType !== "agent" || resource?.role === "independentContributor";
            if (!resource || !assignable || (resourceType === "objective" && id === row.id)) {
              this.recordAssociationAudit({
                entityType: "objective", entityId: row.id, field,
                receivedValue: id, status: "unresolved",
                reason: !resource ? `${resourceType}_not_found` : resourceType === "agent" ? "agent_not_assignable" : "self_relation",
                auditedAt
              });
            }
          }
        }
      }

      const workItems = this.selectAll(
        `SELECT id, objective_id, main_workspace_id, main_agent_id FROM work_items ORDER BY id ASC`
      );
      for (const row of workItems) {
        const objective = this.getObjective(row.objective_id);
        if (!objective) {
          this.recordAssociationAudit({
            entityType: "workItem", entityId: row.id, field: "objectiveId",
            receivedValue: row.objective_id, status: "unresolved", reason: "objective_not_found", auditedAt
          });
          continue;
        }

        const workspaceId = row.main_workspace_id;
        if (workspaceId?.startsWith("worktree:")) {
          const worktree = this.getGitWorktree(workspaceId);
          const repositoryId = worktree?.repositoryId;
          if (repositoryId && this.getGitRepository(repositoryId) && objective.workspaceIds.includes(repositoryId)) {
            if (migrate) {
              this.db.run(
                "UPDATE work_items SET main_workspace_id = ?, updated_at = ? WHERE id = ?",
                [repositoryId, auditedAt, row.id]
              );
            }
            this.recordAssociationAudit({
              entityType: "workItem", entityId: row.id, field: "mainWorkspaceId",
              receivedValue: workspaceId, status: "migrated", reason: "worktree_resolved_in_objective_scope",
              migratedValue: repositoryId, auditedAt
            });
          } else {
            this.recordAssociationAudit({
              entityType: "workItem", entityId: row.id, field: "mainWorkspaceId",
              receivedValue: workspaceId, status: "unresolved",
              reason: repositoryId ? "repository_outside_objective_scope" : "worktree_not_registered", auditedAt
            });
          }
        } else if (workspaceId && (
          !workspaceId.startsWith("repository:") || !this.getGitRepository(workspaceId) || !objective.workspaceIds.includes(workspaceId)
        )) {
          this.recordAssociationAudit({
            entityType: "workItem", entityId: row.id, field: "mainWorkspaceId",
            receivedValue: workspaceId, status: "unresolved", reason: "repository_invalid_or_outside_objective_scope", auditedAt
          });
        }

        if (row.main_agent_id) {
          const agent = this.getAgent(row.main_agent_id);
          const valid = agent?.role === "independentContributor"
            && objective.contributorAgentIds.includes(row.main_agent_id);
          if (!valid) {
            this.recordAssociationAudit({
              entityType: "workItem", entityId: row.id, field: "mainAgentId",
              receivedValue: row.main_agent_id, status: "unresolved",
              reason: !agent ? "agent_not_found" : agent.role !== "independentContributor"
                ? "agent_not_assignable" : "agent_outside_objective_scope",
              auditedAt
            });
          }
        }
      }
    });
    return this.listObjectiveWorkItemAssociationAudit();
  }

  recordAssociationAudit(input) {
    const receivedValue = input.receivedValue == null
      ? null
      : typeof input.receivedValue === "string" ? input.receivedValue : JSON.stringify(input.receivedValue);
    const auditId = [input.entityType, input.entityId, input.field, receivedValue ?? "<null>"].join("|");
    this.db.run(
      `INSERT INTO objective_work_item_association_audit (
         audit_id, entity_type, entity_id, field, received_value, status, reason,
         migrated_value, first_audited_at, last_audited_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(audit_id) DO UPDATE SET
         status=excluded.status,
         reason=excluded.reason,
         migrated_value=excluded.migrated_value,
         last_audited_at=excluded.last_audited_at`,
      [
        auditId, input.entityType, input.entityId, input.field, receivedValue,
        input.status, input.reason, input.migratedValue ?? null, input.auditedAt, input.auditedAt
      ]
    );
  }

  listObjectiveWorkItemAssociationAudit(options = {}) {
    const rows = options.status
      ? this.selectAll(
        `SELECT * FROM objective_work_item_association_audit WHERE status = ?
         ORDER BY entity_type, entity_id, field, received_value`,
        [options.status]
      )
      : this.selectAll(
        `SELECT * FROM objective_work_item_association_audit
         ORDER BY status, entity_type, entity_id, field, received_value`
      );
    return rows.map((row) => ({
      auditId: row.audit_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      field: row.field,
      receivedValue: row.received_value,
      status: row.status,
      reason: row.reason,
      migratedValue: row.migrated_value,
      firstAuditedAt: row.first_audited_at,
      lastAuditedAt: row.last_audited_at
    }));
  }

  createObjective(input = {}) {
    const normalized = validateObjectiveInput(input, "create");
    const id = normalized.id ?? `objective:${randomUUID()}`;
    this.assertObjectiveAssociations(normalized, { objectiveId: id });
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO objectives (id, name, description, ideal_state, status, budget_config, priority, target_date, tags_json, workspace_ids_json, related_objective_ids_json, contributor_agent_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        normalized.name,
        normalized.description ?? "",
        normalized.idealState ?? "",
        normalized.status ?? "active",
        JSON.stringify(normalized.budgetConfig ?? {}),
        normalized.priority ?? null,
        normalized.targetDate ?? null,
        JSON.stringify(normalized.tags ?? []),
        JSON.stringify(normalized.workspaceIds ?? []),
        JSON.stringify(normalized.relatedObjectiveIds ?? []),
        JSON.stringify(normalized.contributorAgentIds ?? []),
        now,
        now,
      ]
    );
    this.scheduleSave();
    return this.getObjective(id);
  }

  listObjectives() {
    return this.selectAll(`SELECT * FROM objectives ORDER BY created_at DESC`).map(objectiveFromRow);
  }

  getObjective(id) {
    const row = this.selectOne(`SELECT * FROM objectives WHERE id = ?`, [id]);
    return row ? objectiveFromRow(row) : null;
  }

  updateObjective(id, patch = {}) {
    const current = this.getObjective(id);
    if (!current) return null;
    const normalized = validateObjectiveInput(patch, "update");
    const prospective = { ...current, ...normalized };
    this.assertObjectiveAssociations(prospective, { objectiveId: id, validateWorkItemScope: true });
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE objectives SET name=?, description=?, ideal_state=?, status=?, budget_config=?, priority=?, target_date=?, tags_json=?, workspace_ids_json=?, related_objective_ids_json=?, contributor_agent_ids_json=?, updated_at=? WHERE id=?`,
      [
        has("name") ? normalized.name : current.name,
        has("description") ? normalized.description : current.description,
        has("idealState") ? normalized.idealState : current.idealState,
        has("status") ? normalized.status : current.status,
        has("budgetConfig") ? JSON.stringify(normalized.budgetConfig) : JSON.stringify(current.budgetConfig ?? {}),
        has("priority") ? normalized.priority : current.priority,
        has("targetDate") ? normalized.targetDate : current.targetDate,
        has("tags") ? JSON.stringify(normalized.tags) : JSON.stringify(current.tags ?? []),
        has("workspaceIds") ? JSON.stringify(normalized.workspaceIds) : JSON.stringify(current.workspaceIds ?? []),
        has("relatedObjectiveIds") ? JSON.stringify(normalized.relatedObjectiveIds) : JSON.stringify(current.relatedObjectiveIds ?? []),
        has("contributorAgentIds") ? JSON.stringify(normalized.contributorAgentIds) : JSON.stringify(current.contributorAgentIds ?? []),
        createdAtFromOrNow(),
        id,
      ]
    );
    this.scheduleSave();
    return this.getObjective(id);
  }

  deleteObjective(id) {
    this.db.run(`DELETE FROM objectives WHERE id = ?`, [id]);
    this.scheduleSave();
  }

  createWorkItem(input = {}) {
    const normalized = validateWorkItemInput(input, "create");
    const objective = this.getObjective(normalized.objectiveId);
    if (!objective) {
      throw associationError(
        "OBJECTIVE_NOT_FOUND", "objectiveId", "existing Objective ID", normalized.objectiveId,
        `Objective not found: ${normalized.objectiveId}`
      );
    }
    this.assertWorkItemAssociations(normalized, objective);
    const id = normalized.id ?? `work_item:${randomUUID()}`;
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO work_items (id, objective_id, title, description, acceptance_criteria, priority, status, main_workspace_id, main_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        normalized.objectiveId,
        normalized.title,
        normalized.description ?? "",
        normalized.acceptanceCriteria ?? "",
        normalized.priority ?? "medium",
        normalized.status ?? "todo",
        normalized.mainWorkspaceId ?? null,
        normalized.mainAgentId ?? null,
        now,
        now,
      ]
    );
    this.scheduleSave();
    return this.getWorkItem(id);
  }

  listWorkItems() {
    return this.selectAll(`SELECT * FROM work_items ORDER BY created_at ASC`);
  }

  listWorkItemsByObjective(objectiveId) {
    return this.selectAll(
      `SELECT * FROM work_items WHERE objective_id = ? ORDER BY created_at ASC`,
      [objectiveId]
    );
  }

  createArtifactMetadata(input) {
    this.db.run(
      `INSERT INTO artifacts (
         artifact_id, objective_id, title, summary, visibility, bound_work_item_id,
         bound_session_id, repository_locator, source_session_id, source_event_id,
         created_by_actor_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.artifactId, input.objectiveId, input.title, input.summary ?? "", input.visibility,
        input.boundWorkItemId ?? null, input.boundSessionId ?? null, input.repositoryLocator ?? null,
        input.sourceSessionId ?? null, input.sourceEventId ?? null, input.actorId,
        input.createdAt, input.createdAt
      ]
    );
    return this.getArtifact(input.artifactId);
  }

  getArtifact(artifactId) {
    const row = this.selectOne(`SELECT * FROM artifacts WHERE artifact_id = ?`, [artifactId]);
    return row ? artifactFromRow(row) : null;
  }

  listArtifactsByObjective(objectiveId, { includeRevoked = false } = {}) {
    return this.selectAll(
      `SELECT * FROM artifacts WHERE objective_id = ? ${includeRevoked ? "" : "AND status <> 'revoked'"}
       ORDER BY updated_at DESC, artifact_id`,
      [objectiveId]
    ).map(artifactFromRow);
  }

  updateArtifact(artifactId, patch = {}) {
    const current = this.getArtifact(artifactId);
    if (!current) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE artifacts SET title=?, summary=?, visibility=?, bound_work_item_id=?, bound_session_id=?,
       repository_locator=?, current_version=?, approved_version=?, status=?, updated_at=?,
       resource_version=resource_version+1 WHERE artifact_id=?`,
      [
        has("title") ? patch.title : current.title,
        has("summary") ? patch.summary : current.summary,
        has("visibility") ? patch.visibility : current.visibility,
        has("boundWorkItemId") ? patch.boundWorkItemId : current.boundWorkItemId,
        has("boundSessionId") ? patch.boundSessionId : current.boundSessionId,
        has("repositoryLocator") ? patch.repositoryLocator : current.repositoryLocator,
        has("currentVersion") ? patch.currentVersion : current.currentVersion,
        has("approvedVersion") ? patch.approvedVersion : current.approvedVersion,
        has("status") ? patch.status : current.status,
        patch.updatedAt ?? createdAtFromOrNow(), artifactId
      ]
    );
    return this.getArtifact(artifactId);
  }

  createArtifactVersion(input) {
    this.db.run(
      `INSERT INTO artifact_versions (
         artifact_id, version, content_hash, byte_length, mime_type, storage_key,
         source_session_id, source_event_id, supersedes_version, approval_status,
         created_by_actor_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.artifactId, input.version, input.contentHash, input.byteLength, input.mimeType,
        input.storageKey ?? null, input.sourceSessionId ?? null, input.sourceEventId ?? null,
        input.supersedesVersion ?? null, input.approvalStatus, input.actorId, input.createdAt
      ]
    );
    return this.getArtifactVersion(input.artifactId, input.version);
  }

  getArtifactVersion(artifactId, version) {
    const row = this.selectOne(
      `SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?`,
      [artifactId, version]
    );
    return row ? artifactVersionFromRow(row) : null;
  }

  listArtifactVersions(artifactId) {
    return this.selectAll(
      `SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC`,
      [artifactId]
    ).map(artifactVersionFromRow);
  }

  createArtifactReference(input) {
    this.db.run(
      `INSERT INTO artifact_references (
         reference_id, artifact_id, objective_id, work_item_id, session_id, relation, required,
         version_policy, pinned_version, pinned_hash, authorized_by_actor_id, authorized_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.referenceId, input.artifactId, input.objectiveId, input.workItemId ?? null,
        input.sessionId ?? null, input.relation, input.required, input.versionPolicy,
        input.pinnedVersion, input.pinnedHash, input.actorId, input.authorizedAt
      ]
    );
    return this.getArtifactReference(input.referenceId);
  }

  getArtifactReference(referenceId) {
    const row = this.selectOne(`SELECT * FROM artifact_references WHERE reference_id = ?`, [referenceId]);
    return row ? artifactReferenceFromRow(row) : null;
  }

  listArtifactReferences({ artifactId = null, workItemId = null, sessionId = null, includeRevoked = false } = {}) {
    const clauses = [];
    const params = [];
    if (artifactId) { clauses.push("artifact_id = ?"); params.push(artifactId); }
    if (workItemId) { clauses.push("work_item_id = ?"); params.push(workItemId); }
    if (sessionId) { clauses.push("session_id = ?"); params.push(sessionId); }
    if (!includeRevoked) clauses.push("revoked_at IS NULL");
    return this.selectAll(
      `SELECT * FROM artifact_references ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY required DESC, authorized_at DESC`,
      params
    ).map(artifactReferenceFromRow);
  }

  updateArtifactReference(referenceId, patch = {}) {
    const current = this.getArtifactReference(referenceId);
    if (!current) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE artifact_references SET pinned_version=?, pinned_hash=?, pending_version=?, pending_hash=?,
       revoked_at=?, revoked_by_actor_id=?, revocation_reason=?, resource_version=resource_version+1
       WHERE reference_id=?`,
      [
        has("pinnedVersion") ? patch.pinnedVersion : current.pinnedVersion,
        has("pinnedHash") ? patch.pinnedHash : current.pinnedHash,
        has("pendingVersion") ? patch.pendingVersion : current.pendingVersion,
        has("pendingHash") ? patch.pendingHash : current.pendingHash,
        has("revokedAt") ? patch.revokedAt : current.revokedAt,
        has("revokedByActorId") ? patch.revokedByActorId : current.revokedByActorId,
        has("revocationReason") ? patch.revocationReason : current.revocationReason,
        referenceId
      ]
    );
    return this.getArtifactReference(referenceId);
  }

  appendArtifactAudit(input) {
    this.db.run(
      `INSERT INTO artifact_audit_events (
         audit_id, artifact_id, objective_id, action, actor_id, session_id, work_item_id,
         from_version, to_version, details_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.auditId, input.artifactId ?? null, input.objectiveId, input.action, input.actorId,
        input.sessionId ?? null, input.workItemId ?? null, input.fromVersion ?? null,
        input.toVersion ?? null, JSON.stringify(input.details ?? {}), input.createdAt
      ]
    );
  }

  listArtifactAudit(objectiveId, artifactId = null) {
    return this.selectAll(
      `SELECT * FROM artifact_audit_events WHERE objective_id = ? ${artifactId ? "AND artifact_id = ?" : ""}
       ORDER BY created_at DESC`,
      artifactId ? [objectiveId, artifactId] : [objectiveId]
    ).map(artifactAuditFromRow);
  }

  createArtifactContentOperation(input) {
    this.db.run(
      `INSERT INTO artifact_content_operations (
         operation_id, artifact_id, version, content_hash, temp_path, final_path, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      [input.operationId, input.artifactId, input.version, input.contentHash, input.tempPath,
        input.finalPath, input.createdAt, input.createdAt]
    );
  }

  updateArtifactContentOperation(operationId, status, errorCode = null) {
    this.db.run(
      `UPDATE artifact_content_operations SET status=?, error_code=?, updated_at=? WHERE operation_id=?`,
      [status, errorCode, createdAtFromOrNow(), operationId]
    );
  }

  listIncompleteArtifactContentOperations() {
    return this.selectAll(
      `SELECT * FROM artifact_content_operations WHERE status IN ('prepared', 'file_committed') ORDER BY created_at`
    );
  }

  recordArtifactUsage(input) {
    this.db.run(
      `INSERT INTO artifact_usage_events (
         usage_id, artifact_id, version, content_hash, actor_id, session_id, work_item_id,
         operation, byte_offset, byte_length, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.usageId, input.artifactId, input.version, input.contentHash, input.actorId,
        input.sessionId, input.workItemId ?? null, input.operation, input.byteOffset ?? 0,
        input.byteLength ?? 0, input.createdAt]
    );
  }

  appendArtifactStorageAudit(input) {
    this.db.run(
      `INSERT OR IGNORE INTO artifact_storage_audit_events (
         audit_id, action, storage_key, content_hash, byte_length, details_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.auditId, input.action, input.storageKey, input.contentHash, input.byteLength,
        JSON.stringify(input.details ?? {}), input.createdAt]
    );
  }

  listArtifactStorageAudit() {
    return this.selectAll(
      `SELECT * FROM artifact_storage_audit_events ORDER BY created_at DESC`
    ).map((row) => ({
      auditId: row.audit_id,
      action: row.action,
      storageKey: row.storage_key,
      contentHash: row.content_hash,
      byteLength: Number(row.byte_length),
      details: parseJson(row.details_json, {}),
      createdAt: row.created_at
    }));
  }

  createProjectIntegrationRun(input) {
    const id = input.id ?? `integration:${randomUUID()}`;
    const timestamp = createdAtFromOrNow();
    this.runInTransaction(() => {
      this.db.run(
        `INSERT INTO project_integration_runs (
           id, repository_id, objective_id, status, main_head_before,
           main_head_after, error, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
        [id, input.repositoryId, input.objectiveId, input.status ?? "running", input.mainHeadBefore, timestamp, timestamp]
      );
      for (const [index, item] of (input.items ?? []).entries()) {
        this.db.run(
          `INSERT INTO project_integration_items (
             run_id, worktree_id, work_item_id, branch_name, source_head_oid,
             ordinal, status, conflict_files_json, merged_main_head, error, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', NULL, NULL, ?)`,
          [
            id,
            item.worktreeId,
            item.workItemId,
            item.branchName ?? null,
            item.sourceHeadOid,
            item.ordinal ?? index,
            item.status ?? "pending",
            timestamp
          ]
        );
      }
    });
    this.scheduleSave();
    return this.getProjectIntegrationRun(id);
  }

  getProjectIntegrationRun(id) {
    const row = this.selectOne(`SELECT * FROM project_integration_runs WHERE id = ?`, [id]);
    if (!row) return null;
    const items = this.selectAll(
      `SELECT * FROM project_integration_items WHERE run_id = ? ORDER BY ordinal ASC`,
      [id]
    ).map(projectIntegrationItemFromRow);
    return projectIntegrationRunFromRow(row, items);
  }

  listProjectIntegrationRuns() {
    return this.selectAll(
      `SELECT id FROM project_integration_runs ORDER BY created_at ASC`
    ).map((row) => this.getProjectIntegrationRun(row.id));
  }

  getLatestProjectIntegrationRun(repositoryId, objectiveId) {
    const row = this.selectOne(
      `SELECT * FROM project_integration_runs
       WHERE repository_id = ? AND objective_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [repositoryId, objectiveId]
    );
    return row ? this.getProjectIntegrationRun(row.id) : null;
  }

  updateProjectIntegrationRun(id, patch = {}) {
    const current = this.getProjectIntegrationRun(id);
    if (!current) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE project_integration_runs SET
         status=?, main_head_after=?, integration_worktree_id=?, integration_worktree_path=?,
         integration_branch=?, conflict_work_item_id=?, conflict_session_id=?, error=?,
         updated_at=?, completed_at=? WHERE id=?`,
      [
        has("status") ? patch.status : current.status,
        has("mainHeadAfter") ? patch.mainHeadAfter : current.mainHeadAfter,
        has("integrationWorktreeId") ? patch.integrationWorktreeId : current.integrationWorktreeId,
        has("integrationWorktreePath") ? patch.integrationWorktreePath : current.integrationWorktreePath,
        has("integrationBranch") ? patch.integrationBranch : current.integrationBranch,
        has("conflictWorkItemId") ? patch.conflictWorkItemId : current.conflictWorkItemId,
        has("conflictSessionId") ? patch.conflictSessionId : current.conflictSessionId,
        has("error") ? patch.error : current.error,
        createdAtFromOrNow(),
        has("completedAt") ? patch.completedAt : current.completedAt,
        id
      ]
    );
    this.scheduleSave();
    return this.getProjectIntegrationRun(id);
  }

  updateProjectIntegrationItem(runId, worktreeId, patch = {}) {
    const current = this.selectOne(
      `SELECT * FROM project_integration_items WHERE run_id = ? AND worktree_id = ?`,
      [runId, worktreeId]
    );
    if (!current) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE project_integration_items SET
         status=?, conflict_files_json=?, merged_main_head=?, error=?, updated_at=?
       WHERE run_id=? AND worktree_id=?`,
      [
        has("status") ? patch.status : current.status,
        has("conflictFiles") ? JSON.stringify(patch.conflictFiles ?? []) : current.conflict_files_json,
        has("mergedMainHead") ? patch.mergedMainHead : current.merged_main_head,
        has("error") ? patch.error : current.error,
        createdAtFromOrNow(),
        runId,
        worktreeId
      ]
    );
    this.scheduleSave();
    return projectIntegrationItemFromRow(this.selectOne(
      `SELECT * FROM project_integration_items WHERE run_id = ? AND worktree_id = ?`,
      [runId, worktreeId]
    ));
  }

  createWorktreeIntegrationJob(input) {
    const id = input.id ?? `worktree_integration:${randomUUID()}`;
    const timestamp = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO worktree_integration_jobs (
         id, repository_id, status, phase, plan_fingerprint, details_json,
         error, created_at, updated_at, confirmed_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      [
        id,
        requiredText(input.repositoryId, "repositoryId"),
        input.status ?? "awaiting_confirmation",
        input.phase ?? "preflight_complete",
        requiredText(input.planFingerprint, "planFingerprint"),
        JSON.stringify(input.details ?? {}),
        input.error ?? null,
        timestamp,
        timestamp
      ]
    );
    this.scheduleSave();
    return this.getWorktreeIntegrationJob(id);
  }

  getWorktreeIntegrationJob(id) {
    const row = this.selectOne(`SELECT * FROM worktree_integration_jobs WHERE id = ?`, [id]);
    return worktreeIntegrationJobFromRow(row);
  }

  listWorktreeIntegrationJobs(repositoryId = null) {
    const rows = repositoryId
      ? this.selectAll(
          `SELECT * FROM worktree_integration_jobs WHERE repository_id = ? ORDER BY created_at DESC`,
          [repositoryId]
        )
      : this.selectAll(`SELECT * FROM worktree_integration_jobs ORDER BY created_at DESC`);
    return rows.map(worktreeIntegrationJobFromRow);
  }

  getLatestWorktreeIntegrationJob(repositoryId) {
    const row = this.selectOne(
      `SELECT * FROM worktree_integration_jobs WHERE repository_id = ? ORDER BY created_at DESC LIMIT 1`,
      [repositoryId]
    );
    return worktreeIntegrationJobFromRow(row);
  }

  listRecoverableWorktreeIntegrationJobs() {
    return this.selectAll(
      `SELECT * FROM worktree_integration_jobs
       WHERE status IN ('queued', 'running', 'cancellation_requested', 'replanning')
          OR (status = 'paused' AND json_extract(details_json, '$.conflictAutomation.status') = 'running')
       ORDER BY created_at ASC`
    ).map(worktreeIntegrationJobFromRow);
  }

  updateWorktreeIntegrationJob(id, patch = {}) {
    const current = this.getWorktreeIntegrationJob(id);
    if (!current) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE worktree_integration_jobs SET
         status=?, phase=?, details_json=?, error=?, updated_at=?, confirmed_at=?, completed_at=?
       WHERE id=?`,
      [
        has("status") ? patch.status : current.status,
        has("phase") ? patch.phase : current.phase,
        JSON.stringify(has("details") ? patch.details : current.details),
        has("error") ? patch.error : current.error,
        createdAtFromOrNow(),
        has("confirmedAt") ? patch.confirmedAt : current.confirmedAt,
        has("completedAt") ? patch.completedAt : current.completedAt,
        id
      ]
    );
    this.scheduleSave();
    return this.getWorktreeIntegrationJob(id);
  }

  getWorkItem(id) {
    return this.selectOne(`SELECT * FROM work_items WHERE id = ?`, [id]);
  }

  // 按当前活跃 session 反查其绑定的实体 WorkItem（session 落定时推进状态用）。
  getWorkItemBySessionId(sessionId) {
    return this.selectOne(
      `SELECT * FROM work_items WHERE current_session_id = ?`,
      [sessionId]
    );
  }

  updateWorkItem(id, patch = {}) {
    const current = this.getWorkItem(id);
    if (!current) return null;
    const internalPatch = {};
    if (Object.prototype.hasOwnProperty.call(patch, "executionStatus")) {
      internalPatch.executionStatus = patch.executionStatus;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "acceptanceAssessment")) {
      internalPatch.acceptanceAssessment = patch.acceptanceAssessment;
    }
    const publicPatch = Object.fromEntries(
      Object.entries(patch).filter(([key]) => !["executionStatus", "acceptanceAssessment"].includes(key))
    );
    const normalized = validateWorkItemInput(publicPatch, "update");
    const prospective = {
      title: current.title,
      description: current.description,
      acceptanceCriteria: current.acceptance_criteria,
      priority: current.priority,
      status: current.status,
      mainWorkspaceId: current.main_workspace_id,
      mainAgentId: current.main_agent_id,
      ...normalized
    };
    const objective = this.getObjective(current.objective_id);
    if (!objective) {
      throw associationError(
        "OBJECTIVE_NOT_FOUND", "objectiveId", "existing Objective ID", current.objective_id,
        `Objective not found: ${current.objective_id}`
      );
    }
    this.assertWorkItemAssociations(prospective, objective);
    const has = (key) => Object.prototype.hasOwnProperty.call(normalized, key);
    this.db.run(
      `UPDATE work_items SET title=?, description=?, acceptance_criteria=?, priority=?, status=?, main_workspace_id=?, main_agent_id=?, execution_status=?, acceptance_assessment_json=?, resource_version=resource_version+1, updated_at=? WHERE id=?`,
      [
        has("title") ? normalized.title : current.title,
        has("description") ? normalized.description : current.description,
        has("acceptanceCriteria") ? normalized.acceptanceCriteria : current.acceptance_criteria,
        has("priority") ? normalized.priority : current.priority,
        has("status") ? normalized.status : current.status,
        has("mainWorkspaceId") ? normalized.mainWorkspaceId : current.main_workspace_id,
        has("mainAgentId") ? normalized.mainAgentId : current.main_agent_id,
        Object.prototype.hasOwnProperty.call(internalPatch, "executionStatus")
          ? internalPatch.executionStatus
          : (current.execution_status ?? "idle"),
        Object.prototype.hasOwnProperty.call(internalPatch, "acceptanceAssessment")
          ? JSON.stringify(internalPatch.acceptanceAssessment ?? {})
          : (current.acceptance_assessment_json ?? "{}"),
        createdAtFromOrNow(),
        id,
      ]
    );
    this.scheduleSave();
    return this.getWorkItem(id);
  }

  assertObjectiveAssociations(input, options = {}) {
    const objectiveId = options.objectiveId ?? input.id ?? null;
    const workspaceIds = input.workspaceIds ?? [];
    const contributorAgentIds = input.contributorAgentIds ?? [];
    for (const [index, repositoryId] of workspaceIds.entries()) {
      const field = `workspaceIds[${index}]`;
      assertRepositoryId(repositoryId, field);
      if (!this.getGitRepository(repositoryId)) {
        throw associationError(
          "WORKSPACE_NOT_FOUND", field, "registered repository: ID", repositoryId,
          `Repository not found: ${repositoryId}`
        );
      }
    }
    for (const [index, relatedId] of (input.relatedObjectiveIds ?? []).entries()) {
      const field = `relatedObjectiveIds[${index}]`;
      if (relatedId === objectiveId) {
        throw associationError(
          "ASSOCIATION_INTEGRITY_ERROR", field, "another existing Objective ID", relatedId,
          "An Objective cannot relate to itself."
        );
      }
      if (!this.getObjective(relatedId)) {
        throw associationError(
          "OBJECTIVE_NOT_FOUND", field, "existing Objective ID", relatedId,
          `Objective not found: ${relatedId}`
        );
      }
    }
    for (const [index, agentId] of contributorAgentIds.entries()) {
      this.assertAssignableAgent(agentId, `contributorAgentIds[${index}]`);
    }

    if (!options.validateWorkItemScope || !objectiveId) return;
    const workspaceScope = new Set(workspaceIds);
    const agentScope = new Set(contributorAgentIds);
    for (const workItem of this.listWorkItemsByObjective(objectiveId)) {
      if (workItem.main_workspace_id && !workspaceScope.has(workItem.main_workspace_id)) {
        throw associationError(
          "OBJECTIVE_SCOPE_CONFLICT", "workspaceIds", "must include every WorkItem mainWorkspaceId",
          workItem.main_workspace_id,
          `Workspace is still assigned to WorkItem ${workItem.id}.`
        );
      }
      if (workItem.main_agent_id && !agentScope.has(workItem.main_agent_id)) {
        throw associationError(
          "OBJECTIVE_SCOPE_CONFLICT", "contributorAgentIds", "must include every WorkItem mainAgentId",
          workItem.main_agent_id,
          `Agent is still assigned to WorkItem ${workItem.id}.`
        );
      }
    }
  }

  assertWorkItemAssociations(input, objective) {
    if (input.mainWorkspaceId) {
      assertRepositoryId(input.mainWorkspaceId, "mainWorkspaceId");
      if (!this.getGitRepository(input.mainWorkspaceId)) {
        throw associationError(
          "WORKSPACE_NOT_FOUND", "mainWorkspaceId", "registered repository: ID", input.mainWorkspaceId,
          `Repository not found: ${input.mainWorkspaceId}`
        );
      }
      if (!(objective.workspaceIds ?? []).includes(input.mainWorkspaceId)) {
        throw associationError(
          "ASSOCIATION_OUT_OF_SCOPE", "mainWorkspaceId", "repository in owning Objective.workspaceIds",
          input.mainWorkspaceId,
          "WorkItem mainWorkspaceId is outside its Objective workspace scope."
        );
      }
    }
    if (input.mainAgentId) {
      this.assertAssignableAgent(input.mainAgentId, "mainAgentId");
      if (!(objective.contributorAgentIds ?? []).includes(input.mainAgentId)) {
        throw associationError(
          "ASSOCIATION_OUT_OF_SCOPE", "mainAgentId", "Agent in owning Objective.contributorAgentIds",
          input.mainAgentId,
          "WorkItem mainAgentId is outside its Objective contributor scope."
        );
      }
    }
  }

  assertAssignableAgent(agentId, field) {
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw associationError(
        "AGENT_NOT_FOUND", field, "existing assignable Agent ID", agentId,
        `Agent not found: ${agentId}`
      );
    }
    if (agent.role !== "independentContributor" || agent.status !== "available") {
      throw associationError(
        "AGENT_NOT_ASSIGNABLE", field, "available independentContributor Agent ID", agentId,
        `Agent is not assignable: ${agentId}`
      );
    }
    return agent;
  }

  deleteWorkItem(id) {
    this.db.run(`DELETE FROM work_items WHERE id = ?`, [id]);
    this.scheduleSave();
  }

  markWorkItemDeletion(id, status, error = null) {
    this.db.run(
      `UPDATE work_items SET deletion_status=?, deletion_error=?, updated_at=? WHERE id=?`,
      [status, error, createdAtFromOrNow(), id]
    );
    this.scheduleSave();
  }

  markWorkItemWorktreeRemoved(id) {
    const timestamp = createdAtFromOrNow();
    this.db.run(
      `UPDATE work_items SET deletion_status='deleting', deletion_error=NULL,
       deletion_worktree_removed_at=COALESCE(deletion_worktree_removed_at, ?), updated_at=? WHERE id=?`,
      [timestamp, timestamp, id]
    );
    this.scheduleSave();
  }

  finalizeWorkItemDeletion(id) {
    const item = this.getWorkItem(id);
    if (!item) return { alreadyDeleted: true };
    const sessions = this.selectAll("SELECT id FROM sessions WHERE work_item_id=?", [id]);
    const collaborationTasks = this.selectAll(
      "SELECT task_id FROM collaboration_tasks WHERE source_work_item_id=? OR work_item_id=?",
      [id, id]
    );
    this.runInTransaction(() => {
      // Session history is user data, not a disposable WorkItem resource. Keep it
      // archived and detach only the exclusive WorkItem ownership reference.
      this.db.run(
        `UPDATE sessions SET work_item_id=NULL, archived=1, updated_at=? WHERE work_item_id=?`,
        [createdAtFromOrNow(), id]
      );
      // Collaboration records and integration history are shared audit data.
      // Preserve them while removing their live ownership references.
      this.db.run(
        `UPDATE collaboration_messages SET source_work_item_id=NULL WHERE source_work_item_id=?`, [id]
      );
      this.db.run(`UPDATE collaboration_messages SET work_item_id=NULL WHERE work_item_id=?`, [id]);
      this.db.run(`UPDATE collaboration_tasks SET source_work_item_id=NULL WHERE source_work_item_id=?`, [id]);
      this.db.run(`UPDATE collaboration_tasks SET work_item_id=NULL WHERE work_item_id=?`, [id]);
      this.db.run(`UPDATE project_integration_runs SET conflict_work_item_id=NULL WHERE conflict_work_item_id=?`, [id]);
      this.db.run(`DELETE FROM work_items WHERE id=?`, [id]);
    });
    this.scheduleSave();
    return {
      archivedSessionIds: sessions.map((row) => row.id),
      preservedCollaborationTaskIds: collaborationTasks.map((row) => row.task_id)
    };
  }

  addWorkItemDependency(workItemId, targetWorkItemId, type = "depends_on") {
    this.db.run(
      `INSERT OR REPLACE INTO work_item_dependencies (work_item_id, target_work_item_id, type) VALUES (?, ?, ?)`,
      [workItemId, targetWorkItemId, type]
    );
    this.scheduleSave();
  }

  removeWorkItemDependency(workItemId, targetWorkItemId) {
    this.db.run(
      `DELETE FROM work_item_dependencies WHERE work_item_id = ? AND target_work_item_id = ?`,
      [workItemId, targetWorkItemId]
    );
    this.scheduleSave();
  }

  listWorkItemDependencies(workItemId) {
    return this.selectAll(
      `SELECT * FROM work_item_dependencies WHERE work_item_id = ?`,
      [workItemId]
    );
  }

  listWorkItemDependents(targetWorkItemId) {
    return this.selectAll(
      `SELECT * FROM work_item_dependencies WHERE target_work_item_id = ?`,
      [targetWorkItemId]
    );
  }

  // ===== 三层记忆（13：Objective/WorkItem 工作记忆 + Agent 进化记忆）=====

  createMemory(input = {}) {
    const association = this.validateMemoryAssociation(input);
    const id = input.id ?? `memory:${randomUUID()}`;
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO memories (
        id, owner_type, owner_id, work_item_id, kind, content, structured_json, tags_json,
        base_confidence, confidence, recency_score, usage_count, last_accessed_at,
        source_type, source_session_id, source_event_sequence, source_event_seqs_json,
        promotion_status, promoted_skill_id, access_policy, trust_level, expires_at, replaces_memory_id, version,
        auto_applied, applied_at, revoked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.ownerType,
        input.ownerId,
        association.workItemId,
        input.kind,
        input.content,
        JSON.stringify(input.structuredJson ?? {}),
        JSON.stringify(input.tags ?? []),
        input.baseConfidence ?? 0.5,
        input.confidence ?? input.baseConfidence ?? 0.5,
        input.recencyScore ?? 0,
        input.usageCount ?? 0,
        input.lastAccessedAt ?? null,
        input.sourceType ?? "user",
        input.sourceSessionId ?? null,
        input.sourceEventSequence ?? null,
        JSON.stringify(input.sourceEventSeqs ?? []),
        input.promotionStatus ?? "active",
        input.promotedSkillId ?? null,
        JSON.stringify(input.accessPolicy ?? {}),
        input.trustLevel ?? ((input.sourceType ?? "user") === "user" ? "trusted" : "untrusted"),
        input.expiresAt ?? null,
        input.replacesMemoryId ?? null,
        input.version ?? 1,
        input.autoApplied ? 1 : 0,
        input.appliedAt ?? null,
        input.revokedAt ?? null,
        now,
        now
      ]
    );
    this.scheduleSave();
    return this.getMemory(id);
  }

  getMemory(id) {
    return this.selectOne(`SELECT * FROM memories WHERE id = ?`, [id]);
  }

  listMemoriesByOwner(ownerType, ownerId) {
    return this.selectAll(
      `SELECT * FROM memories WHERE owner_type = ? AND owner_id = ? ORDER BY confidence DESC`,
      [ownerType, ownerId]
    );
  }

  getMemoryBySourceEvent({ ownerType, ownerId, sourceSessionId, sourceEventSequence }) {
    return this.selectOne(
      `SELECT * FROM memories
       WHERE owner_type = ? AND owner_id = ? AND source_session_id = ? AND source_event_sequence = ?`,
      [ownerType, ownerId, sourceSessionId, sourceEventSequence]
    );
  }

  validateMemoryAssociation(input = {}) {
    const ownerType = typeof input.ownerType === "string" ? input.ownerType.trim() : "";
    const ownerId = typeof input.ownerId === "string" ? input.ownerId.trim() : "";
    if (!ownerType || !ownerId) {
      throw memoryAssociationError("INVALID_MEMORY_ASSOCIATION", "Memory ownerType and ownerId are required.");
    }
    if (ownerType !== "work_item") {
      if (input.workItemId != null && String(input.workItemId).trim()) {
        throw memoryAssociationError(
          "INVALID_MEMORY_ASSOCIATION",
          "workItemId is only valid for work_item memories."
        );
      }
      return { workItemId: null };
    }
    const workItemId = typeof input.workItemId === "string" && input.workItemId.trim()
      ? input.workItemId.trim()
      : ownerId;
    if (workItemId !== ownerId) {
      throw memoryAssociationError(
        "INVALID_MEMORY_ASSOCIATION",
        "workItemId must match ownerId for work_item memories."
      );
    }
    const workItem = this.getWorkItem(workItemId);
    if (!workItem) {
      throw memoryAssociationError("WORK_ITEM_NOT_FOUND", `WorkItem not found: ${workItemId}`);
    }
    if (!workItem.current_session_id) {
      throw memoryAssociationError(
        "WORK_ITEM_NOT_STARTED",
        "WorkItem memories cannot be created before execution starts."
      );
    }
    const sourceSessionId = typeof input.sourceSessionId === "string" ? input.sourceSessionId.trim() : "";
    const sourceSession = sourceSessionId ? this.getSession(sourceSessionId) : null;
    if (!sourceSession || sourceSession.workItemId !== workItem.id
      || sourceSession.objectiveId !== workItem.objective_id) {
      throw memoryAssociationError(
        "INVALID_MEMORY_SOURCE_SESSION",
        "WorkItem memory requires a bound Worker Session for that WorkItem as its source."
      );
    }
    return { workItemId };
  }

  listMemoriesByKind(kind) {
    return this.selectAll(
      `SELECT * FROM memories WHERE kind = ? ORDER BY confidence DESC`,
      [kind]
    );
  }

  listAllMemories() {
    return this.selectAll(`SELECT * FROM memories ORDER BY updated_at DESC`);
  }

  updateMemory(id, patch = {}) {
    const current = this.getMemory(id);
    if (!current) return null;
    this.db.run(
      `UPDATE memories SET
        content=?, structured_json=?, tags_json=?, confidence=?, recency_score=?,
        usage_count=?, last_accessed_at=?, promotion_status=?, promoted_skill_id=?,
        access_policy=?, trust_level=?, expires_at=?, replaces_memory_id=?, version=?, auto_applied=?, applied_at=?, revoked_at=?, updated_at=?
       WHERE id=?`,
      [
        patch.content ?? current.content,
        JSON.stringify(patch.structuredJson ?? JSON.parse(current.structured_json || "{}")),
        JSON.stringify(patch.tags ?? JSON.parse(current.tags_json || "[]")),
        patch.confidence ?? current.confidence,
        patch.recencyScore ?? current.recency_score,
        patch.usageCount ?? current.usage_count,
        patch.lastAccessedAt ?? current.last_accessed_at,
        patch.promotionStatus ?? current.promotion_status,
        patch.promotedSkillId ?? current.promoted_skill_id,
        JSON.stringify(patch.accessPolicy ?? JSON.parse(current.access_policy || "{}")),
        patch.trustLevel ?? current.trust_level,
        patch.expiresAt !== undefined ? patch.expiresAt : current.expires_at,
        patch.replacesMemoryId !== undefined ? patch.replacesMemoryId : current.replaces_memory_id,
        patch.version ?? current.version,
        patch.autoApplied !== undefined ? (patch.autoApplied ? 1 : 0) : current.auto_applied,
        patch.appliedAt !== undefined ? patch.appliedAt : current.applied_at,
        patch.revokedAt !== undefined ? patch.revokedAt : current.revoked_at,
        createdAtFromOrNow(),
        id
      ]
    );
    this.scheduleSave();
    return this.getMemory(id);
  }

  deleteMemory(id) {
    this.db.run(`DELETE FROM memories WHERE id = ?`, [id]);
    this.scheduleSave();
  }

  createMemoryAudit(input = {}) {
    const id = input.id ?? `memory-audit:${randomUUID()}`;
    this.db.run(
      `INSERT INTO memory_audit (
        id, memory_id, action, actor_type, actor_id, reason,
        before_json, after_json, rollback_of, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.memoryId ?? null, input.action, input.actorType ?? "system", input.actorId ?? null,
        input.reason ?? null, input.before ? JSON.stringify(input.before) : null,
        input.after ? JSON.stringify(input.after) : null, input.rollbackOf ?? null, createdAtFromOrNow()]
    );
    this.scheduleSave();
    return this.getMemoryAudit(id);
  }

  getMemoryAudit(id) {
    return presentMemoryAudit(this.selectOne(`SELECT * FROM memory_audit WHERE id = ?`, [id]));
  }

  listMemoryAudit({ memoryId = null, limit = 200 } = {}) {
    const rows = memoryId
      ? this.selectAll(`SELECT * FROM memory_audit WHERE memory_id = ? ORDER BY created_at DESC LIMIT ?`, [memoryId, limit])
      : this.selectAll(`SELECT * FROM memory_audit ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows.map(presentMemoryAudit);
  }

  rollbackMemoryAudit(auditId, actorId = null) {
    const audit = this.getMemoryAudit(auditId);
    if (!audit?.memoryId || !audit.before) return null;
    const current = this.getMemory(audit.memoryId);
    if (!current) return null;
    const before = audit.before;
    const restored = this.updateMemory(current.id, {
      content: before.content,
      structuredJson: safeJsonValue(before.structured_json, before.structured ?? {}),
      tags: safeJsonValue(before.tags_json, before.tags ?? []),
      confidence: before.confidence,
      promotionStatus: before.promotion_status ?? before.promotionStatus,
      promotedSkillId: before.promoted_skill_id ?? before.promotedSkillId,
      trustLevel: before.trust_level ?? before.trustLevel,
      expiresAt: before.expires_at ?? before.expiresAt ?? null,
      replacesMemoryId: before.replaces_memory_id ?? before.replacesMemoryId ?? null,
      revokedAt: before.revoked_at ?? before.revokedAt ?? null,
      version: Number(current.version ?? 1) + 1
    });
    this.createMemoryAudit({
      memoryId: current.id, action: "rollback", actorType: "user", actorId,
      reason: `Rollback ${auditId}`, before: current, after: restored, rollbackOf: auditId
    });
    return restored;
  }

  createMemoryRecallAudit(input = {}) {
    const id = input.id ?? `memory-recall:${randomUUID()}`;
    const createdAt = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO memory_recall_audit (
        id, session_id, phase, mode, reason, scope_json, candidate_ids_json,
        selected_ids_json, diagnostics_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.sessionId ?? null, input.phase, input.mode, input.reason,
        JSON.stringify(input.scope ?? {}), JSON.stringify(input.candidateIds ?? []),
        JSON.stringify(input.selectedIds ?? []), JSON.stringify(input.diagnostics ?? {}), createdAt]
    );
    this.scheduleSave();
    return {
      id, sessionId: input.sessionId ?? null, phase: input.phase, mode: input.mode,
      reason: input.reason, scope: input.scope ?? {}, candidateIds: input.candidateIds ?? [],
      selectedIds: input.selectedIds ?? [], diagnostics: input.diagnostics ?? {}, createdAt
    };
  }

  listMemoryRecallAudit({ sessionId = null, limit = 200 } = {}) {
    const rows = sessionId
      ? this.selectAll(`SELECT * FROM memory_recall_audit WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`, [sessionId, limit])
      : this.selectAll(`SELECT * FROM memory_recall_audit ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows.map((row) => ({
      id: row.id, sessionId: row.session_id, phase: row.phase, mode: row.mode, reason: row.reason,
      scope: safeJsonValue(row.scope_json, {}), candidateIds: safeJsonValue(row.candidate_ids_json, []),
      selectedIds: safeJsonValue(row.selected_ids_json, []), diagnostics: safeJsonValue(row.diagnostics_json, {}),
      createdAt: row.created_at
    }));
  }

  // 置信度衰减（13）：按 factor 下调某 owner 下所有记忆的 confidence
  decayMemories(ownerType, ownerId, factor = 0.9) {
    this.db.run(
      `UPDATE memories SET confidence = confidence * ? WHERE owner_type = ? AND owner_id = ?`,
      [factor, ownerType, ownerId]
    );
    this.scheduleSave();
  }

  // 记忆访问：usage_count +1、recency 提升、刷新 last_accessed_at（供检索排序）
  touchMemory(id) {
    this.db.run(
      `UPDATE memories SET usage_count = usage_count + 1, recency_score = recency_score + 1, last_accessed_at = ? WHERE id = ?`,
      [createdAtFromOrNow(), id]
    );
    this.scheduleSave();
  }

  // 置信度衰减（13.6）：confidence = clamp(base × recency_score × (1 + 0.1 × min(usage,10)), 0, 1)
  // recency_score = exp(-λ·Δt_days)，λ 按 kind 衰减速度不同；confidence < 0.2 视为归档。
  applyConfidenceDecay(ownerType, ownerId, now = new Date()) {
    const mems = this.listMemoriesByOwner(ownerType, ownerId);
    const LAMBDA = {
      episodic: 0.05,
      lesson: 0.02,
      fact: 0.01,
      preference: 0.005,
      skill: 0.002,
      procedure: 0.002,
      dev_experience: 0.002
    };
    for (const m of mems) {
      const base = Number(m.base_confidence ?? 0.5);
      const usage = Number(m.usage_count ?? 0);
      const updated = m.updated_at ? new Date(m.updated_at) : now;
      const deltaDays = Math.max(0, (now - updated) / 86400000);
      const lambda = LAMBDA[m.kind] ?? 0.01;
      const recency = Math.exp(-lambda * deltaDays);
      const confidence = Math.min(1, Math.max(0, base * recency * (1 + 0.1 * Math.min(usage, 10))));
      const status = confidence < 0.2 ? "archived" : m.promotion_status ?? "active";
      this.db.run(
        `UPDATE memories SET confidence=?, recency_score=?, promotion_status=?, updated_at=? WHERE id=?`,
        [confidence, recency, status, createdAtFromOrNow(), m.id]
      );
    }
    this.scheduleSave();
    return this.listMemoriesByOwner(ownerType, ownerId);
  }

  // 晋升候选（13.7）：仅 owner=agent 的 skill/procedure/dev_experience 类记忆，
  // 且 confidence ≥ 0.7 且 usage_count ≥ 5。
  listPromotionCandidates() {
    return this.selectAll(
      `SELECT * FROM memories
        WHERE owner_type = 'agent'
          AND kind IN ('skill', 'procedure', 'dev_experience')
          AND confidence >= 0.7
          AND usage_count >= 5
          AND promotion_status != 'promoted_to_skill'
          AND trust_level = 'trusted'
          AND revoked_at IS NULL
        ORDER BY confidence DESC`
    );
  }

  // 晋升落库（13.7）：记忆 → SkillDraft → skills 表；保留溯源，原记忆标记 promoted_to_skill。
  promoteMemoryToSkill(memoryId, draft = {}) {
    const mem = this.getMemory(memoryId);
    if (!mem) return null;
    if (mem.trust_level !== "trusted") {
      throw memoryAssociationError(
        "UNTRUSTED_MEMORY_PROMOTION_FORBIDDEN",
        "Untrusted memory cannot be promoted to a Skill."
      );
    }
    const id = draft.id ?? `skill:${randomUUID()}`;
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO skills (
        id, name, scenario, trigger_condition, steps_json, risk_level,
        source_memory_id, source_agent_id, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        draft.name ?? `skill_${memoryId.split(":")[1]}`,
        draft.scenario ?? mem.content ?? "",
        draft.trigger ?? "",
        JSON.stringify(draft.steps ?? []),
        draft.riskLevel ?? "moderate",
        memoryId,
        mem.owner_id ?? null,
        draft.status ?? "draft",
        draft.version ?? 1,
        now,
        now
      ]
    );
    this.updateMemory(memoryId, {
      promotionStatus: "promoted_to_skill",
      promotedSkillId: id
    });
    this.createMemoryAudit({
      memoryId, action: "promote_to_skill", actorType: "system",
      before: mem, after: this.getMemory(memoryId), reason: `Promoted to ${id}`
    });
    this.scheduleSave();
    return this.getSkill(id);
  }

  // 独立创建技能草稿（12.6 none 三岔路 proposeSkill 用，无 source_memory 溯源）。
  createSkill(draft = {}) {
    const id = draft.id ?? `skill:${randomUUID()}`;
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO skills (
        id, name, scenario, trigger_condition, steps_json, risk_level,
        source_memory_id, source_agent_id, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        draft.name,
        draft.scenario ?? "",
        draft.trigger ?? "",
        JSON.stringify(draft.steps ?? []),
        draft.riskLevel ?? "moderate",
        draft.sourceMemoryId ?? null,
        draft.sourceAgentId ?? null,
        draft.status ?? "draft",
        draft.version ?? 1,
        now,
        now
      ]
    );
    this.scheduleSave();
    return this.getSkill(id);
  }

  getSkill(id) {
    return this.selectOne(`SELECT * FROM skills WHERE id = ?`, [id]);
  }

  listSkillsByAgent(agentId) {
    return this.selectAll(`SELECT * FROM skills WHERE source_agent_id = ? ORDER BY updated_at DESC`, [agentId]);
  }

  // 供 hub 发现：仅返回已发布（approved/published）的技能
  listDiscoverableSkills() {
    return this.selectAll(`SELECT * FROM skills WHERE status IN ('approved', 'published') ORDER BY updated_at DESC`);
  }

  updateSkillStatus(id, status) {
    this.db.run(`UPDATE skills SET status = ?, updated_at = ? WHERE id = ?`, [status, createdAtFromOrNow(), id]);
    this.scheduleSave();
    return this.getSkill(id);
  }

  // ===== 向量索引（12.7：embedding 语义召回；向量由 embedder 注入，存储只负责持久化）=====

  setMemoryEmbedding(memoryId, vector) {
    this.db.run(
      `INSERT INTO memory_embeddings (memory_id, vector, created_at) VALUES (?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET vector = excluded.vector, created_at = excluded.created_at`,
      [memoryId, JSON.stringify(vector), createdAtFromOrNow()]
    );
    this.scheduleSave();
  }

  getMemoryEmbedding(memoryId) {
    const row = this.selectOne(`SELECT vector FROM memory_embeddings WHERE memory_id = ?`, [memoryId]);
    if (!row) return null;
    try {
      return JSON.parse(row.vector);
    } catch {
      return null;
    }
  }

  // 返回 { memoryId, vector }[] 供 hub 做余弦相似度召回（内存中计算，万级片段 P95 < 20ms）
  listMemoryEmbeddings() {
    const rows = this.selectAll(`SELECT memory_id, vector FROM memory_embeddings`);
    return rows
      .map((row) => {
        try {
          return { memoryId: row.memory_id, vector: JSON.parse(row.vector) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  deleteMemoryEmbedding(memoryId) {
    this.db.run(`DELETE FROM memory_embeddings WHERE memory_id = ?`, [memoryId]);
    this.scheduleSave();
  }

  // ===== 合作调度中心（14：协作目录 + 协作会话 + 声誉缓存）=====

  upsertCollaborator(entry) {
    this.db.run(
      `INSERT INTO collaborator_registry (
        entry_type, entry_id, role, capability_tags_json, description, availability,
        trust_score, policy_json, endpoint_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_type, entry_id) DO UPDATE SET
        role=excluded.role,
        capability_tags_json=excluded.capability_tags_json,
        description=excluded.description,
        availability=excluded.availability,
        trust_score=excluded.trust_score,
        policy_json=excluded.policy_json,
        endpoint_json=excluded.endpoint_json,
        updated_at=excluded.updated_at`,
      [
        entry.entryType,
        entry.entryId,
        entry.role ?? "independentContributor",
        JSON.stringify(entry.capabilityTags ?? []),
        entry.description ?? "",
        entry.availability ?? "idle",
        entry.trustScore ?? 0.5,
        JSON.stringify(entry.policy ?? {}),
        JSON.stringify(entry.endpoint ?? {}),
        createdAtFromOrNow()
      ]
    );
    this.scheduleSave();
    return this.getCollaborator(entry.entryType, entry.entryId);
  }

  getCollaborator(entryType, entryId) {
    return this.selectOne(
      `SELECT * FROM collaborator_registry WHERE entry_type = ? AND entry_id = ?`,
      [entryType, entryId]
    );
  }

  listCollaborators(entryType = "agent") {
    return this.selectAll(
      `SELECT * FROM collaborator_registry WHERE entry_type = ?`,
      [entryType]
    );
  }

  removeCollaborator(entryType, entryId) {
    this.db.run(
      `DELETE FROM collaborator_registry WHERE entry_type = ? AND entry_id = ?`,
      [entryType, entryId]
    );
    this.scheduleSave();
  }

  createCollaborationSession(input = {}) {
    const id = input.id ?? `collab:${randomUUID()}`;
    this.db.run(
      `INSERT INTO collaboration_sessions (
        id, requester_session_id, requester_objective_id, requester_work_item_id,
        mode, request_json, candidate_entry_type, candidate_entry_id,
        status, result_json, created_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.requesterSessionId ?? null,
        input.requesterObjectiveId ?? null,
        input.requesterWorkItemId ?? null,
        input.mode,
        JSON.stringify(input.request ?? {}),
        input.candidateEntryType ?? null,
        input.candidateEntryId ?? null,
        input.status ?? "proposed",
        JSON.stringify(input.result ?? {}),
        createdAtFromOrNow(),
        input.closedAt ?? null
      ]
    );
    this.scheduleSave();
    return this.getCollaborationSession(id);
  }

  getCollaborationSession(id) {
    return this.selectOne(`SELECT * FROM collaboration_sessions WHERE id = ?`, [id]);
  }

  updateCollaborationSession(id, patch = {}) {
    const current = this.getCollaborationSession(id);
    if (!current) return null;
    this.db.run(
      `UPDATE collaboration_sessions SET
        status=?, candidate_entry_type=?, candidate_entry_id=?, result_json=?, closed_at=?
       WHERE id=?`,
      [
        patch.status ?? current.status,
        patch.candidateEntryType ?? current.candidate_entry_type,
        patch.candidateEntryId ?? current.candidate_entry_id,
        JSON.stringify(patch.result ?? JSON.parse(current.result_json || "{}")),
        patch.closedAt ?? current.closed_at,
        id
      ]
    );
    this.scheduleSave();
    return this.getCollaborationSession(id);
  }

  upsertReputation(entryId, trustScore, sampleCount = 1) {
    this.db.run(
      `INSERT INTO collab_reputation_cache (entry_id, trust_score, sample_count, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET
         trust_score=excluded.trust_score,
         sample_count=excluded.sample_count,
         updated_at=excluded.updated_at`,
      [entryId, trustScore, sampleCount, createdAtFromOrNow()]
    );
    this.scheduleSave();
  }

  getReputation(entryId) {
    return this.selectOne(
      `SELECT * FROM collab_reputation_cache WHERE entry_id = ?`,
      [entryId]
    );
  }

  // 当前在跑的协作数（load_penalty 用，14.6）：status 非 closed 的协作会话数。
  countActiveCollaborations(entryId) {
    const row = this.selectOne(
      `SELECT COUNT(*) AS n FROM collaboration_sessions
        WHERE candidate_entry_id = ? AND status != 'closed'`,
      [entryId]
    );
    return row ? Number(row.n) : 0;
  }

  // ===== 统一检索 hub（12：去抖缓存 + 活跃工具集）=====

  cacheHubIntent({ sessionId, workItemId, objectiveId, agentId, intentHash, result }) {
    const id = `hub_cache:${randomUUID()}`;
    this.db.run(
      `INSERT INTO hub_intent_cache (id, session_id, work_item_id, objective_id, agent_id, intent_hash, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        sessionId ?? null,
        workItemId ?? null,
        objectiveId ?? null,
        agentId ?? null,
        intentHash,
        JSON.stringify(result ?? {}),
        createdAtFromOrNow()
      ]
    );
    this.scheduleSave();
    return id;
  }

  getHubIntentCache(intentHash, { agentId } = {}) {
    return this.selectOne(
      `SELECT * FROM hub_intent_cache
       WHERE intent_hash = ? AND agent_id IS ?
       ORDER BY created_at DESC LIMIT 1`,
      [intentHash, agentId ?? null]
    );
  }

  registerActiveTool(sessionId, toolName, toolDef = {}) {
    this.db.run(
      `INSERT OR REPLACE INTO session_active_tools (session_id, tool_name, tool_def_json, registered_at)
       VALUES (?, ?, ?, ?)`,
      [sessionId, toolName, JSON.stringify(toolDef), createdAtFromOrNow()]
    );
    this.scheduleSave();
  }

  listActiveTools(sessionId) {
    return this.selectAll(
      `SELECT * FROM session_active_tools WHERE session_id = ?`,
      [sessionId]
    );
  }

  selectAll(sql, params = []) {
    return this.db.all(sql, params, queryCallerSource());
  }

  selectOne(sql, params = []) {
    return this.db.get(sql, params, queryCallerSource());
  }

  iterate(sql, params = []) {
    return this.db.iterate(sql, params, queryCallerSource());
  }

  queryMetrics(options = {}) {
    return this.db.queryMetrics(options);
  }

  resetEventLoopDelayMetrics() {
    this.db.resetEventLoopDelayMetrics();
  }

  ensureColumn(table, column, definition) {
    const columns = this.selectAll(`PRAGMA table_info(${table})`);
    if (columns.some((entry) => entry.name === column)) {
      return;
    }
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  dropColumnIfExists(table, column) {
    const columns = this.selectAll(`PRAGMA table_info(${table})`);
    if (!columns.some((entry) => entry.name === column)) {
      return;
    }
    this.db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }

  migrateSessionProviderBindings() {
    this.db.run(
      `UPDATE provider_thread_bindings
       SET binding_id = COALESCE(binding_id, 'binding:' || lower(hex(randomblob(16)))),
           provider_session_id = COALESCE(provider_session_id, provider_thread_id),
           provider_id = COALESCE(
             provider_id,
             (
               SELECT sessions.provider
               FROM logical_sessions
               JOIN sessions ON sessions.id = logical_sessions.legacy_session_id
               WHERE logical_sessions.logical_session_id = provider_thread_bindings.logical_session_id
             ),
             'codex-app-server'
           ),
           provider_metadata_json = COALESCE(provider_metadata_json, '{}')
       WHERE binding_id IS NULL
          OR provider_session_id IS NULL
          OR provider_id IS NULL
          OR provider_metadata_json IS NULL`
    );
    this.db.run(
      `UPDATE provider_thread_bindings
       SET parent_binding_id = (
         SELECT parent.binding_id
         FROM provider_thread_bindings AS parent
         WHERE parent.provider_thread_id = provider_thread_bindings.parent_thread_id
       )
       WHERE parent_thread_id IS NOT NULL AND parent_binding_id IS NULL`
    );
    this.db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_thread_bindings_binding_id ON provider_thread_bindings(binding_id)"
    );
    this.db.run("DROP INDEX IF EXISTS idx_provider_thread_bindings_provider_session");
    this.db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_thread_bindings_provider_session
       ON provider_thread_bindings(provider_id, provider_session_id) WHERE state = 'active'`
    );
  }

  migrateWorkspaceTransitionsForDirectoryTargets() {
    const columns = this.selectAll("PRAGMA table_info(workspace_transitions)");
    const targetWorktree = columns.find((column) => column.name === "target_worktree_id");
    const targetCwd = columns.find((column) => column.name === "target_cwd");
    if (targetCwd && Number(targetWorktree?.notnull) === 0) return;

    this.db.run(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE workspace_transitions_next (
        transition_id TEXT PRIMARY KEY,
        logical_session_id TEXT NOT NULL,
        source_thread_id TEXT NOT NULL,
        target_worktree_id TEXT,
        target_cwd TEXT NOT NULL,
        source_routing_version INTEGER NOT NULL,
        last_completed_turn_id TEXT,
        new_thread_id TEXT,
        resume_goal_after_transition INTEGER NOT NULL DEFAULT 0,
        phase TEXT NOT NULL CHECK (phase IN (
          'waitingForTurn', 'preflighting', 'forking', 'validatingInstructions',
          'committingRoute', 'committed', 'failed'
        )),
        strategy TEXT NOT NULL DEFAULT 'fork'
          CHECK (strategy IN ('fork', 'handoff', 'settingsUpdate')),
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE,
        FOREIGN KEY (source_thread_id) REFERENCES provider_thread_bindings(provider_thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (target_worktree_id) REFERENCES git_worktrees(worktree_id) ON DELETE RESTRICT
      );
      INSERT INTO workspace_transitions_next (
        transition_id, logical_session_id, source_thread_id, target_worktree_id, target_cwd,
        source_routing_version, last_completed_turn_id, new_thread_id,
        resume_goal_after_transition, phase, strategy,
        error_json, created_at, updated_at
      )
      SELECT transition_id, logical_session_id, source_thread_id, target_worktree_id,
             COALESCE(
               (SELECT canonical_path FROM git_worktrees WHERE worktree_id = target_worktree_id),
               (SELECT path FROM git_worktrees WHERE worktree_id = target_worktree_id),
               (SELECT bound_cwd FROM provider_thread_bindings WHERE provider_thread_id = source_thread_id)
             ),
             source_routing_version, last_completed_turn_id, new_thread_id, 0, phase, strategy,
             error_json, created_at, updated_at
      FROM workspace_transitions;
      DROP TABLE workspace_transitions;
      ALTER TABLE workspace_transitions_next RENAME TO workspace_transitions;
      CREATE INDEX idx_workspace_transitions_session
      ON workspace_transitions(logical_session_id, created_at DESC);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
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
    const publicId = row.id;
    const threadId = rawStatus.threadId
      ?? (isCodexAppServer ? String(row.id).replace(/^codex:/, "") : row.id);
    const displayStatus = status;
    const activeChoicePrompt = parseActiveChoicePrompt(row.active_choice_json);
    const suggestedOptions = activeChoicePrompt?.options ?? null;
    const logicalIdentity = Object.hasOwn(row, "projection_logical_session_id")
      ? {
          logical_session_id: row.projection_logical_session_id,
          session_name: row.projection_session_name
        }
      : this.selectOne(
        `SELECT logical_session_id, session_name
         FROM logical_sessions WHERE legacy_session_id = ?`,
        [row.id]
      );
    const agentIdentity = Object.hasOwn(row, "projection_binding_agent_id")
      ? {
          agent_id: row.projection_binding_agent_id,
          role: row.projection_agent_role
        }
      : this.selectOne(
        `SELECT bindings.agent_id, agents.role
         FROM agent_sessions bindings
         LEFT JOIN agents ON agents.agent_id = bindings.agent_id
         WHERE bindings.session_id = ? AND bindings.unbound_at IS NULL LIMIT 1`,
        [row.id]
      );
    return {
      id: publicId,
      title: logicalIdentity?.session_name || row.title,
      sessionName: logicalIdentity?.session_name || row.title,
      logicalSessionId: logicalIdentity?.logical_session_id ?? null,
      agent: row.agent,
      agentId: row.agent_id ?? agentIdentity?.agent_id ?? null,
      sessionKind: inferSessionKind({
        sessionKind: row.session_kind,
        objectiveId: row.objective_id,
        workItemId: row.work_item_id,
        agentRole: agentIdentity?.role
      }),
      status: displayStatus,
      progress: displayStatus === "running" || displayStatus === "blocked" ? Number(row.progress) : 1,
      summary: row.summary,
      activityStatus: rawStatus.activityStatus ?? null,
      suggestedOptions,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      accent: row.accent,
      archived: Boolean(row.archived),
      pinned: Boolean(row.pinned),
      sortOrder: Number(row.sort_order ?? 0),
      objectiveId: row.objective_id ?? null,
      workItemId: row.work_item_id ?? null,
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
        logicalSessionId: logicalIdentity?.logical_session_id ?? rawStatus.logicalSessionId ?? null,
        workspace: rawStatus.workspace ?? null,
        routingVersion: Number(rawStatus.routingVersion ?? 0),
        agentSessionId: rawStatus.agentSessionId ?? rawStatus.resume?.agentSessionId ?? null,
        connectionStatus: isCodexAppServer ? null : "disconnected",
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
    this.observability = new SqliteQueryObservability();
  }

  run(sql, params = []) {
    return this.observability.measure(sql, queryCallerSource(), "run", () => {
      const bindings = normalizeSqliteBindings(params);
      if (bindings.length > 0) {
        const result = this.database.prepare(sql).run(...bindings);
        this.rowsModified = Number(result.changes);
        return;
      }

      this.database.exec(sql);
      const result = this.database.prepare("SELECT changes() AS changes").get();
      this.rowsModified = Number(result?.changes ?? 0);
    });
  }

  all(sql, params = [], source = "unknown") {
    return this.observability.measure(sql, source, "selectAll", ({ addRows }) => {
      const rows = this.database.prepare(sql).all(...normalizeSqliteBindings(params));
      for (const row of rows) normalizeSqliteRowPrototype(row);
      addRows(rows);
      return rows;
    });
  }

  get(sql, params = [], source = "unknown") {
    return this.observability.measure(sql, source, "selectOne", ({ addRow }) => {
      const row = this.database.prepare(sql).get(...normalizeSqliteBindings(params)) ?? null;
      if (row) {
        normalizeSqliteRowPrototype(row);
        addRow(row);
      }
      return row;
    });
  }

  *iterate(sql, params = [], source = "unknown") {
    const startedAt = performance.now();
    let rowCount = 0;
    let estimatedResultBytes = 0;
    const iterator = this.database.prepare(sql).iterate(...normalizeSqliteBindings(params));
    try {
      for (const row of iterator) {
        normalizeSqliteRowPrototype(row);
        rowCount += 1;
        estimatedResultBytes += estimateSqliteRowBytes(row);
        yield row;
      }
    } finally {
      iterator.return?.();
      this.observability.record({
        sql,
        source,
        operation: "iterate",
        durationMilliseconds: performance.now() - startedAt,
        rowCount,
        estimatedResultBytes
      });
    }
  }

  queryMetrics(options = {}) {
    return this.observability.snapshot(options);
  }

  resetEventLoopDelayMetrics() {
    this.observability.resetEventLoopDelay();
  }

  getRowsModified() {
    return this.rowsModified;
  }

  checkpoint() {
    this.database.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  close() {
    this.observability.close();
    this.database.close();
  }
}

function estimateSqliteRowBytes(row) {
  let bytes = 0;
  for (const [key, value] of Object.entries(row ?? {})) {
    bytes += Buffer.byteLength(key);
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    else if (value instanceof Uint8Array) bytes += value.byteLength;
    else if (value != null) bytes += 8;
  }
  return bytes;
}

function normalizeSqliteRowPrototype(row) {
  // node:sqlite returns null-prototype records. Preserve the Store's historical
  // plain-object contract by mutating only the prototype; unlike `{ ...row }`,
  // this does not allocate or copy every column of every result row.
  if (Object.getPrototypeOf(row) === null) Object.setPrototypeOf(row, Object.prototype);
  return row;
}

function normalizeSqliteBindings(params) {
  return (Array.isArray(params) ? params : [params]).map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  });
}

function providerThreadBindingFromRow(row) {
  return {
    bindingId: row.binding_id,
    providerId: row.provider_id,
    providerSessionId: row.provider_session_id ?? row.provider_thread_id,
    providerThreadId: row.provider_thread_id,
    logicalSessionId: row.logical_session_id,
    worktreeId: row.worktree_id,
    boundCwd: row.bound_cwd,
    parentThreadId: row.parent_thread_id,
    parentBindingId: row.parent_binding_id,
    forkedAtTurnId: row.forked_at_turn_id,
    instructionSources: parseJson(row.instruction_sources_json, []),
    permissionSnapshot: parseJson(row.permission_snapshot_json, {}),
    providerMetadata: parseJson(row.provider_metadata_json, {}),
    routingVersion: Number(row.routing_version ?? 1),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sessionProjectionSelectSQL() {
  return `SELECT sessions.*,
    (SELECT logical_session_id FROM logical_sessions
     WHERE legacy_session_id = sessions.id LIMIT 1) AS projection_logical_session_id,
    (SELECT session_name FROM logical_sessions
     WHERE legacy_session_id = sessions.id LIMIT 1) AS projection_session_name,
    (SELECT bindings.agent_id FROM agent_sessions bindings
     WHERE bindings.session_id = sessions.id AND bindings.unbound_at IS NULL
     LIMIT 1) AS projection_binding_agent_id,
    (SELECT agents.role FROM agent_sessions bindings
     LEFT JOIN agents ON agents.agent_id = bindings.agent_id
     WHERE bindings.session_id = sessions.id AND bindings.unbound_at IS NULL
     LIMIT 1) AS projection_agent_role
    FROM sessions`;
}

function scheduledSessionTaskFromRow(row) {
  const message = parseJson(row.message_json, {});
  const fallbackTrigger = row.schedule_type === "once"
    ? { type: "at", at: row.run_at }
    : row.schedule_type === "interval"
      ? { type: "interval", startAt: row.run_at, intervalSeconds: Number(row.interval_seconds) }
      : row.schedule_type === "condition"
        ? { type: "condition", condition: parseJson(row.condition_spec_json, null) }
        : { type: "processExit", process: parseJson(row.process_spec_json, null) };
  const trigger = parseJson(row.trigger_spec_json, fallbackTrigger);
  const actions = parseJson(row.actions_json, [{ type: "queueSessionMessage", message }]);
  const policy = parseJson(row.policy_spec_json, {
    misfire: row.missed_policy === "skip" ? "skip" : "fireOnce",
    maxCatchUpRuns: 10,
    maxConcurrentRuns: Number(row.max_concurrent_runs ?? 1),
    timeoutSeconds: Number(row.timeout_seconds ?? 3600),
    backpressureLimit: Number(row.backpressure_limit ?? 100)
  });
  return {
    taskId: row.task_id,
    automationId: row.task_id,
    name: row.name || message.text || row.task_id,
    logicalSessionId: row.logical_session_id,
    message,
    scheduleType: row.schedule_type,
    trigger,
    triggerSpec: trigger,
    conditions: parseJson(row.condition_specs_json, []),
    conditionSpecs: parseJson(row.condition_specs_json, []),
    actions,
    policy,
    policySpec: policy,
    risk: parseJson(row.risk_json, { level: "minimal", remoteWrite: false, destructive: false }),
    runAt: row.run_at,
    nextRunAt: row.next_run_at,
    intervalSeconds: row.interval_seconds == null ? null : Number(row.interval_seconds),
    timezone: row.timezone,
    status: row.status,
    missedPolicy: row.missed_policy,
    conditionSpec: parseJson(row.condition_spec_json, null),
    conditionState: parseJson(row.condition_state_json, null),
    processSpec: parseJson(row.process_spec_json, null),
    processState: parseJson(row.process_state_json, null),
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    objectiveId: row.objective_id,
    environment: row.environment,
    pendingScheduledFor: row.pending_scheduled_for,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? 5),
    maxConcurrentRuns: Number(row.max_concurrent_runs ?? policy.maxConcurrentRuns ?? 1),
    timeoutSeconds: Number(row.timeout_seconds ?? policy.timeoutSeconds ?? 3600),
    backpressureLimit: Number(row.backpressure_limit ?? policy.backpressureLimit ?? 100),
    lastRunId: row.last_run_id,
    lastRunStatus: row.last_run_status,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastRunAt: row.last_run_at,
    resourceVersion: Number(row.resource_version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pausedAt: row.paused_at,
    cancelledAt: row.cancelled_at,
    completedAt: row.completed_at
  };
}

function scheduledSessionRunFromRow(row) {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    runKey: row.run_key,
    scheduledFor: row.scheduled_for,
    triggerKind: row.trigger_kind,
    triggerReason: row.trigger_reason,
    status: row.status,
    attemptCount: Number(row.attempt_count ?? 0),
    agentWorkItemId: row.agent_work_item_id,
    targetTurnId: row.target_turn_id,
    bindingId: row.binding_id,
    providerSessionId: row.provider_session_id,
    routingVersion: row.routing_version == null ? null : Number(row.routing_version),
    exitStatus: parseJson(row.exit_status_json, null),
    conditionResult: parseJson(row.condition_result_json, null),
    stages: parseJson(row.stages_json, []),
    actionResults: parseJson(row.action_results_json, []),
    deadlineAt: row.deadline_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    claimedAt: row.claimed_at,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function scheduledSessionEventFromRow(row) {
  return {
    eventId: row.event_id,
    taskId: row.task_id,
    runId: row.run_id,
    sequence: Number(row.sequence),
    type: row.type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    payload: parseJson(row.payload_json, {}),
    environment: row.environment,
    createdAt: row.created_at
  };
}

function workspaceTransitionFromRow(row) {
  return {
    transitionId: row.transition_id,
    logicalSessionId: row.logical_session_id,
    sourceThreadId: row.source_thread_id,
    targetWorktreeId: row.target_worktree_id,
    targetCwd: row.target_cwd,
    transitionKind: row.transition_kind || "workspace",
    targetProviderId: row.target_provider_id || null,
    sourceRoutingVersion: Number(row.source_routing_version),
    lastCompletedTurnId: row.last_completed_turn_id,
    newThreadId: row.new_thread_id,
    resumeGoalAfterTransition: Boolean(row.resume_goal_after_transition),
    continuationPrompt: row.continuation_prompt || null,
    continuationState: row.continuation_state || "none",
    continuationTurnId: row.continuation_turn_id || null,
    continuationError: row.continuation_error || null,
    phase: row.phase,
    strategy: row.strategy,
    error: parseJson(row.error_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function projectIntegrationRunFromRow(row, items = []) {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    objectiveId: row.objective_id,
    status: row.status,
    mainHeadBefore: row.main_head_before,
    mainHeadAfter: row.main_head_after ?? null,
    integrationWorktreeId: row.integration_worktree_id ?? null,
    integrationWorktreePath: row.integration_worktree_path ?? null,
    integrationBranch: row.integration_branch ?? null,
    conflictWorkItemId: row.conflict_work_item_id ?? null,
    conflictSessionId: row.conflict_session_id ?? null,
    error: row.error ?? null,
    items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null
  };
}

function projectIntegrationItemFromRow(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    worktreeId: row.worktree_id,
    workItemId: row.work_item_id,
    branchName: row.branch_name ?? null,
    sourceHeadOid: row.source_head_oid,
    ordinal: Number(row.ordinal),
    status: row.status,
    conflictFiles: parseJson(row.conflict_files_json, []),
    mergedMainHead: row.merged_main_head ?? null,
    error: row.error ?? null,
    updatedAt: row.updated_at
  };
}

function worktreeIntegrationJobFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    repositoryId: row.repository_id,
    status: row.status,
    phase: row.phase,
    planFingerprint: row.plan_fingerprint,
    details: parseJson(row.details_json, {}),
    error: row.error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at ?? null,
    completedAt: row.completed_at ?? null
  };
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function objectiveFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    idealState: row.ideal_state ?? "",
    status: row.status,
    priority: row.priority ?? null,
    targetDate: row.target_date ?? null,
    tags: parseJson(row.tags_json, []),
    workspaceIds: parseJson(row.workspace_ids_json, []),
    relatedObjectiveIds: parseJson(row.related_objective_ids_json, []),
    contributorAgentIds: parseJson(row.contributor_agent_ids_json, []),
    budgetConfig: parseJson(row.budget_config, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function artifactFromRow(row) {
  return {
    artifactId: row.artifact_id,
    objectiveId: row.objective_id,
    title: row.title,
    summary: row.summary ?? "",
    visibility: row.visibility,
    boundWorkItemId: row.bound_work_item_id ?? null,
    boundSessionId: row.bound_session_id ?? null,
    repositoryLocator: row.repository_locator ?? null,
    currentVersion: Number(row.current_version ?? 0),
    approvedVersion: row.approved_version == null ? null : Number(row.approved_version),
    status: row.status,
    sourceSessionId: row.source_session_id ?? null,
    sourceEventId: row.source_event_id ?? null,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resourceVersion: Number(row.resource_version ?? 1)
  };
}

function artifactVersionFromRow(row) {
  return {
    artifactId: row.artifact_id,
    version: Number(row.version),
    contentHash: row.content_hash,
    byteLength: Number(row.byte_length),
    mimeType: row.mime_type,
    storageKey: row.storage_key ?? null,
    sourceSessionId: row.source_session_id ?? null,
    sourceEventId: row.source_event_id ?? null,
    supersedesVersion: row.supersedes_version == null ? null : Number(row.supersedes_version),
    approvalStatus: row.approval_status,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at
  };
}

function artifactReferenceFromRow(row) {
  return {
    referenceId: row.reference_id,
    artifactId: row.artifact_id,
    objectiveId: row.objective_id,
    workItemId: row.work_item_id ?? null,
    sessionId: row.session_id ?? null,
    relation: row.relation,
    required: Boolean(row.required),
    versionPolicy: row.version_policy,
    pinnedVersion: Number(row.pinned_version),
    pinnedHash: row.pinned_hash,
    pendingVersion: row.pending_version == null ? null : Number(row.pending_version),
    pendingHash: row.pending_hash ?? null,
    authorizedByActorId: row.authorized_by_actor_id,
    authorizedAt: row.authorized_at,
    revokedAt: row.revoked_at ?? null,
    revokedByActorId: row.revoked_by_actor_id ?? null,
    revocationReason: row.revocation_reason ?? null,
    resourceVersion: Number(row.resource_version ?? 1)
  };
}

function artifactAuditFromRow(row) {
  return {
    auditId: row.audit_id,
    artifactId: row.artifact_id ?? null,
    objectiveId: row.objective_id,
    action: row.action,
    actorId: row.actor_id,
    sessionId: row.session_id ?? null,
    workItemId: row.work_item_id ?? null,
    fromVersion: row.from_version == null ? null : Number(row.from_version),
    toVersion: row.to_version == null ? null : Number(row.to_version),
    details: parseJson(row.details_json, {}),
    createdAt: row.created_at
  };
}

function agentFromRow(row) {
  return {
    agentId: row.agent_id,
    agentKind: row.agent_kind ?? AGENT_KIND.USER,
    name: row.name,
    description: row.description ?? "",
    role: row.role ?? "independentContributor",
    // 防御性规范化：即使旧客户端或外部 SQL 写入了历史值，
    // 也不允许会话生命周期重新污染 Agent 可用性。
    status: "available",
    systemPrompt: row.system_prompt ?? "",
    capabilities: parseJson(row.capabilities_json, []),
    workDir: row.work_dir ?? null,
    avatarPath: row.avatar_path ?? null,
    currentSessionId: row.current_session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sessionContextReferenceFromRow(row) {
  return {
    referenceId: row.reference_id,
    ownerSessionId: row.owner_session_id,
    targetType: row.target_type,
    targetKey: row.target_key,
    targetId: row.target_id ?? null,
    locator: row.locator ?? null,
    displayName: row.display_name,
    inclusionMode: row.inclusion_mode,
    enabled: Boolean(row.enabled),
    priority: Number(row.priority),
    status: row.status,
    snapshotTitle: row.snapshot_title ?? null,
    snapshotText: row.snapshot_text ?? null,
    snapshotAt: row.snapshot_at ?? null,
    contentHash: row.content_hash ?? null,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function skillFromRow(row) {
  return {
    skillId: row.skill_id,
    name: row.name,
    description: row.description ?? "",
    sourceType: row.source_type ?? "local",
    source: row.source,
    sourceSubpath: row.source_subpath ?? "",
    packageSubpath: row.package_subpath ?? "",
    mcpDescriptorSubpath: row.mcp_descriptor_subpath ?? "",
    packageDiscoveryMethod: row.package_discovery_method ?? "",
    cachePath: row.cache_path ?? null,
    manifestName: row.manifest_name || row.name,
    manifestDescription: row.manifest_description || row.description || "",
    contentHash: row.content_hash ?? "",
    installedAt: row.installed_at,
    updatedAt: row.updated_at
  };
}

function skillDeletionOperationFromRow(row) {
  return {
    operationId: row.operation_id,
    skillId: row.skill_id,
    skillName: row.skill_name,
    status: row.status,
    affectedAgents: parseJson(row.affected_agents_json, []),
    activeSessions: parseJson(row.active_sessions_json, []),
    cleanup: parseJson(row.cleanup_json, []),
    recovery: parseJson(row.recovery_json, []),
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null
  };
}

function skillRuntimeEventFromRow(row) {
  return {
    eventId: row.event_id,
    stage: row.stage,
    status: row.status,
    errorCode: row.error_code ?? null,
    reason: row.reason ?? "",
    skillId: row.skill_id ?? null,
    agentId: row.agent_id ?? null,
    sessionId: row.session_id ?? null,
    providerId: row.provider_id ?? null,
    serverNames: parseJson(row.server_names_json, []),
    toolCount: row.tool_count == null ? null : Number(row.tool_count),
    details: parseJson(row.details_json, {}),
    createdAt: row.created_at
  };
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
  return { mode: "app-server" };
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
    choiceParser: normalizeProxyProfile(input.choiceParser)
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
    canResume: session.canResume === true,
    threadId: session.external?.threadId ?? null,
    sessionId: session.external?.sessionId ?? null,
    activeTurnId: session.external?.activeTurnId ?? null,
    activityStatus: session.activityStatus ?? null,
    source: session.external?.source ?? null,
    sandbox: session.external?.sandbox ?? session.sandbox ?? null,
    approvalPolicy: session.external?.approvalPolicy ?? session.approvalPolicy ?? null,
    logicalSessionId: session.external?.logicalSessionId ?? null,
    workspace: session.external?.workspace ?? null,
    routingVersion: Number(session.external?.routingVersion ?? 0),
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

function normalizeStoredItem(item, provider) {
  return item;
}

function normalizeStoredText(text = "", provider = "") {
  return text;
}

function isAdjacentDuplicateUserMessage(item, previous) {
  return previous?.type === "userMessage"
    && item.type === "userMessage"
    && normalizeUserText(previous.text) === normalizeUserText(item.text);
}

function normalizeUserText(text = "") {
  return text.replace(/^›\s*/, "").replace(/\s+/g, " ").trim();
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

// 会话日志事件溯源（10）：按事件类型推导 surface（是否投影为用户可见消息）。
// surface=true 的事件才会被 deriveMessages 折叠进 UI 消息列表。
const SURFACE_EVENT_TYPES = new Set([
  "user/message",
  "assistant/message",
  "assistant/chunk",
  "memory/inject"
]);

function surfaceForEventType(type) {
  return SURFACE_EVENT_TYPES.has(type) ? 1 : 0;
}

function agentMessageEventSQL(tableAlias) {
  if (process.env.CORPTIE_OPTIMIZED_MESSAGE_CURSOR_READS === "0") {
    return `(
      ${tableAlias}.type IN ('CodexThreadCompleted', 'AgentTurnCompleted')
      AND COALESCE(json_extract(${tableAlias}.payload_json, '$.hasAgentMessage'), 0) = 1
    )`;
  }
  return `${tableAlias}.has_agent_message = 1`;
}

function sessionEventFromRow(row) {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    logId: row.log_id,
    sequence: Number(row.sequence),
    type: row.type,
    producer: row.producer,
    surface: Number(row.surface) === 1,
    sourceEventSeqs: parseJson(row.source_event_seqs_json, null),
    callId: row.call_id,
    source: parseJson(row.source_json, null),
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at
  };
}

function eventHasAgentMessage(event) {
  return (event.type === "CodexThreadCompleted" || event.type === "AgentTurnCompleted")
    && (event.payload?.hasAgentMessage === true || event.payload?.hasAgentMessage === 1);
}

// 从 source 元数据提取 producer 标签（source 可能是对象或字符串）。
function producerFromSource(source) {
  if (source == null) return null;
  if (typeof source === "string") return source;
  return source.producer ?? source.name ?? source.id ?? null;
}

function memoryAssociationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function presentMemoryAudit(row) {
  if (!row) return null;
  return {
    id: row.id,
    memoryId: row.memory_id,
    action: row.action,
    actorType: row.actor_type,
    actorId: row.actor_id,
    reason: row.reason,
    before: safeJsonValue(row.before_json, null),
    after: safeJsonValue(row.after_json, null),
    rollbackOf: row.rollback_of,
    createdAt: row.created_at
  };
}

function safeJsonValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// 会话日志事件溯源（10）：session_items 的 item.type → 事件类型 + producer。
// 返回 null 表示该 item 是内部状态（非模型可见消息），不进事件流 surface。
function itemTypeToEventType(itemType) {
  switch (itemType) {
    case "userMessage":
    case "user":
    case "inputText":
      return { type: "user/message", producer: "user" };
    case "agentMessage":
    case "text":
    case "reasoning":
    case "taskComplete":
    case "workspaceWrite":
      return { type: "assistant/message", producer: "agent" };
    case "mcpToolCall":
      return { type: "tool/call", producer: "agent" };
    case "approval":
      return { type: "approval/request", producer: "agent" };
    default:
      return null;
  }
}
