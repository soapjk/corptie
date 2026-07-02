import { readFileSync } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import initSqlJs from "sql.js";

const environmentName = normalizeEnvironment(process.env.COPETS_ENV);
const appSupportName = environmentName === "development" ? "Copets Development" : "Copets";
const appSupportDir = join(os.homedir(), "Library", "Application Support", appSupportName);
const legacyDbPath = join(appSupportDir, "copets.sqlite");
const configPath = join(appSupportDir, "config.json");
const fallbackDataDir = appSupportDir;
const dbFileName = "copets.sqlite";

export class CopetsStore {
  constructor(options = {}) {
    this.configPath = options.configPath || process.env.COPETS_CONFIG_PATH || configPath;
    this.dataDir = null;
    this.dbPath = options.dbPath || process.env.COPETS_DB_PATH || null;
    this.SQL = null;
    this.db = null;
    this.saveTimer = null;
    this.config = {};
  }

  async initialize() {
    this.SQL = await initSqlJs();
    await this.resolveDataPath();
    await mkdir(dirname(this.dbPath), { recursive: true });

    try {
      const data = await readFile(this.dbPath);
      this.db = new this.SQL.Database(data);
    } catch {
      this.db = new this.SQL.Database();
    }

    this.migrate();
    await this.save();
  }

  async resolveDataPath() {
    if (this.dbPath) {
      this.dataDir = dirname(this.dbPath);
      return;
    }

    const configured = await this.readConfiguredDataDir();
    this.dataDir = configured || await defaultDataDir();
    this.dbPath = join(this.dataDir, dbFileName);

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
      this.config = {};
      return null;
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
      legacyDbPath,
      choiceParser: this.choiceParserSettings(),
      agentProxy: this.agentProxySettings()
    };
  }

  choiceParserSettings() {
    const configured = this.config.choiceParser ?? {};
    return normalizeChoiceParserSettings(configured);
  }

  agentProxySettings() {
    const configured = this.config.agentProxy ?? {};
    return normalizeAgentProxySettings(configured);
  }

  async updateSettings(input = {}) {
    if (typeof input.dataDir === "string" && input.dataDir.trim()) {
      await this.setDataDirectory(input.dataDir);
    }
    if (input.choiceParser && typeof input.choiceParser === "object") {
      this.config.choiceParser = normalizeChoiceParserSettings(input.choiceParser);
      await this.writeConfig();
    }
    if (input.agentProxy && typeof input.agentProxy === "object") {
      this.config.agentProxy = normalizeAgentProxySettings(input.agentProxy);
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
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    this.dataDir = nextDir;
    this.dbPath = join(nextDir, dbFileName);
    await this.save();
    await this.writeConfig();
    return this.settings();
  }

  migrate() {
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
    `);

    this.ensureColumn("sessions", "archived", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "pinned", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "sort_order", "REAL");
    this.ensureColumn("sessions", "avatar_path", "TEXT");
    this.ensureColumn("session_items", "options_json", "TEXT");
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
  }

  async save() {
    const bytes = this.db.export();
    await writeFile(this.dbPath, Buffer.from(bytes));
  }

  scheduleSave() {
    if (this.saveTimer) {
      return;
    }

    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      try {
        await this.save();
      } catch (error) {
        console.error(`[store] save failed: ${error.message}`);
      }
    }, 120);
    this.saveTimer.unref?.();
  }

  upsertSession(session) {
    const summary = toSessionSummary(session);
    this.db.run(
      `INSERT INTO sessions (
        id, title, agent, provider, command, args_json, cwd, status, progress, summary, accent, created_at, updated_at, archived, pinned, sort_order, avatar_path, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        session.createdAt || session.updatedAt || new Date().toISOString(),
        session.updatedAt || new Date().toISOString(),
        session.archived ? 1 : 0,
        session.pinned ? 1 : 0,
        Number.isFinite(session.sortOrder) ? session.sortOrder : this.nextTopSortOrder(session.archived === true),
        session.avatarPath ?? session.external?.avatarPath ?? null,
        JSON.stringify(toRawStatus(session))
      ]
    );
    this.scheduleSave();
  }

  appendItem(sessionId, item) {
    const createdAt = item.createdAt || new Date().toISOString();
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
        status: row.status
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
      status: session.status,
      source: session.external?.provider,
      connectionStatus: "pty disconnected",
      currentModel: session.external?.currentModel ?? session.rawStatus?.currentModel ?? session.rawStatus?.resume?.currentModel ?? null,
      cwd: session.external?.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      rawStatus: session.rawStatus,
      canSend: false,
      sendUnavailableReason: session.rawStatus?.canResume === false
        ? "This Codex PTY session was not bound to a Codex session id and cannot be reconnected."
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

  deleteSession(id) {
    this.db.run("DELETE FROM session_items WHERE session_id = ?", [id]);
    this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
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
    const suggestedOptions = this.latestSuggestedOptions(row.id) ?? choiceOptionsFromAgentMessage(latestAssistantSummary);
    return {
      id: `pty:${row.id}`,
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
      rawStatus,
      external: {
        provider: row.provider,
        threadId: row.id,
        sessionId: row.id,
        agentSessionId: rawStatus.agentSessionId ?? rawStatus.resume?.agentSessionId ?? null,
        connectionStatus: "pty disconnected",
        currentModel: rawStatus.currentModel ?? rawStatus.resume?.currentModel ?? modelFromArgs(args),
        currentReasoningLevel: rawStatus.currentReasoningLevel ?? rawStatus.resume?.currentReasoningLevel ?? reasoningFromArgs(args),
        cwd: row.cwd,
        source: row.command,
        args
      }
    };
  }

  latestSuggestedOptions(sessionId) {
    const rows = this.selectAll(
      `SELECT type, options_json FROM session_items WHERE session_id = ? ORDER BY created_at DESC LIMIT 40`,
      [sessionId]
    );
    for (const row of rows) {
      if (row.type === "userMessage") {
        return null;
      }
      const options = parseJson(row.options_json, null);
      if (row.type === "agentMessage" && Array.isArray(options) && options.length >= 2) {
        return options;
      }
    }
    return null;
  }
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
    summary: latest || `${session.command ?? ""} ${(session.args ?? []).join(" ")}`.trim(),
    suggestedOptions: latestSuggestedOptionsFromItems(session.items ?? []),
    accent: session.accent || "cyan"
  };
}

