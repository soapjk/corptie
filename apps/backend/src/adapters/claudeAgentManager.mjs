import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { forkSession, query } from "@anthropic-ai/claude-agent-sdk";
import { createdAtFromOrNow } from "../utils/timestamps.mjs";
import { providerRawMetadataJSON } from "../utils/providerRawMetadata.mjs";
import { defaultWorkspacePath } from "../utils/workspacePaths.mjs";
import { providerMessageWithSessionContext } from "../utils/sessionContextMessage.mjs";
import {
  claudeConnectionTestOptions,
  claudeRuntimeEnvironment,
  claudeSdkResultError,
  normalizeClaudeProviderError
} from "../agent-provider/providers/claudeProviderConfiguration.mjs";

export class ClaudeAgentManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.store = options.store ?? null;
    this.maxItems = options.maxItems ?? 2_000;
    this.onTurnSettled = options.onTurnSettled ?? null;
    this.onProviderEvent = options.onProviderEvent ?? null;
    this.resolveRuntimeOptions = options.resolveRuntimeOptions ?? null;
    this.queryFactory = options.query ?? query;
    this.environment = options.environment ?? (() => process.env);
  }

  start(input = {}) {
    const id = input.id || randomUUID();
    const createdAt = createdAtFromOrNow();
    const hasInitialPrompt = typeof input.prompt === "string" && input.prompt.trim().length > 0;
    const session = {
      id,
      title: shortTitle(input.title || input.prompt || "Claude Code"),
      agentName: "Claude Code",
      sessionKind: input.sessionKind ?? null,
      provider: "claude-sdk",
      accent: "amber",
      command: "claude-sdk",
      args: [],
      cwd: input.cwd || defaultWorkspacePath(),
      sandbox: input.sandbox ?? "workspace-write",
      approvalPolicy: input.approvalPolicy ?? "on-request",
      permissionMode: claudePermissionMode(input.sandbox, input.approvalPolicy),
      createdAt,
      updatedAt: createdAt,
      status: hasInitialPrompt ? "running" : "complete",
      archived: input.archived === true,
      pinned: input.pinned === true,
      sortOrder: input.sortOrder ?? null,
      agentSessionId: input.agentSessionId ?? null,
      currentModel: input.model ?? null,
      currentReasoningLevel: normalizeClaudeEffortLevel(input.reasoningLevel),
      initialPrompt: input.prompt ?? "",
      phase: "ready",
      connectionReady: true,
      lastInputAt: null,
      lastOutputAt: null,
      nextItemSeq: Number(input.nextItemSeq ?? 1),
      nextTurnSeq: Number(input.nextTurnSeq ?? 1),
      currentTurnId: input.currentTurnId ?? null,
      items: Array.isArray(input.items) ? input.items.slice(-this.maxItems) : [],
      pendingChoice: null,
      pendingDecision: null,
      pendingChoices: new Map(),
      query: null,
      queryTask: null,
      queryClosed: false,
      interruptRequested: false,
      activeTaskIds: new Set(),
      deferredResult: null,
      lastResult: null,
      turnState: "idle",
      inputQueue: [],
      inputResolvers: [],
      streamingAssistant: null
    };
    session.runtimeOptions = normalizeClaudeRuntimeOptions({
      ...(input.runtimeOptions ?? {}),
      ...(input.toolHost?.providerAttachment ?? {}),
      ...(Array.isArray(input.runtimeWorkspaceRoots)
        ? { additionalDirectories: input.runtimeWorkspaceRoots }
        : {})
    });
    if (typeof input.recoveryContext === "string" && input.recoveryContext.trim()) {
      const current = session.runtimeOptions.systemPrompt;
      const base = current?.type === "preset"
        ? current
        : { type: "preset", preset: "claude_code", append: typeof current === "string" ? current : "" };
      session.runtimeOptions.systemPrompt = {
        ...base,
        append: [base.append, input.recoveryContext.trim()].filter(Boolean).join("\n\n")
      };
    }
    this.sessions.set(id, session);
    console.log(`[claude-sdk] session created id=${id} cwd=${session.cwd}`);
    if (hasInitialPrompt) {
      void this.send(id, input.prompt.trim());
    }
    return this.toSessionSummary(session);
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  has(id) {
    return Boolean(this.get(id));
  }

  rename(id, title) {
    const nextTitle = shortTitle(title);
    const session = this.get(id);
    if (session) {
      session.title = nextTitle;
      session.updatedAt = new Date().toISOString();
      return this.toSessionSummary(session);
    }
    const stored = this.store?.getSession(id) ?? null;
    return stored ? { ...stored, title: nextTitle, updatedAt: new Date().toISOString() } : null;
  }

  detail(id) {
    const session = this.get(id);
    return session ? this.toDetail(session) : (this.store?.getDetail(id) ?? null);
  }

  async read(id) {
    if (!this.get(id)) {
      await this.reconnect(id, { startQuery: false });
    }
    return this.detail(id);
  }

  async readSessionUsage(id) {
    try {
      const session = await this.sessionForOperation(id);
      const query = await this.ensureQueryStarted(session);
      if (typeof query?.getContextUsage !== "function") return null;
      const usage = await query.getContextUsage();
      const usedTokens = finiteNumber(usage?.totalTokens);
      const contextWindow = finiteNumber(usage?.maxTokens);
      if (usedTokens === null || contextWindow === null || contextWindow <= 0) return null;
      return {
        usedTokens,
        contextWindow,
        remainingTokens: Math.max(0, contextWindow - usedTokens),
        usedPercent: finiteNumber(usage?.percentage)
          ?? Math.max(0, Math.min(100, usedTokens / contextWindow * 100))
      };
    } catch (error) {
      const failure = normalizeClaudeProviderError(error, {
        secretValues: [this.environment()?.ANTHROPIC_API_KEY].filter(Boolean)
      });
      console.log(`[claude-sdk] context usage unavailable id=${id} code=${failure.code}`);
      return null;
    }
  }

  async readAccountUsage(id) {
    try {
      const session = await this.sessionForOperation(id);
      const query = await this.ensureQueryStarted(session);
      const readUsage = query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof readUsage !== "function") return unavailableClaudeAccountUsage(session.currentModel);
      return normalizeClaudeAccountUsage(await readUsage.call(query), session.currentModel);
    } catch (error) {
      const failure = normalizeClaudeProviderError(error, {
        secretValues: [this.environment()?.ANTHROPIC_API_KEY].filter(Boolean)
      });
      console.log(`[claude-sdk] account usage unavailable id=${id} code=${failure.code}`);
      return unavailableClaudeAccountUsage(this.get(id)?.currentModel);
    }
  }

  async testConnection(configuration = {}) {
    const startedAt = Date.now();
    const resolved = claudeConnectionTestOptions(configuration, {
      environment: this.environment()
    });
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), resolved.timeoutMs);
    let operation = null;
    try {
      operation = this.queryFactory({
        prompt: "Reply with OK.",
        options: { ...resolved.queryOptions, abortController }
      });
      let providerSessionId = null;
      let model = resolved.validation.configuration.model;
      for await (const message of operation) {
        providerSessionId = message?.session_id ?? providerSessionId;
        if (message?.type === "system" && message?.subtype === "init") {
          model = message.model ?? model;
        }
        if (message?.type === "assistant" && message?.error) {
          throw { code: message.error, status: message.api_error_status };
        }
        if (message?.type === "result") {
          const failure = claudeSdkResultError(message, { secretValues: resolved.secretValues });
          if (failure) throw failure;
          return {
            ok: true,
            provider: "claude-sdk",
            model: model ?? null,
            providerSessionId,
            durationMs: Date.now() - startedAt,
            authentication: resolved.validation.configuration.apiKey
          };
        }
      }
      throw new Error("Claude connection closed before returning a result.");
    } catch (error) {
      throw normalizeClaudeProviderError(error, { secretValues: resolved.secretValues });
    } finally {
      clearTimeout(timeout);
      try {
        await operation?.close?.();
      } catch {
        // Connection-test cleanup is best effort; the classified request result
        // remains authoritative and no secret-bearing cleanup error is surfaced.
      }
    }
  }

  async send(id, message, options = {}) {
    const session = this.get(id);
    if (!session) {
      throw new Error("Claude session not found");
    }
    if (hasPendingChoices(session)) {
      throw new Error("Claude is waiting for your approval choice");
    }
    if (session.turnState === "running") {
      throw new Error("Claude session is still processing the previous request");
    }
    const value = String(typeof message === "string" ? message : message?.text ?? "").trim();
    const images = Array.isArray(message?.images) ? message.images : [];
    if (!value && images.length === 0) {
      throw new Error("Input text or an image is required");
    }

    await this.ensureQueryStarted(session);
    session.interruptRequested = false;
    session.activeTaskIds.clear();
    session.deferredResult = null;
    session.lastResult = null;
    session.streamingAssistant = null;
    session.status = "running";
    session.phase = "input_sent";
    session.turnState = "running";
    session.currentTurnId = options.turnId ?? `${session.id}:turn:${session.nextTurnSeq++}`;
    if (options.turnId) session.nextTurnSeq += 1;
    session.lastInputAt = new Date().toISOString();
    session.updatedAt = session.lastInputAt;
    if (options.localVisibility !== "status_only") {
      this.appendItem(session, {
        type: "userMessage",
        title: "User",
        text: value,
        status: "sent"
      });
    }
    this.emitProviderEvent(session, {
      type: "turn.started",
      turnId: session.currentTurnId,
      occurredAt: session.updatedAt
    });
    console.log(`[claude-sdk] send queued id=${id} chars=${value.length}`);
    const providerValue = providerMessageWithSessionContext(value, options.contextPrompt);
    this.enqueueInput(session, await makeUserMessage(providerValue, images));
    return this.toSessionSummary(session);
  }

  async switchWorkspace(id, cwd) {
    const session = await this.sessionForOperation(id);
    if (session.turnState !== "idle") {
      const error = new Error("Claude must finish the active turn before switching workspaces.");
      error.code = "SESSION_BUSY";
      throw error;
    }
    await this.closeIdleQuery(session);
    if (session.agentSessionId) {
      const forked = await forkSession(session.agentSessionId, { dir: session.cwd, title: session.title });
      session.agentSessionId = forked.sessionId;
    }
    session.cwd = cwd;
    session.updatedAt = new Date().toISOString();
    session.phase = "ready";
    session.status = "complete";
    return this.toSessionSummary(session);
  }

  async switchModel(id, model) {
    const session = this.get(id);
    if (!session) {
      throw new Error("Claude session not found");
    }
    const nextModel = String(model ?? "").trim();
    if (!nextModel) {
      throw new Error("Model is required");
    }
    session.currentModel = nextModel;
    session.updatedAt = new Date().toISOString();
    if (session.query) {
      await session.query.setModel(nextModel);
    }
    this.appendItem(session, {
      type: "system",
      title: "Claude Code",
      text: `Switched Claude model to ${nextModel}.`
    });
    return this.toSessionSummary(session);
  }

  async switchReasoning(id, level) {
    const session = await this.sessionForOperation(id);
    const nextLevel = normalizeClaudeEffortLevel(level);
    if (!nextLevel) {
      throw new Error("Unsupported Claude reasoning level");
    }
    if (session.turnState === "running") {
      const error = new Error("Claude must finish the active turn before switching reasoning effort.");
      error.code = "SESSION_BUSY";
      throw error;
    }
    // An idle Query is recreated cheaply so the next instruction launches with
    // the new effort level; a live Query applies it through flag settings.
    if (session.query) {
      await session.query.applyFlagSettings({ effortLevel: nextLevel });
    }
    session.currentReasoningLevel = nextLevel;
    session.updatedAt = new Date().toISOString();
    this.appendItem(session, {
      type: "system",
      title: "Claude Code",
      text: `Switched Claude reasoning effort to ${nextLevel}.`
    });
    return this.toSessionSummary(session);
  }

  async updatePermissions(id, permissions = {}) {
    const session = await this.sessionForOperation(id);
    const sandbox = String(permissions.sandbox ?? "").trim();
    const approvalPolicy = String(permissions.approvalPolicy ?? "").trim();
    if (!["workspace-write", "danger-full-access", "read-only"].includes(sandbox)) {
      throw new Error("Unsupported sandbox mode");
    }
    if (!["on-request", "ask-risky", "never", "on-failure"].includes(approvalPolicy)) {
      throw new Error("Unsupported approval policy");
    }

    const permissionMode = claudePermissionMode(sandbox, approvalPolicy);
    if (session.turnState === "idle") {
      // An idle Query can be recreated cheaply, ensuring all launch-time
      // permission flags match before the next instruction.
      await this.closeIdleQuery(session);
    } else {
      if (!session.query) {
        throw new Error("Claude session is not connected");
      }
      await session.query.setPermissionMode(permissionMode);
      this.applyPermissionModeToPendingChoices(session, permissionMode);
    }
    session.sandbox = sandbox;
    session.approvalPolicy = approvalPolicy;
    session.permissionMode = permissionMode;
    session.updatedAt = new Date().toISOString();
    return this.toSessionSummary(session);
  }

  async interrupt(id) {
    const session = this.get(id);
    if (!session) {
      throw new Error("Claude session not found");
    }
    if (!session.query && session.turnState === "idle" && session.status !== "running") {
      throw new Error("Claude session is not active");
    }
    const query = session.query;
    const queryTask = session.queryTask;
    session.interruptRequested = true;
    if (query) {
      try {
        await query.interrupt();
      } catch (error) {
        // Closing the Query below is the authoritative cancellation path. The
        // SDK can reject interrupt() when its child process has already exited.
        const failure = normalizeClaudeProviderError(error, {
          secretValues: [this.environment()?.ANTHROPIC_API_KEY].filter(Boolean)
        });
        console.warn(`[claude-sdk] interrupt request failed id=${session.id} code=${failure.code}`);
      }

      // Claude background agents share the Query stream with their parent turn.
      // Interrupting only the foreground turn can leave those agents alive, so
      // close the entire stream and resume it lazily on the next user message.
      session.queryClosed = true;
      session.inputQueue = [];
      for (const resolve of session.inputResolvers.splice(0)) resolve(null);
      try {
        // Claude Agent SDK's Query.close() currently returns void, while some
        // test doubles and older versions return a Promise. `await` supports
        // both contracts; calling `.catch()` on the void result does not.
        await query.close();
      } catch (error) {
        const failure = normalizeClaudeProviderError(error, {
          secretValues: [this.environment()?.ANTHROPIC_API_KEY].filter(Boolean)
        });
        console.warn(`[claude-sdk] query close failed id=${session.id} code=${failure.code}`);
      }
      if (queryTask) await queryTask.catch(() => {});
      session.query = null;
      session.queryTask = null;
      session.queryClosed = false;
    }
    this.resolveAllPendingChoices(session, "Claude Code turn interrupted in Corptie.");
    session.pendingChoice = null;
    session.pendingDecision = null;
    session.pendingChoices?.clear();
    session.activeTaskIds.clear();
    session.deferredResult = null;
    session.lastResult = null;
    session.streamingAssistant = null;
    session.interruptRequested = false;
    session.turnState = "idle";
    session.phase = "ready";
    session.status = "complete";
    session.updatedAt = new Date().toISOString();
    this.appendItem(session, {
      type: "system",
      title: "Claude Code",
      text: "Interrupted current Claude Code turn."
    });
    this.notifyTurnSettled(session, {
      turnId: session.currentTurnId,
      status: "cancelled",
      error: null
    });
    return this.toSessionSummary(session);
  }

  async clear(id) {
    const session = await this.sessionForOperation(id);
    if (session.turnState === "running") {
      const error = new Error("The current task is still running. Stop it before using /clear.");
      error.code = "SESSION_BUSY";
      throw error;
    }

    this.resolveAllPendingChoices(session, "Conversation cleared in Corptie.");
    await this.closeIdleQuery(session);

    const clearedAt = new Date().toISOString();
    session.agentSessionId = null;
    session.initialPrompt = "";
    session.status = "complete";
    session.phase = "ready";
    session.turnState = "idle";
    session.currentTurnId = null;
    session.items = [];
    session.nextItemSeq = 1;
    session.nextTurnSeq = 1;
    session.pendingChoice = null;
    session.pendingDecision = null;
    session.pendingChoices.clear();
    session.query = null;
    session.queryTask = null;
    session.queryClosed = false;
    session.interruptRequested = false;
    session.activeTaskIds.clear();
    session.deferredResult = null;
    session.lastResult = null;
    session.streamingAssistant = null;
    session.lastInputAt = null;
    session.lastOutputAt = null;
    session.updatedAt = clearedAt;
    return this.toSessionSummary(session);
  }

  async sessionForOperation(id) {
    let session = this.get(id);
    if (!session) {
      await this.reconnect(id);
      session = this.get(id);
    }
    if (!session) throw new Error("Claude session not found");
    return session;
  }

  async closeIdleQuery(session) {
    session.queryClosed = true;
    session.inputQueue = [];
    for (const resolve of session.inputResolvers.splice(0)) resolve(null);
    const query = session.query;
    const queryTask = session.queryTask;
    if (query) await query.close();
    if (queryTask) await queryTask.catch(() => {});
    session.query = null;
    session.queryTask = null;
    session.queryClosed = false;
  }

  async close() {
    for (const session of this.sessions.values()) {
      this.resolveAllPendingChoices(session, "Corptie Backend is restarting for Data Root migration.");
      await this.closeIdleQuery(session);
      session.turnState = "idle";
    }
    this.sessions.clear();
  }

  applyPermissionModeToPendingChoices(session, permissionMode) {
    if (!hasPendingChoices(session) || !["bypassPermissions", "dontAsk"].includes(permissionMode)) {
      return;
    }
    const allow = permissionMode === "bypassPermissions";
    const decisions = new Set(session.pendingChoices.values());
    if (session.pendingDecision) decisions.add(session.pendingDecision);
    for (const pendingDecision of decisions) {
      pendingDecision.resolve(allow
        ? { behavior: "allow" }
        : { behavior: "deny", message: "The updated Claude permission mode does not allow this pending action." });
    }
    session.pendingChoices.clear();
    session.pendingChoice = null;
    session.pendingDecision = null;
    session.items = session.items.map((item) => item.type === "choice" && item.status === "pending"
      ? { ...item, status: allow ? "allowed" : "denied" }
      : item);
    session.turnState = "running";
    session.phase = "working";
    session.status = "running";
  }

  terminate(id) {
    const session = this.get(id);
    if (!session) {
      return null;
    }
    this.resolveAllPendingChoices(session, "Session terminated in Corptie.");
    session.queryClosed = true;
    session.turnState = "idle";
    session.status = "cancelled";
    session.phase = "cancelled";
    session.updatedAt = new Date().toISOString();
    session.query?.close();
    session.query = null;
    this.appendItem(session, {
      type: "system",
      title: "Claude Code",
      text: "Closed Claude Code session."
    });
    return this.toSessionSummary(session);
  }

  delete(id) {
    const session = this.get(id);
    if (session) {
      session.queryClosed = true;
      this.resolveAllPendingChoices(session, "Session deleted in Corptie.");
      session.query?.close();
      session.query = null;
      this.sessions.delete(id);
    }
  }

  async disconnect(id) {
    const session = this.get(id);
    if (!session) return { status: "disconnected" };
    if (session.turnState !== "idle" || session.currentTurnId) {
      const error = new Error("Claude Session still has an active Turn.");
      error.code = "SESSION_BUSY";
      throw error;
    }
    this.resolveAllPendingChoices(session, "Session runtime released after archival.");
    await this.closeIdleQuery(session);
    this.sessions.delete(id);
    return { status: "disconnected" };
  }

  async reconnect(id, options = {}) {
    if (this.get(id)) {
      const session = this.get(id);
      if (options.runtimeOptions) {
        const nextRuntimeOptions = normalizeClaudeRuntimeOptions(options.runtimeOptions);
        if (JSON.stringify(session.runtimeOptions ?? {}) !== JSON.stringify(nextRuntimeOptions)) {
          if (session.turnState !== "idle" || session.currentTurnId) {
            const error = new Error("Claude Tool configuration cannot refresh during an active Turn.");
            error.code = "PROVIDER_TOOL_REFRESH_DURING_TURN";
            throw error;
          }
          const previousQuery = session.query;
          const previousQueryTask = session.queryTask;
          session.queryClosed = true;
          await previousQuery?.close?.();
          if (previousQueryTask) await previousQueryTask.catch(() => {});
          if (session.query === previousQuery) session.query = null;
          if (session.queryTask === previousQueryTask) session.queryTask = null;
          session.runtimeOptions = nextRuntimeOptions;
        }
        if (options.startQuery !== false) await this.ensureQueryStarted(session);
      }
      return this.toSessionSummary(session);
    }
    const stored = this.store?.getSession(id);
    if (!stored || stored.external?.provider !== "claude-sdk") {
      return null;
    }
    const raw = stored.rawStatus ?? {};
    const agentSessionId = stored.external?.agentSessionId ?? raw.agentSessionId ?? null;
    const session = {
      id,
      title: stored.title || "Claude Code",
      agentName: stored.agent || "Claude Code",
      sessionKind: stored.sessionKind,
      provider: "claude-sdk",
      accent: stored.accent || "amber",
      command: "claude-sdk",
      args: [],
      cwd: stored.external?.cwd || raw.cwd || defaultWorkspacePath(),
      sandbox: raw.sandbox ?? "workspace-write",
      approvalPolicy: raw.approvalPolicy ?? "on-request",
      permissionMode: raw.permissionMode ?? claudePermissionMode(raw.sandbox, raw.approvalPolicy),
      createdAt: stored.createdAt,
      updatedAt: new Date().toISOString(),
      status: ["running", "blocked", "failed", "cancelled"].includes(stored.status)
        ? "complete"
        : stored.status,
      archived: stored.archived === true,
      pinned: stored.pinned === true,
      sortOrder: stored.sortOrder ?? null,
      agentSessionId,
      currentModel: stored.external?.currentModel ?? raw.currentModel ?? null,
      currentReasoningLevel: normalizeClaudeEffortLevel(
        stored.external?.currentReasoningLevel ?? raw.currentReasoningLevel
      ),
      initialPrompt: raw.initialPrompt ?? "",
      phase: agentSessionId ? "reconnecting" : "ready",
      connectionReady: true,
      lastInputAt: raw.lastInputAt ?? null,
      lastOutputAt: raw.lastOutputAt ?? null,
      nextItemSeq: Number(raw.nextItemSeq ?? 1),
      nextTurnSeq: Number(raw.nextTurnSeq ?? 1),
      currentTurnId: raw.currentTurnId ?? null,
      items: [],
      pendingChoice: null,
      pendingDecision: null,
      pendingChoices: new Map(),
      query: null,
      queryTask: null,
      queryClosed: false,
      interruptRequested: false,
      activeTaskIds: new Set(),
      deferredResult: null,
      lastResult: null,
      turnState: "idle",
      inputQueue: [],
      inputResolvers: [],
      streamingAssistant: null
    };
    session.runtimeOptions = options.runtimeOptions
      ? normalizeClaudeRuntimeOptions(options.runtimeOptions)
      : null;
    const storedItems = this.store?.getItems(id, this.maxItems, "claude-sdk") ?? [];
    // Product history is Corptie-owned. Reconnect restores only the durable
    // Corptie Timeline and never imports the Provider-native transcript.
    session.items = storedItems.slice(-this.maxItems);
    session.nextItemSeq = Math.max(session.nextItemSeq, nextSeqFromItems(session.items));
    session.nextTurnSeq = Math.max(session.nextTurnSeq, nextTurnSeqFromItems(session.id, session.items));
    this.sessions.set(id, session);
    const startQuery = options.startQuery !== false;
    console.log(`[claude-sdk] reconnecting id=${id} resume=${agentSessionId ?? "fresh"} startQuery=${startQuery}`);
    if (agentSessionId && startQuery) void this.ensureQueryStarted(session);
    return this.toSessionSummary(session);
  }

  async probeBinding(id) {
    await this.reconnect(id, { startQuery: false });
    const session = this.get(id);
    if (!session) {
      const error = new Error("Claude Provider Session was not found.");
      error.code = "PROVIDER_SESSION_UNAVAILABLE";
      throw error;
    }
    // Starting the SDK query is Claude's concrete resume/readiness boundary.
    // It performs no Turn and consumes no user message.
    await this.ensureQueryStarted(session);
    return { ready: true, providerSessionId: id };
  }

  respondToChoice(id, input = {}) {
    const session = this.get(id);
    if (!session) {
      throw new Error("Claude session not found");
    }
    const choiceId = String(input.choiceId || input.itemId || "").trim();
    const pendingDecision = choiceId
      ? session.pendingChoices?.get(choiceId)
      : latestPendingDecision(session);
    const options = pendingDecision?.choice?.options ?? [];
    const optionIndex = Number.isInteger(input.optionIndex)
      ? input.optionIndex
      : options.findIndex((option) => option.id === input.optionId);
    const option = optionIndex >= 0 ? options[optionIndex] : null;
    if (!option || !pendingDecision) {
      if (choiceId && isChoiceItemAlreadyHandled(session, choiceId)) {
        return this.toSessionSummary(session);
      }
      throw new Error("No active Claude choice prompt");
    }

    if (pendingDecision.choice.kind === "ask-user" && advanceAskUserChoice(session, pendingDecision, option, this)) {
      return this.toSessionSummary(session);
    }

    const resolution = optionResolution(pendingDecision.choice, option);
    console.log(`[claude-sdk] choice selected id=${id} choiceId=${pendingDecision.choice.id ?? ""} option=${option.id} behavior=${resolution.behavior} updatedPermissions=${Array.isArray(resolution.updatedPermissions) ? resolution.updatedPermissions.length : 0}`);
    pendingDecision.resolve(resolution);
    session.pendingChoices?.delete(pendingDecision.choice.id);
    session.pendingChoice = latestPendingChoice(session);
    session.pendingDecision = latestPendingDecision(session);
    session.turnState = hasPendingChoices(session) ? "requires_action" : "running";
    session.phase = hasPendingChoices(session) ? "waiting_approval" : "working";
    session.updatedAt = new Date().toISOString();
    this.markPendingChoiceItemsSelected(session, option.id, pendingDecision.choice.id);
    return this.toSessionSummary(session);
  }

  async ensureQueryStarted(session) {
    if (session.query) return session.query;
    if (session.queryStartTask) return session.queryStartTask;
    const startTask = (async () => {
      if (session.query) return session.query;
      console.log(`[claude-sdk] query starting id=${session.id} resume=${session.agentSessionId ?? ""}`);
      session.queryClosed = false;
      const permissionOptions = claudePermissionOptions(session);
      const runtimeOptions = await this.runtimeOptionsFor(session);
      session.query = this.queryFactory({
        prompt: this.inputStream(session),
        options: {
          cwd: session.cwd,
          resume: session.agentSessionId || undefined,
          persistSession: true,
          model: session.currentModel || undefined,
          effort: session.currentReasoningLevel || undefined,
          env: claudeRuntimeEnvironment(this.environment()),
          includePartialMessages: true,
          ...runtimeOptions,
          ...permissionOptions,
          canUseTool: async (toolName, input, options) => this.handleToolRequest(session, toolName, input, options)
        }
      });
      session.queryTask = this.consumeQuery(session);
      return session.query;
    })();
    session.queryStartTask = startTask;
    try {
      return await startTask;
    } finally {
      if (session.queryStartTask === startTask) session.queryStartTask = null;
    }
  }

  async runtimeOptionsFor(session) {
    if (session.runtimeOptions) return session.runtimeOptions;
    if (typeof this.resolveRuntimeOptions !== "function") return {};
    session.runtimeOptions = normalizeClaudeRuntimeOptions(
      await this.resolveRuntimeOptions(session.id)
    );
    return session.runtimeOptions;
  }

  async consumeQuery(session) {
    try {
      for await (const message of session.query) {
        this.handleSdkMessage(session, message);
      }
      console.log(`[claude-sdk] query ended id=${session.id} status=${session.status} turnState=${session.turnState}`);
      if (!session.queryClosed) {
        session.query = null;
        session.queryTask = null;
        session.turnState = "idle";
        session.phase = session.status === "failed" ? "failed" : "ready";
        session.updatedAt = new Date().toISOString();
      }
    } catch (error) {
      const failure = normalizeClaudeProviderError(error, {
        secretValues: [this.environment()?.ANTHROPIC_API_KEY].filter(Boolean)
      });
      console.error(`[claude-sdk] query failed id=${session.id} code=${failure.code} retryable=${failure.retryable}`);
      const wasInterrupted = session.interruptRequested === true;
      session.query = null;
      session.queryTask = null;
      this.resolveAllPendingChoices(session, wasInterrupted
        ? "Claude Code turn interrupted in Corptie."
        : "Claude Code query failed before the permission request was answered.");
      session.pendingChoice = null;
      session.pendingDecision = null;
      session.turnState = "idle";
      session.interruptRequested = false;
      session.status = wasInterrupted ? "complete" : (session.status === "cancelled" ? "cancelled" : "failed");
      session.phase = wasInterrupted ? "ready" : "failed";
      session.updatedAt = new Date().toISOString();
      if (!wasInterrupted) {
        this.appendItem(session, {
          type: "system",
          title: "Claude Code",
          text: failure.message,
          status: "failed"
        });
      }
      this.notifyTurnSettled(session, {
        turnId: session.currentTurnId,
        status: wasInterrupted ? "cancelled" : "failed",
        error: wasInterrupted ? null : {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable
        }
      });
    }
  }

  async runBackgroundPrompt(input = {}) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), input.timeoutMs ?? 120_000);
    let latestText = "";
    try {
      const operation = this.queryFactory({
        prompt: input.prompt,
        options: {
          cwd: input.cwd,
          persistSession: false,
          model: input.model || undefined,
          env: claudeRuntimeEnvironment(this.environment()),
          permissionMode: "plan",
          maxTurns: 1,
          abortController
        }
      });
      for await (const message of operation) {
        if (message?.type === "assistant") {
          latestText = assistantText(message.message) || latestText;
        }
        if (message?.type === "result") {
          const failure = claudeSdkResultError(message, {
            secretValues: [this.environment()?.ANTHROPIC_API_KEY].filter(Boolean)
          });
          if (failure) throw failure;
          latestText = (typeof message.result === "string" ? message.result.trim() : "") || latestText;
        }
      }
      return { text: latestText };
    } catch (error) {
      throw normalizeClaudeProviderError(error, {
        secretValues: [this.environment()?.ANTHROPIC_API_KEY].filter(Boolean)
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async handleToolRequest(session, toolName, input, options = {}) {
    console.log(`[claude-sdk] tool request id=${session.id} tool=${toolName} requestId=${options.requestId ?? ""} toolUseID=${options.toolUseID ?? ""} suggestions=${Array.isArray(options?.suggestions) ? options.suggestions.length : 0}`);
    const choice = buildToolChoice(toolName, input, options);
    if (!choice) {
      return { behavior: "allow" };
    }

    session.turnState = "requires_action";
    session.phase = "waiting_approval";
    const choiceId = `${session.id}:choice:${session.nextItemSeq}`;
    choice.id = choiceId;
    session.pendingChoice = choice;
    session.updatedAt = new Date().toISOString();
    this.appendItem(session, {
      id: choiceId,
      type: "choice",
      title: choice.title,
      text: choice.text,
      status: "pending",
      options: choice.options
    });

    return await new Promise((resolve) => {
      const pendingDecision = { resolve, choice };
      session.pendingChoices.set(choice.id, pendingDecision);
      session.pendingDecision = pendingDecision;
    });
  }

  handleSdkMessage(session, message) {
    session.updatedAt = new Date().toISOString();
    console.log(`[claude-sdk] message id=${session.id} type=${message?.type ?? "unknown"} subtype=${message?.subtype ?? ""}`);
    if (message?.session_id && !session.agentSessionId) {
      session.agentSessionId = message.session_id;
    }

    if (message?.type === "system" && message?.subtype === "init") {
      session.agentSessionId = message.session_id ?? session.agentSessionId;
      session.currentModel = message.model ?? session.currentModel;
      session.phase = "ready";
      return;
    }

    if (message?.type === "stream_event") {
      this.handleStreamEvent(session, message);
      return;
    }

    if (message?.type === "assistant") {
      if (session.lastResult && session.turnState !== "running") {
        // A foreground result is not necessarily the end of the Query. Claude
        // can continue streaming assistant/tool events from a background Agent.
        session.deferredResult = session.lastResult;
        session.turnState = "running";
        session.status = "running";
        session.phase = "working";
      }
      const items = claudeAssistantContentItems(message.message);
      if (items.length > 0) {
        session.lastOutputAt = session.updatedAt;
        const finalText = items.filter((item) => item.type === "agentMessage")
          .map((item) => item.text)
          .join("\n\n")
          .trim();
        if (session.streamingAssistant && finalText) {
          this.updateStreamingAssistant(session, finalText, { completed: true });
        } else {
          for (const item of items.filter((item) => item.type === "agentMessage")) {
            this.appendItem(session, item);
          }
        }
        for (const item of items.filter((item) => item.type !== "agentMessage")) {
          this.appendItem(session, item);
        }
      }
      return;
    }

    if (message?.type === "result") {
      const failure = claudeSdkResultError(message, {
        secretValues: [this.environment()?.ANTHROPIC_API_KEY].filter(Boolean)
      });
      const text = failure?.message
        ?? (typeof message.result === "string" ? message.result.trim() : "");
      session.pendingChoice = null;
      session.pendingDecision = null;
      session.pendingChoices?.clear();
      const wasInterrupted = session.interruptRequested === true;
      session.interruptRequested = false;
      const result = {
        turnId: session.currentTurnId,
        succeeded: !failure || wasInterrupted,
        text,
        failure,
        notified: false
      };
      session.lastResult = result;
      finalizeClaudeTurnItems(
        session,
        session.currentTurnId,
        result.succeeded ? "complete" : "failed"
      );
      if (text && !result.succeeded) {
        session.lastOutputAt = session.updatedAt;
        this.appendItem(session, {
          type: "system",
          title: "Claude Code",
          text,
          status: message.subtype || "result"
        });
      }
      if (session.activeTaskIds.size > 0) {
        session.deferredResult = result;
        session.turnState = "running";
        session.status = "running";
        session.phase = "working";
      } else {
        this.settleClaudeResult(session, result);
      }
      return;
    }

    if (message?.type === "status") {
      session.phase = message.status || session.phase;
      if (message.status === "requesting" || message.status === "compacting") {
        session.turnState = "running";
      }
      return;
    }

    if (message?.type === "session_state_changed") {
      session.turnState = message.state || session.turnState;
      session.phase = message.state || session.phase;
      return;
    }

    const taskSubtype = claudeTaskSubtype(message);
    if (taskSubtype) {
      const taskId = String(message?.task_id ?? message?.tool_use_id ?? "").trim();
      const terminal = isTerminalClaudeTaskMessage(message, taskSubtype);
      const blocksTurnSettlement = claudeTaskBlocksTurnSettlement(message);
      if (taskId) {
        if (terminal) session.activeTaskIds.delete(taskId);
        else if (blocksTurnSettlement) session.activeTaskIds.add(taskId);
      }
      if (!terminal && (!session.lastResult || blocksTurnSettlement)) {
        if (session.lastResult && !session.deferredResult) {
          session.deferredResult = session.lastResult;
        }
        session.turnState = "running";
        session.status = "running";
        session.phase = "working";
      }
      const text = taskMessageText(message);
      if (text && message?.skip_transcript !== true) {
        this.appendItem(session, {
          type: "mcpToolCall",
          title: message?.label || message?.subagent_type || "Claude task",
          text,
          status: terminal ? (message?.status === "failed" ? "failed" : "completed") : "running"
        });
      }
      if (terminal && session.activeTaskIds.size === 0 && session.deferredResult) {
        this.settleClaudeResult(session, session.deferredResult);
      } else {
      }
      return;
    }

    if (message?.type === "informational" || message?.type === "permission_denied") {
      const text = message.message || message.content || message.permission_denial_reason || "";
      if (text) {
        this.appendItem(session, {
          type: message?.type === "permission_denied" ? "warning" : "mcpToolCall",
          title: "Claude Code",
          text: String(text)
        });
      }
      return;
    }
  }

  settleClaudeResult(session, result) {
    session.deferredResult = null;
    session.turnState = "idle";
    session.phase = result.succeeded ? "ready" : "failed";
    session.status = result.succeeded ? "complete" : "failed";
    finalizeClaudeTurnItems(
      session,
      result.turnId,
      result.succeeded ? "complete" : "failed"
    );
    if (!result.notified) {
      result.notified = true;
      this.notifyTurnSettled(session, {
        turnId: result.turnId,
        status: result.succeeded ? "completed" : "failed",
        error: result.succeeded ? null : {
          code: result.failure?.code ?? "CLAUDE_REQUEST_FAILED",
          message: result.text,
          retryable: result.failure?.retryable === true
        }
      });
    }
  }

  handleStreamEvent(session, message) {
    const event = message?.event;
    if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
      const delta = typeof event.delta.text === "string" ? event.delta.text : "";
      if (!delta) return;
      const nextText = `${session.streamingAssistant?.text ?? ""}${delta}`;
      this.updateStreamingAssistant(session, nextText);
    }
  }

  updateStreamingAssistant(session, text, options = {}) {
    const value = String(text ?? "");
    if (!value) return null;
    const existing = session.streamingAssistant;
    if (!existing) {
      const item = this.appendItem(session, {
        id: `${session.id}:stream:${session.currentTurnId ?? session.nextTurnSeq}`,
        type: "agentMessage",
        title: "Claude Code",
        text: value,
        presentationRole: "commentary"
      });
      session.streamingAssistant = { itemId: item.id, text: value };
      return item;
    }
    const index = session.items.findIndex((item) => item.id === existing.itemId);
    if (index < 0) {
      session.streamingAssistant = null;
      return this.updateStreamingAssistant(session, value, options);
    }
    const item = {
      ...session.items[index],
      text: value,
      presentationRole: options.completed === true ? "final_answer" : "commentary"
    };
    session.items[index] = item;
    session.streamingAssistant = options.completed === true
      ? null
      : { itemId: item.id, text: value };
    this.emitProviderEvent(session, {
      type: options.completed === true ? "assistant.message.completed" : "assistant.message.delta",
      turnId: item.turnId,
      itemId: item.id,
      item,
      occurredAt: session.updatedAt
    });
    return item;
  }

  inputStream(session) {
    const manager = this;
    return {
      async *[Symbol.asyncIterator]() {
        while (!session.queryClosed) {
          const next = await manager.dequeueInput(session);
          if (next == null) {
            break;
          }
          yield next;
        }
      }
    };
  }

  enqueueInput(session, message) {
    if (session.inputResolvers.length > 0) {
      const resolve = session.inputResolvers.shift();
      resolve(message);
      return;
    }
    session.inputQueue.push(message);
  }

  dequeueInput(session) {
    if (session.inputQueue.length > 0) {
      return Promise.resolve(session.inputQueue.shift());
    }
    if (session.queryClosed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      session.inputResolvers.push(resolve);
    });
  }

  toDetail(session) {
    // A cancelled status settles the previous Turn; it does not close the
    // Corptie Session or invalidate its persisted Claude session id. A later
    // send lazily starts a new Query and resumes that same Provider Session.
    const canSend = session.turnState !== "running" && !hasPendingChoices(session);
    return {
      id: session.id,
      title: session.title,
      status: hasPendingChoices(session) ? "blocked" : session.status,
      source: "claude-sdk",
      connectionStatus: "connected",
      currentModel: session.currentModel ?? null,
      currentReasoningLevel: session.currentReasoningLevel ?? null,
      activityStatus: activityStatusForSession(session),
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archived: session.archived === true,
      rawStatus: {
        provider: session.provider,
        command: session.command,
        args: session.args,
        agentSessionId: session.agentSessionId,
        phase: session.phase,
        cwd: session.cwd,
        sandbox: session.sandbox,
        approvalPolicy: session.approvalPolicy,
        permissionMode: session.permissionMode,
        nextItemSeq: session.nextItemSeq,
        nextTurnSeq: session.nextTurnSeq,
        lastInputAt: session.lastInputAt,
        lastOutputAt: session.lastOutputAt,
        turnState: session.turnState,
        currentTurnId: session.currentTurnId,
        accent: session.accent
      },
      canSend,
      sendUnavailableReason: canSend ? null : (hasPendingChoices(session) ? "Claude is waiting for your approval choice." : unavailableReasonForSession(session)),
      capabilities: {
        canSend,
        canSwitchModel: true,
        canSwitchReasoning: true,
        canInterrupt: Boolean(session.query) && session.turnState === "running",
        canReconnect: false
      },
      turnCount: 1,
      items: visibleClaudeItems(session.items).slice(-this.maxItems)
    };
  }

  toSessionSummary(session) {
    const storedSession = this.store?.getSession(session.id);
    const detail = this.toDetail(session);
    const latest = lastMeaningfulText(detail.items);
    return {
      id: `pty:${session.id}`,
      title: session.title,
      agent: session.agentName,
      sessionKind: storedSession?.sessionKind ?? session.sessionKind ?? null,
      status: detail.status,
      progress: detail.status === "running" || detail.status === "blocked" ? 0.5 : 1,
      summary: latest || "Claude Code is ready.",
      suggestedOptions: latestSuggestedOptions(session.items),
      activityStatus: detail.activityStatus,
      capabilities: detail.capabilities,
      updatedAt: session.updatedAt,
      accent: session.accent,
      archived: session.archived === true,
      pinned: session.pinned === true || storedSession?.pinned === true,
      sortOrder: Number.isFinite(session.sortOrder) ? session.sortOrder : (storedSession?.sortOrder ?? 0),
      external: {
        provider: session.provider,
        threadId: session.id,
        sessionId: session.id,
        agentSessionId: session.agentSessionId,
        connectionStatus: detail.connectionStatus,
        currentModel: session.currentModel ?? null,
        currentReasoningLevel: session.currentReasoningLevel ?? null,
        cwd: session.cwd,
        sandbox: session.sandbox,
        approvalPolicy: session.approvalPolicy,
        permissionMode: session.permissionMode,
        source: "claude-sdk"
      }
    };
  }

  appendItem(session, item) {
    const createdAt = createdAtFromOrNow(item);
    const appendedItem = {
      id: item.id ?? `${session.id}:${session.nextItemSeq}`,
      turnId: item.turnId ?? session.currentTurnId ?? session.id,
      turnStatus: session.status,
      type: item.type,
      title: item.title,
      text: item.text,
      options: item.options ?? null,
      status: item.status ?? null,
      createdAt,
      presentationRole: item.presentationRole ?? null,
      presentationText: item.presentationText ?? null,
      rawMetadataJSON: item.rawMetadataJSON ?? providerRawMetadataJSON(
        "claude-sdk",
        item.rawPayload ?? item,
        { source: item.rawPayload ? "provider_event" : "normalized_item" }
      )
    };
    session.items.push(appendedItem);
    session.nextItemSeq += 1;
    if (session.items.length > this.maxItems) {
      session.items = session.items.slice(-this.maxItems);
    }
    this.emitProviderEvent(session, {
      type: claudeItemProviderEventType(appendedItem),
      turnId: appendedItem.turnId,
      itemId: appendedItem.id,
      item: appendedItem,
      occurredAt: appendedItem.createdAt
    });
    return appendedItem;
  }

  markPendingChoiceItemsSelected(session, optionId, choiceId = null) {
    session.items = session.items.map((item) => {
      if (item.type !== "choice" || !Array.isArray(item.options) || item.status === "selected") {
        return item;
      }
      if (choiceId && item.id !== choiceId) {
        return item;
      }
      return {
        ...item,
        status: "selected",
        options: item.options.map((option) => ({
          ...option,
          selected: option.id === optionId
        }))
      };
    });
    for (const item of session.items) {
      if (item.type === "choice" && item.status === "selected" && (!choiceId || item.id === choiceId)) {
        this.emitProviderEvent(session, {
          type: "approval.resolved",
          turnId: item.turnId,
          itemId: item.id,
          item,
          occurredAt: session.updatedAt
        });
      }
    }
  }

  resolveAllPendingChoices(session, message) {
    for (const pendingDecision of session.pendingChoices?.values?.() ?? []) {
      pendingDecision.resolve({ behavior: "deny", message });
    }
    session.pendingChoices?.clear?.();
    if (session.pendingDecision) {
      session.pendingDecision.resolve({ behavior: "deny", message });
    }
    session.pendingChoice = null;
    session.pendingDecision = null;
  }

  notifyTurnSettled(session, event) {
    if (typeof this.onTurnSettled !== "function") return;
    const hasAgentMessage = session.items.some((item) =>
      item.turnId === event.turnId
      && item.type === "agentMessage"
      && item.presentationRole === "final_answer"
      && typeof item.text === "string"
      && item.text.trim().length > 0
    );
    queueMicrotask(() => Promise.resolve(this.onTurnSettled({
      providerSessionId: session.id,
      session: this.toSessionSummary(session),
      items: session.items.filter((item) => item.turnId === event.turnId),
      hasAgentMessage,
      ...event
    })).catch((error) => {
      console.error(`[claude-sdk] turn-settled callback failed id=${session.id}: ${error.message}`);
    }));
  }

  emitProviderEvent(session, event) {
    if (typeof this.onProviderEvent !== "function" || !event?.type) return;
    queueMicrotask(() => Promise.resolve(this.onProviderEvent({
      providerSessionId: session.id,
      providerEventId: event.providerEventId ?? null,
      turnId: event.turnId ?? session.currentTurnId ?? null,
      itemId: event.itemId ?? event.item?.id ?? null,
      occurredAt: event.occurredAt ?? session.updatedAt,
      ...event
    })).catch((error) => {
      console.error(`[claude-sdk] Provider event callback failed id=${session.id} type=${event.type}: ${error.message}`);
    }));
  }
}

