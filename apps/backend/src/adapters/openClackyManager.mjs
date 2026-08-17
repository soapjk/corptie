const DEFAULT_BASE_URL = "http://127.0.0.1:7070";

export class OpenClackyManager {
  constructor(options = {}) {
    this.baseURL = normalizedBaseURL(options.baseURL ?? DEFAULT_BASE_URL);
    this.accessKey = optionalText(options.accessKey);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.onSessionChanged = options.onSessionChanged ?? null;
    this.resolveOwnedSessionIds = options.resolveOwnedSessionIds ?? (() => []);
    this.refreshIntervalMs = options.refreshIntervalMs ?? 10_000;
    this.ownedSessionIds = new Set();
    this.sessions = new Map();
    this.details = new Map();
    this.sockets = new Map();
    this.refreshTimer = null;
    this.lastSnapshotSignature = null;
    this.connectionErrorMessage = null;
  }

  start() {
    void this.refresh().catch((error) => this.reportConnectionError(error));
    if (this.refreshIntervalMs > 0 && !this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void this.refresh().catch((error) => this.reportConnectionError(error));
      }, this.refreshIntervalMs);
      this.refreshTimer.unref?.();
    }
    return this;
  }

  stop() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    for (const socket of this.sockets.values()) socket.close?.();
    this.sockets.clear();
  }

  list(options = {}) {
    const archived = options.archived === true;
    return Array.from(this.sessions.values())
      .filter((session) => Boolean(session.archived) === archived)
      .map((session) => ({ ...session }));
  }

  async refresh() {
    const persistedIds = await this.resolveOwnedSessionIds();
    if (!Array.isArray(persistedIds)) {
      throw new Error("OpenClacky Session ownership resolver returned an invalid result.");
    }
    const ownedIds = new Set([
      ...this.ownedSessionIds,
      ...persistedIds.map(optionalText).filter(Boolean)
    ]);
    const seen = new Set();
    for (const sessionId of ownedIds) {
      try {
        const payload = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
        const summary = openClackySessionSummary(payload?.session ?? payload);
        if (summary.external.sessionId !== sessionId) {
          throw new Error(`OpenClacky returned Session ${summary.external.sessionId} for ${sessionId}.`);
        }
        seen.add(sessionId);
        this.sessions.set(sessionId, summary);
      } catch (error) {
        if (error.statusCode === 404) continue;
        throw error;
      }
    }
    for (const id of this.sessions.keys()) {
      if (!seen.has(id)) this.sessions.delete(id);
    }
    const signature = JSON.stringify(this.list().map((session) => [session.id, session.status, session.updatedAt]));
    const changed = signature !== this.lastSnapshotSignature;
    this.lastSnapshotSignature = signature;
    this.connectionErrorMessage = null;
    if (changed) this.onSessionChanged?.({ type: "refreshed" });
    return this.list();
  }

  async create(input = {}) {
    const body = {
      name: requiredText(input.title ?? input.name ?? "OpenClacky", "title"),
      working_dir: requiredText(input.cwd, "cwd"),
      agent_profile: optionalText(input.agentProfile) ?? "coding"
    };
    if (optionalText(input.model)) body.model_id = optionalText(input.model);
    const payload = await this.request("/api/sessions", { method: "POST", body });
    const row = payload?.session ?? payload;
    const summary = openClackySessionSummary(row);
    const sessionId = summary.external.sessionId;
    this.ownedSessionIds.add(sessionId);
    this.sessions.set(sessionId, summary);
    this.ensureSocket(sessionId);
    const prompt = optionalText(input.prompt);
    if (prompt) this.sendSocket(sessionId, { type: "message", session_id: sessionId, content: prompt });
    this.onSessionChanged?.({ type: "created", session: summary });
    return summary;
  }

  async read(sessionId) {
    const [sessionPayload, messagePayload] = await Promise.all([
      this.request(`/api/sessions/${encodeURIComponent(sessionId)}`),
      this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`)
    ]);
    const row = sessionPayload?.session ?? sessionPayload;
    const summary = openClackySessionSummary(row);
    const events = Array.isArray(messagePayload) ? messagePayload : messagePayload?.events ?? [];
    const detail = openClackySessionDetail(summary, events);
    this.sessions.set(sessionId, summary);
    this.details.set(sessionId, detail);
    this.ensureSocket(sessionId);
    return detail;
  }

  async resume(sessionId) {
    await this.read(sessionId);
    return this.sessions.get(sessionId);
  }

  async delete(sessionId) {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    this.sockets.get(sessionId)?.close?.();
    this.sockets.delete(sessionId);
    this.ownedSessionIds.delete(sessionId);
    this.sessions.delete(sessionId);
    this.details.delete(sessionId);
    this.onSessionChanged?.({ type: "deleted", sessionId });
    return true;
  }

  async rename(sessionId, title) {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: { name: requiredText(title, "title") }
    });
    return this.refreshOne(sessionId);
  }

  async send(sessionId, message) {
    this.sendSocket(sessionId, {
      type: "message",
      session_id: sessionId,
      content: requiredText(message, "message")
    });
    return { queued: true };
  }

  async interrupt(sessionId) {
    this.sendSocket(sessionId, { type: "interrupt", session_id: sessionId });
    return { interrupted: true };
  }

  async respondToApproval(sessionId, approval = {}) {
    const id = requiredText(approval.id ?? approval.choiceId, "approval.id");
    const result = approval.result ?? (approval.approved === true ? "yes" : "no");
    this.sendSocket(sessionId, { type: "confirmation", session_id: sessionId, id, result });
    return { accepted: true };
  }

  async listModels() {
    const payload = await this.request("/api/config");
    const currentId = optionalText(payload?.current_id);
    return {
      currentModel: currentId,
      currentReasoningLevel: null,
      models: (Array.isArray(payload?.models) ? payload.models : []).map((model) => ({
        id: String(model.id),
        name: optionalText(model.model) ?? String(model.id),
        description: optionalText(model.provider_id),
        defaultReasoningLevel: null,
        reasoningLevels: ["off", "low", "medium", "high", "xhigh", "max"]
      }))
    };
  }

  async switchModel(sessionId, modelId) {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: "PATCH",
      body: { model_id: requiredText(modelId, "modelId") }
    });
    return this.refreshOne(sessionId);
  }

  async switchReasoning(sessionId, reasoningLevel) {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/reasoning_effort`, {
      method: "PATCH",
      body: { reasoning_effort: requiredText(reasoningLevel, "reasoningLevel") }
    });
    return this.refreshOne(sessionId);
  }

  async refreshOne(sessionId) {
    const payload = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const summary = openClackySessionSummary(payload?.session ?? payload);
    this.sessions.set(sessionId, summary);
    this.onSessionChanged?.({ type: "updated", session: summary });
    return summary;
  }

  ensureSocket(sessionId) {
    const existing = this.sockets.get(sessionId);
    if (existing && existing.readyState < 2) return existing;
    if (typeof this.WebSocket !== "function") {
      throw new Error("This Node.js runtime does not provide WebSocket support.");
    }
    const url = new URL("/ws", this.baseURL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.accessKey) url.searchParams.set("access_key", this.accessKey);
    const socket = new this.WebSocket(url);
    socket.__corptieQueue = [{ type: "subscribe", session_id: sessionId }];
    socket.addEventListener("open", () => this.flushSocket(socket));
    socket.addEventListener("message", (event) => this.handleSocketEvent(sessionId, event.data));
    socket.addEventListener("close", () => {
      if (this.sockets.get(sessionId) === socket) this.sockets.delete(sessionId);
    });
    this.sockets.set(sessionId, socket);
    return socket;
  }

  sendSocket(sessionId, message) {
    const socket = this.ensureSocket(sessionId);
    socket.__corptieQueue ??= [];
    socket.__corptieQueue.push(message);
    this.flushSocket(socket);
  }

  flushSocket(socket) {
    if (socket.readyState !== 1) return;
    for (const message of socket.__corptieQueue.splice(0)) socket.send(JSON.stringify(message));
  }

  handleSocketEvent(sessionId, raw) {
    let event;
    try {
      event = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      return;
    }
    if (event.type === "session_update") {
      const row = event.session ?? { ...(this.sessions.get(sessionId)?.external?.raw ?? {}), ...event, id: sessionId };
      const summary = openClackySessionSummary(row);
      this.sessions.set(sessionId, summary);
    }
    const current = this.details.get(sessionId);
    if (current) this.details.set(sessionId, appendOpenClackyEvent(current, event));
    this.onSessionChanged?.({ type: "event", sessionId, event, session: this.sessions.get(sessionId) });
  }

  async request(path, options = {}) {
    if (typeof this.fetch !== "function") throw new Error("OpenClacky Provider requires fetch support.");
    const headers = { accept: "application/json" };
    if (this.accessKey) headers.authorization = `Bearer ${this.accessKey}`;
    let body;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    let response;
    try {
      response = await this.fetch(new URL(path, this.baseURL), { method: options.method ?? "GET", headers, body });
    } catch (error) {
      throw new Error(`Cannot connect to OpenClacky at ${this.baseURL}: ${error.message}`);
    }
    const text = await response.text();
    const payload = text ? safeJson(text) : {};
    if (!response.ok) {
      const error = new Error(payload?.error ?? `OpenClacky request failed (${response.status}).`);
      error.statusCode = response.status;
      throw error;
    }
    return payload;
  }

  reportConnectionError(error) {
    if (this.connectionErrorMessage === error.message) return;
    this.connectionErrorMessage = error.message;
    this.onSessionChanged?.({ type: "connection-error", error });
  }
}

