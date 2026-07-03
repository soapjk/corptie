import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { CodexAppServerClient } from "./codexAppServer.mjs";

const ansiPattern = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const codexAppBundleBinary = "/Applications/Codex.app/Contents/Resources/codex";

export class PtyAgentManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.choiceParseTimers = new Map();
    this.store = options.store ?? null;
    this.settingsProvider = options.settingsProvider ?? null;
    this.maxItems = options.maxItems ?? 240;
    this.cols = options.cols ?? 100;
    this.rows = options.rows ?? 28;
    this.detailSubscribers = new Map();
    this.detailEmitTimers = new Map();
  }

  start(input = {}) {
    const id = input.id || randomUUID();
    const cwd = input.cwd || process.cwd();
    const command = input.command || defaultShell();
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const title = input.title || input.initialInput || `${command} ${args.join(" ")}`.trim();
    const agentName = input.agentName || "PTY Agent";
    const provider = input.provider || "pty";
    const accent = input.accent || "violet";
    const createdAt = new Date().toISOString();
    const initialSeq = Number(input.nextItemSeq ?? 1);

    const session = {
      id,
      title: shortTitle(title),
      agentName,
      provider,
      accent,
      command,
      args,
      cwd,
      createdAt,
      updatedAt: createdAt,
      status: "running",
      archived: input.archived === true,
      exitCode: null,
      signal: null,
      resume: input.resume ?? null,
      agentSessionId: input.agentSessionId ?? input.resume?.agentSessionId ?? null,
      initialPrompt: input.initialPrompt ?? input.initialInput ?? "",
      phase: input.phase || "starting",
      canResume: input.canResume === true,
      currentModel: input.currentModel ?? input.resume?.currentModel ?? modelFromArgs(args),
      currentReasoningLevel: input.currentReasoningLevel ?? input.resume?.currentReasoningLevel ?? reasoningFromArgs(args),
      avatarPath: input.avatarPath ?? null,
      connectionReady: input.connectionReady === true,
      lastInputAt: null,
      lastSubmittedText: "",
      lastOutputAt: null,
      nextItemSeq: Number.isFinite(initialSeq) && initialSeq > 0 ? initialSeq : 1,
      buffer: "",
      screenText: "",
      pendingChoice: null,
      choiceSignature: "",
      choiceParseInputSignature: "",
      consumedChoiceInputSignature: "",
      choiceParseInputAt: 0,
      items: Array.isArray(input.items) ? input.items.slice(-this.maxItems) : []
    };

    const terminal = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: Number(input.cols ?? this.cols),
      rows: Number(input.rows ?? this.rows),
      cwd,
      env: {
        ...sanitizeEnv(process.env, provider),
        ...proxyEnvForAgent(this.settingsProvider?.()?.agentProxy, provider === "codex-pty" ? "codex" : "pty"),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        CORPTIE_PTY: "1"
      }
    });

    session.terminal = terminal;
    this.sessions.set(id, session);
    if (input.suppressStartItem !== true) {
      this.appendSystemItem(session, `Started ${command} ${args.join(" ")}`.trim());
    }
    this.persistSession(session);

    terminal.onData((chunk) => {
      if (session.deleted) {
        return;
      }
      this.appendOutput(session, chunk);
    });

    terminal.onExit(({ exitCode, signal }) => {
      if (session.deleted) {
        return;
      }
      this.flushBufferedOutput(session, { force: true });
      session.status = exitCode === 0 ? "complete" : "failed";
      session.exitCode = exitCode;
      session.signal = signal;
      session.updatedAt = new Date().toISOString();
      this.appendSystemItem(session, `Process exited with code ${exitCode}${signal ? ` (${signal})` : ""}.`);
      this.persistSession(session);
    });

    const initialInput = typeof input.initialInput === "string" ? input.initialInput.trim() : "";
    if (initialInput) {
      this.write(id, initialInput, { submit: true, echo: true });
    }

    return this.toSessionSummary(session);
  }

  list(options = {}) {
    const archived = options.archived === true;
    const runningSessions = Array.from(this.sessions.values())
      .filter((session) => Boolean(session.archived) === archived)
      .map((session) => {
        this.flushBufferedOutput(session);
        return this.toSessionSummary(session);
      })
    const runningIds = new Set(runningSessions.map((session) => session.id));
    const storedSessions = this.store?.listSessions({ archived })
      .filter((session) => !runningIds.has(session.id)) ?? [];

    return [...runningSessions, ...storedSessions].sort(compareSessionOrder);
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  detail(id, options = {}) {
    const session = this.get(id);
    if (!session) {
      const reconnected = this.reconnect(id);
      if (reconnected) {
        return this.detail(id, options);
      }
      return this.store?.getDetail(id) ?? null;
    }
    if (options.flush !== false) {
      this.flushBufferedOutput(session, { force: true });
    }
    return this.toDetail(session);
  }

  toDetail(session) {
    const canonicalItems = canonicalCodexItems(session, this.maxItems);
    const items = withLiveOutputItem(
      canonicalItems ?? visibleItems(session.items, session.provider).slice(-this.maxItems),
      session
    ).slice(-this.maxItems);

    return {
      id: session.id,
      title: session.title,
      status: displayStatusForSession(session),
      source: "pty",
      connectionStatus: connectionStatusForSession(session),
      currentModel: session.currentModel ?? null,
      currentReasoningLevel: session.currentReasoningLevel ?? null,
      activityStatus: activityStatusForSession(session),
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archived: session.archived === true,
      rawStatus: {
        pid: session.terminal?.pid ?? null,
        command: session.command,
        args: session.args,
        provider: session.provider,
        phase: session.phase,
        connectionReady: session.connectionReady === true,
        lastInputAt: session.lastInputAt,
        lastOutputAt: session.lastOutputAt,
        idleSeconds: idleSeconds(session),
        agentSessionId: session.agentSessionId,
        currentModel: session.currentModel ?? null,
        currentReasoningLevel: session.currentReasoningLevel ?? null,
        resume: session.resume,
        exitCode: session.exitCode,
        signal: session.signal
      },
      canSend: session.status === "running",
      sendUnavailableReason: session.status === "running" ? null : "This terminal process has exited.",
      capabilities: capabilitiesForSession(session),
      turnCount: 1,
      items
    };
  }

  subscribeDetail(id, response) {
    const session = this.get(id) ?? this.ensureReconnected(id);
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

  reconnect(id) {
    if (this.sessions.has(id)) {
      return this.toSessionSummary(this.sessions.get(id));
    }

    const stored = this.store?.getSession(id);
    if (!stored) {
      return null;
    }

    const raw = stored.rawStatus ?? {};
    const provider = stored.external?.provider;
    if (provider !== "codex-pty" || raw.canResume === false) {
      return null;
    }

    const resume = raw.resume ?? {};
    const agentSessionId = resume.agentSessionId ?? raw.agentSessionId ?? null;
    if (!agentSessionId) {
      return null;
    }
    const command = resume.command || raw.command || defaultCodexCommand();
    const args = Array.isArray(resume.args) && resume.args.length > 0
      ? resume.args
      : defaultCodexResumeArgs(stored.external?.cwd);
    const items = this.store?.getItems(id, this.maxItems, "") ?? [];

    return this.start({
      id,
      title: stored.title,
      agentName: stored.agent || "Codex CLI",
      provider,
      accent: stored.accent || "cyan",
      command,
      args,
      cwd: stored.external?.cwd,
      resume,
      agentSessionId,
      canResume: true,
      phase: "connecting",
      connectionReady: false,
      items,
      suppressStartItem: true,
      nextItemSeq: raw.nextItemSeq,
      initialPrompt: raw.initialPrompt ?? ""
    });
  }

  async waitForConnectionReady(id, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? 12_000);
    const intervalMs = Number(options.intervalMs ?? 250);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const session = this.get(id);
      if (!session) {
        return false;
      }
      this.flushBufferedOutput(session);
      if (session.status !== "running") {
        return false;
      }
      if (session.provider !== "codex-pty" || session.connectionReady === true) {
        return true;
      }
      await sleep(intervalMs);
    }
    return false;
  }

  ensureReconnected(id) {
    this.reconnect(id);
    return this.get(id);
  }

  archive(id, archived = true) {
    const session = this.get(id);
    if (session) {
      session.archived = archived;
      session.sortOrder = this.store?.nextTopSortOrder?.(archived) ?? session.sortOrder;
      session.updatedAt = new Date().toISOString();
      this.persistSession(session);
      this.store?.archiveSession(session.id, archived);
      return this.toSessionSummary(session);
    }
    return this.store?.archiveSession(id, archived) ?? null;
  }

  pin(id, pinned = true) {
    const session = this.get(id);
    if (session) {
      session.pinned = pinned;
      this.persistSession(session);
      this.store?.pinSession(session.id, pinned);
      return this.toSessionSummary(session);
    }
    return this.store?.pinSession(id, pinned) ?? null;
  }

  updateAvatar(id, avatarPath = null) {
    const session = this.get(id);
    if (session) {
      session.avatarPath = typeof avatarPath === "string" && avatarPath.trim() ? avatarPath.trim() : null;
      this.persistSession(session);
      this.store?.updateSessionAvatar(id, session.avatarPath);
      return this.toSessionSummary(session);
    }
    return this.store?.updateSessionAvatar(id, avatarPath) ?? null;
  }

  reorder(sessionIds = []) {
    const ids = sessionIds.map((id) => String(id).replace(/^pty:/, "")).filter(Boolean);
    ids.forEach((id, index) => {
      const session = this.get(id);
      if (session) {
        session.sortOrder = index;
        this.persistSession(session);
      }
    });
    this.store?.reorderSessions(ids);
    return this.list({ archived: false });
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

  delete(id) {
    const session = this.get(id);
    if (session) {
      session.deleted = true;
      if (session.status === "running") {
        session.terminal.kill();
      }
      this.sessions.delete(id);
    }
    this.store?.deleteSession(id);
  }

  updateSession(id, patch = {}) {
    const session = this.get(id);
    if (!session) {
      return null;
    }

    if (Object.hasOwn(patch, "agentSessionId")) {
      session.agentSessionId = patch.agentSessionId;
    }
    if (Object.hasOwn(patch, "status")) {
      session.status = patch.status;
    }
    if (Object.hasOwn(patch, "canResume")) {
      session.canResume = patch.canResume === true;
    }
    if (patch.resume) {
      session.resume = patch.resume;
      session.agentSessionId = patch.resume.agentSessionId ?? session.agentSessionId;
      session.canResume = Boolean(session.agentSessionId) || session.canResume;
    }
    if (patch.phase) {
      session.phase = patch.phase;
    }
    if (patch.summary) {
      this.appendSystemItem(session, patch.summary);
    }
    session.updatedAt = new Date().toISOString();
    this.persistSession(session);
    return this.toSessionSummary(session);
  }

  write(id, text, options = {}) {
    const session = this.get(id) ?? this.ensureReconnected(id);
    if (!session) {
      throw new Error("PTY session not found");
    }
    if (session.status !== "running") {
      throw new Error("PTY session is not running");
    }

    const submit = options.submit !== false;
    const value = inputSequenceForSession(session, text, submit);
    session.terminal.write(value);
    session.updatedAt = new Date().toISOString();
    session.lastInputAt = session.updatedAt;
    session.lastSubmittedText = text.trim();
    session.phase = "input_sent";
    session.pendingChoice = null;
    session.choiceSignature = "";
    session.consumedChoiceInputSignature = currentChoiceInputSignature(session);

    if (options.echo !== false) {
      this.appendItem(session, {
        turnId: session.id,
        turnStatus: "running",
        type: "userMessage",
        title: "User",
        text,
        status: "sent"
      });
    }
    this.persistSession(session);
  }

  interrupt(id) {
    const session = this.get(id) ?? this.ensureReconnected(id);
    if (!session) {
      throw new Error("PTY session not found");
    }
    if (session.status !== "running") {
      throw new Error("PTY session is not running");
    }

    session.terminal.write(session.provider === "codex-pty" ? "\x1b" : "\x03");
    session.phase = "ready";
    session.updatedAt = new Date().toISOString();
    this.appendSystemItem(session, "Sent interrupt signal to terminal.");
    this.persistSession(session);
    return this.toSessionSummary(session);
  }

  respondToCodexApproval(id, input = {}) {
    const session = this.get(id) ?? this.ensureReconnected(id);
    if (!session) {
      throw new Error("PTY session not found");
    }
    if (session.status !== "running") {
      throw new Error("PTY session is not running");
    }
    if (session.provider !== "codex-pty") {
      throw new Error("Session is not a Codex PTY session");
    }

    const approved = input.approved === true;
    if (!hasLiveCodexApprovalPrompt(session)) {
      throw new Error("No active Codex approval prompt is visible in the terminal");
    }

    const options = liveCodexApprovalOptions(session);
    const optionId = typeof input.optionId === "string" ? input.optionId : "";
    const optionIndex = Number.isInteger(input.optionIndex)
      ? input.optionIndex
      : options.findIndex((option) => option.id === optionId || option.role === optionId);
    const targetIndex = optionIndex >= 0
      ? optionIndex
      : options.findIndex((option) => option.role === (approved ? "approve" : "deny"));
    const hasExplicitOption = optionId.length > 0 || Number.isInteger(input.optionIndex);
    const value = hasExplicitOption
      ? optionSelectionSequence(options, targetIndex)
      : (approved ? optionSelectionSequence(options, Math.max(0, targetIndex)) : "\x1b");
    session.terminal.write(value);
    session.updatedAt = new Date().toISOString();
    session.lastInputAt = session.updatedAt;
    session.lastSubmittedText = "";
    session.phase = targetIndex >= 0 && options[targetIndex]?.role === "deny" ? "ready" : "working";
    const label = targetIndex >= 0 ? options[targetIndex]?.label : (approved ? "Approve" : "Deny");
    this.markPendingApprovalItemsSelected(session, targetIndex);
    this.appendSystemItem(session, `Selected Codex option: ${label}.`);
    this.persistSession(session);
    return this.toSessionSummary(session);
  }

  respondToPtyChoice(id, input = {}) {
    const session = this.get(id) ?? this.ensureReconnected(id);
    if (!session) {
      throw new Error("PTY session not found");
    }
    if (session.status !== "running") {
      throw new Error("PTY session is not running");
    }
    const options = Array.isArray(session.pendingChoice?.options) ? session.pendingChoice.options : [];
    const optionIndex = Number.isInteger(input.optionIndex)
      ? input.optionIndex
      : options.findIndex((option) => option.id === input.optionId);
    session.terminal.write(optionSelectionSequence(options, optionIndex));
    session.updatedAt = new Date().toISOString();
    session.lastInputAt = session.updatedAt;
    session.phase = "input_sent";
    session.pendingChoice = null;
    session.choiceSignature = "";
    session.choiceParseInputSignature = "";
    session.consumedChoiceInputSignature = currentChoiceInputSignature(session);
    session.choiceParseInputAt = 0;
    this.markPendingChoiceItemsSelected(session, optionIndex);
    this.persistSession(session);
    return this.toSessionSummary(session);
  }

  disconnect(id) {
    const session = this.get(id);
    if (!session) {
      return this.store?.getSession(id) ?? null;
    }
    if (session.provider !== "codex-pty") {
      throw new Error("Disconnect is only available for Codex CLI sessions");
    }
    if (!session.agentSessionId || session.canResume !== true) {
      throw new Error("This Codex CLI session is not bound yet and cannot be safely reconnected");
    }

    session.phase = "ready";
    session.status = "blocked";
    session.updatedAt = new Date().toISOString();
    this.appendSystemItem(session, "PTY disconnected by user.");
    this.persistSession(session);
    session.deleted = true;
    session.terminal?.kill();
    this.sessions.delete(id);
    return this.store?.getSession(id) ?? this.toSessionSummary(session);
  }

  switchModel(id, model) {
    const session = this.get(id) ?? this.ensureReconnected(id);
    if (!session) {
      throw new Error("PTY session not found");
    }
    if (session.provider !== "codex-pty") {
      throw new Error("Model switching is only available for Codex CLI sessions");
    }
    if (session.status !== "running") {
      throw new Error("PTY session is not running");
    }

    const nextModel = String(model).trim();
    session.terminal.write(inputSequenceForSession(session, `/model ${nextModel}`, true));
    session.currentModel = nextModel;
    session.updatedAt = new Date().toISOString();
    session.phase = "ready";
    if (session.resume) {
      session.resume = {
        ...session.resume,
        currentModel: nextModel,
        resumeOptions: withModelOption(session.resume.resumeOptions ?? [], nextModel)
      };
    }
    this.appendSystemItem(session, `Requested Codex model switch to ${nextModel}.`);
    this.persistSession(session);
    return this.toSessionSummary(session);
  }

  switchReasoning(id, reasoningLevel) {
    const session = this.get(id) ?? this.ensureReconnected(id);
    if (!session) {
      throw new Error("PTY session not found");
    }
    if (session.provider !== "codex-pty") {
      throw new Error("Reasoning switching is only available for Codex CLI sessions");
    }
    if (session.status !== "running") {
      throw new Error("PTY session is not running");
    }

    const nextReasoningLevel = String(reasoningLevel).trim();
    session.terminal.write(inputSequenceForSession(session, `/model ${nextReasoningLevel}`, true));
    session.currentReasoningLevel = nextReasoningLevel;
    session.updatedAt = new Date().toISOString();
    session.phase = "ready";
    if (session.resume) {
      session.resume = {
        ...session.resume,
        currentReasoningLevel: nextReasoningLevel,
        resumeOptions: withReasoningOption(session.resume.resumeOptions ?? [], nextReasoningLevel)
      };
    }
    this.appendSystemItem(session, `Requested Codex reasoning switch to ${nextReasoningLevel}.`);
    this.persistSession(session);
    return this.toSessionSummary(session);
  }

  resize(id, cols, rows) {
    const session = this.get(id);
    if (!session) {
      throw new Error("PTY session not found");
    }
    session.terminal.resize(Number(cols), Number(rows));
    session.updatedAt = new Date().toISOString();
  }

  terminate(id) {
    const session = this.get(id);
    if (!session) {
      return null;
    }
    if (session.status === "running") {
      session.terminal.kill();
      session.status = "cancelled";
      session.updatedAt = new Date().toISOString();
      this.appendSystemItem(session, "Process terminated by Corptie.");
      this.persistSession(session);
    }
    return this.toSessionSummary(session);
  }

  closeAll() {
    for (const session of this.sessions.values()) {
      if (session.status === "running") {
        session.terminal.kill();
      }
    }
  }

  appendOutput(session, chunk) {
    const screenChunk = stripAnsi(chunk)
      .replace(/\r/g, "\n")
      .replace(/[\b\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    session.screenText = `${session.screenText}${screenChunk}`.slice(-6000);
    this.scheduleChoiceParse(session);
    const cleaned = stripAnsi(chunk)
      .replace(/\r/g, "")
      .replace(/(?:\d+;[^\s]*corptie)+/g, "")
      .replace(/[\b\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    session.buffer += cleaned;
    session.updatedAt = new Date().toISOString();
    session.lastOutputAt = session.updatedAt;
    session.bufferUpdatedAt = session.updatedAt;

    const lines = session.buffer.split("\n");
    session.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const text = line.trimEnd();
      if (!text) {
        continue;
      }
      const normalizedText = normalizeOutputText(text, session.provider);
      if (!normalizedText || isCodexNoise(normalizedText)) {
        continue;
      }
      if (classifyOutput(text, session.provider) === "userMessage") {
        continue;
      }
      if (isSubmittedEcho(session, text, normalizedText)) {
        continue;
      }
      if (isKnownUserEcho(session, normalizedText) || isReconnectReplayDuplicate(session, normalizedText)) {
        continue;
      }
      session.phase = inferPhase(normalizedText, session.provider, session.phase);
      updateConnectionReady(session, normalizedText);
      const type = classifyOutput(text, session.provider);
      this.appendItem(session, {
        turnId: session.id,
        turnStatus: "running",
        type,
        title: itemTitle(text, session.provider),
        text: normalizedText,
        status: null
      });
    }
    if (session.provider === "codex-pty") {
      session.phase = inferPhase(`${cleaned}\n${session.buffer}`, session.provider, session.phase);
      updateConnectionReady(session, `${cleaned}\n${session.buffer}`);
    }
    this.persistSession(session);
  }

  scheduleChoiceParse(session) {
    if (shouldSuppressChoiceParser(session)) {
      if (process.env.CORPTIE_CHOICE_PARSER_DEBUG === "1") {
        logChoiceParser("skip", session, { reason: "codex-approval-active" });
      }
      return;
    }
    const choiceContext = buildChoiceContext(session.screenText ?? "");
    if (!choiceContext || !possibleChoiceStage(choiceContext.text)) {
      if (process.env.CORPTIE_CHOICE_PARSER_DEBUG === "1") {
        logChoiceParser("skip", session, { reason: choiceContext ? "not-choice-stage" : "no-choice-context" });
      }
      return;
    }
    const existing = this.choiceParseTimers.get(session.id);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.choiceParseTimers.delete(session.id);
      this.parseChoiceStage(session).catch(() => {});
    }, 650);
    this.choiceParseTimers.set(session.id, timer);
  }

  async parseChoiceStage(session) {
    if (session.status !== "running" || shouldSuppressChoiceParser(session)) {
      return;
    }
    const choiceContext = buildChoiceContext(session.screenText ?? "");
    if (!choiceContext) {
      return;
    }
    const screenText = choiceContext.text;
    const inputSignature = choiceInputSignature(screenText);
    if (inputSignature && inputSignature === session.consumedChoiceInputSignature) {
      return;
    }
    const nowMs = Date.now();
    if (inputSignature === session.choiceParseInputSignature && nowMs - (session.choiceParseInputAt ?? 0) < 10000) {
      return;
    }
    session.choiceParseInputSignature = inputSignature;
    session.choiceParseInputAt = nowMs;
    const settings = this.settingsProvider?.() ?? {};
    const configuredParserSettings = {
      ...(settings.choiceParser ?? {}),
      agentProxy: settings.agentProxy
    };
    const parserEnabled = configuredParserSettings.provider && configuredParserSettings.provider !== "disabled";
    const configured = await parseChoiceStageWithConfiguredParser(screenText, configuredParserSettings, session).catch((error) => {
      logChoiceParser("configured-error", session, { error: error.message });
      return null;
    });
    const parsed = parserEnabled ? configured : parseChoiceStageWithRules(screenText);
    if (!parsed || parsed.options.length < 2 || parsed.confidence < 0.45) {
      logChoiceParser("rejected", session, {
        source: parsed?.source ?? "none",
        options: parsed?.options?.length ?? 0,
        confidence: parsed?.confidence ?? 0
      });
      return;
    }
    const options = parsed.options.slice(0, 6).map((option, index) => ({
      id: option.id || `${option.role ?? "option"}-${index}`,
      label: option.label,
      role: option.role ?? approvalOptionRole(option.label),
      index,
      selected: index === parsed.selectedIndex
    }));
    const signature = `${parsed.prompt}|${options.map((option) => `${option.label}:${option.selected}`).join("|")}`;
    if (signature === session.choiceSignature) {
      return;
    }
    session.choiceSignature = signature;
    session.pendingChoice = {
      prompt: parsed.prompt || "The agent is waiting for a choice.",
      options,
      confidence: parsed.confidence,
      source: parsed.source,
      updatedAt: new Date().toISOString()
    };
    logChoiceParser("accepted", session, {
      source: parsed.source,
      options: options.length,
      confidence: parsed.confidence,
      prompt: previewText(session.pendingChoice.prompt)
    });
    this.upsertPendingChoiceItem(session);
    this.persistSession(session);
  }

  upsertPendingChoiceItem(session) {
    const choice = session.pendingChoice;
    if (!choice) {
      return;
    }
    const existing = session.items.find((item) => item.type === "choice" && item.status === "pending");
    if (existing) {
      existing.text = choice.prompt;
      existing.options = choice.options;
      existing.updatedAt = choice.updatedAt;
      this.store?.appendItem(session.id, existing);
      return;
    }
    this.appendItem(session, {
      turnId: session.id,
      turnStatus: "waiting_choice",
      type: "choice",
      title: "Agent choice",
      text: choice.prompt,
      options: choice.options,
      status: "pending"
    });
  }

  markPendingChoiceItemsSelected(session, optionIndex) {
    for (const item of session.items) {
      if (item.type !== "choice" || item.status !== "pending") {
        continue;
      }
      item.status = "selected";
      item.options = (item.options ?? []).map((option) => ({
        ...option,
        selected: option.index === optionIndex
      }));
    }
  }

  markPendingApprovalItemsSelected(session, optionIndex) {
    for (const item of session.items) {
      if (item.type !== "approval" || item.status !== "pending") {
        continue;
      }
      item.status = "selected";
      item.options = (item.options ?? []).map((option) => ({
        ...option,
        selected: option.index === optionIndex
      }));
    }
  }

  flushBufferedOutput(session, options = {}) {
    if (!session.buffer?.trim()) {
      return;
    }
    const bufferAgeMs = session.bufferUpdatedAt ? Date.now() - Date.parse(session.bufferUpdatedAt) : 0;
    if (options.force !== true && bufferAgeMs < 350) {
      return;
    }

    const text = session.buffer.trimEnd();
    session.buffer = "";
    const normalizedText = normalizeOutputText(text, session.provider);
    if (!normalizedText || isCodexNoise(normalizedText)) {
      this.persistSession(session);
      return;
    }
    if (classifyOutput(text, session.provider) === "userMessage") {
      this.persistSession(session);
      return;
    }
    if (isSubmittedEcho(session, text, normalizedText)) {
      this.persistSession(session);
      return;
    }
    if (isKnownUserEcho(session, normalizedText) || isReconnectReplayDuplicate(session, normalizedText)) {
      this.persistSession(session);
      return;
    }

    session.phase = inferPhase(normalizedText, session.provider, session.phase);
    updateConnectionReady(session, normalizedText);
    this.appendItem(session, {
      turnId: session.id,
      turnStatus: "running",
      type: classifyOutput(text, session.provider),
      title: itemTitle(text, session.provider),
      text: normalizedText,
      status: null
    });
    session.updatedAt = new Date().toISOString();
    this.persistSession(session);
  }

  appendSystemItem(session, text) {
    this.appendItem(session, {
      turnId: session.id,
      turnStatus: session.status,
      type: "system",
      title: "Corptie",
      text,
      status: session.status
    });
  }

  appendItem(session, item) {
    const createdAt = new Date().toISOString();
    const nextItem = {
      ...item,
      id: item.id ?? `${session.id}:${item.type ?? "item"}:${session.nextItemSeq++}`,
      createdAt
    };
    session.items.push(nextItem);
    this.store?.appendItem(session.id, nextItem);
    this.trim(session);
  }

  persistSession(session) {
    this.store?.upsertSession(session);
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
    const detail = this.toDetail(session);
    response.write(`event: detail\n`);
    response.write(`data: ${JSON.stringify({ thread: detail })}\n\n`);
  }

  trim(session) {
    if (session.items.length > this.maxItems) {
      session.items = session.items.slice(-this.maxItems);
    }
  }

  toSessionSummary(session) {
    const storedSession = this.store?.getSession(session.id);
    const latestOutput = latestCodexAssistantText(session) || lastMeaningfulText(session.items);
    const status = displayStatusForSession(session);
    const summary = latestOutput
      || (status === "running" || isWaitingForUser(session.phase)
        ? runningSummary(session, latestOutput)
        : `${session.command} ${session.args.join(" ")}`.trim());
    const suggestedOptions = latestSuggestedOptions(session);
    return {
      id: `pty:${session.id}`,
      title: session.title,
      agent: session.agentName,
      status,
      progress: status === "running" || status === "blocked" ? 0.5 : 1,
      summary,
      suggestedOptions,
      activityStatus: activityStatusForSession(session),
      capabilities: capabilitiesForSession(session),
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
        connectionStatus: connectionStatusForSession(session),
        currentModel: session.currentModel ?? null,
        currentReasoningLevel: session.currentReasoningLevel ?? null,
        cwd: session.cwd,
        source: session.command
      }
    };
  }
}

