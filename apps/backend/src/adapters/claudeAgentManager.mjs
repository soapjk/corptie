import { randomUUID } from "node:crypto";
import { getSessionMessages, query } from "@anthropic-ai/claude-agent-sdk";
import { createdAtFromOrNow } from "../utils/timestamps.mjs";

export class ClaudeAgentManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.store = options.store ?? null;
    this.maxItems = options.maxItems ?? 240;
    this.detailSubscribers = new Map();
    this.detailEmitTimers = new Map();
  }

  start(input = {}) {
    const id = input.id || randomUUID();
    const createdAt = createdAtFromOrNow();
    const hasInitialPrompt = typeof input.prompt === "string" && input.prompt.trim().length > 0;
    const session = {
      id,
      title: shortTitle(input.title || input.prompt || "Claude Code"),
      agentName: "Claude Code",
      provider: "claude-sdk",
      accent: "amber",
      command: "claude-sdk",
      args: [],
      cwd: input.cwd || process.cwd(),
      sandbox: input.sandbox ?? "workspace-write",
      approvalPolicy: input.approvalPolicy ?? "on-request",
      permissionMode: claudePermissionMode(input.sandbox, input.approvalPolicy),
      createdAt,
      updatedAt: createdAt,
      status: hasInitialPrompt ? "running" : "complete",
      archived: input.archived === true,
      pinned: input.pinned === true,
      sortOrder: input.sortOrder ?? null,
      avatarPath: input.avatarPath ?? null,
      agentSessionId: input.agentSessionId ?? null,
      currentModel: input.model ?? null,
      currentReasoningLevel: null,
      initialPrompt: input.prompt ?? "",
      phase: "ready",
      connectionReady: true,
      lastInputAt: null,
      lastOutputAt: null,
      nextItemSeq: Number(input.nextItemSeq ?? 1),
      nextTurnSeq: Number(input.nextTurnSeq ?? 1),
      currentTurnId: null,
      items: Array.isArray(input.items) ? input.items.slice(-this.maxItems) : [],
      pendingChoice: null,
      pendingDecision: null,
      pendingChoices: new Map(),
      query: null,
      queryTask: null,
      queryClosed: false,
      interruptRequested: false,
      turnState: "idle",
      inputQueue: [],
      inputResolvers: []
    };
    this.sessions.set(id, session);
    console.log(`[claude-sdk] session created id=${id} cwd=${session.cwd}`);
    this.persistSession(session);
    if (hasInitialPrompt) {
      void this.send(id, input.prompt.trim());
    }
    return this.toSessionSummary(session);
  }

  list(options = {}) {
    const archived = options.archived === true;
    const runningSessions = Array.from(this.sessions.values())
      .filter((session) => Boolean(session.archived) === archived)
      .map((session) => this.toSessionSummary(session));
    const runningIds = new Set(runningSessions.map((session) => session.id));
    const storedSessions = this.store?.listSessions({ archived })
      .filter((session) => session.external?.provider === "claude-sdk" && !runningIds.has(session.id)) ?? [];
    return [...runningSessions, ...storedSessions].sort(compareSessionOrder);
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
      this.persistSession(session);
      return this.toSessionSummary(session);
    }
    return this.store?.renameSession(id, nextTitle) ?? null;
  }

  updateAvatar(id, avatarPath = null) {
    const nextAvatarPath = typeof avatarPath === "string" && avatarPath.trim() ? avatarPath.trim() : null;
    const session = this.get(id);
    if (session) {
      session.avatarPath = nextAvatarPath;
      this.persistSession(session);
      this.store?.updateSessionAvatar(id, nextAvatarPath);
      return this.toSessionSummary(session);
    }
    return this.store?.updateSessionAvatar(id, nextAvatarPath) ?? null;
  }

  detail(id) {
    const session = this.get(id);
    return session ? this.toDetail(session) : (this.store?.getDetail(id) ?? null);
  }

  subscribeDetail(id, response) {
    const session = this.get(id);
    if (!session) {
      return false;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    response.write("retry: 1000\n\n");
    let subscribers = this.detailSubscribers.get(id);
    if (!subscribers) {
      subscribers = new Set();
      this.detailSubscribers.set(id, subscribers);
    }
    subscribers.add(response);
    this.writeDetailEvent(response, session);
    response.on("close", () => {
      subscribers.delete(response);
      if (subscribers.size === 0) {
        this.detailSubscribers.delete(id);
      }
    });
    return true;
  }

  async send(id, text) {
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
    const value = String(text ?? "").trim();
    if (!value) {
      throw new Error("Input text is required");
    }

    await this.ensureQueryStarted(session);
    session.interruptRequested = false;
    session.status = "running";
    session.phase = "input_sent";
    session.turnState = "running";
    session.currentTurnId = `${session.id}:turn:${session.nextTurnSeq++}`;
    session.lastInputAt = new Date().toISOString();
    session.updatedAt = session.lastInputAt;
    this.appendItem(session, {
      type: "userMessage",
      title: "User",
      text: value,
      status: "sent"
    });
    this.persistSession(session);
    console.log(`[claude-sdk] send queued id=${id} chars=${value.length}`);
    this.enqueueInput(session, makeUserMessage(value));
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
    this.persistSession(session);
    return this.toSessionSummary(session);
  }

  async interrupt(id) {
    const session = this.get(id);
    if (!session) {
      throw new Error("Claude session not found");
    }
    if (!session.query) {
      throw new Error("Claude session is not active");
    }
    await session.query.interrupt();
    this.resolveAllPendingChoices(session, "Claude Code turn interrupted in Corptie.");
    session.pendingChoice = null;
    session.pendingDecision = null;
    session.pendingChoices?.clear();
    session.interruptRequested = true;
    session.turnState = "idle";
    session.phase = "ready";
    session.status = "complete";
    session.updatedAt = new Date().toISOString();
    this.appendItem(session, {
      type: "system",
      title: "Claude Code",
      text: "Interrupted current Claude Code turn."
    });
    this.persistSession(session);
    return this.toSessionSummary(session);
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
    this.persistSession(session);
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
    this.store?.deleteSession(id);
  }

  async reconnect(id) {
    if (this.get(id)) {
      return this.toSessionSummary(this.get(id));
    }
    const stored = this.store?.getSession(id);
    if (!stored || stored.external?.provider !== "claude-sdk") {
      return null;
    }
    const raw = stored.rawStatus ?? {};
    const agentSessionId = stored.external?.agentSessionId ?? raw.agentSessionId ?? null;
    if (!agentSessionId) {
      throw new Error("Claude session does not have a resumable Claude Code session id");
    }
    const session = {
      id,
      title: stored.title || "Claude Code",
      agentName: stored.agent || "Claude Code",
      provider: "claude-sdk",
      accent: stored.accent || "amber",
      command: "claude-sdk",
      args: [],
      cwd: stored.external?.cwd || raw.cwd || process.cwd(),
      sandbox: raw.sandbox ?? "workspace-write",
      approvalPolicy: raw.approvalPolicy ?? "on-request",
      permissionMode: raw.permissionMode ?? claudePermissionMode(raw.sandbox, raw.approvalPolicy),
      createdAt: stored.createdAt,
      updatedAt: new Date().toISOString(),
      status: stored.status === "failed" || stored.status === "cancelled" ? "complete" : stored.status,
      archived: stored.archived === true,
      pinned: stored.pinned === true,
      sortOrder: stored.sortOrder ?? null,
      avatarPath: stored.avatarPath ?? null,
      agentSessionId,
      currentModel: stored.external?.currentModel ?? raw.currentModel ?? null,
      currentReasoningLevel: null,
      initialPrompt: raw.initialPrompt ?? "",
      phase: "reconnecting",
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
      turnState: "idle",
      inputQueue: [],
      inputResolvers: []
    };
    const transcriptItems = await this.loadTranscriptItems(session);
    session.items = transcriptItems.length > 0
      ? transcriptItems.slice(-this.maxItems)
      : this.store?.getItems(id, this.maxItems, "claude-sdk") ?? [];
    session.nextItemSeq = Math.max(session.nextItemSeq, nextSeqFromItems(session.items));
    session.nextTurnSeq = Math.max(session.nextTurnSeq, nextTurnSeqFromItems(session.id, session.items));
    this.sessions.set(id, session);
    console.log(`[claude-sdk] reconnecting id=${id} resume=${agentSessionId}`);
    void this.ensureQueryStarted(session);
    this.persistSession(session);
    return this.toSessionSummary(session);
  }

  async loadTranscriptItems(session) {
    try {
      const messages = await getSessionMessages(session.agentSessionId, {
        dir: session.cwd,
        limit: this.maxItems,
        includeSystemMessages: false
      });
      const items = [];
      let currentTurnId = null;
      let nextItemSeq = 1;
      let nextTurnSeq = 1;
      for (const message of messages ?? []) {
        if (message.type === "user") {
          currentTurnId = `${session.id}:turn:${nextTurnSeq++}`;
          const text = userMessageText(message.message);
          if (text) {
            items.push(transcriptItem(session, nextItemSeq++, currentTurnId, "userMessage", "User", text, message.timestamp, "sent"));
          }
          continue;
        }
        if (message.type === "assistant") {
          const text = assistantText(message.message);
          if (!text) {
            continue;
          }
          if (!currentTurnId) {
            currentTurnId = `${session.id}:turn:${nextTurnSeq++}`;
          }
          items.push(transcriptItem(session, nextItemSeq++, currentTurnId, "agentMessage", "Claude Code", text, message.timestamp, null));
        }
      }
      return items;
    } catch (error) {
      console.error(`[claude-sdk] transcript load failed id=${session.id}: ${error?.message || String(error)}`);
      return [];
    }
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
    this.persistSession(session);
    return this.toSessionSummary(session);
  }

  async ensureQueryStarted(session) {
    if (session.query) {
      return session.query;
    }
    console.log(`[claude-sdk] query starting id=${session.id} resume=${session.agentSessionId ?? ""}`);
    session.queryClosed = false;
    const permissionOptions = claudePermissionOptions(session);
    session.query = query({
      prompt: this.inputStream(session),
      options: {
        cwd: session.cwd,
        resume: session.agentSessionId || undefined,
        persistSession: true,
        model: session.currentModel || undefined,
        ...permissionOptions,
        ...(permissionOptions.permissionMode === "bypassPermissions"
          ? {}
          : { canUseTool: async (toolName, input, options) => this.handleToolRequest(session, toolName, input, options) })
      }
    });
    session.queryTask = this.consumeQuery(session);
    this.persistSession(session);
    return session.query;
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
        this.persistSession(session);
      }
    } catch (error) {
      console.error(`[claude-sdk] query failed id=${session.id}: ${error?.message || String(error)}`);
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
          text: error?.message || String(error),
          status: "failed"
        });
      }
      this.persistSession(session);
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
    this.persistSession(session);

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
      this.persistSession(session);
      return;
    }

    if (message?.type === "assistant") {
      const text = assistantText(message.message);
      if (text) {
        session.lastOutputAt = session.updatedAt;
        this.appendItem(session, {
          type: "agentMessage",
          title: "Claude Code",
          text
        });
      }
      this.persistSession(session);
      return;
    }

    if (message?.type === "result") {
      const text = typeof message.result === "string" ? message.result.trim() : "";
      session.turnState = "idle";
      session.pendingChoice = null;
      session.pendingDecision = null;
      session.pendingChoices?.clear();
      const wasInterrupted = session.interruptRequested === true;
      session.interruptRequested = false;
      session.phase = message.subtype === "success" || wasInterrupted ? "ready" : "failed";
      session.status = message.subtype === "success" || wasInterrupted ? "complete" : "failed";
      if (text && message.subtype !== "success" && !wasInterrupted) {
        session.lastOutputAt = session.updatedAt;
        this.appendItem(session, {
          type: "system",
          title: "Claude Code",
          text,
          status: message.subtype || "result"
        });
      }
      this.persistSession(session);
      return;
    }

    if (message?.type === "status") {
      session.phase = message.status || session.phase;
      if (message.status === "requesting" || message.status === "compacting") {
        session.turnState = "running";
      }
      this.persistSession(session);
      return;
    }

    if (message?.type === "session_state_changed") {
      session.turnState = message.state || session.turnState;
      session.phase = message.state || session.phase;
      this.persistSession(session);
      return;
    }

    if (message?.type === "task_started" || message?.type === "task_progress" || message?.type === "task_complete" || message?.type === "task_notification") {
      const text = taskMessageText(message);
      if (text) {
        this.appendItem(session, {
          type: "system",
          title: "Claude Code",
          text
        });
      }
      this.persistSession(session);
      return;
    }

    if (message?.type === "informational" || message?.type === "permission_denied") {
      const text = message.message || message.content || message.permission_denial_reason || "";
      if (text) {
        this.appendItem(session, {
          type: "system",
          title: "Claude Code",
          text: String(text)
        });
      }
      this.persistSession(session);
      return;
    }

    this.persistSession(session);
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
    const canSend = session.turnState !== "running" && !hasPendingChoices(session) && session.status !== "cancelled";
    return {
      id: session.id,
      title: session.title,
      status: hasPendingChoices(session) ? "blocked" : session.status,
      source: "claude-sdk",
      connectionStatus: "connected",
      currentModel: session.currentModel ?? null,
      currentReasoningLevel: null,
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
        accent: session.accent
      },
      canSend,
      sendUnavailableReason: canSend ? null : (hasPendingChoices(session) ? "Claude is waiting for your approval choice." : unavailableReasonForSession(session)),
      capabilities: {
        canSend,
        canSwitchModel: true,
        canSwitchReasoning: false,
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
      avatarPath: session.avatarPath ?? storedSession?.avatarPath ?? null,
      external: {
        provider: session.provider,
        threadId: session.id,
        sessionId: session.id,
        agentSessionId: session.agentSessionId,
        connectionStatus: detail.connectionStatus,
        currentModel: session.currentModel ?? null,
        currentReasoningLevel: null,
        cwd: session.cwd,
        sandbox: session.sandbox,
        approvalPolicy: session.approvalPolicy,
        permissionMode: session.permissionMode,
        source: "claude-sdk"
      }
    };
  }

  persistSession(session) {
    this.store?.upsertSession({
      ...session,
      capabilities: this.toDetail(session).capabilities,
      toSessionSummary: (value) => this.toSessionSummary(value)
    });
    this.scheduleDetailEmit(session);
  }

  scheduleDetailEmit(session) {
    if (!this.detailSubscribers.has(session.id) || this.detailEmitTimers.has(session.id)) {
      return;
    }
    const timer = setTimeout(() => {
      this.detailEmitTimers.delete(session.id);
      this.emitDetail(session);
    }, 80);
    timer.unref?.();
    this.detailEmitTimers.set(session.id, timer);
  }

  emitDetail(session) {
    const subscribers = this.detailSubscribers.get(session.id);
    if (!subscribers?.size) {
      return;
    }
    for (const response of subscribers) {
      this.writeDetailEvent(response, session);
    }
  }

  writeDetailEvent(response, session) {
    response.write("event: detail\n");
    response.write(`data: ${JSON.stringify({ thread: this.toDetail(session) })}\n\n`);
  }

  appendItem(session, item) {
    const createdAt = createdAtFromOrNow(item);
    session.items.push({
      id: item.id ?? `${session.id}:${session.nextItemSeq}`,
      turnId: item.turnId ?? session.currentTurnId ?? session.id,
      turnStatus: session.status,
      type: item.type,
      title: item.title,
      text: item.text,
      options: item.options ?? null,
      status: item.status ?? null,
      createdAt
    });
    session.nextItemSeq += 1;
    if (session.items.length > this.maxItems) {
      session.items = session.items.slice(-this.maxItems);
    }
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

function makeUserMessage(text) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text
        }
      ]
    },
    parent_tool_use_id: null
  };
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

function userMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function transcriptItem(session, seq, turnId, type, title, text, timestamp, status) {
  return {
    id: `${session.id}:transcript:${seq}`,
    turnId,
    turnStatus: "complete",
    type,
    title,
    text,
    options: null,
    status,
    createdAt: createdAtFromOrNow(timestamp)
  };
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
    const question = typeof input?.question === "string" ? input.question.trim() : "Claude needs your input.";
    const options = Array.isArray(input?.options) ? input.options : [];
    if (options.length > 0) {
      return {
        kind: "ask-user",
        title: "Claude needs input",
        text: question,
        questions: input?.questions ?? null,
        options: options.map((option, index) => ({
          id: String(option.id ?? option.value ?? index),
          label: String(option.label ?? option.title ?? option.value ?? `Option ${index + 1}`),
          role: "message-choice",
          index,
          selected: false,
          value: option.value ?? option.id ?? option.label
        }))
      };
    }
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
    const key = choice.questions?.[0]?.name ?? choice.questions?.[0]?.id ?? "answer";
    return {
      behavior: "allow",
      updatedInput: {
        ...(choice.questions ? { questions: choice.questions } : {}),
        answers: {
          [key]: option.value ?? option.label
        }
      }
    };
  }

  return { behavior: "deny", message: "This Claude prompt type is not supported in Corptie yet." };
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
    message?.message,
    message?.content
  ].filter((value) => typeof value === "string" && value.trim());
  return segments.join(": ").trim();
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
  if (session.status === "cancelled") {
    return "Claude session closed";
  }
  return "Ready";
}

function unavailableReasonForSession(session) {
  if (session.status === "cancelled") {
    return "Claude session is closed.";
  }
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
  if (permissionMode === "bypassPermissions") {
    return {
      permissionMode,
      allowDangerouslySkipPermissions: true
    };
  }
  return { permissionMode };
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

function compareSessionOrder(left, right) {
  const leftPinned = left.pinned === true;
  const rightPinned = right.pinned === true;
  if (leftPinned !== rightPinned) {
    return leftPinned ? -1 : 1;
  }
  const leftOrder = Number.isFinite(left.sortOrder) ? left.sortOrder : Number.POSITIVE_INFINITY;
  const rightOrder = Number.isFinite(right.sortOrder) ? right.sortOrder : Number.POSITIVE_INFINITY;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
}

function shortTitle(value) {
  const text = String(value ?? "").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : (text || "Claude Code");
}
