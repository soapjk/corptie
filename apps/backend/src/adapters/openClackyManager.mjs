import { randomUUID } from "node:crypto";
import { providerMessageWithSessionContext, userMessageWithoutSessionContext } from "../utils/sessionContextMessage.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:7070";

// Corptie bridge protocol version advertised by this adapter. OpenClacky runtimes
// below the minimum do not receive TOOL_HOST_ATTACH / WORKSPACE_TRANSITION and are
// presented as a restricted basic-chat Provider instead of claiming parity.
const CORPTIE_BRIDGE_PROTOCOL = "corptie-bridge-v1";
const MIN_BRIDGE_PROTOCOL = "corptie-bridge-v1";

export class OpenClackyManager {
  constructor(options = {}) {
    this.baseURL = normalizedBaseURL(options.baseURL ?? DEFAULT_BASE_URL);
    this.accessKey = optionalText(options.accessKey);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.onSessionChanged = options.onSessionChanged ?? null;
    this.resolveOwnedSessionIds = options.resolveOwnedSessionIds ?? (() => []);
    this.refreshIntervalMs = options.refreshIntervalMs ?? 10_000;
    // Corptie-owned isolated runtime options. When present, every created Session
    // is bootstrapped with the Corptie Agent identity, runtime instructions, scope
    // and permission boundary through the session bootstrap payload. The user's
    // native OpenClacky configuration is never mutated.
    this.runtimeDirectory = options.runtimeDirectory ?? null;
    this.systemPrompt = options.systemPrompt ?? null;
    this.runtimeInstructions = options.runtimeInstructions ?? null;
    this.resolveSessionBootstrap = options.resolveSessionBootstrap ?? null;
    // Optional bridge token provider. The token is injected by the host process and
    // must not be readable/forgeable by the model; it is bound to Session/Agent/
    // Objective/WorkItem/Workspace roots and re-verified by the Corptie server.
    this.issueToolHostToken = options.issueToolHostToken ?? null;
    this.onProbe = options.onProbe ?? null;
    this.featureFlags = {
      toolHostBridge: options.featureFlags?.toolHostBridge !== false,
      workspaceTransition: options.featureFlags?.workspaceTransition !== false,
      ...options.featureFlags
    };
    this.ownedSessionIds = new Set();
    this.sessions = new Map();
    this.details = new Map();
    this.sockets = new Map();
    this.eventCursors = new Map();
    this.deliveryAcks = new Map();
    this.refreshTimer = null;
    this.lastSnapshotSignature = null;
    this.connectionErrorMessage = null;
    // Runtime probe results. Null until the first successful probe.
    this.probe = null;
    this.probeError = null;
  }