function capabilitiesForSession(session) {
  const isCodex = session.provider === "codex-pty";
  const isRunning = session.status === "running";
  return {
    canSend: isRunning,
    canSwitchModel: isCodex,
    canSwitchReasoning: isCodex,
    canInterrupt: isRunning,
    canReconnect: session.provider === "pty" || session.provider === "codex-pty"
  };
}

class LocalChoiceParserRuntime {
  constructor() {
    this.process = null;
    this.output = "";
    this.signature = "";
    this.settings = null;
    this.ready = false;
    this.startPromise = null;
    this.queue = Promise.resolve();
    this.client = null;
  }

  configure(settings = {}) {
    if (!settings || settings.provider !== "local-agent") {
      this.stop("provider-disabled");
      return;
    }
    const signature = localChoiceParserSettingsSignature(settings);
    if (this.client && this.signature === signature) {
      return;
    }
    this.stop("reconfigure");
    this.signature = signature;
    this.settings = settings;
    this.startPromise = this.start(settings);
  }

  stop(reason = "stop") {
    if (this.process) {
      logChoiceParser("local-agent-stop", { id: "choice-parser-runtime", provider: "local-agent" }, { reason });
      this.process.kill();
    }
    this.client?.close().catch(() => {});
    this.client = null;
    this.process = null;
    this.output = "";
    this.ready = false;
    this.startPromise = null;
  }