export function openClackySessionSummary(row = {}) {
  const id = requiredText(row.id ?? row.session_id, "OpenClacky session id");
  const status = openClackyStatus(row.status);
  const updatedAt = isoTimestamp(row.updated_at ?? row.created_at);
  const title = optionalText(row.name) ?? "OpenClacky";
  return {
    id: `openclacky:${id}`,
    title,
    agent: "OpenClacky",
    status,
    progress: status === "running" || status === "blocked" ? 0.5 : 1,
    summary: optionalText(row.error) ?? (status === "running" ? "OpenClacky is working…" : "OpenClacky is ready."),
    suggestedOptions: [],
    activityStatus: status === "running" ? "working" : status,
    capabilities: {
      canSend: status !== "running" && status !== "blocked",
      canSwitchModel: true,
      canSwitchReasoning: true,
      canInterrupt: status === "running",
      canReconnect: false
    },
    updatedAt,
    accent: "mint",
    archived: false,
    pinned: row.pinned === true,
    sortOrder: 0,
    avatarPath: null,
    external: {
      provider: "openclacky",
      threadId: id,
      sessionId: id,
      connectionStatus: "connected",
      currentModel: optionalText(row.model_id ?? row.model),
      currentReasoningLevel: optionalText(row.reasoning_effort),
      cwd: optionalText(row.working_dir),
      source: "openclacky",
      raw: row
    }
  };
}

