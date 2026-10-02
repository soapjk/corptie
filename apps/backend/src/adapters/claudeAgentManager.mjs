import { randomUUID } from "node:crypto";
import { publicUserInput, validateInteractionAnswers } from "../application/interactionInput.mjs";
import { question, elicitationInput, elicitationResponse, interactionError } from "../application/structuredInteraction.mjs";
import { makeClaudeUserMessage } from "./claudeMessageInput.mjs";
import { forkSession, query } from "@anthropic-ai/claude-agent-sdk";
import { createdAtFromOrNow } from "../utils/timestamps.mjs";
import { defaultWorkspacePath } from "../utils/workspacePaths.mjs";
import { providerMessageWithSessionContext } from "../utils/sessionContextMessage.mjs";
import { recoverClaudeSessionIdentity } from "./claudeSessionIdentity.mjs";
import { createClaudeSdkMessageHandler } from "./claudeSdkMessageHandler.mjs";
import { ClaudeQueryInput } from "./claudeQueryInput.mjs";
import { runClaudeBackgroundPrompt } from "./claudeBackgroundOperation.mjs";
import { createClaudeTimelineWriter } from "./claudeTimelineWriter.mjs";
import { claudeSessionDetail, claudeSessionSummary, hasPendingChoices } from "./claudeSessionProjection.mjs";
import {
  normalizeClaudeAccountUsage,
  unavailableClaudeAccountUsage,
  finiteNumber,
  shortTitle
} from "./claudeMessageProjection.mjs";
import { claudePermissionMode, claudePermissionOptions, normalizeClaudeEffortLevel, normalizeClaudeRuntimeOptions } from "./claudeRuntimeOptions.mjs";
export { normalizeClaudeEffortLevel, normalizeClaudeRuntimeOptions } from "./claudeRuntimeOptions.mjs";
import { buildToolChoice, optionResolution, advanceAskUserChoice } from "./claudeChoiceProtocol.mjs";
import {
  claudeConnectionTestOptions,
  claudeProviderErrorDiagnostic,
  claudeRuntimeEnvironment,
  claudeSdkResultError,
  normalizeClaudeProviderError
} from "../agent-provider/providers/claudeProviderConfiguration.mjs";