  async start(settings = {}) {
    const command = settings.localCommand || defaultCodexCommand();
    const args = localChoiceParserAppServerArgs(settings);
    const cwd = localChoiceParserWorkspace();
    mkdirSync(cwd, { recursive: true });
    logChoiceParser("local-agent-start", { id: "choice-parser-runtime", provider: "local-agent" }, {
      command,
      args: redactLocalAgentArgs(args),
      model: settings.localModel || "",
      cwd
    });
    const startedAt = Date.now();
    this.client = new CodexAppServerClient({
      command,
      args,
      requestTimeoutMs: Math.max(30000, settings.timeoutMs ?? 12000),
      env: {
        ...sanitizeEnv(process.env, "codex-pty"),
        ...proxyEnvForAgent(settings.agentProxy, "choiceParser"),
        CORPTIE_CHOICE_PARSER: "1"
      }
    });
    await this.client.initialize();
    this.ready = true;
    logChoiceParser("local-agent-ready", { id: "choice-parser-runtime", provider: "local-agent" }, {
      ready: this.ready,
      durationMs: Date.now() - startedAt
    });
  }

  async parse(screenText = "", settings = {}, session = null) {
    this.configure(settings);
    this.queue = this.queue
      .catch(() => {})
      .then(() => this.parseNow(screenText, settings, session));
    return this.queue;
  }

