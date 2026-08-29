import { randomUUID } from "node:crypto";
import { providerMessageWithSessionContext } from "../utils/sessionContextMessage.mjs";

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
    this.onDetailChanged = options.onDetailChanged ?? null;
    this.resolveOwnedSessionIds = options.resolveOwnedSessionIds ?? (() => []);
    // Corptie-owned isolated runtime options. When present, every created Session
    // is bootstrapped with the Corptie Agent identity, runtime instructions, scope
    // and permission boundary through the session bootstrap payload. The user's
    // native OpenClacky configuration is never mutated.
    this.runtimeDirectory = options.runtimeDirectory ?? null;
    this.systemPrompt = options.systemPrompt ?? null;
    this.runtimeInstructions = options.runtimeInstructions ?? null;
    this.resolveSessionBootstrap = options.resolveSessionBootstrap ?? null;
    this.ensureRuntime = options.ensureRuntime ?? null;
    this.stopRuntime = options.stopRuntime ?? null;
    // Optional bridge token provider. The token is injected by the host process and
    // must not be readable/forgeable by the model; it is bound to Session/Agent/
    // Objective/WorkItem/Workspace roots and re-verified by the Corptie server.
    this.issueToolHostToken = options.issueToolHostToken ?? null;
    this.onToolCall = options.onToolCall ?? null;
    this.onProbe = options.onProbe ?? null;
    this.featureFlags = {
      toolHostBridge: options.featureFlags?.toolHostBridge !== false,
      workspaceTransition: options.featureFlags?.workspaceTransition !== false,
      ...options.featureFlags
    };
    this.ownedSessionIds = new Set();
    this.sessions = new Map();
    this.sockets = new Map();
    this.eventCursors = new Map();
    this.deliveryAcks = new Map();
    this.toolHosts = new Map();
    this.connectionErrorMessage = null;
    // Runtime probe results. Null until the first successful probe.
    this.probe = null;
    this.probeError = null;
  }

  start() {
    void this.probeRuntime().catch((error) => this.reportConnectionError(error));
    Promise.resolve(this.resolveOwnedSessionIds()).then((sessionIds) => {
      for (const sessionId of Array.isArray(sessionIds) ? sessionIds : []) {
        const id = optionalText(sessionId);
        if (!id) continue;
        this.ownedSessionIds.add(id);
        this.ensureSocket(id);
      }
    }).catch((error) => this.reportConnectionError(error));
    return this;
  }

  stop() {
    // Clear ownership before closing sockets so their close callbacks cannot
    // schedule reconnect timers after the backend has begun shutting down.
    this.ownedSessionIds.clear();
    for (const socket of this.sockets.values()) socket.close?.();
    this.sockets.clear();
    this.stopRuntime?.();
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

  // ---- Session bootstrap: Corptie-owned isolated runtime ------------------

  async create(input = {}) {
    const modelId = await this.resolveCreateModelId(optionalText(input.model));
    const body = {
      name: requiredText(input.title ?? input.name ?? "OpenClacky", "title"),
      working_dir: requiredText(input.cwd, "cwd"),
      agent_profile: optionalText(input.agentProfile) ?? "coding"
    };
    if (modelId) body.model_id = modelId;
    // Inject the Corptie Agent system prompt, runtime instructions, scope identity
    // and permission boundary when a session bootstrap is available. This is the
    // trusted session contract; it never mutates the user's native configuration.
    const bootstrap = await this.buildSessionBootstrap(input);
    if (bootstrap) Object.assign(body, bootstrap.body ?? {});
    const toolHost = await this.prepareToolHost(input.toolHost);
    if (toolHost) body.corptie_tool_host = toolHost.manifest;
    const payload = await this.request("/api/sessions", { method: "POST", body });
    const row = payload?.session ?? payload;
    const summary = openClackySessionSummary(row, { bootstrap: bootstrap?.summary ?? null });
    const sessionId = summary.external.sessionId;
    if (toolHost) this.toolHosts.set(sessionId, toolHost.context);
    this.ownedSessionIds.add(sessionId);
    this.sessions.set(sessionId, summary);
    this.ensureSocket(sessionId);
    // Session creation can succeed at the HTTP layer while OpenClacky fails its
    // asynchronous workspace/bootstrap initialization. Read the authoritative
    // Session once before returning so the route coordinator never commits a
    // failed target binding as if it were ready.
    const initialized = await this.refreshOne(sessionId);
    const prompt = optionalText(input.prompt);
    if (prompt) this.sendSocket(sessionId, { type: "message", session_id: sessionId, content: prompt });
    this.onSessionChanged?.({ type: "created", session: initialized });
    return initialized;
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

  async resume(sessionId, options = {}) {
    const toolHost = await this.prepareToolHost(options.toolHost);
    if (toolHost) {
      await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/corptie/tool-host`, {
        method: "POST",
        body: toolHost.manifest
      });
      this.toolHosts.set(sessionId, toolHost.context);
    }
    this.ownedSessionIds.add(sessionId);
    this.ensureSocket(sessionId);
    return this.sessions.get(sessionId) ?? {
      id: `openclacky:${sessionId}`,
      external: { provider: "openclacky", sessionId }
    };
  }

  async delete(sessionId) {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    this.sockets.get(sessionId)?.close?.();
    this.sockets.delete(sessionId);
    this.ownedSessionIds.delete(sessionId);
    this.sessions.delete(sessionId);
    this.eventCursors.delete(sessionId);
    this.toolHosts.delete(sessionId);
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
    const session = await this.refreshOne(sessionId);
    assertOpenClackySessionRunnable(session);
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
      ? { queued: true, turn: { id: turnId }, turnId, delivery: "accepted" }
      : { queued: false, turn: { id: turnId }, turnId, delivery: "unknown" };
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

  async resolveCreateModelId(requestedModelId) {
    if (!requestedModelId) return null;
    const payload = await this.request("/api/config");
    const models = Array.isArray(payload?.models) ? payload.models : [];
    if (models.some((model) => optionalText(model.id) === requestedModelId)) return requestedModelId;
    // OpenClacky 1.x synthesizes model UUIDs at process startup. A Corptie
    // binding may therefore hold a valid model selection whose transient id
    // changed when the managed Provider daemon restarted. In that case the
    // Provider's persisted current model is authoritative.
    return optionalText(payload?.current_id) ?? optionalText(models[0]?.id);
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
    const row = payload?.session ?? payload;
    const summary = openClackySessionSummary(row);
    this.sessions.set(sessionId, summary);
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

  async prepareToolHost(toolHost) {
    const attachment = toolHost?.providerAttachment;
    if (!attachment || attachment.kind !== "corptie_call" || !Array.isArray(attachment.tools)) return null;
    if (!toolHost.actorId) throw new Error("OpenClacky Tool Host requires a trusted Agent identity.");
    const metadata = attachment.metadata ?? toolHost.metadata ?? null;
    const issued = typeof this.issueToolHostToken === "function"
      ? await this.issueToolHostToken({ actorId: toolHost.actorId, metadata })
      : randomUUID();
    const token = optionalText(issued?.token ?? issued);
    if (!token) throw new Error("OpenClacky Tool Host token provider returned an empty token.");
    return {
      manifest: {
        protocol: CORPTIE_BRIDGE_PROTOCOL,
        kind: "corptie_call",
        token,
        tools: attachment.tools.map((tool) => ({ ...tool }))
      },
      context: {
        token,
        actorId: toolHost.actorId,
        metadata,
        tools: new Set(attachment.tools.map((tool) => tool.name))
      }
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
    const cursor = this.eventCursors.get(sessionId) ?? null;
    socket.__corptieQueue = [{
      type: "subscribe",
      session_id: sessionId,
      ...(cursor ? { cursor, after: cursor } : {})
    }];
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
      }
    }, delayMs);
    timer.unref?.();
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
    if (event.type === "corptie_tool_call") {
      void this.handleBridgeToolCall(sessionId, event);
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
    const nextDetail = null;
    const currentSummary = this.sessions.get(sessionId);
    if (currentSummary) {
      const status = nextDetail?.status ?? openClackyEventStatus(event, currentSummary.status);
      const latestAgentText = nextDetail?.items?.findLast?.((item) => item.type === "agentMessage")?.text
        ?? (event.type === "assistant_message" ? optionalText(event.content) : null);
      const updatedAt = isoTimestamp(event?.created_at, new Date().toISOString());
      this.sessions.set(sessionId, {
        ...currentSummary,
        status,
        progress: status === "running" || status === "blocked" ? 0.5 : 1,
        summary: latestAgentText || currentSummary.summary,
        activityStatus: status === "running" ? "working" : status,
        updatedAt,
        lastMessageAt: updatedAt,
        capabilities: {
          ...currentSummary.capabilities,
          canSend: status === "complete" || status === "failed",
          canInterrupt: status === "running"
        }
      });
    }
    const id = stableEventId(event);
    if (id) this.eventCursors.set(sessionId, id);
    const hasAgentMessage = event.type === "task_finished"
      && Boolean(nextDetail?.items?.findLast?.((item) =>
        item.type === "agentMessage"
        && typeof item.text === "string"
        && item.text.trim().length > 0
      ));
    this.onSessionChanged?.({
      type: "event",
      sessionId,
      event,
      detail: nextDetail,
      session: this.sessions.get(sessionId),
      hasAgentMessage
    });
  }

  async handleBridgeToolCall(sessionId, event) {
    const context = this.toolHosts.get(sessionId);
    const callId = optionalText(event?.call_id ?? event?.id);
    const tool = optionalText(event?.tool ?? event?.name);
    const respond = (payload) => this.sendSocket(sessionId, {
      type: "corptie_tool_result",
      session_id: sessionId,
      call_id: callId,
      ...payload
    });
    try {
      if (!context || !callId || event?.token !== context.token) {
        const error = new Error("OpenClacky Tool Host call has invalid or expired Session credentials.");
        error.code = "TOOL_HOST_UNAUTHORIZED";
        throw error;
      }
      if (!tool || !context.tools.has(tool)) {
        const error = new Error(`OpenClacky Tool Host tool is not attached: ${tool ?? "unknown"}.`);
        error.code = "HOST_TOOL_UNSUPPORTED";
        throw error;
      }
      if (typeof this.onToolCall !== "function") {
        const error = new Error("OpenClacky Tool Host callback is unavailable.");
        error.code = "TOOL_HOST_UNAVAILABLE";
        throw error;
      }
      const result = await this.onToolCall({
        actorId: context.actorId,
        metadata: context.metadata,
        tool,
        arguments: event.arguments ?? {}
      });
      respond({ success: true, result });
    } catch (error) {
      respond({
        success: false,
        error: { code: error.code ?? "TOOL_HOST_FAILED", message: error.message }
      });
    }
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
    if (typeof this.ensureRuntime === "function") await this.ensureRuntime();
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
  const failureMessage = status === "failed"
    ? optionalText(row.error ?? row.raw_message) ?? "OpenClacky Session initialization or execution failed."
    : null;
  return {
    id: `openclacky:${id}`,
    title,
    agent: "OpenClacky",
    status,
    progress: status === "running" || status === "blocked" ? 0.5 : 1,
    summary: failureMessage ?? (status === "running" ? "OpenClacky is working…" : "OpenClacky is ready."),
    sendUnavailableReason: failureMessage,
    suggestedOptions: [],
    activityStatus: status === "running" ? "working" : status,
    capabilities: {
      canSend: status === "complete",
      canSwitchModel: true,
      canSwitchReasoning: true,
      canInterrupt: status === "running",
      canReconnect: false
    },
    updatedAt,
    // OpenClacky exposes one provider activity timestamp rather than separate
    // input/output timestamps; project it through the shared Session contract.
    lastMessageAt: updatedAt,
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

function assertOpenClackySessionRunnable(session) {
  if (session?.status !== "failed") return session;
  const detail = optionalText(session.sendUnavailableReason ?? session.summary)
    ?? "OpenClacky Session initialization or execution failed.";
  const error = new Error(`OpenClacky cannot process this message: ${detail}`);
  error.code = "PROVIDER_SESSION_UNAVAILABLE";
  error.statusCode = 409;
  error.providerId = "openclacky";
  error.providerSessionId = session?.external?.sessionId ?? null;
  // This check runs before the realtime message is written, so the shared
  // application layer may safely replace the failed physical Provider Session
  // and retry the same durable Delivery exactly once.
  error.dispatchState = "not_sent";
  error.recoveryAction = "replace_provider_binding";
  throw error;
}

function openClackyEventStatus(event, fallback) {
  switch (String(event?.type ?? "")) {
    case "task_finished":
    case "interrupted":
      return "complete";
    case "request_confirmation":
    case "request_feedback":
      return "blocked";
    case "error":
      return "failed";
    case "assistant_message":
    case "tool_call":
    case "tool_result":
    case "tool_error":
    case "subagent_start":
      return fallback === "blocked" ? "blocked" : "running";
    default:
      return fallback;
  }
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

function isoTimestamp(value, fallback = new Date().toISOString()) {
  if (value === null || value === undefined || value === "") return fallback;
  let normalized = value;
  if (typeof value === "number" || (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const magnitude = Math.abs(numeric);
    // Date expects milliseconds. OpenClacky currently emits Unix seconds, but
    // accept millisecond/microsecond/nanosecond epochs as well so the provider
    // boundary remains tolerant of upstream serialization changes.
    normalized = magnitude < 1e11
      ? numeric * 1_000
      : magnitude < 1e14
        ? numeric
        : magnitude < 1e17
          ? numeric / 1_000
          : numeric / 1_000_000;
  }
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return { error: value }; }
}