function toRawStatus(session) {
  const agentSessionId = session.agentSessionId ?? session.resume?.agentSessionId ?? null;
  return {
    command: session.command ?? null,
    args: session.args ?? [],
    provider: session.provider ?? null,
    resume: session.resume ?? null,
    agentSessionId,
    initialPrompt: session.initialPrompt ?? "",
    phase: session.phase ?? null,
    connectionReady: session.connectionReady === true,
    currentModel: session.currentModel ?? session.resume?.currentModel ?? modelFromArgs(session.args ?? []),
    currentReasoningLevel: session.currentReasoningLevel ?? session.resume?.currentReasoningLevel ?? reasoningFromArgs(session.args ?? []),
    lastInputAt: session.lastInputAt ?? null,
    lastOutputAt: session.lastOutputAt ?? null,
    nextItemSeq: session.nextItemSeq ?? null,
    canResume: session.provider === "codex-pty" && session.canResume === true && Boolean(agentSessionId),
    exitCode: session.exitCode ?? null,
    signal: session.signal ?? null
  };
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
    if (item.type === "agentMessage" && Array.isArray(item.options) && item.options.length >= 2) {
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
      status: role === "user" ? "sent" : payload.phase ?? null
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
    status: "pending"
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
  return process.env.COPETS_DEFAULT_DATA_DIR || fallbackDataDir;
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