export function openClackySessionDetail(summary, events = []) {
  const sessionId = summary.external.sessionId;
  const items = events.flatMap((event, index) => openClackyEventItems(sessionId, event, index));
  return {
    id: sessionId,
    title: summary.title,
    status: summary.status,
    source: "openclacky",
    connectionStatus: "connected",
    currentModel: summary.external.currentModel,
    currentReasoningLevel: summary.external.currentReasoningLevel,
    activityStatus: summary.activityStatus,
    cwd: summary.external.cwd,
    createdAt: isoTimestamp(summary.external.raw?.created_at),
    updatedAt: summary.updatedAt,
    canSend: summary.capabilities.canSend,
    sendUnavailableReason: summary.capabilities.canSend ? null : "OpenClacky is busy or waiting for confirmation.",
    capabilities: summary.capabilities,
    turnCount: Math.max(1, items.filter((item) => item.type === "userMessage").length),
    items
  };
}

function appendOpenClackyEvent(detail, event) {
  const items = openClackyEventItems(detail.id, event, detail.items.length);
  const status = event.type === "session_update"
    ? openClackyStatus(event.session?.status ?? event.status)
    : event.type === "request_confirmation"
      ? "blocked"
      : event.type === "task_finished" || event.type === "interrupted" ? "complete" : detail.status;
  return {
    ...detail,
    status,
    activityStatus: status === "running" ? "working" : status,
    updatedAt: new Date().toISOString(),
    canSend: status === "complete" || status === "failed",
    items: [...detail.items, ...items]
  };
}

function openClackyEventItems(sessionId, event, index) {
  const type = String(event?.type ?? "");
  const base = {
    id: String(event?.id ?? `${sessionId}:${index}:${type || "event"}`),
    turnId: String(event?.turn_id ?? `${sessionId}:turn`),
    turnStatus: "complete",
    title: "OpenClacky",
    createdAt: isoTimestamp(event?.created_at)
  };
  if (type === "history_user_message" || type === "user_message") {
    return [{ ...base, type: "userMessage", title: "You", text: String(event.content ?? "") }];
  }
  if (type === "assistant_message") {
    return [{ ...base, type: "agentMessage", text: String(event.content ?? "") }];
  }
  if (type === "tool_call") {
    return [{ ...base, type: "commandExecution", title: String(event.summary ?? event.name ?? "Tool"), text: stringify(event.args), status: "running" }];
  }
  if (type === "tool_result" || type === "tool_error") {
    return [{ ...base, type: "commandExecution", title: type === "tool_error" ? "Tool error" : "Tool result", text: stringify(event.result ?? event.error), status: type === "tool_error" ? "failed" : "complete" }];
  }
  if (type === "request_confirmation") {
    const options = [{ id: "yes", label: "Yes", role: "approve" }, { id: "no", label: "No", role: "deny" }];
    return [{ ...base, type: "choice", title: "Confirmation", text: String(event.message ?? ""), options, status: "pending" }];
  }
  if (type === "request_feedback") {
    const options = Array.isArray(event.options) ? event.options.map(String) : [];
    const optionText = options.length ? `\n\n${options.map((option) => `- ${option}`).join("\n")}` : "";
    return [{ ...base, type: "agentMessage", title: "Question", text: `${event.question ?? ""}${optionText}` }];
  }
  if (["error", "warning", "info"].includes(type)) {
    return [{ ...base, type: "system", title: type, text: String(event.message ?? event.error ?? "") }];
  }
  return [];
}

function openClackyStatus(value) {
  switch (String(value ?? "idle").toLowerCase()) {
    case "running":
    case "working": return "running";
    case "error":
    case "failed": return "failed";
    case "blocked":
    case "waiting": return "blocked";
    default: return "complete";
  }
}

function normalizedBaseURL(value) {
  const text = requiredText(value, "OpenClacky baseURL");
  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("OpenClacky baseURL must use http or https.");
  return url.toString().replace(/\/$/, "");
}

function requiredText(value, field) {
  const text = optionalText(value);
  if (!text) throw new TypeError(`${field} is required.`);
  return text;
}

function optionalText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function isoTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return { error: value }; }
}

function stringify(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? "", null, 2); } catch { return String(value ?? ""); }
}