  async parseNow(screenText = "", settings = {}, session = null) {
    if (this.startPromise) {
      await this.startPromise;
    }
    if (!this.client) {
      throw new Error("Local choice parser app-server is not running.");
    }
    const prompt = localChoiceParserPrompt(screenText);
    const startedAt = Date.now();
    logChoiceParser("local-agent-request", session, {
      chars: screenText.length,
      model: settings.localModel || "",
      promptChars: prompt.length
    });
    const timeoutMs = settings.timeoutMs ?? 12000;
    const result = await this.client.runChoiceParser({
      prompt,
      cwd: localChoiceParserWorkspace(),
      model: settings.localModel || undefined,
      timeoutMs
    });
    const json = extractChoiceParserJsonObject(result.text);
    if (json) {
      const normalized = normalizeChoiceParserJson(JSON.parse(json), screenText, "local-agent");
      logChoiceParser("local-agent-response", session, {
        ok: true,
        durationMs: Date.now() - startedAt,
        appServerDurationMs: result.durationMs,
        accepted: Boolean(normalized),
        options: normalized?.options?.length ?? 0,
        confidence: normalized?.confidence ?? 0,
        raw: normalized ? undefined : previewLogText(json)
      });
      return normalized;
    }
    logChoiceParser("local-agent-response", session, {
      ok: false,
      durationMs: Date.now() - startedAt,
      reason: "timeout-missing-json",
      timedOut: result.timedOut === true,
      output: previewLogText(result.text)
    });
    return null;
  }
}

const localChoiceParserRuntime = new LocalChoiceParserRuntime();

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

function withModelOption(args = [], model) {
  const next = [];
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === "-m" || args[index] === "--model") && args[index + 1]) {
      index += 1;
      continue;
    }
    next.push(args[index]);
  }
  next.push("-m", model);
  return next;
}

function withReasoningOption(args = [], reasoningLevel) {
  const next = [];
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === "-c" || args[index] === "--config") && args[index + 1]) {
      if (String(args[index + 1]).startsWith("model_reasoning_effort=")) {
        index += 1;
        continue;
      }
    }
    next.push(args[index]);
  }
  next.push("-c", `model_reasoning_effort="${reasoningLevel}"`);
  return next;
}

function compareSessionOrder(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) {
    return a.pinned ? -1 : 1;
  }
  const aOrder = Number(a.sortOrder);
  const bOrder = Number(b.sortOrder);
  if (Number.isFinite(aOrder) && Number.isFinite(bOrder) && aOrder !== bOrder) {
    return aOrder - bOrder;
  }
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

function defaultShell() {
  return process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/zsh");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inputSequenceForSession(session, text, submit) {
  if (!submit) {
    return text;
  }
  if (session.provider !== "codex-pty") {
    return `${text}\r`;
  }
  return `${bracketedPaste(text)}\r`;
}

function bracketedPaste(text) {
  const safeText = text.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
  return `\x1b[200~${safeText}\x1b[201~`;
}

function displayStatusForSession(session) {
  if (hasPendingCodexApproval(session)) {
    return "blocked";
  }
  if (hasPendingCodexInput(session)) {
    return "running";
  }
  if (hasLiveStreamingOutput(session)) {
    return "running";
  }
  if (hasFinalCodexAnswer(session)) {
    return "blocked";
  }
  if (session.status === "running" && (lastItemType(session.items) === "approval" || isWaitingForUser(session.phase))) {
    return "blocked";
  }
  return session.status;
}

function connectionStatusForSession(session) {
  if (session.status === "running") {
    if (session.provider === "codex-pty" && session.connectionReady !== true) {
      return "pty connecting";
    }
    return "pty connected";
  }
  if (session.status === "cancelled") {
    return "pty stopped";
  }
  if (session.status === "complete") {
    return "pty closed";
  }
  return "pty disconnected";
}

function updateConnectionReady(session, text = "") {
  if (session.provider !== "codex-pty" || session.connectionReady === true) {
    return;
  }
  if (isCodexPrompt(text) || ["ready", "waiting_approval", "working", "input_sent"].includes(session.phase)) {
    session.connectionReady = true;
  }
}

function activityStatusForSession(session) {
  if (session.provider === "codex-pty") {
    if (hasPendingCodexApproval(session)) {
      return "Waiting for approval";
    }
    const codexStatus = codexRolloutActivityStatus(session);
    if (codexStatus) {
      return codexStatus;
    }
  }
  if (hasPendingCodexInput(session)) {
    return "Waiting for Codex";
  }
  if (hasLiveStreamingOutput(session)) {
    return "Receiving reply";
  }
  if (hasFinalCodexAnswer(session) || isWaitingForUser(session.phase)) {
    return "Ready";
  }
  if (session.phase === "working") {
    return "Working";
  }
  if (session.phase === "input_sent") {
    return "Sending";
  }
  if (session.phase === "error") {
    return "Error";
  }
  return session.status === "running" ? "Working" : "Idle";
}

function defaultCodexResumeArgs(cwd) {
  return [
    "resume",
    "--no-alt-screen",
    "-C",
    cwd || process.cwd(),
    "-s",
    "workspace-write",
    "-a",
    "on-request"
  ];
}

function sanitizeEnv(env, provider) {
  const next = { ...env };
  if (provider === "codex-pty") {
    delete next.npm_config_prefix;
    delete next.npm_config_global;
    delete next.npm_config_user_agent;
    next.CORPTIE_MANAGED_CODEX = "1";
  }
  return next;
}

function proxyEnvForAgent(agentProxy = {}, agentKey = "") {
  const profile = agentProxy?.[agentKey];
  if (!profile?.enabled) {
    return {};
  }

  const env = {};
  setProxyEnvPair(env, "HTTP_PROXY", profile.httpProxy);
  setProxyEnvPair(env, "HTTPS_PROXY", profile.httpsProxy);
  setProxyEnvPair(env, "ALL_PROXY", profile.allProxy);
  setProxyEnvPair(env, "NO_PROXY", profile.noProxy);
  return env;
}

function setProxyEnvPair(env, key, value) {
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  env[key] = value.trim();
  env[key.toLowerCase()] = value.trim();
}

function stripAnsi(text) {
  return text.replace(ansiPattern, "");
}

function shortTitle(text) {
  const compact = text.replace(/\s+/g, " ").trim() || "New PTY agent";
  return compact.length > 64 ? `${compact.slice(0, 61)}...` : compact;
}

function classifyOutput(text, provider) {
  if (provider === "codex-pty" && /^›\s*/.test(text)) {
    return "userMessage";
  }
  if (provider === "codex-pty" && /^(thinking|codex|assistant|ok\b)/i.test(text.trim())) {
    return "agentMessage";
  }
  if (isApprovalPrompt(text)) {
    return "approval";
  }
  if (/diff|modified|apply patch|changed file|files changed|补丁/i.test(text)) {
    return "fileChange";
  }
  if (/exec|running|command|shell|bash|zsh|\$ /i.test(text)) {
    return "commandExecution";
  }
  if (/error|failed|exception|traceback|timed out|错误|失败/i.test(text)) {
    return "error";
  }
  return "terminalOutput";
}

function inferPhase(text, provider, fallback = "running") {
  if (provider !== "codex-pty") {
    return "output";
  }
  if (isCodexNoise(text)) {
    return fallback;
  }
  if (isCodexPrompt(text)) {
    return "ready";
  }
  if (isApprovalPrompt(text)) {
    return "waiting_approval";
  }
  if (/thinking|thinking for|reasoning|working|running|exec|patch|apply patch|reading|searching/i.test(text)) {
    return "working";
  }
  if (/error|failed|exception|traceback|timed out|错误|失败/i.test(text)) {
    return "error";
  }
  if (/usage limit|limit resets|rate limit/i.test(text)) {
    return "blocked";
  }
  if (/ready|done|complete|finished|ok\b/i.test(text)) {
    return "ready";
  }
  return fallback === "starting" || fallback === "input_sent" ? "output" : fallback;
}

function idleSeconds(session) {
  const reference = session.lastOutputAt || session.lastInputAt || session.updatedAt;
  if (!reference) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - Date.parse(reference)) / 1000));
}

function runningSummary(session, latestOutput) {
  const idle = idleSeconds(session);
  if (hasPendingCodexInput(session)) {
    return "Message sent to Codex; waiting for it to appear in the session log.";
  }
  if (hasFinalCodexAnswer(session)) {
    return "Codex is waiting for your next instruction.";
  }
  if (session.phase === "awaiting_first_input") {
    return "Codex CLI is ready; send your first instruction.";
  }
  if (session.phase === "input_sent") {
    return "Input sent to Codex; waiting for terminal output.";
  }
  if (session.phase === "waiting_approval") {
    return "Codex is waiting for approval.";
  }
  if (session.phase === "ready") {
    return "Codex is waiting for your next instruction.";
  }
  if (session.phase === "blocked") {
    return latestOutput || "Codex reported a usage or rate limit.";
  }
  if (session.phase === "error") {
    return latestOutput || "Codex reported an error.";
  }
  if (idle !== null && idle > 60) {
    return latestOutput
      ? `${latestOutput} (no new output for ${Math.floor(idle / 60)}m)`
      : `No terminal output for ${Math.floor(idle / 60)}m.`;
  }
  return latestOutput || "Codex terminal is starting.";
}