function claudeItemProviderEventType(item) {
  if (item?.type === "agentMessage" || item?.type === "reasoning") {
    return "assistant.message.delta";
  }
  if (item?.type === "choice") return "approval.requested";
  if (item?.status === "failed") return "tool.failed";
  if (item?.status === "completed") return "tool.completed";
  return "tool.started";
}

function hasPendingChoices(session) {
  return (session.pendingChoices?.size ?? 0) > 0;
}

function latestPendingDecision(session) {
  const values = Array.from(session.pendingChoices?.values?.() ?? []);
  return values.length > 0 ? values[values.length - 1] : null;
}

function latestPendingChoice(session) {
  return latestPendingDecision(session)?.choice ?? null;
}

function isChoiceItemAlreadyHandled(session, choiceId) {
  return session.items.some((item) => item.id === choiceId && item.type === "choice" && item.status === "selected");
}

async function makeUserMessage(text, images = []) {
  const content = [];
  for (const image of images) {
    const mediaType = claudeImageMediaType(image?.mimeType);
    const path = typeof image?.absolutePath === "string" ? image.absolutePath : "";
    if (!path) {
      const error = new Error("Claude image input requires a resolved local path.");
      error.code = "CHAT_IMAGE_MISSING";
      throw error;
    }
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: (await readFile(path)).toString("base64")
      }
    });
  }
  if (text) content.push({ type: "text", text });
  return {
    type: "user",
    message: {
      role: "user",
      content
    },
    parent_tool_use_id: null
  };
}