export class ClaudeAgentManager {
  constructor(options = {}) {
    this.executable = options.executable;
    this.sessions = new Map();
    this.store = options.store ?? null;
    this.maxItems = options.maxItems ?? 2_000;
    this.onTurnSettled = options.onTurnSettled ?? null;
    this.onProviderEvent = options.onProviderEvent ?? null;
    this.resolveRuntimeOptions = options.resolveRuntimeOptions ?? null;
    this.queryFactory = options.query ?? query;
    this.forkSessionFactory = options.forkSession ?? forkSession;
    this.environment = options.environment ?? (() => process.env);
    this.structuredPlanEvents = options.structuredPlanEvents !== false;
    this.timelineWriter = createClaudeTimelineWriter({
      maxItems: () => this.maxItems,
      emitProviderEvent: (...args) => this.emitProviderEvent(...args)
    });
    this.sdkMessageHandler = createClaudeSdkMessageHandler({
      emitProviderEvent: (...args) => this.emitProviderEvent(...args),
      appendItem: (...args) => this.appendItem(...args),
      persistSessionIdentity: (session) => this.persistSessionIdentity(session),
      settleToolResults: (...args) => this.settleToolResults(...args),
      structuredPlanEvents: () => this.structuredPlanEvents,
      appendPlanToolFallback: (...args) => this.appendPlanToolFallback(...args),
      expireInteractions: (session) => this.expireInteractions(session),
      environment: () => this.environment(),
      upsertTaskProgressItem: (...args) => this.upsertTaskProgressItem(...args),
      notifyTurnSettled: (...args) => this.notifyTurnSettled(...args)
    });
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
      hiddenTaskIds: new Set(),
      deferredResult: null,
      lastResult: null,
      turnState: "idle",
      queryInput: new ClaudeQueryInput(),
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

  async fork(input, { forkSource }) {
    const source = await this.sessionForOperation(forkSource.reference.providerSessionId);
    if (source.turnState !== "idle" || !source.agentSessionId || !forkSource.point.providerMessageId) {
      throw Object.assign(new Error("Claude 历史中缺少可验证的分叉消息位置，请选择更新后的完整回复。"), { code: "FORK_POINT_UNAVAILABLE" });
    }
    const result = await this.forkSessionFactory(source.agentSessionId, {
      dir: source.cwd, upToMessageId: forkSource.point.providerMessageId, title: input.title
    });
    return this.start({ ...input, prompt: "", agentSessionId: result.sessionId });
  }

  storedSession(id) {
    const direct = this.store?.getSession(`pty:${id}`) ?? this.store?.getSession(id) ?? null;
    if (direct) return direct;
    // A Provider switch preserves the public Corptie Session id while giving
    // Claude a new Provider Session id. After a backend restart, reconnect is
    // addressed by that Claude id, so resolve it through the durable active
    // binding before loading the shared Session projection.
    const logical = this.store?.getLogicalSessionByProviderSessionId?.("claude-sdk", id);
    return logical?.legacySessionId
      ? this.store?.getSession(logical.legacySessionId) ?? null
      : null;
  }

  persistSessionIdentity(session) {
    const stored = this.storedSession(session.id);
    if (!stored || !session.agentSessionId || !this.store?.upsertSession) return;
    if (stored.external?.agentSessionId === session.agentSessionId) return;
    this.store.upsertSession({ ...stored, agentSessionId: session.agentSessionId,
      external: { ...stored.external, agentSessionId: session.agentSessionId } });
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
    session.toolContinuationItemIds = new Set();
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
    this.enqueueInput(session, await makeClaudeUserMessage(providerValue, images));
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
    if (session.query) {
      await session.query.setModel(nextModel);
    }
    // Do not publish a model which the live Query rejected.
    session.currentModel = nextModel;
    session.updatedAt = new Date().toISOString();
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
      session.queryInput.reset();
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
    session.queryInput.reset();
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
    if (!(session.pendingChoices?.size > 0) || !["bypassPermissions", "dontAsk"].includes(permissionMode)) {
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
    if (session.pendingInteractions?.size > 0) return;
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
        const runtimeChanged = JSON.stringify(session.runtimeOptions ?? {}) !== JSON.stringify(nextRuntimeOptions);
        if (runtimeChanged) {
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
    const stored = this.storedSession(id);
    if (!stored || stored.external?.provider !== "claude-sdk") {
      return null;
    }
    const raw = stored.rawStatus ?? {};
    const storedItems = this.store?.getItems(stored.id, this.maxItems, "claude-sdk") ?? [];
    let agentSessionId = stored.external?.agentSessionId ?? raw.agentSessionId ?? null;
    const logical = this.store?.getLogicalSessionByLegacySessionId?.(stored.id);
    const activeBindingId = logical?.activeBinding?.bindingId ?? null;
    const currentBindingHasConversation = activeBindingId
      ? typeof this.store?.hasSessionTurnForBinding === "function"
        ? this.store.hasSessionTurnForBinding(stored.id, activeBindingId)
        : storedItems.some((item) => item.bindingId === activeBindingId
          && ["agentMessage", "userMessage"].includes(item.type))
      : storedItems.some((item) => ["agentMessage", "userMessage"].includes(item.type));
    if (!agentSessionId && currentBindingHasConversation) {
      agentSessionId = await recoverClaudeSessionIdentity({
        configDirectory: this.environment()?.CLAUDE_CONFIG_DIR,
        cwd: stored.external?.cwd, logicalSessionId: logical?.logicalSessionId
      });
      if (!agentSessionId) throw Object.assign(new Error("Claude Session identity could not be verified; refusing to start a new conversation."), {
        code: "PROVIDER_SESSION_UNAVAILABLE"
      });
    }
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
      currentTurnId: null,
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
      queryInput: new ClaudeQueryInput(),
      streamingAssistant: null
    };
    session.runtimeOptions = options.runtimeOptions
      ? normalizeClaudeRuntimeOptions(options.runtimeOptions)
      : null;
    // Product history is Corptie-owned. Reconnect restores only the durable
    // Corptie Timeline and never imports the Provider-native transcript.
    session.items = storedItems.slice(-this.maxItems);
    session.nextItemSeq = Math.max(session.nextItemSeq, nextSeqFromItems(session.items));
    session.nextTurnSeq = Math.max(session.nextTurnSeq, nextTurnSeqFromItems(session.id, session.items));
    this.sessions.set(id, session);
    this.persistSessionIdentity(session);
    const startQuery = options.startQuery !== false;
    console.log(`[claude-sdk] reconnecting id=${id} resume=${agentSessionId ?? "fresh"} startQuery=${startQuery}`);
    if (startQuery && options.runtimeOptions) {
      // Explicit runtime preparation must finish before tool observation, even
      // for a restored binding that has not acquired an SDK Session id yet.
      await this.ensureQueryStarted(session);
    } else if (agentSessionId && startQuery) {
      void this.ensureQueryStarted(session);
    }
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

    if (pendingDecision.choice.kind === "ask-user" && advanceAskUserChoice(session, pendingDecision, option, {
      markPendingChoiceItemsSelected: (...args) => this.markPendingChoiceItemsSelected(...args),
      appendItem: (...args) => this.appendItem(...args)
    })) {
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
      console.log("[claude-sdk] query startup", JSON.stringify({
        sessionId: session.id, agentSessionId: session.agentSessionId ?? null, status: "starting"
      }));
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
          ...(this.executable ? { pathToClaudeCodeExecutable: this.executable() } : {}),
          ...permissionOptions,
          canUseTool: async (toolName, input, options) => this.handleToolRequest(session, toolName, input, options),
          onElicitation: (request, options) => this.handleElicitation(session, request, options)
        }
      });
      session.queryTask = this.consumeQuery(session);
      return session.query;
    })();
    session.queryStartTask = startTask;
    try {
      const startedQuery = await startTask;
      console.log("[claude-sdk] query startup", JSON.stringify({
        sessionId: session.id, agentSessionId: session.agentSessionId ?? null, status: "started"
      }));
      return startedQuery;
    } catch (error) {
      console.error("[claude-sdk] query startup", JSON.stringify({
        sessionId: session.id, agentSessionId: session.agentSessionId ?? null, status: "failed"
      }));
      throw error;
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
    const query = session.query;
    try {
      for await (const message of query) {
        this.handleSdkMessage(session, message);
      }
      console.log(`[claude-sdk] query ended id=${session.id} status=${session.status} turnState=${session.turnState}`);
      if (!session.queryClosed && session.query === query) {
        const incompleteTurn = Boolean(session.currentTurnId)
          && session.status === "running"
          && ["running", "requires_action"].includes(session.turnState);
        this.releaseQueryInput(session, query);
        session.updatedAt = new Date().toISOString();
        if (incompleteTurn) {
          const failure = {
            code: "PROVIDER_STREAM_ENDED_INCOMPLETE",
            message: "模型流式连接在返回完成事件前结束，请重试本轮消息。",
            retryable: true
          };
          this.resolveAllPendingChoices(session, failure.message);
          session.pendingChoice = null;
          session.pendingDecision = null;
          session.activeTaskIds.clear();
          session.hiddenTaskIds.clear();
          this.appendItem(session, {
            type: "system",
            title: "模型连接中断",
            text: failure.message,
            status: "failed"
          });
          this.settleClaudeResult(session, {
            turnId: session.currentTurnId,
            succeeded: false,
            text: failure.message,
            failure,
            notified: false
          });
        } else {
          session.turnState = "idle";
          session.phase = session.status === "failed" ? "failed" : "ready";
        }
      }
    } catch (error) {
      const secretValues = [this.environment()?.ANTHROPIC_API_KEY].filter(Boolean);
      const failure = normalizeClaudeProviderError(error, {
        secretValues
      });
      console.error("[claude-sdk] query failed", JSON.stringify({
        sessionId: session.id,
        code: failure.code,
        retryable: failure.retryable,
        diagnostic: claudeProviderErrorDiagnostic(error, { secretValues })
      }));
      const wasInterrupted = session.interruptRequested === true;
      if (!this.releaseQueryInput(session, query)) {
        console.warn(`[claude-sdk] ignored stale query failure id=${session.id}`);
        return;
      }
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

  releaseQueryInput(session, query) {
    if (session.query !== query) return false;
    // A failed/ended SDK query may leave its prompt iterator suspended in
    // ClaudeQueryInput. Release those readers before a replacement query is
    // allowed to start, otherwise the next user message can be consumed by
    // the dead query instead of the new one.
    session.queryClosed = true;
    session.queryInput.reset();
    session.query = null;
    session.queryTask = null;
    session.queryClosed = false;
    return true;
  }

  async runBackgroundPrompt(input = {}) {
    return runClaudeBackgroundPrompt(input, {
      queryFactory: (options) => this.queryFactory(options),
      environment: () => this.environment()
    });
  }

  async handleToolRequest(session, toolName, input, options = {}) {
    if (toolName === "AskUserQuestion") {
      const model = publicUserInput({ schemaVersion: 1, kind: "question", isBlocking: true, canCancel: true,
        questions: (Array.isArray(input?.questions) ? input.questions : []).map((q, i) => question(`question-${i}`, q?.question, null, {
          header: q?.header, isOther: true, selectionMode: q?.multiSelect === true ? "multiple" : "single",
          options: Array.isArray(q?.options) ? q.options.map(o => ({ label: o?.label, description: o?.description ?? "" })) : null
        })) });
      if (!model) {
        this.appendItem(session, { type: "system", title: "交互未支持", text: "问题格式无法完整展示，已拒绝请求。", status: "failed" });
        return { behavior: "deny", message: "Unsupported question schema. Ask in plain language instead." };
      }
      return this.waitForInteraction(session, model, response => response.action === "cancel"
        ? { behavior: "deny", message: "User cancelled the question." }
        : { behavior: "allow", updatedInput: { ...input, answers: Object.fromEntries(input.questions.map((q, i) => [q.question, response.answers[`question-${i}`].join(", ")])) } }, options.signal);
    }
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
    return this.sdkMessageHandler.handleSdkMessage(session, message);
  }

  settleClaudeResult(session, result) {
    return this.sdkMessageHandler.settleClaudeResult(session, result);
  }

  handleStreamEvent(session, message) {
    return this.sdkMessageHandler.handleStreamEvent(session, message);
  }

  updateStreamingAssistant(session, text, options = {}) {
    return this.sdkMessageHandler.updateStreamingAssistant(session, text, options);
  }

  inputStream(session) {
    return session.queryInput.stream(() => session.queryClosed);
  }

  enqueueInput(session, message) {
    session.queryInput.enqueue(message);
  }

  dequeueInput(session) {
    return session.queryInput.dequeue(session.queryClosed);
  }

  toDetail(session) {
    return claudeSessionDetail(session, this.maxItems);
  }

  toSessionSummary(session) {
    return claudeSessionSummary(session, this.store?.getSession(session.id), this.toDetail(session));
  }

  appendItem(session, item) {
    return this.timelineWriter.appendItem(session, item);
  }

  appendPlanToolFallback(session, call, reason) {
    return this.timelineWriter.appendPlanToolFallback(session, call, reason);
  }

  upsertTaskProgressItem(session, message, taskId, terminal) {
    return this.timelineWriter.upsertTaskProgressItem(session, message, taskId, terminal);
  }

  settleToolResults(session, message) {
    return this.timelineWriter.settleToolResults(session, message);
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
    this.expireInteractions(session);
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

  async handleElicitation(session, request, options = {}) {
    try {
      return await this.waitForInteraction(session, elicitationInput(request), input => {
        const response = elicitationResponse(request, input);
        // Claude exposes MCP ElicitResult (optional object), whereas Codex
        // app-server requires an explicit nullable content field.
        return response.content == null ? { action: response.action } : response;
      }, options.signal);
    } catch (error) {
      this.appendItem(session, { type: "system", title: "交互未支持", text: "外部工具的表单无法安全展示，已取消请求。", status: "failed" });
      return { action: "cancel" };
    }
  }

  waitForInteraction(session, model, translate, signal) {
    if (signal?.aborted) return Promise.resolve(translate({ action: "cancel" }));
    session.pendingInteractions ??= new Map();
    session.turnState = "requires_action";
    session.phase = "waiting_approval";
    const item = this.appendItem(session, { type: "userInput", title: "需要你的输入",
      text: model.questions[0].question, status: "pending", userInput: model,
      rawMetadataJSON: JSON.stringify({ userInput: model }) });
    return new Promise(resolve => {
      const abort = () => this.settleInteraction(session, item.id, "expired", translate({ action: "cancel" }));
      session.pendingInteractions.set(item.id, { model, translate, resolve,
        cleanup: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  respondToUserInput(id, input) {
    const session = this.get(id);
    if (!session) throw Object.assign(new Error("Session not found."), { code: "USER_INPUT_NOT_PENDING" });
    const pending = session.pendingInteractions?.get(input.itemId);
    if (!pending) throw Object.assign(new Error("Question is no longer pending."), { code: "USER_INPUT_NOT_PENDING" });
    if (input.action !== "cancel" && !validateInteractionAnswers(pending.model, input.answers)) throw interactionError();
    const response = pending.translate(input);
    this.settleInteraction(session, input.itemId, input.action === "cancel" ? "cancelled" : "submitted", response);
    return this.toSessionSummary(session);
  }

  settleInteraction(session, id, status, response) {
    const pending = session.pendingInteractions?.get(id);
    if (!pending) return;
    session.pendingInteractions.delete(id);
    pending.cleanup();
    const index = session.items.findIndex(item => item.id === id);
    if (index >= 0) {
      const item = { ...session.items[index], status };
      session.items[index] = item;
      this.emitProviderEvent(session, { type: status === "submitted" ? "interaction.submitted" : "interaction.resolved",
        turnId: item.turnId, itemId: id, item, occurredAt: new Date().toISOString() });
    }
    pending.resolve(response);
  }

  expireInteractions(session) {
    for (const [id, pending] of session.pendingInteractions ?? []) {
      this.settleInteraction(session, id, "expired", pending.translate({ action: "cancel" }));
    }
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