function itemTitle(text, provider) {
  if (provider === "codex-pty") {
    if (/^›\s*/.test(text)) {
      return "User";
    }
    if (isApprovalPrompt(text)) {
      return "Codex approval";
    }
    return "Codex";
  }
  return "Terminal";
}

function normalizeOutputText(text, provider) {
  if (provider !== "codex-pty") {
    return text;
  }

  return text
    .replace(/^›\s*/, "")
    .replace(/›[\s\S]*?(?:gpt-[\w.-]+.*?·\s*~?\/[^\n]*)$/i, "")
    .replace(/\b(?:gpt-[\w.-]+.*?·\s*~?\/[^\n]*)$/i, "")
    .replace(/[╭╮╰╯│─]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function lastMeaningfulText(items) {
  for (const item of visibleItems(items).slice().reverse()) {
    if (item.text && item.type !== "userMessage" && item.type !== "system" && !isCodexNoise(item.text)) {
      return item.text;
    }
  }
  return "";
}

function visibleItems(items, provider = "") {
  const visible = items
    .filter((item) => !isCodexNoise(item.text ?? ""))
    .filter((item) => !(provider === "codex-pty" && item.type === "userMessage" && item.status !== "sent"))
    .map((item) => normalizeVisibleItem(item, provider));
  const cleaned = cleanReplayItems(dedupeAdjacentUserEchoes(visible), provider);
  return provider === "codex-pty" ? mergeReadableCodexItems(cleaned) : cleaned;
}

function withLiveOutputItem(items, session) {
  const liveText = liveOutputText(session);
  if (!liveText) {
    return items;
  }
  const liveItem = {
    id: `${session.id}:live-output`,
    turnId: session.id,
    turnStatus: "running",
    type: "agentMessage",
    title: session.provider === "codex-pty" ? "Codex" : "Agent",
    text: liveText,
    options: null,
    status: "streaming",
    createdAt: session.bufferUpdatedAt ?? session.updatedAt
  };
  const withoutPreviousLive = items.filter((item) => item.id !== liveItem.id);
  return [...withoutPreviousLive, liveItem];
}

function mergeReadableCodexItems(items = []) {
  const merged = [];
  for (const item of items) {
    const previous = merged.at(-1);
    if (canMergeCodexDisplayItems(previous, item)) {
      previous.title = "Codex";
      previous.type = "agentMessage";
      previous.text = mergeCodexText(previous.text, item.text);
      previous.createdAt = item.createdAt ?? previous.createdAt;
      previous.turnStatus = item.turnStatus ?? previous.turnStatus;
      previous.status = item.status ?? previous.status;
      continue;
    }
    merged.push({ ...item });
  }
  return merged;
}

function canMergeCodexDisplayItems(previous, item) {
  if (!previous || !item) {
    return false;
  }
  if (previous.turnId !== item.turnId) {
    return false;
  }
  if (previous.options?.length || item.options?.length) {
    return false;
  }
  if (!isMergeableCodexDisplayType(previous.type) || !isMergeableCodexDisplayType(item.type)) {
    return false;
  }
  if (isToolStatusText(previous.text) && !isToolStatusText(item.text)) {
    previous.title = "Codex";
    previous.type = "agentMessage";
  }
  return true;
}

function isMergeableCodexDisplayType(type = "") {
  return type === "agentMessage" || type === "terminalOutput" || type === "commandExecution";
}

function mergeCodexText(previous = "", next = "") {
  const left = String(previous ?? "").trimEnd();
  const right = String(next ?? "").trim();
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  if (left.endsWith(right)) {
    return left;
  }
  return `${left}\n\n${right}`;
}

function isToolStatusText(text = "") {
  return /^(running|exec|command|shell|bash|zsh|reading|searching|using)\b/i.test(String(text).trim());
}

function liveOutputText(session) {
  if (session.status !== "running") {
    return "";
  }
  const text = normalizeOutputText((session.buffer ?? "").trimEnd(), session.provider);
  if (!text || isCodexNoise(text)) {
    return "";
  }
  if (classifyOutput(text, session.provider) === "userMessage") {
    return "";
  }
  if (isSubmittedEcho(session, text, text) || isKnownUserEcho(session, text)) {
    return "";
  }
  return text;
}

function hasLiveStreamingOutput(session) {
  if (session.status !== "running") {
    return false;
  }
  if (liveOutputText(session)) {
    return true;
  }
  const ageMs = session.lastOutputAt ? Date.now() - Date.parse(session.lastOutputAt) : Number.POSITIVE_INFINITY;
  return session.provider === "codex-pty" && ageMs < 900 && session.phase !== "waiting_approval";
}

function canonicalCodexItems(session, maxItems) {
  const rolloutPath = session.resume?.rolloutPath;
  if (session.provider !== "codex-pty" || !rolloutPath) {
    return null;
  }

  let content = "";
  try {
    content = readFileSync(rolloutPath, "utf8");
  } catch {
    return null;
  }

  const sentItems = session.items
    .filter((item) => item.type === "userMessage" && item.status === "sent")
    .map((item, sentIndex) => ({
      ...item,
      sentIndex,
      normalizedText: normalizeUserText(item.text),
      createdAtMs: Date.parse(item.createdAt ?? "")
    }));
  const matchedSentIndexes = new Set();
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
      const approval = approvalItemFromFunctionCall(session, payload, index, completedCallIds, activeTurnId);
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
    if (!text || isCodexNoise(text)) {
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
    const matchingSent = role === "user"
      ? matchingSentItemForText(sentItems, matchedSentIndexes, text)
      : null;
    if (matchingSent) {
      matchedSentIndexes.add(matchingSent.sentIndex);
    }
    const contentOptions = role === "assistant" ? choiceOptionsFromAgentMessage(text) : null;
    items.push({
      id: `${session.id}:rollout:${index}`,
      turnId: payload.turn_id ?? session.id,
      turnStatus: payload.phase === "final_answer" ? "complete" : "running",
      type: role === "user" ? "userMessage" : "agentMessage",
      title: role === "user" ? "User" : "Codex",
      text,
      options: contentOptions,
      status: role === "user" ? "sent" : payload.phase ?? null,
      createdAt: matchingSent?.createdAt ?? session.createdAt,
      rolloutIndex: index
    });
  }

  if (items.length === 0) {
    return null;
  }

  const latestCanonicalSentMs = Math.max(
    0,
    ...items
      .filter((item) => item.type === "userMessage")
      .map((item) => Date.parse(item.createdAt ?? ""))
      .filter(Number.isFinite)
  );
  for (const item of sentItems) {
    if (!item.normalizedText) {
      continue;
    }
    const isAlreadyCovered = matchedSentIndexes.has(item.sentIndex);
    const isRecentPending = Number.isFinite(item.createdAtMs) && Date.now() - item.createdAtMs < 120_000;
    const isNewerThanCanonical = latestCanonicalSentMs > 0
      ? Number.isFinite(item.createdAtMs) && item.createdAtMs >= latestCanonicalSentMs
      : true;
    if (!isAlreadyCovered && (isNewerThanCanonical || isRecentPending)) {
      items.push(item);
    }
  }

  const merged = mergeReadableCodexItems(items).slice(-maxItems);
  if (hasLiveCodexApprovalPrompt(session)) {
    return merged;
  }
  return merged.filter((item) => !(item.type === "approval" && item.status === "pending"));
}

function matchingSentItemForText(sentItems, matchedSentIndexes, text) {
  const normalizedText = normalizeUserText(text);
  if (!normalizedText) {
    return null;
  }
  const exact = sentItems.find((item) => !matchedSentIndexes.has(item.sentIndex) && item.normalizedText === normalizedText);
  if (exact) {
    return exact;
  }
  return sentItems.find((item) => {
    if (matchedSentIndexes.has(item.sentIndex) || !item.normalizedText) {
      return false;
    }
    return normalizedText.includes(item.normalizedText) || item.normalizedText.includes(normalizedText);
  }) ?? null;
}

function latestCodexAssistantText(session) {
  const canonical = canonicalCodexItems(session, 40);
  for (const item of (canonical ?? []).slice().reverse()) {
    if (item.type === "agentMessage" && item.text && !isCodexNoise(item.text)) {
      return previewText(item.text);
    }
  }
  return "";
}

function latestSuggestedOptions(session) {
  const options = session.pendingChoice?.options;
  return Array.isArray(options) && options.length >= 2 ? options : null;
}

function currentChoiceInputSignature(session) {
  const choiceContext = buildChoiceContext(session.screenText ?? "");
  return choiceContext ? choiceInputSignature(choiceContext.text) : "";
}

function codexRolloutActivityStatus(session) {
  const rolloutPath = session.resume?.rolloutPath;
  if (session.provider !== "codex-pty" || !rolloutPath) {
    return "";
  }
  if (isInterruptedCodexScreen(session.screenText ?? "")) {
    return "";
  }

  let content = "";
  try {
    content = readFileSync(rolloutPath, "utf8");
  } catch {
    return "";
  }

  let activeTurnId = null;
  let latestActivity = "";
  for (const line of content.split("\n")) {
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
      activeTurnId = payload.turn_id ?? null;
      latestActivity = "Starting";
      continue;
    }
    if (entry.type === "event_msg" && payload.type === "task_complete" && (!activeTurnId || payload.turn_id === activeTurnId)) {
      activeTurnId = null;
      latestActivity = "Ready";
      continue;
    }
    if (!activeTurnId) {
      continue;
    }
    const passthroughTurnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
    if (passthroughTurnId && passthroughTurnId !== activeTurnId) {
      continue;
    }
    const activity = activityFromRolloutEntry(entry);
    if (activity) {
      latestActivity = activity;
    }
  }

  return latestActivity || "";
}

function activityFromRolloutEntry(entry) {
  const payload = entry.payload ?? {};
  if (entry.type === "response_item" && payload.type === "function_call") {
    return toolActivityLabel(payload.name, payload.arguments);
  }
  if (entry.type === "response_item" && payload.type === "function_call_output") {
    return "Reading tool output";
  }
  if (entry.type === "response_item" && payload.type === "web_search_call") {
    return webSearchActivityLabel(payload.action);
  }
  if (entry.type === "event_msg" && payload.type === "web_search_end") {
    return webSearchActivityLabel(payload.action);
  }
  if (entry.type === "response_item" && payload.type === "reasoning") {
    return "Thinking";
  }
  if (entry.type === "event_msg" && payload.type === "agent_message" && payload.phase === "commentary") {
    return firstLine(payload.message);
  }
  return "";
}

function toolActivityLabel(name = "", rawArguments = "") {
  if (name === "shell_command") {
    const command = parseToolArguments(rawArguments).command;
    return command ? `Running shell: ${shorten(command, 52)}` : "Running shell command";
  }
  if (name === "read_mcp_resource") {
    return "Reading MCP resource";
  }
  if (name === "web_search") {
    return "Searching web";
  }
  return name ? `Using ${name}` : "Using tool";
}

function webSearchActivityLabel(action = {}) {
  if (action?.type === "open_page") {
    return "Opening web page";
  }
  return "Searching web";
}

function parseToolArguments(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value ?? {};
  } catch {
    return {};
  }
}