function claudeImageMediaType(value) {
  const type = String(value ?? "").toLowerCase();
  if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(type)) return type;
  const error = new Error(`Claude does not support image format ${type || "unknown"}.`);
  error.code = "CHAT_IMAGE_FORMAT_UNSUPPORTED";
  throw error;
}

function claudeAssistantContentItems(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const items = [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      items.push({
        type: "agentMessage",
        title: "Claude Code",
        text: block.text.trim(),
        presentationRole: "commentary"
      });
      continue;
    }
    if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      items.push({
        type: "reasoning",
        title: "Thinking",
        text: block.thinking.trim()
      });
      continue;
    }
    if (block?.type === "tool_use") {
      const toolName = String(block.name ?? "Claude tool").trim() || "Claude tool";
      items.push({
        type: claudeToolItemType(toolName),
        title: toolName,
        text: claudeToolInputText(toolName, block.input),
        status: "running"
      });
    }
  }
  return items;
}

function claudeToolItemType(toolName) {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" || normalized.includes("shell") || normalized.includes("command")) {
    return "commandExecution";
  }
  if (["write", "edit", "multiedit", "notebookedit"].some((name) => normalized.includes(name))) {
    return "fileChange";
  }
  if (normalized.includes("websearch") || normalized.includes("webfetch") || normalized.includes("browser")) {
    return "webSearch";
  }
  return "mcpToolCall";
}