  start() {
    void this.probeRuntime().catch((error) => this.reportConnectionError(error));
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

  // ---- Phase 0: version / bridge capability handshake ---------------------

  async probeRuntime() {
    const [health, version] = await Promise.all([
      this.requestOptional("/health"),
      this.requestOptional("/api/version")
    ]);
    const versionPayload = version?.payload ?? null;
    const bridgeProtocol = optionalText(
      versionPayload?.bridge_protocol
      ?? versionPayload?.corptie_bridge_protocol
      ?? versionPayload?.bridgeProtocol
    );
    const detectedVersion = optionalText(
      versionPayload?.version ?? versionPayload?.app_version ?? health?.payload?.version
    );
    const bridgeHealthy = Boolean(health?.ok) && bridgeProtocol === MIN_BRIDGE_PROTOCOL;
    const probe = {
      detectedAt: new Date().toISOString(),
      reachable: health?.ok === true,
      healthy: Boolean(health?.payload?.healthy ?? health?.ok === true),
      version: detectedVersion,
      bridgeProtocol,
      bridgeHealthy,
      capabilities: this.capabilitiesFromProbe(probeRuntimeResult(detectedVersion, bridgeProtocol, bridgeHealthy, this.featureFlags))
    };
    this.probe = probe;
    this.probeError = null;
    if (typeof this.onProbe === "function") {
      try { this.onProbe(probe); } catch { /* probe consumers must not break the manager */ }
    }
    return probe;
  }

  capabilitiesFromProbe(result) {
    return result;
  }

  async runtimeStatus() {
    if (this.probe) return { ...this.probe, error: this.probeError };
    try {
      return await this.probeRuntime();
    } catch (error) {
      this.probeError = error.message;
      return {
        detectedAt: new Date().toISOString(),
        reachable: false,
        healthy: false,
        version: null,
        bridgeProtocol: null,
        bridgeHealthy: false,
        error: error.message,
        capabilities: probeRuntimeResult(null, null, false, this.featureFlags)
      };
    }
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

  // ---- Session bootstrap: Corptie-owned isolated runtime ------------------

  async create(input = {}) {
    const body = {
      name: requiredText(input.title ?? input.name ?? "OpenClacky", "title"),
      working_dir: requiredText(input.cwd, "cwd"),
      agent_profile: optionalText(input.agentProfile) ?? "coding"
    };
    if (optionalText(input.model)) body.model_id = optionalText(input.model);
    // Inject the Corptie Agent system prompt, runtime instructions, scope identity
    // and permission boundary when a session bootstrap is available. This is the
    // trusted session contract; it never mutates the user's native configuration.
    const bootstrap = await this.buildSessionBootstrap(input);
    if (bootstrap) Object.assign(body, bootstrap.body ?? {});
    const payload = await this.request("/api/sessions", { method: "POST", body });
    const row = payload?.session ?? payload;
    const summary = openClackySessionSummary(row, { bootstrap: bootstrap?.summary ?? null });
    const sessionId = summary.external.sessionId;
    this.ownedSessionIds.add(sessionId);
    this.sessions.set(sessionId, summary);
    this.ensureSocket(sessionId);
    const prompt = optionalText(input.prompt);
    if (prompt) this.sendSocket(sessionId, { type: "message", session_id: sessionId, content: prompt });
    this.onSessionChanged?.({ type: "created", session: summary });
    return summary;
  }

  async buildSessionBootstrap(input = {}) {
    if (typeof this.resolveSessionBootstrap !== "function") {
      return this.staticSessionBootstrap(input);
    }
    return this.resolveSessionBootstrap(input);
  }

  staticSessionBootstrap(input = {}) {
    const systemPrompt = optionalText(input.systemPrompt ?? this.systemPrompt);
    const runtimeInstructions = optionalText(input.runtimeInstructions ?? this.runtimeInstructions);
    const runtimeDirectory = optionalText(input.runtimeDirectory ?? this.runtimeDirectory);
    const metadata = input.metadata ?? null;
    if (!systemPrompt && !runtimeInstructions && !runtimeDirectory && !metadata) return null;
    const body = {};
    if (runtimeDirectory) body.runtime_directory = runtimeDirectory;
    if (systemPrompt) body.system_prompt_append = systemPrompt;
    if (runtimeInstructions) body.runtime_instructions = runtimeInstructions;
    if (metadata) body.corptie_metadata = metadata;
    return {
      body,
      summary: {
        hasSystemPrompt: Boolean(systemPrompt),
        hasRuntimeInstructions: Boolean(runtimeInstructions),
        runtimeDirectory,
        scope: metadata ?? null
      }
    };
  }

  // ---- Read / paginated history -------------------------------------------

  async read(sessionId) {
    const [sessionPayload, messagePayload] = await Promise.all([
      this.request(`/api/sessions/${encodeURIComponent(sessionId)}`),
      this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`)
    ]);
    const row = sessionPayload?.session ?? sessionPayload;
    const summary = openClackySessionSummary(row);
    const page = normalizeMessagePage(messagePayload);
    const events = page.events;
    const detail = openClackySessionDetail(summary, events);
    this.sessions.set(sessionId, summary);
    this.details.set(sessionId, detail);
    if (page.cursor) this.eventCursors.set(sessionId, page.cursor);
    this.ensureSocket(sessionId);
    return detail;
  }

  // Fetch the complete (paginated) history for a session, following `before` /
  // `has_more` cursors. Deduplicates by stable event id and preserves ordering.
  async readHistory(sessionId, options = {}) {
    const maxPages = options.maxPages ?? 200;
    const events = [];
    const seen = new Set();
    let before = options.before ?? null;
    let hasMore = true;
    let pageCount = 0;
    while (hasMore && pageCount < maxPages) {
      const query = new URLSearchParams({ limit: "100" });
      if (before) query.set("before", before);
      const payload = await this.request(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`
      );
      const page = normalizeMessagePage(payload);
      for (const event of page.events) {
        const id = stableEventId(event, events.length + seen.size);
        if (seen.has(id)) continue;
        seen.add(id);
        events.push(event);
      }
      hasMore = page.hasMore === true;
      before = page.cursor ?? null;
      if (!before) hasMore = false;
      pageCount += 1;
    }
    events.reverse();
    return { events, hasMore, cursor: before };
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
    this.eventCursors.delete(sessionId);
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

  // ---- Delivery with acknowledgement --------------------------------------

  // `send` assigns a Corptie turn id and returns it with the acknowledgement state.
  // A message is only confirmed once the provider acks it or a matching history
  // event is observed; otherwise the delivery stays `unknown` (never falsely "ok").
  async send(sessionId, message, context = {}) {
    const userMessage = requiredText(message, "message");
    const contextPrompt = optionalText(context.sessionContext?.prompt);
    const turnId = context.turnId ?? `openclacky:turn:${randomUUID()}`;
    const content = providerMessageWithSessionContext(userMessage, contextPrompt);
    const socket = this.ensureSocket(sessionId);
    const accepted = this.sendSocket(sessionId, {
      type: "message",
      session_id: sessionId,
      turn_id: turnId,
      content
    });
    const result = accepted
      ? { queued: true, turnId, delivery: "accepted" }
      : { queued: false, turnId, delivery: "unknown" };
    this.deliveryAcks.set(sessionId, { ...this.deliveryAcks.get(sessionId), [turnId]: result });
    return result;
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

  // ---- Tool Host bridge (corptie_call) ------------------------------------

  // The OpenClacky bridge exposes a single `corptie_call` tool that forwards the
  // invocation to the Provider-neutral Tool Host. It is only attached when the
  // runtime handshake confirmed bridge support (TOOL_HOST_ATTACH capability).
  buildToolHostAttachment(tools = []) {
    return {
      kind: "corptie_call",
      tools: tools.map((tool) => ({ ...tool }))
    };
  }

  // ---- WebSocket: reconnect with backoff, resubscribe, replay -------------

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
    socket.__corptieSessionId = sessionId;
    socket.__corptieQueue = [{ type: "subscribe", session_id: sessionId }];
    socket.__corptieReconnectAttempts = 0;
    socket.addEventListener("open", () => {
      socket.__corptieReconnectAttempts = 0;
      this.flushSocket(socket);
    });
    socket.addEventListener("message", (event) => this.handleSocketEvent(sessionId, event.data));
    socket.addEventListener("close", () => {
      if (this.sockets.get(sessionId) === socket) this.sockets.delete(sessionId);
      this.scheduleReconnect(sessionId, socket);
    });
    this.sockets.set(sessionId, socket);
    return socket;
  }

  scheduleReconnect(sessionId, socket) {
    if (!this.ownedSessionIds.has(sessionId)) return;
    const attempt = (socket.__corptieReconnectAttempts ?? 0) + 1;
    socket.__corptieReconnectAttempts = attempt;
    const delayMs = Math.min(30_000, 500 * (2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 500));
    const timer = setTimeout(() => {
      if (this.ownedSessionIds.has(sessionId) && !this.sockets.has(sessionId)) {
        this.ensureSocket(sessionId);
        void this.replayMissedEvents(sessionId);
      }
    }, delayMs);
    timer.unref?.();
  }

  async replayMissedEvents(sessionId) {
    const cursor = this.eventCursors.get(sessionId);
    if (!cursor) return;
    try {
      const { events } = await this.readHistory(sessionId, { before: cursor });
      const current = this.details.get(sessionId);
      if (current) {
        let next = current;
        for (const event of events) {
          next = appendOpenClackyEvent(next, event);
        }
        this.details.set(sessionId, next);
      }
    } catch {
      // Best-effort replay; the next full read will reconcile.
    }
  }

  sendSocket(sessionId, message) {
    const socket = this.ensureSocket(sessionId);
    socket.__corptieQueue ??= [];
    socket.__corptieQueue.push(message);
    return this.flushSocket(socket);
  }

  flushSocket(socket) {
    if (socket.readyState !== 1) return false;
    for (const message of socket.__corptieQueue.splice(0)) socket.send(JSON.stringify(message));
    return true;
  }

  handleSocketEvent(sessionId, raw) {
    let event;
    try {
      event = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      return;
    }
    // Acknowledged delivery: when the provider echoes a turn id or a user message
    // with our turn id, mark the delivery as confirmed.
    this.confirmDelivery(sessionId, event);
    if (event.type === "session_update") {
      const row = event.session ?? { ...(this.sessions.get(sessionId)?.external?.raw ?? {}), ...event, id: sessionId };
      const summary = openClackySessionSummary(row);
      this.sessions.set(sessionId, summary);
    }
    const current = this.details.get(sessionId);
    if (current) this.details.set(sessionId, appendOpenClackyEvent(current, event));
    const id = stableEventId(event);
    if (id) this.eventCursors.set(sessionId, id);
    this.onSessionChanged?.({ type: "event", sessionId, event, session: this.sessions.get(sessionId) });
  }

  confirmDelivery(sessionId, event) {
    const turnId = optionalText(event?.turn_id ?? event?.ack_turn_id ?? event?.turnId);
    if (!turnId) return;
    const acks = this.deliveryAcks.get(sessionId);
    const pending = acks?.[turnId];
    if (pending) {
      pending.delivery = "confirmed";
      pending.confirmedAt = new Date().toISOString();
    }
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

  // Non-throwing variant for optional probe endpoints.
  async requestOptional(path) {
    try {
      return { ok: true, payload: await this.request(path) };
    } catch (error) {
      if (error.statusCode === 404) return { ok: false, payload: null };
      throw error;
    }
  }

  reportConnectionError(error) {
    if (this.connectionErrorMessage === error.message) return;
    this.connectionErrorMessage = error.message;
    this.onSessionChanged?.({ type: "connection-error", error });
  }
}

// The `deliveryAcks` map is initialized in the constructor; no prototype patch needed.

// Derive the runtime capability snapshot from the probe result. Older runtimes or
// unhealthy bridges degrade to basic chat only (no Tool Host, no Workspace
// transition) so the UI can show a clear restricted reason instead of a false
// parity claim.
export function probeRuntimeResult(version, bridgeProtocol, bridgeHealthy, flags = {}) {
  const bridgeCapable = bridgeHealthy === true;
  return {
    toolHost: Boolean(flags.toolHostBridge) && bridgeCapable,
    workspaceTransition: Boolean(flags.workspaceTransition) && bridgeCapable,
    version,
    bridgeProtocol,
    bridgeHealthy,
    restricted: !bridgeCapable,
    restrictedReason: bridgeCapable ? null : "OpenClacky bridge is unavailable or outdated; basic chat only."
  };
}

// ---- Event / history normalization ----------------------------------------

function normalizeMessagePage(payload) {
  if (Array.isArray(payload)) return { events: payload, hasMore: false, cursor: null };
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return {
    events,
    hasMore: payload?.has_more === true || payload?.hasMore === true,
    cursor: optionalText(payload?.next_cursor ?? payload?.cursor ?? payload?.before)
  };
}

// Stable event id: prefer the upstream id; otherwise derive a deterministic id from
// a stable key (session + index + type + created_at) so replay/dedup is reliable.
function stableEventId(event, fallbackIndex = 0) {
  const upstream = optionalText(event?.id ?? event?.event_id);
  if (upstream) return upstream;
  const sessionId = optionalText(event?.session_id);
  const createdAt = optionalText(event?.created_at);
  const type = String(event?.type ?? "event");
  const turnId = optionalText(event?.turn_id);
  return [sessionId, turnId, type, createdAt, fallbackIndex].filter(Boolean).join(":");
}

export function openClackySessionSummary(row = {}, options = {}) {
  const id = requiredText(row.id ?? row.session_id, "OpenClacky session id");
  const status = openClackyStatus(row.status);
  const updatedAt = isoTimestamp(row.updated_at ?? row.created_at);
  const title = optionalText(row.name) ?? "OpenClacky";
  const bootstrap = options.bootstrap ?? null;
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
    restricted: Boolean(bootstrap?.restricted),
    restrictedReason: bootstrap?.restrictedReason ?? null,
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
  const items = [];
  let currentTurnId = null;
  for (const [index, event] of events.entries()) {
    const explicitTurnId = optionalText(event?.turn_id);
    if (explicitTurnId) {
      currentTurnId = explicitTurnId;
    } else if (!currentTurnId || isOpenClackyUserEvent(event)) {
      currentTurnId = fallbackOpenClackyTurnId(sessionId, index);
    }
    items.push(...openClackyEventItems(sessionId, event, index, currentTurnId));
  }
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
    usage: summary.external.raw?.usage ?? null,
    turnCount: Math.max(1, items.filter((item) => item.type === "userMessage").length),
    items
  };
}

function appendOpenClackyEvent(detail, event) {
  const index = detail.items.length;
  const explicitTurnId = optionalText(event?.turn_id);
  const fallbackTurnId = explicitTurnId
    ?? (isOpenClackyUserEvent(event)
      ? fallbackOpenClackyTurnId(detail.id, index)
      : detail.items.at(-1)?.turnId ?? fallbackOpenClackyTurnId(detail.id, index));
  const items = openClackyEventItems(detail.id, event, index, fallbackTurnId);
  const status = event.type === "session_update"
    ? openClackyStatus(event.session?.status ?? event.status)
    : event.type === "request_confirmation"
      ? "blocked"
      : event.type === "task_finished" || event.type === "interrupted" ? "complete" : detail.status;
  const usage = mergeUsage(detail.usage, event);
  return {
    ...detail,
    status,
    activityStatus: status === "running" ? "working" : status,
    updatedAt: new Date().toISOString(),
    canSend: status === "complete" || status === "failed",
    usage,
    items: [...detail.items, ...items]
  };
}

function mergeUsage(current, event) {
  if (event?.type !== "token_usage" || !event.usage) return current;
  const incoming = event.usage;
  const prev = current && typeof current === "object" ? current : {};
  return {
    ...prev,
    inputTokens: (prev.inputTokens ?? 0) + Number(incoming.input_tokens ?? incoming.prompt_tokens ?? 0),
    outputTokens: (prev.outputTokens ?? 0) + Number(incoming.output_tokens ?? incoming.completion_tokens ?? 0),
    totalTokens: (prev.totalTokens ?? 0) + Number(incoming.total_tokens ?? incoming.input_tokens ?? 0) + Number(incoming.output_tokens ?? 0),
    cacheReadInputTokens: (prev.cacheReadInputTokens ?? 0) + Number(incoming.cache_read_input_tokens ?? 0)
  };
}

function openClackyEventItems(sessionId, event, index, fallbackTurnId) {
  const type = String(event?.type ?? "");
  const base = {
    id: String(event?.id ?? stableEventId(event, index)),
    turnId: String(event?.turn_id ?? fallbackTurnId ?? fallbackOpenClackyTurnId(sessionId, index)),
    turnStatus: "complete",
    title: "OpenClacky",
    createdAt: isoTimestamp(event?.created_at)
  };
  if (type === "history_user_message" || type === "user_message") {
    return [{ ...base, type: "userMessage", title: "You", text: userMessageWithoutSessionContext(event.content) }];
  }
  if (type === "assistant_message") {
    return [{ ...base, type: "agentMessage", text: String(event.content ?? "") }];
  }
  if (type === "tool_call") {
    return [{ ...base, type: "commandExecution", title: String(event.summary ?? event.name ?? "Tool"), text: stringify(event.args), status: "running" }];
  }
  if (type === "tool_result") {
    return [{ ...base, type: "commandExecution", title: "Tool result", text: stringify(event.result), status: "complete" }];
  }
  if (type === "tool_error") {
    return [{ ...base, type: "commandExecution", title: "Tool error", text: stringify(event.error ?? event.message), status: "failed" }];
  }
  if (type === "request_confirmation") {
    const options = [{ id: "yes", label: "Yes", role: "approve" }, { id: "no", label: "No", role: "deny" }];
    return [{ ...base, type: "choice", title: "Confirmation", text: String(event.message ?? ""), options, status: "pending" }];
  }
  if (type === "request_feedback") {
    const options = Array.isArray(event.options) ? event.options.map(String) : [];
    const optionText = options.length ? `\n\n${options.map((option) => `- ${option}`).join("\n")}` : "";
    return [{ ...base, type: "agentMessage", title: "Question", text: `${event.question ?? ""}${optionText}`, feedback: { requestId: optionalText(event.id) } }];
  }
  if (type === "feedback") {
    return [{ ...base, type: "system", title: "Feedback", text: stringify(event.feedback ?? event.value ?? event.content) }];
  }
  if (type === "subagent_start") {
    return [{ ...base, type: "system", title: "Subagent", text: `Subagent started: ${String(event.name ?? event.subagent_id ?? "")}` }];
  }
  if (type === "subagent_end") {
    return [{ ...base, type: "system", title: "Subagent", text: "Subagent finished." }];
  }
  if (type === "token_usage") {
    // Usage is aggregated on the detail; it is not a visible chat item.
    return [];
  }
  if (type === "task_finished") {
    return [{ ...base, type: "system", title: "Task finished", text: String(event.message ?? event.summary ?? "") }];
  }
  if (["error", "warning", "info"].includes(type)) {
    return [{ ...base, type: "system", title: type, text: String(event.message ?? event.error ?? "") }];
  }
  return [];
}

function isOpenClackyUserEvent(event) {
  return event?.type === "history_user_message" || event?.type === "user_message";
}

function fallbackOpenClackyTurnId(sessionId, index) {
  return `${sessionId}:turn:${index + 1}`;
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