function approvalItemFromFunctionCall(session, payload, index, completedCallIds, activeTurnId = null) {
  if (!payload.call_id || completedCallIds.has(payload.call_id)) {
    return null;
  }
  const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id ?? session.id;
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
  const options = codexApprovalOptions(session);
  return {
    id: `${session.id}:approval:${payload.call_id}`,
    turnId,
    turnStatus: "waiting_approval",
    type: "approval",
    title: "Codex approval",
    text: body,
    options,
    status: "pending",
    createdAt: session.updatedAt ?? session.createdAt,
    rolloutIndex: index
  };
}

function shouldSuppressChoiceParser(session) {
  return session.provider === "codex-pty" && hasPendingCodexApproval(session);
}

function codexApprovalOptions(session) {
  return [
    { id: "approve", label: "Approve", role: "approve", index: 0, selected: true },
    { id: "deny", label: "Deny", role: "deny", index: 1, selected: false }
  ];
}

function possibleChoiceStage(screenText = "") {
  const text = trimChoiceScreen(screenText);
  if (!text) {
    return false;
  }
  const parsed = parseTerminalOptions(choiceOptionBlockText(text));
  if (parsed.options.length >= 2) {
    return true;
  }
  return /(\?|是否|选择|请选择|approve|allow|deny|cancel|continue|proceed|run command|permission|approval|\[[yn]\/[yn]\])/i.test(text)
    && /(approve|allow|deny|cancel|yes|no|continue|proceed|run|拒绝|允许|继续|取消)/i.test(text);
}

function choiceParserShouldUseModel(screenText = "") {
  const text = trimChoiceScreen(screenText);
  if (!text || containsPendingUserInputRegion(text)) {
    return false;
  }
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const block = lastChoiceOptionBlock(lines);
  if (block?.count >= 2) {
    return true;
  }
  return lines.slice(-8).some((line) => isExplicitChoiceRequestLine(line));
}

function isExplicitChoiceRequestLine(line = "") {
  return /你现在可以|现在可以|可以选择|请选择|选择一个|选择操作|回复选项|which option|choose (?:one|an option)|select (?:one|an option)|pick (?:one|an option)|approve|approval|permission|allow|deny/i.test(line);
}

function trimChoiceScreen(screenText = "") {
  return screenText
    .split("\n")
    .slice(-80)
    .join("\n")
    .trim()
    .slice(-4000);
}

function buildChoiceContext(screenText = "") {
  const trimmed = trimChoiceScreen(screenText);
  if (!trimmed) {
    return null;
  }
  const sanitized = removePendingUserInputRegions(trimmed);
  if (!sanitized) {
    return null;
  }
  const lines = sanitized
    .split("\n")
    .map((line) => normalizeChoiceScreenLine(line))
    .filter((line) => line && !isNonChoiceStatusLine(line))
    .slice(-80);
  if (!lines.length) {
    return null;
  }

  const optionBlock = lastChoiceOptionBlock(lines);
  if (optionBlock && optionBlock.count >= 2) {
    return {
      text: lines.slice(Math.max(0, optionBlock.start - 4), Math.min(lines.length, optionBlock.end + 3)).join("\n"),
      source: "option-lines"
    };
  }

  const anchorIndex = findLastChoiceAnchorIndex(lines);
  if (anchorIndex < 0) {
    return null;
  }
  return {
    text: lines.slice(Math.max(0, anchorIndex - 8), Math.min(lines.length, anchorIndex + 12)).join("\n"),
    source: "anchor"
  };
}

function removePendingUserInputRegions(screenText = "") {
  const lines = screenText.split("\n");
  const cleaned = [];
  let droppingQueuedInputs = false;
  for (const line of lines) {
    const pendingIndex = pendingUserInputMarkerIndex(line);
    if (pendingIndex >= 0) {
      const prefix = line.slice(0, pendingIndex).trim();
      if (prefix) {
        cleaned.push(prefix);
      }
      droppingQueuedInputs = true;
      continue;
    }
    if (droppingQueuedInputs && isQueuedUserInputLine(line)) {
      continue;
    }
    droppingQueuedInputs = false;
    cleaned.push(line);
  }
  return cleaned
    .map((line) => stripQueuedUserInputFragments(line).trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function pendingUserInputMarkerIndex(line = "") {
  const compact = line.replace(/\s+/g, "").toLowerCase();
  const compactIndex = compact.indexOf("messagestobesubmittedafternexttoolcall");
  if (compactIndex >= 0) {
    const plainIndex = line.toLowerCase().search(/messages\s*to\s*be\s*submitted\s*after\s*next\s*tool\s*call/i);
    return plainIndex >= 0 ? plainIndex : Math.max(0, line.length - (compact.length - compactIndex));
  }
  return line.toLowerCase().search(/press\s+esc\s+to\s+interrupt\s+and\s+send\s+immediately/i);
}

function stripQueuedUserInputFragments(line = "") {
  const pendingIndex = pendingUserInputMarkerIndex(line);
  if (pendingIndex >= 0) {
    return line.slice(0, pendingIndex);
  }
  return line;
}

function isQueuedUserInputLine(line = "") {
  const text = line.trim();
  return /^[↳➜→]\s+/.test(text) || /^[-*]\s+\S/.test(text);
}

function normalizeChoiceScreenLine(line = "") {
  return line
    .replace(/\s+/g, " ")
    .replace(/([•└])(?=\S)/g, "$1 ")
    .replace(/([.!?。！？])(?=\S)/g, "$1 ")
    .trim();
}

function isNonChoiceStatusLine(line = "") {
  return /^worked for\b/i.test(line)
    || /^working\b/i.test(line)
    || /^•?\s*working\(/i.test(line)
    || /^•?\s*ran\b/i.test(line)
    || /^└\s*\d{4}-\d{2}-\d{2}\b/.test(line)
    || /^0;\[[^\]]+\]\s*action required/i.test(line);
}

function findLastChoiceAnchorIndex(lines = []) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isChoiceAnchorLine(lines[index])) {
      return index;
    }
  }
  return -1;
}

function isChoiceAnchorLine(line = "") {
  return /(\?|？|是否|选择|请选择|approve|allow|deny|cancel|continue|proceed|run command|permission|approval|\[[yn]\/[yn]\])/i.test(line)
    && !isNonChoiceStatusLine(line);
}

function parseChoiceStageWithRules(screenText = "") {
  const parsed = parseTerminalOptions(choiceOptionBlockText(screenText));
  if (parsed.options.length < 2) {
    return null;
  }
  return {
    prompt: inferChoicePrompt(screenText),
    options: parsed.options,
    selectedIndex: parsed.selectedIndex >= 0 ? parsed.selectedIndex : 0,
    confidence: 0.58,
    source: "rules"
  };
}

export async function parseChoiceStageWithConfiguredParser(screenText = "", settings = {}, session = null) {
  if (!settings || settings.provider === "disabled" || process.env.CORPTIE_DISABLE_LLM_CHOICE_PARSER === "1") {
    return null;
  }
  if (!choiceParserShouldUseModel(screenText)) {
    logChoiceParser("configured-skip", session, { provider: settings.provider, reason: "weak-choice-context" });
    return null;
  }
  if (settings.provider === "local-agent") {
    return parseChoiceStageWithLocalAgent(screenText, settings, session);
  }
  return parseChoiceStageWithOpenAi(screenText, settings, session);
}

export function configureChoiceParserRuntime(settings = {}) {
  localChoiceParserRuntime.configure(settings);
}