function claudeToolInputText(toolName, input) {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" && typeof input?.command === "string") return input.command.trim();
  if (normalized.includes("websearch") && typeof input?.query === "string") return input.query.trim();
  if (normalized.includes("webfetch") && typeof input?.url === "string") return input.url.trim();
  if (typeof input?.file_path === "string") return input.file_path.trim();
  if (!input || typeof input !== "object") return "";
  const serialized = JSON.stringify(input, null, 2);
  return serialized.length > 800 ? `${serialized.slice(0, 797)}...` : serialized;
}

function finalizeClaudeTurnItems(session, turnId, turnStatus) {
  if (!turnId || !Array.isArray(session?.items)) return;
  const agentIndexes = [];
  let lastContentIndex = null;
  session.items = session.items.map((item, index) => {
    if (item.turnId !== turnId) return item;
    if (item.type === "agentMessage") agentIndexes.push(index);
    if (item.type !== "userMessage") lastContentIndex = index;
    return { ...item, turnStatus };
  });
  const lastAgentIndex = agentIndexes.at(-1);
  const finalAgentIndex = lastAgentIndex === lastContentIndex ? lastAgentIndex : null;
  if (finalAgentIndex == null) return;
  session.items = session.items.map((item, index) => {
    if (item.turnId !== turnId || item.type !== "agentMessage") return item;
    return {
      ...item,
      presentationRole: index === finalAgentIndex ? "final_answer" : "commentary"
    };
  });
}