async function parseChoiceStageWithOpenAi(screenText = "", settings = {}, session = null) {
  const apiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY || process.env.CORPTIE_OPENAI_API_KEY;
  if (!apiKey) {
    logChoiceParser("openai-skip", session, { reason: "missing-api-key" });
    return null;
  }
  const model = settings.openaiModel || process.env.CORPTIE_CHOICE_PARSER_MODEL || "gpt-4o-mini";
  const endpoint = openAiCompatibleChatCompletionsURL(settings.openaiBaseURL || process.env.CORPTIE_CHOICE_PARSER_BASE_URL);
  const startedAt = Date.now();
  logChoiceParser("openai-request-start", session, { model, endpoint: redactURL(endpoint), chars: screenText.length });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You extract interactive terminal choice prompts for a desktop agent UI.",
            "Return only JSON with: kind, prompt, options, selectedIndex, confidence.",
            "options must be an array of {id,label,role}. role is one of approve, approve-always, deny, edit, other.",
            "Only extract options that are visibly present in the supplied candidate region.",
            "Never treat queued user messages, chat history, tool logs, or status text as options.",
            "If the screen is not asking the user to choose an option, return {\"kind\":\"none\",\"options\":[],\"selectedIndex\":-1,\"confidence\":0}."
          ].join(" ")
        },
        {
          role: "user",
          content: `Terminal candidate choice region:\n${screenText}`
        }
      ]
    })
  });
  const headersAt = Date.now();
  logChoiceParser("openai-response-headers", session, {
    ok: response.ok,
    status: response.status,
    durationMs: headersAt - startedAt,
    contentType: response.headers.get("content-type") ?? ""
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const errorMessage = choiceParserHttpErrorMessage(response.status, errorText);
    logChoiceParser("openai-response-error", session, {
      ok: false,
      status: response.status,
      durationMs: Date.now() - startedAt,
      bodyReadMs: Date.now() - headersAt,
      error: errorMessage
    });
    throw new Error(errorMessage);
  }
  const responseText = await response.text();
  const bodyAt = Date.now();
  logChoiceParser("openai-response-body", session, {
    durationMs: bodyAt - startedAt,
    bodyReadMs: bodyAt - headersAt,
    bytes: Buffer.byteLength(responseText)
  });
  const data = JSON.parse(responseText);
  const parsedAt = Date.now();
  logChoiceParser("openai-response-json", session, {
    durationMs: parsedAt - startedAt,
    parseMs: parsedAt - bodyAt
  });
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) {
    logChoiceParser("openai-response-final", session, { ok: true, durationMs: Date.now() - startedAt, reason: "empty-content" });
    return null;
  }
  const normalized = normalizeChoiceParserJson(JSON.parse(raw), screenText, "openai");
  const normalizedAt = Date.now();
  logChoiceParser("openai-response-final", session, {
    ok: true,
    durationMs: normalizedAt - startedAt,
    normalizeMs: normalizedAt - parsedAt,
    accepted: Boolean(normalized),
    options: normalized?.options?.length ?? 0,
    confidence: normalized?.confidence ?? 0
  });
  return normalized;
}

function openAiCompatibleChatCompletionsURL(baseURL) {
  const raw = typeof baseURL === "string" && baseURL.trim()
    ? baseURL.trim()
    : "https://api.openai.com/v1";
  const withoutTrailingSlash = raw.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(withoutTrailingSlash)) {
    return withoutTrailingSlash;
  }
  return `${withoutTrailingSlash}/chat/completions`;
}

function choiceParserHttpErrorMessage(status, body = "") {
  const fallback = `OpenAI-compatible parser request failed with HTTP ${status}.`;
  if (!body) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.message || parsed?.error;
    if (message) {
      return `${fallback} ${String(message)}`;
    }
  } catch {
    // Fall back to a short body preview below.
  }
  return `${fallback} ${body.replace(/\s+/g, " ").trim().slice(0, 500)}`;
}

async function parseChoiceStageWithLocalAgent(screenText = "", settings = {}, session = null) {
  return localChoiceParserRuntime.parse(screenText, settings, session);
}

function localChoiceParserPrompt(screenText = "") {
  const compactScreenText = screenText.replace(/\s*\n\s*/g, " \\n ").trim();
  return [
    "Return JSON only. Detect whether this terminal text is asking the user to choose.",
    "Fields: kind, prompt, options, selectedIndex, confidence.",
    "options items: id, label, role. Roles: approve, approve-always, deny, edit, other.",
    "Use only visible option labels. If no choice: kind none, options empty, selectedIndex -1, confidence 0.",
    `Terminal candidate choice region: ${compactScreenText}`
  ].join(" ");
}

function localChoiceParserAppServerArgs(settings = {}) {
  const configuredArgs = splitShellArgs(settings.localArgs || "");
  return [
    "app-server",
    "--listen",
    "stdio://",
    "--disable",
    "hooks",
    "-c",
    "model_reasoning_effort=\"low\"",
    "-c",
    "mcp_servers={}",
    "-c",
    "features.rmcp_client=false",
    "-c",
    "web_search=\"disabled\"",
    ...configuredArgs
  ].filter(Boolean);
}

function localChoiceParserWorkspace() {
  return path.join(os.tmpdir(), "corptie-choice-parser-workspace");
}

function localChoiceParserSettingsSignature(settings = {}) {
  return JSON.stringify({
    command: settings.localCommand || defaultCodexCommand(),
    args: settings.localArgs || "",
    model: settings.localModel || "",
    proxy: settings.agentProxy?.choiceParser ?? null
  });
}

function redactLocalAgentArgs(args = []) {
  return args.map((arg) => {
    if (typeof arg !== "string") {
      return arg;
    }
    if (arg.length > 120 || arg.includes("\n")) {
      return `<prompt:${arg.length} chars>`;
    }
    return arg;
  });
}

function previewLogText(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function normalizeChoiceParserJson(parsed, screenText, source) {
  if (parsed.kind === "none" || !Array.isArray(parsed.options)) {
    return null;
  }
  const options = parsed.options
    .map((option, index) => normalizeParsedChoiceOption(option, index))
    .filter((option) => option.label);
  if (!choiceOptionsAreGrounded(options, screenText)) {
    return null;
  }
  return {
    prompt: String(parsed.prompt || inferChoicePrompt(screenText)).trim(),
    options,
    selectedIndex: Number.isInteger(parsed.selectedIndex) ? parsed.selectedIndex : 0,
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
    source
  };
}

function normalizeParsedChoiceOption(option, index) {
  if (typeof option === "string" || typeof option === "number") {
    return {
      id: `option-${index}`,
      label: String(option).trim(),
      role: "other"
    };
  }
  if (!option || typeof option !== "object") {
    return {
      id: `option-${index}`,
      label: "",
      role: "other"
    };
  }
  const role = typeof option.role === "string" && option.role.trim() ? option.role.trim() : "other";
  const label = option.label ?? option.text ?? option.title ?? option.name ?? option.value ?? "";
  return {
    id: String(option.id || `${role}-${index}`),
    label: String(label).trim(),
    role
  };
}

function choiceOptionsAreGrounded(options = [], screenText = "") {
  if (options.length < 2) {
    return false;
  }
  if (containsPendingUserInputRegion(screenText)) {
    return false;
  }
  const haystack = normalizeForChoiceGrounding(screenText);
  return options.every((option) => {
    const label = String(option.label || "").trim();
    if (!label || isLikelyQueuedUserMessageOption(label)) {
      return false;
    }
    const needle = normalizeForChoiceGrounding(label);
    return needle.length >= 2 && haystack.includes(needle);
  });
}

function containsPendingUserInputRegion(text = "") {
  return pendingUserInputMarkerIndex(text) >= 0 || /↳\s+\S/.test(text);
}

function isLikelyQueuedUserMessageOption(label = "") {
  return /^\/model\b/i.test(label)
    || /^\/\w+\b/.test(label)
    || /operation not permitted/i.test(label)
    || /为什么|刚刚|我刚|我现在|你没有|你为什么/.test(label);
}

function normalizeForChoiceGrounding(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[\s"'`*_~()[\]{}<>:：,，.。!！?？;；|\\/+-]/g, "")
    .trim();
}

function extractFirstJsonObject(text = "") {
  return extractJsonObjects(text)[0] ?? "";
}

function extractChoiceParserJsonObject(text = "") {
  for (const candidate of extractJsonObjects(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (Object.prototype.hasOwnProperty.call(parsed, "options")
            || Object.prototype.hasOwnProperty.call(parsed, "kind")
            || Object.prototype.hasOwnProperty.call(parsed, "prompt")) {
          return candidate;
        }
      }
    } catch {
      // Candidates are already parsed in extractJsonObjects, but keep this defensive.
    }
  }
  return "";
}

function extractJsonObjects(text = "") {
  const results = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = inString;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, index + 1);
          try {
            JSON.parse(candidate);
            results.push(candidate);
          } catch {
            // Keep scanning; terminal output often contains partial objects while streaming.
          }
          break;
        }
      }
    }
  }
  return results;
}

function splitShellArgs(value = "") {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match;
  while ((match = pattern.exec(value))) {
    args.push(match[1] ?? match[2] ?? match[0]);
  }
  return args;
}

function inferChoicePrompt(screenText = "") {
  const lines = screenText
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const line of lines.slice(-12).reverse()) {
    if (looksLikeChoiceLine(line)) {
      continue;
    }
    if (/[?？]$|approval|permission|allow|run|continue|是否|允许|选择|请选择/i.test(line)) {
      return line;
    }
  }
  return "The agent is waiting for a choice.";
}

function parseTerminalOptions(screenText = "") {
  const lines = screenText
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-80);
  const options = [];
  let selectedIndex = -1;
  for (const line of lines) {
    if (!looksLikeChoiceLine(line)) {
      continue;
    }
    const selected = /^[>›❯➜▶●◉]\s*/.test(line) || /\bselected\b/i.test(line);
    const label = normalizeChoiceLabel(line);
    if (!label || label.length > 80 || isCodexNoise(label)) {
      continue;
    }
    const role = approvalOptionRole(label);
    const id = `${role}-${options.length}`;
    const option = { id, label, role, index: options.length };
    options.push(option);
    if (selected) {
      selectedIndex = option.index;
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const option of options) {
    const key = option.label.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({ ...option, index: deduped.length, id: `${option.role}-${deduped.length}` });
  }
  if (selectedIndex >= deduped.length) {
    selectedIndex = -1;
  }
  return { options: deduped.slice(-6), selectedIndex };
}

function choiceOptionBlockText(screenText = "") {
  const lines = screenText
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-80);
  const block = lastChoiceOptionBlock(lines);
  if (block) {
    return lines.slice(Math.max(0, block.start - 2), block.end + 1).join("\n");
  }
  return lines.some((line) => looksLikeChoiceLine(line)) ? "" : screenText;
}

function lastChoiceOptionBlock(lines = []) {
  const blocks = [];
  let current = null;
  for (const [index, line] of lines.entries()) {
    if (looksLikeChoiceLine(line)) {
      if (!current) {
        current = { start: index, end: index, count: 0 };
      }
      current.end = index;
      current.count += 1;
      continue;
    }
    if (current) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) {
    blocks.push(current);
  }

  return blocks
    .filter((block) => block.count >= 2)
    .filter((block) => !isInventoryOnlyOptionBlock(lines, block))
    .at(-1) ?? null;
}

function isInventoryOnlyOptionBlock(lines = [], block) {
  const before = lines.slice(Math.max(0, block.start - 3), block.start).join(" ");
  const hasChoiceAnchor = lines
    .slice(Math.max(0, block.start - 4), block.start)
    .some((line) => isChoiceAnchorLine(line));
  if (hasChoiceAnchor) {
    return false;
  }
  return /里面有|物资|背包|清单|包括|inventory|contains/i.test(before);
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
    if (!label || label.length > 120 || isCodexNoise(label)) {
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
    if (!label || label.length > 180 || isCodexNoise(label)) {
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

function looksLikeChoiceLine(line) {
  return /^[>›❯➜▶●◉○◌]\s+/.test(line)
    || /^\(?[0-9a-z]\)?[.)]\s+/.test(line)
    || /^\[[ xX✓✔-]\]\s+/.test(line)
    || /^(approve|allow|run|continue|yes|deny|reject|cancel|no)\b/i.test(line)
    || /\b(approve|allow|run command|continue|yes|deny|reject|cancel|no)\b/i.test(line);
}

function normalizeChoiceLabel(line) {
  return line
    .replace(/^[>›❯➜▶●◉○◌]\s*/, "")
    .replace(/^\(?[0-9a-z]\)?[.)]\s*/i, "")
    .replace(/^\[[ xX✓✔-]\]\s*/, "")
    .replace(/\bselected\b/ig, "")
    .trim();
}

function approvalOptionRole(label = "") {
  if (/\b(deny|reject|cancel|no|do not|don't)\b|拒绝|取消|不允许/i.test(label)) {
    return "deny";
  }
  if (/\b(always|forever|remember)\b|总是|永久|记住/i.test(label)) {
    return "approve-always";
  }
  return "approve";
}

function optionSelectionSequence(options, targetIndex) {
  if (!options.length || targetIndex < 0) {
    return "\r";
  }
  const selectedIndex = options.findIndex((option) => option.selected === true);
  if (selectedIndex < 0) {
    return `${"\x1b[A".repeat(options.length)}${"\x1b[B".repeat(targetIndex)}\r`;
  }
  const delta = targetIndex - selectedIndex;
  if (delta > 0) {
    return `${"\x1b[B".repeat(delta)}\r`;
  }
  if (delta < 0) {
    return `${"\x1b[A".repeat(Math.abs(delta))}\r`;
  }
  return "\r";
}

function firstLine(value = "") {
  return shorten(String(value).split("\n")[0].trim(), 72);
}

function shorten(value = "", limit = 60) {
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function previewText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function logChoiceParser(event, session, details = {}) {
  const noisySkip = event === "skip" || event === "configured-skip";
  if (noisySkip && process.env.CORPTIE_CHOICE_PARSER_DEBUG !== "1") {
    return;
  }
  const sessionId = session?.id ?? "unknown";
  const safeDetails = Object.fromEntries(
    Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 220) : value])
  );
  console.log(`[choice-parser] event=${event} session=${sessionId} ${JSON.stringify(safeDetails)}`);
}

function redactURL(value = "") {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return String(value).replace(/\?.*$/, "");
  }
}

function hasPendingCodexInput(session) {
  if (session.provider !== "codex-pty" || !session.lastSubmittedText) {
    return false;
  }
  const lastInputAgeMs = session.lastInputAt ? Date.now() - Date.parse(session.lastInputAt) : Number.POSITIVE_INFINITY;
  if (lastInputAgeMs > 120_000) {
    return false;
  }
  const canonical = canonicalCodexItems(session, maxItemsForPendingCheck(session));
  if (!canonical) {
    return true;
  }
  const submitted = normalizeUserText(session.lastSubmittedText);
  return !canonical.some((item) => item.type === "userMessage" && normalizeUserText(item.text).includes(submitted));
}

function hasPendingCodexApproval(session) {
  if (session.provider !== "codex-pty") {
    return false;
  }
  if (!hasLiveCodexApprovalPrompt(session)) {
    return false;
  }
  const canonical = canonicalCodexItems(session, maxItemsForPendingCheck(session));
  return Boolean(canonical?.some((item) => item.type === "approval" && item.status === "pending"));
}

function hasLiveCodexApprovalPrompt(session) {
  if (session.provider !== "codex-pty" || session.status !== "running") {
    return false;
  }
  const screenText = session.screenText ?? "";
  if (!screenText || isInterruptedCodexScreen(screenText)) {
    return false;
  }
  return isApprovalPrompt(screenText);
}

function isInterruptedCodexScreen(screenText = "") {
  return /Conversation interrupted/i.test(screenText);
}

function liveCodexApprovalOptions(session) {
  const parsed = parseTerminalOptions(choiceOptionBlockText(session.screenText ?? ""));
  const options = parsed.options.length >= 2
    ? parsed.options.map((option, index) => ({
      id: approvalOptionRole(option.label) === "deny" ? "deny" : `approve-${index}`,
      label: option.label,
      role: approvalOptionRole(option.label),
      index,
      selected: option.selected === true
    }))
    : [];
  if (options.some((option) => option.role === "approve") && options.some((option) => option.role === "deny")) {
    return options;
  }
  return codexApprovalOptions(session);
}

function hasFinalCodexAnswer(session) {
  if (session.provider !== "codex-pty") {
    return false;
  }
  const canonical = canonicalCodexItems(session, 20);
  const latest = canonical?.at(-1);
  return latest?.type === "agentMessage" && latest.status === "final_answer";
}

function maxItemsForPendingCheck(session) {
  return Math.max(20, Math.min(240, session.items?.length ?? 20));
}

function normalizeVisibleItem(item, provider) {
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

function dedupeAdjacentUserEchoes(items) {
  const deduped = [];
  for (const item of items) {
    const previous = deduped.at(-1);
    if (
      previous?.type === "userMessage"
      && item.type === "userMessage"
      && normalizeUserText(previous.text) === normalizeUserText(item.text)
    ) {
      continue;
    }
    deduped.push(item);
  }
  return deduped;
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

function isSubmittedEcho(session, rawText, normalizedText) {
  if (session.provider !== "codex-pty" || !session.lastSubmittedText) {
    return false;
  }
  const lastInputAgeMs = session.lastInputAt ? Date.now() - Date.parse(session.lastInputAt) : Number.POSITIVE_INFINITY;
  if (lastInputAgeMs > 30_000) {
    return false;
  }
  const normalizedSubmitted = normalizeUserText(session.lastSubmittedText);
  const normalizedOutput = normalizeUserText(normalizedText);
  if (!normalizedSubmitted || normalizedSubmitted !== normalizedOutput) {
    return false;
  }
  return /^›\s*/.test(rawText) || rawText.includes(session.lastSubmittedText) || normalizedOutput === normalizedSubmitted;
}

function isKnownUserEcho(session, normalizedText) {
  if (session.provider !== "codex-pty") {
    return false;
  }
  const normalizedOutput = normalizeUserText(normalizedText);
  if (!normalizedOutput) {
    return false;
  }
  return session.items.some((item) => item.type === "userMessage" && normalizeUserText(item.text) === normalizedOutput);
}

function isReconnectReplayDuplicate(session, normalizedText) {
  if (session.provider !== "codex-pty") {
    return false;
  }
  const createdMs = Date.parse(session.createdAt);
  if (!Number.isFinite(createdMs) || Date.now() - createdMs > 20_000) {
    return false;
  }
  const normalizedOutput = normalizeUserText(normalizedText);
  return session.items.some((item) => item.type !== "userMessage" && item.type !== "system" && normalizeUserText(item.text) === normalizedOutput);
}

function normalizeUserText(text = "") {
  return text.replace(/^›\s*/, "").replace(/\s+/g, " ").trim();
}

function choiceInputSignature(text = "") {
  return text.replace(/\s+/g, " ").trim().slice(0, 2000);
}

function lastItemType(items) {
  return items.at(-1)?.type ?? "";
}

function isWaitingForUser(phase) {
  return phase === "waiting_approval" || phase === "ready" || phase === "blocked" || phase === "awaiting_first_input";
}

function isCodexPrompt(text) {
  return /tab to queue message|Press enter to continue|›\s*.*(?:context left|gpt-|\/model)|What do you want to work on/i.test(text);
}

function isApprovalPrompt(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  return /requires? (your )?approval|needs? (your )?approval|permission required|wants to (run|execute)|run this command|execute this command|allow .*command|approve\?|confirm\?|proceed\?|continue\?|do you want .*\?|would you like .*\?|are you sure .*\?|\[y\/n\]|yes\/no|批准.*\?|允许.*\?|是否.*(批准|允许|继续)/i.test(compact);
}

function isCodexNoise(text) {
  return /^现$|^your config\.toml:?$|^Started codex resume |You have \d+ usage limit resets available|10;\?11;\?.*>_ OpenAI Codex|^(?:10;\?11;\?|\[[0-9;?]*[a-zA-Z])$|^>_ OpenAI Codex|^model:\s|^directory:\s|features?.*web[_\s-]?search[_\s-]?request.*deprecated|web[_\s-]?search[_\s-]?request.*deprecated|set [`'"]?web[_\s-]?search[`'"]?.*(live|true|enabled)|falling back from web ?sockets? to https|websocket.*fallback|under a profile\) in config\.toml|Tip: Try the Codex App|HooksLifecycle hooks|EventInstalledActiveReviewDescription|MCP startup incomplete|MCP client .* timed out|Starting MCP servers|startup_timeout_sec|\[mcp_servers\.|0;[⠼⠴⠦⠧⠇⠏⠋⠙⠹⠸]/i.test(text);
}

function isExecutable(path) {
  if (typeof path !== "string" || !path.trim()) {
    return false;
  }
  try {
    accessSync(path.trim(), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultCodexCommand() {
  const configured = [
    process.env.CORPTIE_CODEX_PATH,
    process.env.CORPTIE_CODEX_REAL_PATH
  ].find(isExecutable);
  if (configured) {
    return configured.trim();
  }
  return isExecutable(codexAppBundleBinary) ? codexAppBundleBinary : "codex";
}