function assistantText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function nextSeqFromItems(items = []) {
  return items.length + 1;
}

function nextTurnSeqFromItems(sessionId, items = []) {
  let max = 0;
  const pattern = new RegExp(`^${escapeRegExp(sessionId)}:turn:(\\d+)$`);
  for (const item of items) {
    const match = String(item.turnId ?? "").match(pattern);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildToolChoice(toolName, input, context = {}) {
  if (toolName === "AskUserQuestion") {
    const questions = normalizeAskUserQuestions(input);
    if (questions.length > 0 && questions[0].options.length > 0) {
      const firstQuestion = questions[0];
      return {
        kind: "ask-user",
        title: "Claude needs input",
        text: askUserQuestionText(firstQuestion, 0, questions.length),
        questions,
        originalQuestions: Array.isArray(input?.questions) ? input.questions : null,
        questionIndex: 0,
        answers: {},
        options: askUserQuestionOptions(firstQuestion, 0)
      };
    }
    const question = typeof input?.question === "string" ? input.question.trim() : "Claude needs your input.";
    return {
      kind: "ask-user-unsupported",
      title: "Claude needs input",
      text: `${question}\n\nCurrent Corptie build only supports option-style AskUserQuestion prompts.`,
      options: [
        { id: "deny", label: "Cancel", role: "deny", index: 0, selected: false }
      ]
    };
  }

  const decisionReason = typeof context?.decisionReason === "string" && context.decisionReason.trim()
    ? context.decisionReason.trim()
    : (typeof input?.decisionReason === "string" && input.decisionReason.trim() ? input.decisionReason.trim() : null);
  const blockedPath = typeof context?.blockedPath === "string" && context.blockedPath.trim()
    ? context.blockedPath.trim()
    : (typeof input?.blockedPath === "string" && input.blockedPath.trim() ? input.blockedPath.trim() : null);
  const title = typeof context?.title === "string" && context.title.trim()
    ? context.title.trim()
    : `Allow Claude Code to use tool \`${toolName}\`?`;
  const description = typeof context?.description === "string" && context.description.trim()
    ? context.description.trim()
    : null;
  const details = [
    title,
    description,
    decisionReason,
    blockedPath ? `Path: ${blockedPath}` : null
  ].filter(Boolean).join("\n\n");

  return {
    kind: "tool-approval",
    title: "Claude tool approval",
    text: details,
    toolName,
    toolUseID: context?.toolUseID ?? null,
    suggestions: Array.isArray(context?.suggestions) ? context.suggestions : undefined,
    options: [
      { id: "allow", label: "Allow Once", role: "approve", index: 0, selected: false },
      { id: "allow-always", label: "Always Allow", role: "approve_always", index: 1, selected: false },
      { id: "deny", label: "Deny", role: "deny", index: 2, selected: false }
    ]
  };
}

function optionResolution(choice, option) {
  if (choice.kind === "tool-approval") {
    if (option.id === "allow") {
      return {
        behavior: "allow",
        updatedInput: {},
        toolUseID: choice.toolUseID ?? undefined
      };
    }
    if (option.id === "allow-always") {
      return {
        behavior: "allow",
        updatedInput: {},
        toolUseID: choice.toolUseID ?? undefined,
        updatedPermissions: permissionUpdatesForAlwaysAllow(choice)
      };
    }
    return {
      behavior: "deny",
      message: "User denied this tool request in Corptie.",
      toolUseID: choice.toolUseID ?? undefined
    };
  }

  if (choice.kind === "ask-user") {
    const question = choice.questions?.[choice.questionIndex ?? 0];
    const key = question?.question ?? "answer";
    return {
      behavior: "allow",
      updatedInput: {
        questions: choice.originalQuestions ?? choice.questions,
        answers: {
          ...(choice.answers ?? {}),
          [key]: option.value ?? option.label
        }
      }
    };
  }

  return { behavior: "deny", message: "This Claude prompt type is not supported in Corptie yet." };
}

function normalizeAskUserQuestions(input = {}) {
  const nested = Array.isArray(input?.questions) ? input.questions : [];
  const source = nested.length > 0
    ? nested
    : (typeof input?.question === "string" ? [{ question: input.question, options: input.options }] : []);
  return source
    .map((question, questionIndex) => ({
      question: String(question?.question ?? "").trim(),
      header: String(question?.header ?? "").trim(),
      multiSelect: question?.multiSelect === true,
      options: (Array.isArray(question?.options) ? question.options : []).map((option, optionIndex) => ({
        label: String(option?.label ?? option?.title ?? option?.value ?? `Option ${optionIndex + 1}`),
        description: String(option?.description ?? "").trim(),
        value: option?.value ?? option?.id ?? option?.label ?? optionIndex
      })),
      sourceIndex: questionIndex
    }))
    .filter((question) => question.question && question.options.length > 0);
}

function askUserQuestionText(question, index, total) {
  const progress = total > 1 ? `Question ${index + 1} of ${total}\n\n` : "";
  const header = question.header ? `${question.header}\n\n` : "";
  const descriptions = question.options
    .filter((option) => option.description)
    .map((option) => `${option.label}: ${option.description}`)
    .join("\n");
  return `${progress}${header}${question.question}${descriptions ? `\n\n${descriptions}` : ""}`;
}

function askUserQuestionOptions(question, questionIndex) {
  return question.options.map((option, optionIndex) => ({
    id: `question-${questionIndex}-option-${optionIndex}`,
    label: option.label,
    role: "message-choice",
    index: optionIndex,
    selected: false,
    value: option.value
  }));
}

function advanceAskUserChoice(session, pendingDecision, option, manager) {
  const choice = pendingDecision.choice;
  const questionIndex = choice.questionIndex ?? 0;
  const question = choice.questions?.[questionIndex];
  const nextQuestion = choice.questions?.[questionIndex + 1];
  if (!question || !nextQuestion) {
    return false;
  }

  choice.answers = {
    ...(choice.answers ?? {}),
    [question.question]: String(option.value ?? option.label)
  };
  manager.markPendingChoiceItemsSelected(session, option.id, choice.id);
  session.pendingChoices.delete(choice.id);
  choice.questionIndex = questionIndex + 1;
  choice.id = `${session.id}:choice:${session.nextItemSeq}`;
  choice.text = askUserQuestionText(nextQuestion, choice.questionIndex, choice.questions.length);
  choice.options = askUserQuestionOptions(nextQuestion, choice.questionIndex);
  session.pendingChoices.set(choice.id, pendingDecision);
  session.pendingChoice = choice;
  session.pendingDecision = pendingDecision;
  session.turnState = "requires_action";
  session.phase = "waiting_approval";
  session.updatedAt = new Date().toISOString();
  manager.appendItem(session, {
    id: choice.id,
    type: "choice",
    title: choice.title,
    text: choice.text,
    status: "pending",
    options: choice.options
  });
  return true;
}

function permissionUpdatesForAlwaysAllow(choice) {
  const updates = Array.isArray(choice.suggestions) ? choice.suggestions.slice() : [];
  const toolName = String(choice.toolName ?? "").trim();
  if (toolName && !updates.some((update) => update?.type === "addRules" && update?.behavior === "allow" && Array.isArray(update.rules) && update.rules.some((rule) => rule?.toolName === toolName))) {
    updates.push({
      type: "addRules",
      rules: [{ toolName }],
      behavior: "allow",
      destination: "session"
    });
  }
  return updates.length > 0 ? updates : undefined;
}

function taskMessageText(message) {
  const segments = [
    message?.label,
    message?.status,
    message?.description,
    message?.summary,
    message?.patch?.error,
    message?.message,
    message?.content
  ].filter((value) => typeof value === "string" && value.trim());
  return segments.join(": ").trim();
}

function claudeTaskSubtype(message) {
  const subtype = message?.type === "system" ? message?.subtype : message?.type;
  return [
    "task_started",
    "task_progress",
    "task_updated",
    "task_complete",
    "task_notification"
  ].includes(subtype) ? subtype : null;
}

function isTerminalClaudeTaskMessage(message, subtype) {
  if (subtype === "task_complete" || subtype === "task_notification") return true;
  if (subtype !== "task_updated") return false;
  return ["completed", "failed", "killed"].includes(message?.patch?.status);
}

function claudeTaskBlocksTurnSettlement(message) {
  if (typeof message?.subagent_type === "string" && message.subagent_type.trim()) {
    return true;
  }
  return ["agent", "subagent", "local_workflow"].includes(
    String(message?.task_type ?? "").trim().toLowerCase()
  );
}

function activityStatusForSession(session) {
  if (hasPendingChoices(session)) {
    return "Waiting for your choice";
  }
  if (session.turnState === "running") {
    return "Claude is working";
  }
  if (session.status === "failed") {
    return "Claude request failed";
  }
  return "Ready";
}

function unavailableReasonForSession(session) {
  return "Claude is still processing the previous request.";
}

function claudePermissionMode(sandbox = "workspace-write", approvalPolicy = "on-request") {
  if (approvalPolicy === "never" && sandbox === "danger-full-access") {
    return "bypassPermissions";
  }
  if (approvalPolicy === "never") {
    return "dontAsk";
  }
  return "default";
}

function claudePermissionOptions(session) {
  const permissionMode = session.permissionMode ?? claudePermissionMode(session.sandbox, session.approvalPolicy);
  return {
    permissionMode,
    // This flag only permits a later explicit switch to bypass mode; the
    // active permissionMode remains authoritative and is not widened by it.
    allowDangerouslySkipPermissions: true
  };
}

// Claude effort levels mirror the Agent SDK's EffortLevel union. "off" is not
// part of the SDK surface; callers map a disabled level to undefined before it
// reaches this helper.
export function normalizeClaudeEffortLevel(value) {
  const level = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["low", "medium", "high", "xhigh", "max"].includes(level) ? level : null;
}

export function normalizeClaudeRuntimeOptions(input = {}) {
  if (!input || typeof input !== "object") return {};
  const result = {};
  if (input.mcpServers && typeof input.mcpServers === "object") {
    result.mcpServers = { ...input.mcpServers };
  }
  if (Array.isArray(input.plugins)) {
    result.plugins = input.plugins.map((plugin) => ({ ...plugin }));
  }
  if (input.skills === "all" || Array.isArray(input.skills)) {
    result.skills = Array.isArray(input.skills) ? [...input.skills] : input.skills;
  }
  if (Array.isArray(input.settingSources)) {
    result.settingSources = [...input.settingSources];
  }
  if (Array.isArray(input.additionalDirectories)) {
    result.additionalDirectories = [...new Set(input.additionalDirectories.filter((path) => (
      typeof path === "string" && path.trim()
    )).map((path) => path.trim()))];
  }
  if (Array.isArray(input.disallowedTools)) {
    result.disallowedTools = [...new Set(input.disallowedTools.filter((tool) => {
      return typeof tool === "string" && tool.trim();
    }).map((tool) => tool.trim()))];
  }
  if (typeof input.systemPrompt === "string" || Array.isArray(input.systemPrompt) || input.systemPrompt?.type === "preset") {
    result.systemPrompt = input.systemPrompt;
  }
  return result;
}

function lastMeaningfulText(items = []) {
  for (const item of items.slice().reverse()) {
    if (item.text && item.type !== "userMessage") {
      return item.text;
    }
  }
  return "";
}

function latestSuggestedOptions(items = []) {
  for (const item of items.slice().reverse()) {
    if (item.type === "userMessage") {
      return null;
    }
    if ((item.type === "choice" || item.type === "agentMessage") && item.status !== "selected" && Array.isArray(item.options) && item.options.length >= 1) {
      return item.options;
    }
  }
  return null;
}

function visibleClaudeItems(items = []) {
  const visible = [];
  for (const item of items) {
    const previous = visible.at(-1);
    const isDuplicateSuccessResult = item.type === "system"
      && item.title === "Claude Code"
      && item.status === "success"
      && previous?.type === "agentMessage"
      && previous?.text === item.text;
    if (!isDuplicateSuccessResult) {
      visible.push(item);
    }
  }
  return visible;
}

function normalizeClaudeAccountUsage(usage, model = null) {
  const windows = [];
  const addWindow = (id, label, raw, durationMinutes) => {
    const usedPercent = finiteNumber(raw?.utilization);
    if (usedPercent === null) return;
    windows.push([id, {
      limitId: id,
      limitName: label,
      primary: {
        usedPercent,
        windowDurationMins: durationMinutes,
        resetsAt: epochSeconds(raw?.resets_at)
      },
      secondary: null
    }]);
  };
  addWindow("five_hour", "5 hour", usage?.rate_limits?.five_hour, 300);
  addWindow("seven_day", "7 day", usage?.rate_limits?.seven_day, 10_080);
  addWindow("seven_day_oauth_apps", "7 day OAuth apps", usage?.rate_limits?.seven_day_oauth_apps, 10_080);
  addWindow("seven_day_opus", "7 day Opus", usage?.rate_limits?.seven_day_opus, 10_080);
  addWindow("seven_day_sonnet", "7 day Sonnet", usage?.rate_limits?.seven_day_sonnet, 10_080);
  for (const [index, raw] of (usage?.rate_limits?.model_scoped ?? []).entries()) {
    addWindow(`model_scoped_${index}`, raw?.display_name || "Model", raw, 10_080);
  }
  return {
    available: usage?.rate_limits_available === true && windows.length > 0,
    provider: "claude",
    model,
    subscriptionType: usage?.subscription_type ?? null,
    rateLimits: windows[0]?.[1] ?? null,
    rateLimitsByLimitId: Object.fromEntries(windows)
  };
}

function unavailableClaudeAccountUsage(model = null) {
  return {
    available: false,
    provider: "claude",
    model,
    rateLimits: null,
    rateLimitsByLimitId: {}
  };
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function epochSeconds(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp / 1_000 : null;
}

function shortTitle(value) {
  const text = String(value ?? "").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : (text || "Claude Code");
}
