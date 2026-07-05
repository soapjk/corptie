import http from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readdir, readFile, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { startup } from "@anthropic-ai/claude-agent-sdk";
import {
  CodexAppServerClient,
  mapCodexThreadToDetail,
  mapCodexThreadToSession,
  readCodexRolloutDetail
} from "./adapters/codexAppServer.mjs";
import { ClaudeAgentManager } from "./adapters/claudeAgentManager.mjs";
import { PtyAgentManager, choiceParserShouldUseModel, configureChoiceParserRuntime, parseChoiceStageWithConfiguredParser } from "./adapters/ptyAgentManager.mjs";
import { CorptieStore } from "./store/corptieStore.mjs";

const environmentName = normalizeEnvironment(process.env.CORPTIE_ENV);
const port = Number(process.env.CORPTIE_BACKEND_PORT ?? (environmentName === "development" ? 47322 : 47321));
const execFileAsync = promisify(execFile);
const codexAppBundleBinary = "/Applications/Codex.app/Contents/Resources/codex";

const sessions = new Map();
const managedCodexSessions = new Map();
const eventLog = [];
const sseClients = new Set();
const codexChoiceOptionsCache = new Map();
const pendingCodexChoiceParses = new Set();
const choiceGenerations = new Map();
const store = new CorptieStore();
const codexClient = new CodexAppServerClient({
  command: resolveCodexCommand(),
  env: () => ({
    ...process.env,
    ...proxyEnvForProfile(store.settings().agentProxy?.codex)
  }),
  onNotification: (message) => {
    handleCodexAppServerNotification(message);
  }
});
const ptyAgents = new PtyAgentManager({ store, settingsProvider: () => store.settings() });
const claudeAgents = new ClaudeAgentManager({ store });
let codexModelsCache = null;
let claudeModelsCache = null;

const statuses = new Set(["running", "blocked", "complete", "failed", "cancelled"]);

function now() {
  return new Date().toISOString();
}

function currentChoiceGeneration(sessionId) {
  return choiceGenerations.get(sessionId) ?? 0;
}

function bumpChoiceGeneration(sessionId) {
  const next = currentChoiceGeneration(sessionId) + 1;
  choiceGenerations.set(sessionId, next);
  return next;
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

function resolveCodexCommand(requestedCommand = "") {
  const requested = typeof requestedCommand === "string" ? requestedCommand.trim() : "";
  if (requested && requested !== "codex") {
    return requested;
  }

  const configured = [
    process.env.CORPTIE_CODEX_PATH,
    process.env.CORPTIE_CODEX_REAL_PATH
  ].find(isExecutable);
  if (configured) {
    return configured.trim();
  }

  if (isExecutable(codexAppBundleBinary)) {
    return codexAppBundleBinary;
  }

  return requested || "codex";
}

function createSession(input = {}) {
  const id = randomUUID();
  const session = {
    id,
    title: input.title || "Review sidebar layout",
    agent: input.agent || "Codex",
    status: statuses.has(input.status) ? input.status : "running",
    progress: Number(input.progress ?? 0.08),
    summary: input.summary || "Reading project files and preparing a change plan.",
    updatedAt: now(),
    accent: input.accent || "cyan"
  };

  sessions.set(id, session);
  emitEvent("TaskCreated", { session });
  return session;
}

function seedSessions() {
  createSession({
    title: "Implement floating panel shell",
    agent: "Codex",
    progress: 0.42,
    summary: "Building the macOS panel and task card surface.",
    accent: "mint"
  });
  createSession({
    title: "Compare Claude Code adapter paths",
    agent: "Claude Code",
    progress: 0.64,
    summary: "Waiting for a decision on CLI versus SDK integration.",
    status: "blocked",
    accent: "violet"
  });
  createSession({
    title: "Draft theme token schema",
    agent: "Research",
    progress: 0.88,
    summary: "Theme tokens are ready for review.",
    accent: "amber"
  });
}

function emitEvent(type, payload) {
  const event = {
    id: eventLog.length + 1,
    type,
    payload,
    createdAt: now()
  };
  eventLog.push(event);

  const frame = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of sseClients) {
    response.write(frame);
  }
}

function updateMockProgress() {
  for (const session of sessions.values()) {
    if (session.status !== "running") {
      continue;
    }

    const nextProgress = Math.min(1, session.progress + Math.random() * 0.08);
    session.progress = Number(nextProgress.toFixed(2));
    session.updatedAt = now();

    if (session.progress >= 1) {
      session.status = "complete";
      session.summary = "Finished and ready for review.";
      emitEvent("TaskCompleted", { session });
    } else if (Math.random() < 0.08) {
      session.status = "blocked";
      session.summary = "Needs user confirmation before continuing.";
      emitEvent("TaskBlocked", { session });
    } else {
      session.summary = "Working in the background.";
      emitEvent("TaskProgressChanged", { session });
    }
  }
}

async function resolveCodexPtySessionId(options) {
  const rolloutMatch = await waitForCodexRolloutSession(options);
  if (rolloutMatch) {
    bindCodexPtySession({
      ...options,
      agentSessionId: rolloutMatch.id,
      strategy: "codex-rollout-session-meta",
      rolloutPath: rolloutMatch.path
    });
    return rolloutMatch;
  }

  throw new Error("No matching Codex rollout session_meta found after PTY launch");
}

async function bindCodexPtySessionWhenAvailable(options) {
  try {
    const match = await resolveCodexPtySessionId(options);
    console.log(`[codex-pty] bound ${options.corptieSessionId} to ${match.id}`);
    return match;
  } catch (error) {
    console.log(`[codex-pty] session id binding pending/failed for ${options.corptieSessionId}: ${error.message}`);
    return null;
  }
}

function enrichCodexDetailChoiceOptions(detail) {
  const items = Array.isArray(detail?.items) ? detail.items : [];
  if (detail?.status === "running") {
    return detail;
  }
  const settings = store.settings();
  const choiceParser = {
    ...(settings.choiceParser ?? {}),
    agentProxy: settings.agentProxy
  };
  const parserEnabled = choiceParser.provider && choiceParser.provider !== "disabled";
  if (!parserEnabled) {
    return detail;
  }

  const candidates = items
    .filter((item) => item.type === "agentMessage" && item.text && !(Array.isArray(item.options) && item.options.length >= 2))
    .filter((item) => choiceParserShouldUseModel(item.text))
    .slice(-2);
  for (const item of candidates) {
    const cacheKey = choiceOptionsCacheKey(item.text, choiceParser);
    const cached = codexChoiceOptionsCache.get(cacheKey);
    if (cached) {
      item.options = cached.map((option) => ({ ...option }));
      continue;
    }
    scheduleCodexChoiceParse(detail.id, item.text, choiceParser, cacheKey, currentChoiceGeneration(`codex:${detail.id}`));
  }
  return detail;
}

function scheduleCodexChoiceParse(threadId, text, choiceParser, cacheKey, generation = currentChoiceGeneration(`codex:${threadId}`)) {
  if (pendingCodexChoiceParses.has(cacheKey)) {
    return;
  }
  pendingCodexChoiceParses.add(cacheKey);
  const scheduledAt = Date.now();
  console.log(`[choice-parser] event=codex-app-server-scheduled session=codex:${threadId} ${JSON.stringify({ at: new Date(scheduledAt).toISOString(), chars: String(text).length })}`);
  parseChoiceStageWithConfiguredParser(text, choiceParser, {
    id: `codex:${threadId}`,
    provider: "codex-app-server"
  })
    .then((parsed) => {
      if (!parsed || !Array.isArray(parsed.options) || parsed.options.length < 2 || parsed.confidence < 0.45) {
        return;
      }
      const options = parsed.options.slice(0, 6).map((option, index) => ({
        id: option.id || `${option.role ?? "option"}-${index}`,
        label: option.label,
        role: option.role ?? "message-choice",
        index,
        selected: index === parsed.selectedIndex
      }));
      codexChoiceOptionsCache.set(cacheKey, options.map((option) => ({ ...option })));
      if (codexChoiceOptionsCache.size > 200) {
        codexChoiceOptionsCache.delete(codexChoiceOptionsCache.keys().next().value);
      }
      applyCodexChoiceOptionsToManagedSession(threadId, text, options, generation);
      console.log(`[choice-parser] event=codex-app-server-detail-accepted session=codex:${threadId} ${JSON.stringify({ at: new Date().toISOString(), queuedMs: Date.now() - scheduledAt, options: options.length, confidence: parsed.confidence, source: parsed.source, async: true })}`);
      emitEvent("CodexThreadChoiceOptionsUpdated", { threadId, optionsCount: options.length });
    })
    .catch((error) => {
      console.log(`[choice-parser] event=codex-app-server-detail-error session=codex:${threadId} ${JSON.stringify({ error: error.message, async: true })}`);
    })
    .finally(() => {
      pendingCodexChoiceParses.delete(cacheKey);
    });
}

function choiceOptionsCacheKey(text = "", choiceParser = {}) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return JSON.stringify({
    provider: choiceParser.provider ?? "",
    model: choiceParser.provider === "openai" ? choiceParser.openaiModel : choiceParser.localModel,
    text: normalized.slice(-4000)
  });
}

function scheduleCodexChoiceParseForText(threadId, text) {
  const cleanText = typeof text === "string" ? text.trim() : "";
  if (!cleanText) {
    return;
  }
  if (!choiceParserShouldUseModel(cleanText)) {
    return;
  }
  const settings = store.settings();
  const choiceParser = {
    ...(settings.choiceParser ?? {}),
    agentProxy: settings.agentProxy
  };
  if (!choiceParser.provider || choiceParser.provider === "disabled") {
    return;
  }
  const cacheKey = choiceOptionsCacheKey(cleanText, choiceParser);
  const generation = currentChoiceGeneration(`codex:${threadId}`);
  if (codexChoiceOptionsCache.has(cacheKey)) {
    applyCodexChoiceOptionsToManagedSession(threadId, cleanText, codexChoiceOptionsCache.get(cacheKey), generation);
    return;
  }
  scheduleCodexChoiceParse(threadId, cleanText, choiceParser, cacheKey, generation);
}

function syncManagedCodexSessionFromDetail(threadId, detail) {
  const sessionId = `codex:${threadId}`;
  const session = managedCodexSessions.get(sessionId) ?? store.getSession(sessionId);
  if (!session || !detail) {
    return null;
  }
  const latestAgentMessage = Array.isArray(detail.items)
    ? detail.items.slice().reverse().find((item) => item.type === "agentMessage" && item.text)
    : null;
  const nextSession = {
    ...session,
    status: detail.status ?? session.status,
    progress: detail.status === "running" || detail.status === "blocked" ? 0.5 : 1,
    summary: latestAgentMessage?.text ?? session.summary,
    suggestedOptions: session.suggestedOptions ?? null,
    activityStatus: detail.activityStatus ?? (detail.status === "running" ? session.activityStatus ?? null : null),
    updatedAt: detail.updatedAt ?? session.updatedAt,
    capabilities: detail.capabilities ?? session.capabilities,
    external: {
      ...session.external,
      currentModel: detail.currentModel ?? session.external?.currentModel ?? null,
      currentReasoningLevel: detail.currentReasoningLevel ?? session.external?.currentReasoningLevel ?? null,
      rawStatus: detail.rawStatus ?? session.external?.rawStatus
    }
  };
  upsertManagedCodexSession(nextSession);
  return nextSession;
}

function applyCodexChoiceOptionsToManagedSession(threadId, text, options, generation = currentChoiceGeneration(`codex:${threadId}`)) {
  const sessionId = `codex:${threadId}`;
  const session = managedCodexSessions.get(sessionId) ?? store.getSession(sessionId);
  if (!session) {
    return null;
  }
  if (generation !== currentChoiceGeneration(sessionId) || session.status === "running") {
    console.log(`[choice-parser] event=codex-app-server-options-stale-generation session=${sessionId} ${JSON.stringify({ at: new Date().toISOString(), generation, currentGeneration: currentChoiceGeneration(sessionId), status: session.status })}`);
    return null;
  }
  const normalizedSessionSummary = String(session.summary ?? "").replace(/\s+/g, " ").trim();
  const normalizedText = String(text ?? "").replace(/\s+/g, " ").trim();
  const summaryMatches = !normalizedSessionSummary
    || normalizedSessionSummary === normalizedText
    || normalizedSessionSummary.includes(normalizedText.slice(0, 120))
    || normalizedText.includes(normalizedSessionSummary.slice(0, 120));
  if (!summaryMatches) {
    console.log(`[choice-parser] event=codex-app-server-options-stale session=codex:${threadId} ${JSON.stringify({ at: new Date().toISOString(), sessionSummaryChars: normalizedSessionSummary.length, textChars: normalizedText.length })}`);
    return null;
  }
  const nextSession = {
    ...session,
    summary: text || session.summary,
    suggestedOptions: options.map((option) => ({ ...option })),
    updatedAt: now()
  };
  upsertManagedCodexSession(nextSession);
  store.setActiveChoicePrompt(sessionId, text, nextSession.suggestedOptions);
  emitEvent("CodexThreadProgressChanged", { session: nextSession, threadId, method: "choice-options-updated" });
  return nextSession;
}

function upsertManagedCodexSession(session) {
  managedCodexSessions.set(session.id, session);
  store.upsertSession({
    ...session,
    provider: session.external?.provider ?? "codex-app-server",
    cwd: session.external?.cwd,
    command: session.external?.source ?? "codex-app-server"
  });
}

function mergeStoredSessionPresentation(session, stored) {
  if (!stored) {
    return session;
  }
  return {
    ...session,
    archived: stored.archived,
    pinned: stored.pinned,
    sortOrder: stored.sortOrder,
    avatarPath: stored.avatarPath ?? session.avatarPath ?? null,
    suggestedOptions: stored.suggestedOptions ?? session.suggestedOptions ?? null
  };
}

function sortSessionsForList(sessions = []) {
  return sessions.slice().sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) {
      return a.pinned ? -1 : 1;
    }
    const aOrder = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number.POSITIVE_INFINITY;
    const bOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
  });
}

function handleCodexAppServerNotification(message) {
  const method = message?.method;
  const params = message?.params ?? {};
  const threadId = params.threadId;
  if (!threadId) {
    return;
  }
  const sessionId = `codex:${threadId}`;
  const session = managedCodexSessions.get(sessionId);
  if (!session) {
    return;
  }

  const liveItems = codexClient.liveItemsForThread(threadId);
  const latestAgentMessage = liveItems.slice().reverse().find((item) => item.type === "agentMessage" && item.text);
  const nowIso = now();

  if (method === "corptie/codexApprovalRequested") {
    const approvalItem = liveItems.slice().reverse().find((item) => item.type === "approval" && Array.isArray(item.options) && item.options.length > 0);
    const nextSession = {
      ...session,
      status: "blocked",
      progress: 0.5,
      suggestedOptions: approvalItem?.options ?? session.suggestedOptions,
      suggestedPrompt: approvalItem?.text ?? session.suggestedPrompt,
      activityStatus: "Waiting for approval",
      updatedAt: nowIso,
      capabilities: {
        ...(session.capabilities ?? {}),
        canInterrupt: true
      }
    };
    upsertManagedCodexSession(nextSession);
    emitEvent("CodexThreadApprovalRequested", {
      session: nextSession,
      threadId,
      requestId: params.requestId ?? null
    });
    return;
  }

  if (method === "turn/started") {
    const turn = params.turn ?? {};
    const nextSession = {
      ...session,
      status: "running",
      progress: 0.5,
      activityStatus: "Working",
      updatedAt: nowIso,
      capabilities: {
        ...(session.capabilities ?? {}),
        canInterrupt: true
      },
      external: {
        ...session.external,
        activeTurnId: turn.id ?? session.external?.activeTurnId ?? null,
        rawStatus: turn.status ?? "running"
      }
    };
    upsertManagedCodexSession(nextSession);
    emitEvent("CodexThreadProgressChanged", { session: nextSession, threadId, method });
    return;
  }

  if (method === "item/started" || method === "item/completed") {
    const nextSession = {
      ...session,
      status: "running",
      progress: 0.5,
      summary: latestAgentMessage?.text ?? session.summary,
      activityStatus: readableCodexActivity(params.item?.type ?? params.item?.title ?? method),
      updatedAt: nowIso,
      capabilities: {
        ...(session.capabilities ?? {}),
        canInterrupt: true
      },
      external: {
        ...session.external,
        activeTurnId: params.turnId ?? session.external?.activeTurnId ?? null
      }
    };
    upsertManagedCodexSession(nextSession);
    emitEvent("CodexThreadProgressChanged", { session: nextSession, threadId, method });
    return;
  }

  if (method === "turn/completed") {
    const turn = params.turn ?? {};
      const failed = Boolean(turn.error) || turn.status === "failed";
      const cancelled = turn.status === "interrupted" || turn.status === "cancelled";
      const nextSession = {
        ...session,
        status: failed ? "failed" : (cancelled ? "cancelled" : "complete"),
        progress: 1,
        summary: latestAgentMessage?.text ?? session.summary,
        activityStatus: null,
        updatedAt: nowIso,
        capabilities: {
          ...(session.capabilities ?? {}),
          canInterrupt: false
        },
        external: {
          ...session.external,
          activeTurnId: null,
          rawStatus: turn.status ?? (failed ? "failed" : (cancelled ? "cancelled" : "complete"))
        }
      };
      upsertManagedCodexSession(nextSession);
      if (!failed && !cancelled && latestAgentMessage?.text) {
        scheduleCodexChoiceParseForText(threadId, latestAgentMessage.text);
      }
      emitEvent(failed ? "CodexThreadFailed" : (cancelled ? "CodexThreadCancelled" : "CodexThreadCompleted"), { session: nextSession, threadId, turn });
      return;
    }

  if (method === "error") {
    const nextSession = {
      ...session,
      status: params.willRetry ? "running" : "failed",
      progress: params.willRetry ? 0.5 : 1,
      summary: params.error?.message ?? session.summary,
      activityStatus: params.willRetry ? "Reconnecting" : null,
      updatedAt: nowIso
    };
    upsertManagedCodexSession(nextSession);
    emitEvent("CodexThreadError", { session: nextSession, threadId, error: params.error });
  }
}

function readableCodexActivity(value = "") {
  const text = String(value || "");
  switch (text) {
    case "reasoning":
      return "Reasoning";
    case "commandExecution":
      return "Running command";
    case "webSearch":
      return "Searching";
    case "mcpToolCall":
    case "dynamicToolCall":
      return "Using tool";
    default:
      return "Working";
  }
}

function codexAppServerSessionCapabilities(overrides = {}) {
  return {
    canSend: true,
    canSwitchModel: true,
    canSwitchReasoning: false,
    canInterrupt: true,
    canReconnect: false,
    ...overrides
  };
}

async function waitForCodexRolloutSession(options) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await delay(attempt === 0 ? 4000 : 1000);
    const match = await findCodexRolloutSession(options);
    if (match) {
      return match;
    }
  }
  return null;
}

async function findCodexRolloutSession(options) {
  const root = join(os.homedir(), ".codex", "sessions");
  const startedAfterMs = Date.parse(options.startedAfter ?? 0);
  const files = await listRolloutFiles(root);
  const candidates = [];

  for (const path of files) {
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs < startedAfterMs - 5000) {
      continue;
    }
    candidates.push({ path, mtimeMs: info.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const matching = [];
  for (const candidate of candidates.slice(0, 24)) {
    const meta = await readSessionMeta(candidate.path).catch(() => null);
    if (!meta?.id || meta.cwd !== options.cwd) {
      continue;
    }
    const timestampMs = codexTimestampMs(meta.timestamp);
    if (Number.isFinite(startedAfterMs) && timestampMs && timestampMs < startedAfterMs - 5000) {
      continue;
    }
    matching.push({ id: meta.id, path: candidate.path, timestampMs });
  }

  return matching.sort((a, b) => b.timestampMs - a.timestampMs)[0] ?? null;
}

async function findCodexRolloutBySessionId(sessionId) {
  if (!sessionId) {
    return null;
  }
  const root = join(os.homedir(), ".codex", "sessions");
  const files = await listRolloutFiles(root);
  for (const path of files) {
    const meta = await readSessionMeta(path).catch(() => null);
    if (meta?.id === sessionId) {
      return {
        id: sessionId,
        path,
        cwd: meta.cwd,
        timestampMs: codexTimestampMs(meta.timestamp)
      };
    }
  }
  return null;
}

async function listRolloutFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath ?? entry.path ?? root, entry.name));
}

async function readSessionMeta(path) {
  const content = await readFile(path, "utf8");
  for (const line of content.split("\n").slice(0, 20)) {
    if (!line.includes('"session_meta"')) {
      continue;
    }
    const parsed = JSON.parse(line);
    return parsed.payload ?? null;
  }
  return null;
}

function bindCodexPtySession(options) {
  const resume = {
    command: options.command || resolveCodexCommand(),
    args: ["resume", ...(options.resumeOptions ?? []), options.agentSessionId],
    strategy: options.strategy,
    agentSessionId: options.agentSessionId,
    cwd: options.cwd,
    resolvedAt: now(),
    rolloutPath: options.rolloutPath
  };

  const session = ptyAgents.updateSession(options.corptieSessionId, {
    agentSessionId: options.agentSessionId,
    resume,
    phase: "bound",
    canResume: true,
    summary: `Bound to Codex session ${options.agentSessionId}.`
  });

  if (session) {
    emitEvent("CodexPtySessionBound", { session, agentSessionId: options.agentSessionId });
  }
}

function codexTimestampMs(value) {
  if (typeof value === "number") {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadCodexModels() {
  const nowMs = Date.now();
  if (codexModelsCache && nowMs - codexModelsCache.loadedAt < 5 * 60 * 1000) {
    return codexModelsCache.payload;
  }

  const { stdout } = await execFileAsync(resolveCodexCommand(), ["debug", "models"], {
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024
  });
  const parsed = JSON.parse(stdout);
  const models = Array.isArray(parsed?.models) ? parsed.models : [];
  const currentConfig = await readCodexDefaultConfig();
  const payload = {
    currentModel: currentConfig.model,
    currentReasoningLevel: currentConfig.reasoningLevel,
    models: models
      .filter((model) => model?.visibility === "list" && !String(model.slug ?? "").includes("auto-review"))
      .sort((a, b) => {
        if (a.slug === currentConfig.model) {
          return -1;
        }
        if (b.slug === currentConfig.model) {
          return 1;
        }
        return Number(b.priority ?? 0) - Number(a.priority ?? 0);
      })
      .map((model) => ({
        id: model.slug,
        name: model.display_name || model.slug,
        description: model.description || "",
        defaultReasoningLevel: model.default_reasoning_level || null,
        reasoningLevels: Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels.map((level) => level.effort).filter(Boolean)
          : [],
        serviceTiers: Array.isArray(model.service_tiers)
          ? model.service_tiers.map((tier) => ({ id: tier.id, name: tier.name || tier.id }))
          : []
      }))
      .filter((model) => model.id)
  };
  codexModelsCache = { loadedAt: nowMs, payload };
  return payload;
}

async function loadClaudeModels(options = {}) {
  const nowMs = Date.now();
  const refresh = options.refresh === true;
  if (!refresh && claudeModelsCache && nowMs - claudeModelsCache.loadedAt < 5 * 60 * 1000) {
    return claudeModelsCache.payload;
  }

  const warm = await startup({
    options: {
      cwd: process.cwd()
    },
    initializeTimeoutMs: 15_000
  });

  try {
    const models = await warm.query((async function* () {})()).supportedModels();
    const activeSession = Array.from(claudeAgents.sessions?.values?.() ?? []).find((session) => session.currentModel);
    const payload = {
      currentModel: activeSession?.currentModel ?? null,
      currentReasoningLevel: null,
      models: (Array.isArray(models) ? models : [])
        .map((model) => ({
          id: model.value || model.id,
          name: model.displayName || model.display_name || model.value || model.id,
          description: model.description || "",
          defaultReasoningLevel: null,
          reasoningLevels: Array.isArray(model.supportedEffortLevels)
            ? model.supportedEffortLevels.filter(Boolean)
            : [],
          serviceTiers: []
        }))
        .filter((model) => model.id)
    };
    claudeModelsCache = { loadedAt: nowMs, payload };
    return payload;
  } finally {
    warm.close();
  }
}

async function readCodexDefaultConfig() {
  const config = await readFile(join(os.homedir(), ".codex", "config.toml"), "utf8").catch(() => "");
  const modelMatch = config.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
  const reasoningMatch = config.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m);
  return {
    model: modelMatch?.[1] ?? null,
    reasoningLevel: reasoningMatch?.[1] ?? null
  };
}

function normalizeSessionId(id) {
  return id.startsWith("pty:") ? id.slice(4) : id;
}

function titleFromPrompt(prompt) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "New Codex task";
  }
  return compact.length > 64 ? `${compact.slice(0, 61)}...` : compact;
}

function createManagedCodexDetail(session, items, readError) {
  const warning = readError
    ? [{
        id: `${session.external.threadId}:read-warning`,
        turnId: session.external.threadId,
        turnStatus: "inProgress",
        type: "warning",
        title: "Codex thread is starting",
        text: friendlyError(readError),
        status: "starting"
      }]
    : [];

  return {
    id: session.external.threadId,
    title: session.title,
    status: session.status,
    source: session.external.source,
    connectionStatus: "app-server connected",
    cwd: session.external.cwd,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    rawStatus: session.external.rawStatus,
    activityStatus: session.activityStatus ?? null,
    canSend: true,
    sendUnavailableReason: null,
    capabilities: session.capabilities ?? codexAppServerSessionCapabilities({ canInterrupt: session.status === "running" }),
    turnCount: Math.max(1, new Set(items.map((item) => item.turnId)).size),
    currentModel: session.external.currentModel ?? null,
    currentReasoningLevel: session.external.currentReasoningLevel ?? null,
    items: [...warning, ...items].slice(-60)
  };
}

function friendlyError(error) {
  const message = error?.message ?? String(error ?? "");
  try {
    const parsed = JSON.parse(message);
    return parsed.message ?? message;
  } catch {
    return message;
  }
}

function normalizeCodexSandbox(value) {
  const sandbox = typeof value === "string" ? value.trim() : "";
  const allowed = new Set(["workspace-write", "danger-full-access", "read-only"]);
  return allowed.has(sandbox) ? sandbox : "workspace-write";
}

function normalizeCodexApprovalPolicy(value) {
  const approval = typeof value === "string" ? value.trim() : "";
  const allowed = new Set(["on-request", "ask-risky", "on-failure", "never"]);
  return allowed.has(approval) ? approval : "on-request";
}

function codexApprovalPolicyForCli(approvalPolicy) {
  return approvalPolicy === "ask-risky" ? "on-request" : approvalPolicy;
}

function proxyEnvForProfile(profile = {}) {
  if (!profile?.enabled) {
    return {};
  }
  const env = {};
  setProxyEnvValue(env, "HTTP_PROXY", profile.httpProxy);
  setProxyEnvValue(env, "HTTPS_PROXY", profile.httpsProxy);
  setProxyEnvValue(env, "ALL_PROXY", profile.allProxy);
  setProxyEnvValue(env, "NO_PROXY", profile.noProxy);
  return env;
}

function setProxyEnvValue(env, key, value) {
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  env[key] = value.trim();
  env[key.toLowerCase()] = value.trim();
}

function sendJson(response, statusCode, body) {
  const json = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json)
  });
  response.end(json);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function assertDirectory(path) {
  const info = await stat(path).catch(() => null);
  if (!info) {
    await mkdir(path, { recursive: true });
    return;
  }
  if (!info.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${path}`);
  }
}

function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "corptie-backend",
      version: "0.1.0",
      time: now()
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/settings") {
    sendJson(response, 200, store.settings());
    return;
  }

  if (request.method === "GET" && url.pathname === "/codex/models") {
    loadCodexModels()
      .then((models) => {
        sendJson(response, 200, models);
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message, adapter: "codex-cli" });
      });
    return;
  }

  if (request.method === "GET" && url.pathname === "/claude/models") {
    loadClaudeModels({ refresh: url.searchParams.get("refresh") === "true" })
      .then((models) => {
        sendJson(response, 200, models);
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message, adapter: "claude-sdk" });
      });
    return;
  }

  const codexSessionMatch = url.pathname.match(/^\/codex\/sessions\/([^/]+)$/);
  if (request.method === "GET" && codexSessionMatch) {
    const sessionId = decodeURIComponent(codexSessionMatch[1]).trim();
    findCodexRolloutBySessionId(sessionId)
      .then((match) => {
        if (!match) {
          sendJson(response, 404, { error: "Codex session not found" });
          return;
        }
        sendJson(response, 200, {
          id: match.id,
          cwd: match.cwd ?? null,
          rolloutPath: match.path,
          timestampMs: match.timestampMs
        });
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message, adapter: "codex-rollout" });
      });
    return;
  }

  if (request.method === "PATCH" && url.pathname === "/settings") {
    readJson(request)
      .then(async (input) => {
        const before = store.settings();
        const settings = await store.updateSettings(input);
        const codexBackendChanged = JSON.stringify(before.codexBackend) !== JSON.stringify(settings.codexBackend);
        const codexProxyChanged = JSON.stringify(before.agentProxy?.codex) !== JSON.stringify(settings.agentProxy?.codex);
        if (codexBackendChanged || codexProxyChanged) {
          await codexClient.close();
        }
        return settings;
      })
      .then((settings) => {
        configureChoiceParserRuntime({
          ...(settings.choiceParser ?? {}),
          agentProxy: settings.agentProxy
        });
        sendJson(response, 200, settings);
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message });
      });
    return;
  }

  const sessionModelMatch = url.pathname.match(/^\/sessions\/([^/]+)\/model$/);
  if (request.method === "POST" && sessionModelMatch) {
    const sessionId = decodeURIComponent(sessionModelMatch[1]);
    readJson(request)
      .then((input) => {
        const model = typeof input.model === "string" ? input.model.trim() : "";
        if (!model) {
          sendJson(response, 400, { error: "Model is required" });
          return;
        }

        if (sessionId.startsWith("pty:")) {
          const normalizedId = normalizeSessionId(sessionId);
          if (claudeAgents.has(normalizedId)) {
            claudeAgents.switchModel(normalizedId, model)
              .then((session) => {
                emitEvent("ClaudeSessionModelChanged", { sessionId, model });
                sendJson(response, 202, { session, model });
              })
              .catch((error) => {
                sendJson(response, 502, { error: error.message, adapter: "claude-sdk" });
              });
            return;
          }
          const session = ptyAgents.switchModel(normalizedId, model);
          emitEvent("PtySessionModelChanged", { sessionId, model });
          sendJson(response, 202, { session, model });
          return;
        }

        if (sessionId.startsWith("codex:")) {
          const threadId = sessionId.slice("codex:".length);
          const previous = managedCodexSessions.get(sessionId) ?? store.getSession(sessionId);
          const now = new Date().toISOString();
          const session = previous ?? {
            id: sessionId,
            title: `Codex ${threadId.slice(0, 8)}`,
            agent: "Codex",
            status: "complete",
            progress: 1,
            summary: "Corptie-managed Codex task",
            capabilities: {
              ...codexAppServerSessionCapabilities({ canInterrupt: false })
            },
            updatedAt: now,
            accent: "cyan",
            external: {
              provider: "codex-app-server",
              threadId,
              source: "corptie"
            }
          };
          const nextSession = {
            ...session,
            updatedAt: now,
            capabilities: {
              ...(session.capabilities ?? {}),
              canSwitchModel: true,
              canSwitchReasoning: true
            },
            external: {
              ...session.external,
              provider: "codex-app-server",
              threadId,
              currentModel: model
            }
          };
          upsertManagedCodexSession(nextSession);
          emitEvent("CodexThreadModelChanged", { threadId, model });
          sendJson(response, 202, { session: nextSession, model });
          return;
        }

        sendJson(response, 404, { error: "Session does not support model switching" });
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message });
      });
    return;
  }

  const sessionReasoningMatch = url.pathname.match(/^\/sessions\/([^/]+)\/reasoning$/);
  if (request.method === "POST" && sessionReasoningMatch) {
    const sessionId = decodeURIComponent(sessionReasoningMatch[1]);
    readJson(request)
      .then((input) => {
        const reasoningLevel = typeof input.reasoningLevel === "string" ? input.reasoningLevel.trim() : "";
        if (!reasoningLevel) {
          sendJson(response, 400, { error: "Reasoning level is required" });
          return;
        }

        if (sessionId.startsWith("pty:")) {
          const normalizedId = normalizeSessionId(sessionId);
          const session = ptyAgents.switchReasoning(normalizedId, reasoningLevel);
          emitEvent("PtySessionReasoningChanged", { sessionId, reasoningLevel });
          sendJson(response, 202, { session, reasoningLevel });
          return;
        }

        if (sessionId.startsWith("codex:")) {
          const threadId = sessionId.slice("codex:".length);
          const previous = managedCodexSessions.get(sessionId) ?? store.getSession(sessionId);
          const now = new Date().toISOString();
          const session = previous ?? {
            id: sessionId,
            title: `Codex ${threadId.slice(0, 8)}`,
            agent: "Codex",
            status: "complete",
            progress: 1,
            summary: "Corptie-managed Codex task",
            capabilities: {
              ...codexAppServerSessionCapabilities({ canInterrupt: false })
            },
            updatedAt: now,
            accent: "cyan",
            external: {
              provider: "codex-app-server",
              threadId,
              source: "corptie"
            }
          };
          const nextSession = {
            ...session,
            updatedAt: now,
            capabilities: {
              ...(session.capabilities ?? {}),
              canSwitchModel: true,
              canSwitchReasoning: true
            },
            external: {
              ...session.external,
              provider: "codex-app-server",
              threadId,
              currentReasoningLevel: reasoningLevel
            }
          };
          upsertManagedCodexSession(nextSession);
          emitEvent("CodexThreadReasoningChanged", { threadId, reasoningLevel });
          sendJson(response, 202, { session: nextSession, reasoningLevel });
          return;
        }

        sendJson(response, 404, { error: "Session does not support reasoning switching" });
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message });
      });
    return;
  }

  if (request.method === "POST" && url.pathname === "/settings/choice-parser/test") {
    readJson(request)
      .then(async (input) => {
        const choiceParser = {
          ...(store.settings().choiceParser ?? {}),
          ...(input?.choiceParser ?? {}),
          agentProxy: input?.agentProxy ?? store.settings().agentProxy
        };
        configureChoiceParserRuntime(choiceParser);
        const sample = [
          "The agent is waiting for your choice:",
          "",
          "1. Open the README and summarize it",
          "2. Run the test suite",
          "3. Cancel and wait for more instructions",
          "",
          "Please choose one option."
        ].join("\n");
        const startedAt = Date.now();
        const parsed = await parseChoiceStageWithConfiguredParser(sample, choiceParser, {
          id: "settings-test",
          provider: "settings"
        });
        const durationMs = Date.now() - startedAt;
        if (!parsed || !Array.isArray(parsed.options) || parsed.options.length < 2) {
          return {
            ok: false,
            error: "Parser did not return enough options for the sample choice prompt.",
            options: parsed?.options ?? [],
            durationMs
          };
        }
        return {
          ok: true,
          options: parsed.options,
          confidence: parsed.confidence ?? 0,
          source: parsed.source ?? choiceParser?.provider ?? "",
          durationMs
        };
      })
      .then((result) => {
        sendJson(response, result.ok ? 200 : 422, result);
      })
      .catch((error) => {
        sendJson(response, 400, { ok: false, error: error.message });
      });
    return;
  }

  if (request.method === "GET" && url.pathname === "/sessions") {
    const includeMock = url.searchParams.get("includeMock") === "true";
    const includeCodexHistory = url.searchParams.get("includeCodexHistory") === "true";
    const archived = url.searchParams.get("archived") === "true";

    if (!includeCodexHistory) {
      const mockSessions = includeMock ? Array.from(sessions.values()) : [];
      const storedSessions = ptyAgents.list({ archived });
      const ptySessions = storedSessions
        .filter((session) => session.external?.provider !== "codex-app-server")
        .filter((session) => session.external?.provider !== "claude-sdk");
      const storedCodexSessions = storedSessions.filter((session) => session.external?.provider === "codex-app-server");
      const claudeSessions = claudeAgents.list({ archived });
      if (claudeSessions.length > 0) {
        console.log(`[claude-sdk] sessions list count=${claudeSessions.length} ids=${claudeSessions.map((session) => session.id).join(",")}`);
      }
      const listedIds = new Set(ptySessions.map((session) => session.id));
      claudeSessions.forEach((session) => listedIds.add(session.id));
      const managedById = new Map(Array.from(managedCodexSessions.values()).map((session) => [session.id, session]));
      const codexSessions = [
        ...storedCodexSessions.map((stored) => {
          const managed = managedById.get(stored.id);
          return managed ? mergeStoredSessionPresentation(managed, stored) : stored;
        }),
        ...Array.from(managedById.values()).filter((session) => !storedCodexSessions.some((stored) => stored.id === session.id))
      ].filter((session) => !listedIds.has(session.id));
      sendJson(response, 200, {
        sessions: sortSessionsForList([...ptySessions, ...claudeSessions, ...(archived ? [] : codexSessions), ...(archived ? [] : mockSessions)]),
        sources: {
          pty: {
            ok: true,
            count: ptySessions.length
          },
          claude: {
            ok: true,
            count: claudeSessions.length
          },
          codex: {
            ok: true,
            count: codexSessions.length,
            historyIncluded: false
          },
          mock: {
            ok: true,
            count: archived ? 0 : mockSessions.length,
            included: includeMock && !archived
          }
        }
      });
      return;
    }

    codexClient
      .listThreads({
        limit: Number(url.searchParams.get("codexLimit") ?? 8),
        archived: false,
        sortKey: "updated_at",
        sortDirection: "desc"
      })
      .then((result) => {
        const claudeSessions = claudeAgents.list({ archived });
        const codexSessions = result.data.map((thread) => {
          const session = mapCodexThreadToSession(thread);
          const managedSession = managedCodexSessions.get(session.id);
          if (!managedSession) {
            return session;
          }
          const stored = store.getSession(session.id);
          return mergeStoredSessionPresentation({
            ...session,
            status: managedSession.status ?? session.status,
            progress: managedSession.progress ?? session.progress,
            summary: managedSession.summary || session.summary,
            suggestedOptions: managedSession.suggestedOptions ?? session.suggestedOptions ?? null,
            capabilities: managedSession.capabilities ?? session.capabilities,
            external: {
              ...session.external,
              currentModel: managedSession.external?.currentModel ?? session.external?.currentModel ?? null,
              currentReasoningLevel: managedSession.external?.currentReasoningLevel ?? session.external?.currentReasoningLevel ?? null
            }
          }, stored);
        });
        const knownIds = new Set(codexSessions.map((session) => session.id));
        const managedSessions = Array.from(managedCodexSessions.values())
          .filter((session) => !knownIds.has(session.id));
        const mockSessions = includeMock ? Array.from(sessions.values()) : [];
        const ptySessions = ptyAgents.list({ archived })
          .filter((session) => session.external?.provider !== "codex-app-server")
          .filter((session) => session.external?.provider !== "claude-sdk")
          .filter((session) => !knownIds.has(session.id));

        sendJson(response, 200, {
          sessions: sortSessionsForList([...ptySessions, ...claudeSessions, ...(archived ? [] : managedSessions), ...(archived ? [] : codexSessions), ...(archived ? [] : mockSessions)]),
          sources: {
            pty: {
              ok: true,
              count: ptySessions.length
            },
            claude: {
              ok: true,
              count: claudeSessions.length
            },
            codex: {
              ok: true,
              count: result.data.length,
              managedCount: managedSessions.length
            },
            mock: {
              ok: true,
              count: mockSessions.length,
              included: includeMock
            }
          }
        });
      })
      .catch((error) => {
        const mockSessions = Array.from(sessions.values());
        const ptySessions = ptyAgents.list({ archived });

        sendJson(response, 200, {
          sessions: [...ptySessions, ...(archived ? [] : mockSessions)],
          sources: {
            pty: {
              ok: true,
              count: ptySessions.length
            },
            codex: {
              ok: false,
              error: error.message
            },
            mock: {
              ok: true,
              count: mockSessions.length,
              included: true,
              fallback: true
            }
          }
        });
      });
    return;
  }

  const sessionArchiveMatch = url.pathname.match(/^\/sessions\/([^/]+)\/archive$/);
  if (request.method === "POST" && sessionArchiveMatch) {
    readJson(request)
      .catch(() => ({}))
      .then((input) => {
        const rawId = decodeURIComponent(sessionArchiveMatch[1]);
        const archived = input.archived !== false;
        if (rawId.startsWith("codex:")) {
          const session = managedCodexSessions.get(rawId) ?? store.getSession(rawId);
          if (!session) {
            sendJson(response, 404, { error: "Session not found" });
            return;
          }
          const nextSession = {
            ...session,
            archived,
            updatedAt: new Date().toISOString()
          };
          if (archived) {
            managedCodexSessions.delete(rawId);
            store.archiveSession(rawId, true);
          } else {
            upsertManagedCodexSession(nextSession);
          }
          emitEvent(archived ? "SessionArchived" : "SessionUnarchived", { session: nextSession });
          sendJson(response, 200, { session: nextSession });
          return;
        }

        const id = normalizeSessionId(rawId);
        const session = ptyAgents.archive(id, archived);
        if (!session) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        emitEvent(archived ? "SessionArchived" : "SessionUnarchived", { session });
        sendJson(response, 200, { session });
      });
    return;
  }

  const sessionPinMatch = url.pathname.match(/^\/sessions\/([^/]+)\/pin$/);
  if (request.method === "POST" && sessionPinMatch) {
    readJson(request)
      .catch(() => ({}))
      .then((input) => {
        const id = normalizeSessionId(decodeURIComponent(sessionPinMatch[1]));
        const pinned = input.pinned !== false;
        const session = ptyAgents.pin(id, pinned);
        if (!session) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        if (managedCodexSessions.has(id)) {
          const managed = managedCodexSessions.get(id);
          managedCodexSessions.set(id, {
            ...managed,
            pinned,
            sortOrder: session.sortOrder ?? managed.sortOrder,
            avatarPath: session.avatarPath ?? managed.avatarPath ?? null
          });
        }
        emitEvent(pinned ? "SessionPinned" : "SessionUnpinned", { session });
        sendJson(response, 200, { session });
      });
    return;
  }

  if (request.method === "POST" && url.pathname === "/sessions/reorder") {
    readJson(request)
      .then((input) => {
        const sessionIds = Array.isArray(input.sessionIds) ? input.sessionIds.map((id) => normalizeSessionId(String(id))) : [];
        const sessions = ptyAgents.reorder(sessionIds);
        sessionIds.forEach((id, index) => {
          if (managedCodexSessions.has(id)) {
            managedCodexSessions.set(id, {
              ...managedCodexSessions.get(id),
              sortOrder: index
            });
          }
        });
        emitEvent("SessionsReordered", { sessionIds });
        sendJson(response, 200, { sessions });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message });
      });
    return;
  }

  const sessionDeleteMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
  if (request.method === "PATCH" && sessionDeleteMatch) {
    readJson(request)
      .then((input) => {
        const rawId = decodeURIComponent(sessionDeleteMatch[1]);
        if (rawId.startsWith("codex:")) {
          const session = managedCodexSessions.get(rawId) ?? store.getSession(rawId);
          if (!session) {
            sendJson(response, 404, { error: "Session not found" });
            return;
          }
          if (Object.prototype.hasOwnProperty.call(input, "avatarPath")) {
            const nextSession = { ...session, avatarPath: input.avatarPath ?? null };
            upsertManagedCodexSession(nextSession);
            emitEvent("SessionAvatarUpdated", { session: nextSession });
            sendJson(response, 200, { session: nextSession });
            return;
          }
          const title = typeof input.title === "string" ? input.title.trim() : "";
          if (!title) {
            sendJson(response, 400, { error: "Title is required" });
            return;
          }
          const nextSession = { ...session, title, updatedAt: new Date().toISOString() };
          upsertManagedCodexSession(nextSession);
          emitEvent("SessionRenamed", { session: nextSession });
          sendJson(response, 200, { session: nextSession });
          return;
        }

        const id = normalizeSessionId(rawId);
        const storedSession = store.getSession(id);
        const isClaudeSession = claudeAgents.has(id) || storedSession?.external?.provider === "claude-sdk";
        if (Object.prototype.hasOwnProperty.call(input, "avatarPath")) {
          const session = isClaudeSession
            ? claudeAgents.updateAvatar(id, input.avatarPath)
            : ptyAgents.updateAvatar(id, input.avatarPath);
          if (!session) {
            sendJson(response, 404, { error: "Session not found" });
            return;
          }
          emitEvent("SessionAvatarUpdated", { session });
          sendJson(response, 200, { session });
          return;
        }
        const title = typeof input.title === "string" ? input.title.trim() : "";
        if (!title) {
          sendJson(response, 400, { error: "Title is required" });
          return;
        }
        const session = isClaudeSession ? claudeAgents.rename(id, title) : ptyAgents.rename(id, title);
        if (!session) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        emitEvent("SessionRenamed", { session });
        sendJson(response, 200, { session });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message });
      });
    return;
  }

  if (request.method === "DELETE" && sessionDeleteMatch) {
    const rawId = decodeURIComponent(sessionDeleteMatch[1]);
    if (rawId.startsWith("codex:")) {
      const existed = managedCodexSessions.delete(rawId);
      store.deleteSession(rawId);
      emitEvent("SessionDeleted", { sessionId: rawId, provider: "codex-app-server", existed });
      sendJson(response, 200, { ok: true, deleted: existed });
      return;
    }

    const id = normalizeSessionId(rawId);
    if (claudeAgents.has(id)) {
      claudeAgents.delete(id);
      emitEvent("SessionDeleted", { sessionId: id, provider: "claude-sdk" });
      sendJson(response, 200, { ok: true });
      return;
    }
    ptyAgents.delete(id);
    emitEvent("SessionDeleted", { sessionId: id });
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/pty/sessions") {
    readJson(request)
      .then((input) => {
        const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : process.cwd();
        return assertDirectory(cwd).then(() => ({ input, cwd }));
      })
      .then(({ input, cwd }) => {
        const session = ptyAgents.start({
          title: input.title,
          command: input.command,
          args: input.args,
          cwd,
          initialInput: input.initialInput,
          cols: input.cols,
          rows: input.rows
        });
        emitEvent("PtySessionStarted", { session });
        sendJson(response, 201, { session });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message, adapter: "pty" });
      });
    return;
  }

  if (request.method === "POST" && url.pathname === "/claude/sessions") {
    readJson(request)
      .then((input) => {
        const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : process.cwd();
        return assertDirectory(cwd).then(() => ({ input, cwd }));
      })
      .then(({ input, cwd }) => {
        const session = claudeAgents.start({
          title: input.title,
          prompt: typeof input.prompt === "string" ? input.prompt.trim() : "",
          cwd,
          model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : null,
          sandbox: normalizeCodexSandbox(input.sandbox),
          approvalPolicy: normalizeCodexApprovalPolicy(input.approvalPolicy)
        });
        emitEvent("ClaudeSessionStarted", { session });
        sendJson(response, 201, { session });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message, adapter: "claude-sdk" });
      });
    return;
  }

  if (request.method === "POST" && url.pathname === "/codex/pty-sessions") {
    readJson(request)
      .then((input) => {
        const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
        const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : process.cwd();
        return assertDirectory(cwd).then(() => ({ input, prompt, cwd }));
      })
      .then(async ({ input, prompt, cwd }) => {
        const existingSessionId = typeof input.existingSessionId === "string" ? input.existingSessionId.trim() : "";
        const launchPrompt = prompt || "Reply exactly: Ready";
        const codexCommand = resolveCodexCommand(input.command);
        const sandbox = normalizeCodexSandbox(input.sandbox);
        const approvalMode = normalizeCodexApprovalPolicy(input.approvalPolicy);
        const approval = codexApprovalPolicyForCli(approvalMode);
        const safetyArgs = [
          "-c",
          `approval_policy="${approval}"`,
          "-c",
          `sandbox_mode="${sandbox}"`,
          "-c",
          "auto_update=false"
        ];
        const hookArgs = ["--disable", "hooks"];
        const mcpArgs = input.enableMcp === true
          ? []
          : ["-c", "features.rmcp_client=false", "-c", "mcp_servers={}"];
        const args = [...safetyArgs, ...hookArgs, ...mcpArgs, "--no-alt-screen", "-C", cwd, "-s", sandbox, "-a", approval];
        const resumeOptions = [...safetyArgs, ...hookArgs, ...mcpArgs, "--no-alt-screen", "-C", cwd, "-s", sandbox, "-a", approval];

        const reasoningLevel = typeof input.reasoningLevel === "string" ? input.reasoningLevel.trim() : "";

        if (typeof input.model === "string" && input.model.trim()) {
          args.push("-m", input.model.trim());
          resumeOptions.push("-m", input.model.trim());
        }
        if (reasoningLevel) {
          args.push("-c", `model_reasoning_effort="${reasoningLevel}"`);
          resumeOptions.push("-c", `model_reasoning_effort="${reasoningLevel}"`);
        }
        if (input.search === true) {
          args.push("--search");
        }
        if (existingSessionId) {
          const rolloutMatch = await findCodexRolloutBySessionId(existingSessionId);
          const resumeArgs = ["resume", ...resumeOptions, existingSessionId];
          const session = ptyAgents.start({
            title: input.title || `Codex ${existingSessionId.slice(0, 8)}`,
            agentName: "Codex CLI",
            provider: "codex-pty",
            accent: "cyan",
            command: codexCommand,
            args: resumeArgs,
            cwd,
            initialPrompt: "",
            resume: {
              command: codexCommand,
              args: resumeArgs,
              strategy: "codex-resume-session-id",
              agentSessionId: existingSessionId,
              cwd,
              currentReasoningLevel: reasoningLevel || null,
              resumeOptions,
              rolloutPath: rolloutMatch?.path ?? null
            },
            agentSessionId: existingSessionId,
            currentReasoningLevel: reasoningLevel || null,
            phase: "connecting",
            connectionReady: false,
            canResume: true
          });
          emitEvent("CodexPtySessionStarted", { session });
          sendJson(response, 201, { session });
          return;
        }
        if (launchPrompt) {
          args.push(launchPrompt);
        }

        const launchWindowStartedAt = new Date(Date.now() - 5000).toISOString();
        const session = ptyAgents.start({
          title: input.title || prompt || "Codex CLI",
          agentName: "Codex CLI",
          provider: "codex-pty",
          accent: "cyan",
          command: codexCommand,
          args,
          cwd,
          initialPrompt: prompt,
          resume: {
            command: codexCommand,
            args: [],
            strategy: "pending-codex-session-id",
            cwd,
            currentReasoningLevel: reasoningLevel || null,
            resumeOptions
          },
          currentReasoningLevel: reasoningLevel || null,
          phase: "starting",
          canResume: false
        });

        bindCodexPtySessionWhenAvailable({
          corptieSessionId: session.external.sessionId,
          command: codexCommand,
          cwd,
          resumeOptions,
          startedAfter: launchWindowStartedAt
        });

        const boundSession = ptyAgents.get(session.external.sessionId);
        const responseSession = boundSession ? ptyAgents.toSessionSummary(boundSession) : session;
        emitEvent("CodexPtySessionStarted", { session: responseSession });
        sendJson(response, 201, { session: responseSession });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message, adapter: "codex-pty" });
      });
    return;
  }

  const ptyEventsMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/events$/);
  if (request.method === "GET" && ptyEventsMatch) {
    const sessionId = decodeURIComponent(ptyEventsMatch[1]);
    if (claudeAgents.has(sessionId)) {
      if (!claudeAgents.subscribeDetail(sessionId, response)) {
        sendJson(response, 404, { error: "Claude session not found", adapter: "claude-sdk" });
      }
      return;
    }
    if (!ptyAgents.subscribeDetail(sessionId, response)) {
      sendJson(response, 404, { error: "PTY session not found", adapter: "pty" });
    }
    return;
  }

  const ptySessionMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)$/);
  if (request.method === "GET" && ptySessionMatch) {
    const sessionId = decodeURIComponent(ptySessionMatch[1]);
    const detail = claudeAgents.has(sessionId)
      ? claudeAgents.detail(sessionId)
      : ptyAgents.detail(sessionId);
    if (!detail) {
      sendJson(response, 404, { error: "PTY session not found", adapter: "pty" });
      return;
    }
    sendJson(response, 200, { thread: detail });
    return;
  }

  const ptyInputMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/input$/);
  if (request.method === "POST" && ptyInputMatch) {
    const sessionId = decodeURIComponent(ptyInputMatch[1]);
    readJson(request)
      .then((input) => {
        const text = typeof input.text === "string" ? input.text : "";
        if (!text.trim()) {
          sendJson(response, 400, { error: "Input text is required", adapter: "pty" });
          return;
        }
        if (claudeAgents.has(sessionId)) {
          store.clearActiveChoicePrompt(sessionId);
          return claudeAgents.send(sessionId, text).then((session) => {
            emitEvent("ClaudeSessionInputSent", { sessionId });
            sendJson(response, 202, {
              mode: "claude-sdk",
              visibleInCodexDesktop: false,
              session
            });
          });
        }
        const session = ptyAgents.get(sessionId);
        store.clearActiveChoicePrompt(sessionId);
        const shouldBindCodexSession = session?.provider === "codex-pty" && !session.agentSessionId;
        const bindStartedAt = session?.createdAt ?? new Date(Date.now() - 5000).toISOString();
        ptyAgents.write(sessionId, text, {
          submit: input.submit !== false
        });
        if (shouldBindCodexSession) {
          bindCodexPtySessionWhenAvailable({
            corptieSessionId: sessionId,
            command: session.command || "codex",
            cwd: session.cwd,
            resumeOptions: session.resume?.resumeOptions ?? [],
            startedAfter: bindStartedAt
          }).then((match) => {
            if (!match) {
              ptyAgents.updateSession(sessionId, {
                phase: "binding_failed",
                canResume: false,
                summary: "Codex session id was not found yet; this task can continue while connected, but cannot be reconnected after restart until it binds."
              });
            }
          });
        }
        emitEvent("PtySessionInputSent", { sessionId });
        sendJson(response, 202, {
          mode: "pty",
          visibleInCodexDesktop: false
        });
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message, adapter: "pty" });
      });
    return;
  }

  const ptyModelMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/model$/);
  if (request.method === "POST" && ptyModelMatch) {
    const sessionId = decodeURIComponent(ptyModelMatch[1]);
    readJson(request)
      .then((input) => {
        const model = typeof input.model === "string" ? input.model.trim() : "";
        if (!model) {
          sendJson(response, 400, { error: "Model is required", adapter: "pty" });
          return;
        }
        const session = ptyAgents.switchModel(sessionId, model);
        emitEvent("PtySessionModelChanged", { sessionId, model });
        sendJson(response, 202, { session, model });
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message, adapter: "pty" });
      });
    return;
  }

  const ptyReasoningMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/reasoning$/);
  if (request.method === "POST" && ptyReasoningMatch) {
    const sessionId = decodeURIComponent(ptyReasoningMatch[1]);
    readJson(request)
      .then((input) => {
        const reasoningLevel = typeof input.reasoningLevel === "string" ? input.reasoningLevel.trim() : "";
        if (!reasoningLevel) {
          sendJson(response, 400, { error: "Reasoning level is required", adapter: "pty" });
          return;
        }
        const session = ptyAgents.switchReasoning(sessionId, reasoningLevel);
        emitEvent("PtySessionReasoningChanged", { sessionId, reasoningLevel });
        sendJson(response, 202, { session, reasoningLevel });
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message, adapter: "pty" });
      });
    return;
  }

  const ptyDisconnectMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/disconnect$/);
  if (request.method === "POST" && ptyDisconnectMatch) {
    const sessionId = decodeURIComponent(ptyDisconnectMatch[1]);
    try {
      const session = ptyAgents.disconnect(sessionId);
      if (!session) {
        sendJson(response, 404, { error: "PTY session not found", adapter: "pty" });
        return;
      }
      emitEvent("PtySessionDisconnected", { sessionId });
      sendJson(response, 200, { session });
    } catch (error) {
      sendJson(response, 400, { error: error.message, adapter: "pty" });
    }
    return;
  }

  const ptyTerminateMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/terminate$/);
  if (request.method === "POST" && ptyTerminateMatch) {
    const sessionId = decodeURIComponent(ptyTerminateMatch[1]);
    const session = ptyAgents.terminate(sessionId) ?? (claudeAgents.has(sessionId) ? claudeAgents.terminate(sessionId) : null);
    if (!session) {
      sendJson(response, 404, { error: "PTY session not found", adapter: "pty" });
      return;
    }
    emitEvent("PtySessionTerminated", { session });
    sendJson(response, 200, { session });
    return;
  }

  const ptyInterruptMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/interrupt$/);
  if (request.method === "POST" && ptyInterruptMatch) {
    const sessionId = decodeURIComponent(ptyInterruptMatch[1]);
    if (claudeAgents.has(sessionId) && !ptyAgents.get(sessionId)) {
      claudeAgents.interrupt(sessionId)
        .then((session) => {
          emitEvent("ClaudeSessionInterrupted", { session });
          sendJson(response, 200, { session });
        })
        .catch((error) => {
          sendJson(response, 502, { error: error.message, adapter: "claude-sdk" });
        });
      return;
    }
    try {
      const session = ptyAgents.interrupt(sessionId);
      emitEvent("PtySessionInterrupted", { session });
      sendJson(response, 200, { session });
    } catch (error) {
      sendJson(response, 502, { error: error.message, adapter: "pty" });
    }
    return;
  }

  const ptyReconnectMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/reconnect$/);
  if (request.method === "POST" && ptyReconnectMatch) {
    const sessionId = decodeURIComponent(ptyReconnectMatch[1]);
    const storedSession = store.getSession(sessionId);
    if (claudeAgents.has(sessionId) || storedSession?.external?.provider === "claude-sdk") {
      claudeAgents.reconnect(sessionId)
        .then((session) => {
        if (!session) {
          sendJson(response, 404, { error: "Claude session cannot be reconnected", adapter: "claude-sdk" });
          return;
        }
        emitEvent("ClaudeSessionReconnected", { session });
        sendJson(response, 200, { session });
        })
        .catch((error) => {
          sendJson(response, 502, { error: error.message, adapter: "claude-sdk" });
        });
      return;
    }
    const session = ptyAgents.reconnect(sessionId);
    if (!session) {
      sendJson(response, 404, { error: "PTY session cannot be reconnected", adapter: "pty" });
      return;
    }
    ptyAgents.waitForConnectionReady(sessionId)
      .then((isReady) => {
        const readySession = ptyAgents.get(sessionId);
        if (!isReady || !readySession) {
          sendJson(response, 504, { error: "PTY session did not become ready in time", adapter: "pty" });
          return;
        }
        const summary = ptyAgents.toSessionSummary(readySession);
        emitEvent("PtySessionReconnected", { session: summary });
        sendJson(response, 200, { session: summary });
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message, adapter: "pty" });
      });
    return;
  }

  const ptyRawInputMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/raw-input$/);
  if (request.method === "POST" && ptyRawInputMatch) {
    const sessionId = decodeURIComponent(ptyRawInputMatch[1]);
    readJson(request)
      .then((input) => {
        const text = typeof input.text === "string" ? input.text : "";
        ptyAgents.write(sessionId, text, {
          submit: false,
          echo: input.echo !== false
        });
        emitEvent("PtySessionRawInputSent", { sessionId });
        sendJson(response, 202, { mode: "pty-raw" });
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message, adapter: "pty" });
      });
    return;
  }

  const ptyCodexApprovalMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/codex-approval$/);
  if (request.method === "POST" && ptyCodexApprovalMatch) {
    const sessionId = decodeURIComponent(ptyCodexApprovalMatch[1]);
    readJson(request)
      .then((input) => {
        const approved = input.approved === true;
        const session = ptyAgents.respondToCodexApproval(sessionId, {
          approved,
          optionId: input.optionId,
          optionIndex: input.optionIndex
        });
        emitEvent("PtySessionCodexApprovalResponded", { sessionId, approved });
        sendJson(response, 202, { mode: "codex-approval", approved, session });
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message, adapter: "pty" });
      });
    return;
  }

  const ptyChoiceMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/choice$/);
  if (request.method === "POST" && ptyChoiceMatch) {
    const sessionId = decodeURIComponent(ptyChoiceMatch[1]);
    readJson(request)
      .then((input) => {
        const session = claudeAgents.has(sessionId)
          ? claudeAgents.respondToChoice(sessionId, {
            choiceId: input.choiceId,
            optionId: input.optionId,
            optionIndex: input.optionIndex
          })
          : ptyAgents.respondToPtyChoice(sessionId, {
          optionId: input.optionId,
          optionIndex: input.optionIndex
        });
        emitEvent("PtySessionChoiceSelected", { sessionId, choiceId: input.choiceId, optionId: input.optionId, optionIndex: input.optionIndex });
        sendJson(response, 202, { mode: "pty-choice", session });
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message, adapter: "pty" });
      });
    return;
  }

  if (request.method === "GET" && url.pathname === "/codex/threads") {
    codexClient
      .listThreads({
        limit: Number(url.searchParams.get("limit") ?? 12),
        archived: url.searchParams.get("archived") === "true",
        cwd: url.searchParams.get("cwd") ?? undefined,
        searchTerm: url.searchParams.get("search") ?? undefined,
        sortKey: "updated_at",
        sortDirection: "desc"
      })
      .then((result) => {
        sendJson(response, 200, {
          threads: result.data,
          sessions: result.data.map(mapCodexThreadToSession),
          nextCursor: result.nextCursor,
          backwardsCursor: result.backwardsCursor
        });
      })
      .catch((error) => {
        sendJson(response, 502, {
          error: error.message,
          adapter: "codex-app-server"
        });
      });
    return;
  }

  if (request.method === "GET" && url.pathname === "/codex/notifications") {
    sendJson(response, 200, {
      notifications: codexClient.notifications.slice(-Number(url.searchParams.get("limit") ?? 80))
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/codex/threads") {
    readJson(request)
      .then(async (input) => {
        const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
        const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : process.cwd();
        const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : titleFromPrompt(prompt);

        if (!prompt) {
          sendJson(response, 400, { error: "Prompt is required" });
          return;
        }

        console.log(`[codex] create thread cwd=${cwd} chars=${prompt.length}`);

        const started = await codexClient.startThread({
          cwd,
          approvalPolicy: input.approvalPolicy ?? "on-request",
          sandbox: input.sandbox ?? "workspace-write",
          model: input.model,
          modelProvider: input.modelProvider
        });

        const threadId = started.thread.id;
        const turn = await codexClient.startTurn(threadId, prompt, {
          cwd,
          approvalPolicy: input.approvalPolicy ?? "on-request",
          model: input.model,
          reasoningEffort: input.reasoningLevel
        });

        const session = {
          ...mapCodexThreadToSession({
            ...started.thread,
            preview: title,
            name: title,
            cwd,
            updatedAt: Date.now() / 1000,
            status: "running",
            source: "corptie",
          currentModel: input.model ?? started.model ?? null,
          currentReasoningLevel: input.reasoningLevel ?? started.reasoningEffort ?? null,
          activeTurnId: turn.turn?.id ?? null
        }),
        title,
        summary: `Corptie-managed Codex task in ${cwd}`,
        capabilities: {
          ...codexAppServerSessionCapabilities(),
          canInterrupt: true
        }
      };
        upsertManagedCodexSession(session);

        emitEvent("CodexThreadCreated", { threadId, session, turn: turn.turn });
        console.log(`[codex] created thread=${threadId} turn=${turn.turn?.id ?? "unknown"}`);

        sendJson(response, 201, {
          thread: started.thread,
          turn: turn.turn,
          session,
          mode: "app-server-stdio",
          visibleInCodexDesktop: false,
          warning: "Started through Corptie' app-server connection. Codex Desktop may not show this thread immediately."
        });
      })
      .catch((error) => {
        sendJson(response, 502, {
          error: error.message,
          adapter: "codex-app-server"
        });
      });
    return;
  }

  const codexThreadMatch = url.pathname.match(/^\/codex\/threads\/([^/]+)$/);
  if (request.method === "GET" && codexThreadMatch) {
    const threadId = decodeURIComponent(codexThreadMatch[1]);
    codexClient
      .readThread(threadId, { includeTurns: true })
      .then(async (result) => {
        const managedSession = managedCodexSessions.get(`codex:${threadId}`);
        const detail = mapCodexThreadToDetail(result.thread, codexClient.liveItemsForThread(threadId));
        const enrichedDetail = enrichCodexDetailChoiceOptions({
          ...detail,
          activityStatus: managedSession?.activityStatus ?? detail.activityStatus ?? null,
          currentModel: managedSession?.external?.currentModel ?? detail.currentModel ?? null,
          currentReasoningLevel: managedSession?.external?.currentReasoningLevel ?? detail.currentReasoningLevel ?? null
        });
        syncManagedCodexSessionFromDetail(threadId, enrichedDetail);
        sendJson(response, 200, {
          thread: enrichedDetail
        });
      })
      .catch(async (error) => {
        const managedSession = managedCodexSessions.get(`codex:${threadId}`);
        if (managedSession) {
          const detail = enrichCodexDetailChoiceOptions(createManagedCodexDetail(
            managedSession,
            codexClient.liveItemsForThread(threadId),
            error
          ));
          syncManagedCodexSessionFromDetail(threadId, detail);
          sendJson(response, 200, {
            thread: detail,
            liveFallback: true
          });
          return;
        }

        try {
          const threads = await codexClient.listThreads({ limit: 100, archived: false });
          const thread = threads.data.find((item) => item.id === threadId);
          if (!thread) {
            sendJson(response, 502, {
              error: error.message,
              adapter: "codex-app-server"
            });
            return;
          }

          const detail = await readCodexRolloutDetail(thread, error);
          sendJson(response, 200, {
            thread: detail,
            fallback: true
          });
        } catch (fallbackError) {
          sendJson(response, 502, {
            error: fallbackError.message,
            originalError: error.message,
            adapter: "codex-app-server"
          });
        }
      });
    return;
  }

  const codexApprovalMatch = url.pathname.match(/^\/codex\/threads\/([^/]+)\/approval$/);
  if (request.method === "POST" && codexApprovalMatch) {
    const threadId = decodeURIComponent(codexApprovalMatch[1]);
    readJson(request)
      .then((input) => {
        const approved = input.approved === true;
        return codexClient.respondToApproval(threadId, {
          approved,
          optionId: input.optionId
        }).then(() => {
          const sessionId = `codex:${threadId}`;
          const previousSession = managedCodexSessions.get(sessionId) ?? store.getSession(sessionId) ?? null;
          store.clearActiveChoicePrompt(sessionId);
          const session = previousSession ? {
            ...previousSession,
            status: previousSession.status === "blocked" ? "running" : previousSession.status,
            suggestedOptions: null,
            suggestedPrompt: null,
            activityStatus: approved ? "Approval sent" : "Approval denied",
            updatedAt: now()
          } : null;
          if (session) {
            upsertManagedCodexSession(session);
          }
          emitEvent("CodexThreadApprovalResponded", { threadId, approved, session });
          sendJson(response, 202, { mode: "codex-app-server-approval", approved, session });
        });
      })
      .catch((error) => {
        sendJson(response, 502, { error: error.message, adapter: "codex-app-server" });
      });
    return;
  }

  const codexMessageMatch = url.pathname.match(/^\/codex\/threads\/([^/]+)\/messages$/);
  if (request.method === "POST" && codexMessageMatch) {
    const threadId = decodeURIComponent(codexMessageMatch[1]);
    readJson(request)
      .then(async (input) => {
        const text = typeof input.text === "string" ? input.text.trim() : "";
        const allowBackgroundFallback = input.allowBackgroundFallback === true;
        if (!text) {
          sendJson(response, 400, { error: "Message text is required" });
          return;
        }

        console.log(`[codex] send requested thread=${threadId} chars=${text.length}`);
        const sessionId = `codex:${threadId}`;
        const managedSessionBeforeSend = managedCodexSessions.get(sessionId) ?? store.getSession(sessionId);
        bumpChoiceGeneration(sessionId);
        store.clearActiveChoicePrompt(sessionId);
        if (managedSessionBeforeSend) {
          upsertManagedCodexSession({
            ...managedSessionBeforeSend,
            suggestedOptions: null,
            updatedAt: new Date().toISOString()
          });
        }

        try {
          await codexClient.resumeThread(threadId);
          const managedSession = managedCodexSessions.get(`codex:${threadId}`);
          const result = await codexClient.startTurn(threadId, text, {
            model: managedSession?.external?.currentModel ?? input.model ?? undefined,
            reasoningEffort: managedSession?.external?.currentReasoningLevel ?? undefined
          });
          if (managedSession) {
            upsertManagedCodexSession({
              ...managedSession,
              status: "running",
              progress: 0.5,
              suggestedOptions: null,
              activityStatus: "Working",
              updatedAt: new Date().toISOString(),
              capabilities: {
                ...(managedSession.capabilities ?? {}),
                canInterrupt: true
              },
              external: {
                ...managedSession.external,
                activeTurnId: result.turn?.id ?? managedSession.external?.activeTurnId ?? null
              }
            });
          }
          emitEvent("CodexTurnStarted", { threadId, turn: result.turn, mode: "app-server" });
          console.log(`[codex] send accepted by app-server thread=${threadId} turn=${result.turn?.id ?? "unknown"}`);
          sendJson(response, 202, {
            turn: result.turn,
            mode: "app-server-stdio",
            visibleInCodexDesktop: false,
            warning: "Sent through Corptie' stdio app-server connection. Codex Desktop may not refresh this thread."
          });
        } catch (appServerError) {
          console.log(`[codex] app-server send failed thread=${threadId} error=${appServerError.message}`);
          if (!allowBackgroundFallback) {
            sendJson(response, 502, {
              error: "Codex app-server could not resume this thread, so the message was not sent.",
              rawError: appServerError.message,
              adapter: "codex-app-server",
              visibleInCodexDesktop: false,
              hint: "This thread is read-only in Corptie until we connect to the Codex Desktop control socket or find a supported resume path."
            });
            return;
          }

          const result = await codexClient.execResumeThread(threadId, text);
          emitEvent("CodexTurnStarted", { threadId, mode: result.mode, pid: result.pid });
          sendJson(response, 202, {
            ...result,
            fallback: true,
            visibleInCodexDesktop: false,
            appServerError: appServerError.message
          });
        }
      })
      .catch((error) => {
        sendJson(response, 502, {
          error: error.message,
          adapter: "codex-app-server"
        });
      });
    return;
  }

  const codexModelMatch = url.pathname.match(/^\/codex\/threads\/([^/]+)\/model$/);
  if (request.method === "POST" && codexModelMatch) {
    const threadId = decodeURIComponent(codexModelMatch[1]);
    readJson(request)
      .then((input) => {
        const model = typeof input.model === "string" ? input.model.trim() : "";
        if (!model) {
          sendJson(response, 400, { error: "Model is required" });
          return;
        }

        const sessionId = `codex:${threadId}`;
        const previous = managedCodexSessions.get(sessionId);
        const now = new Date().toISOString();
        const session = previous ?? {
          id: sessionId,
          title: `Codex ${threadId.slice(0, 8)}`,
          agent: "Codex",
          status: "complete",
          progress: 1,
          summary: "Corptie-managed Codex task",
          updatedAt: now,
          accent: "cyan",
          external: {
            provider: "codex-app-server",
            threadId,
            source: "corptie"
          }
        };
        const nextSession = {
          ...session,
          updatedAt: now,
          external: {
            ...session.external,
            provider: "codex-app-server",
            threadId,
            currentModel: model
          }
        };
        upsertManagedCodexSession(nextSession);
        emitEvent("CodexThreadModelChanged", { threadId, model });
        sendJson(response, 202, { session: nextSession, model });
      })
      .catch((error) => {
        sendJson(response, 502, {
          error: error.message,
          adapter: "codex-app-server"
        });
      });
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });

    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    for (const event of eventLog.filter((entry) => entry.id > cursor)) {
      response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }

    sseClients.add(response);
    request.on("close", () => {
      sseClients.delete(response);
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/tasks") {
    readJson(request)
      .then((input) => {
        const session = createSession(input);
        sendJson(response, 201, { session });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message });
      });
    return;
  }

  const cancelMatch = url.pathname.match(/^\/tasks\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const taskId = decodeURIComponent(cancelMatch[1]);
    if (taskId.startsWith("pty:")) {
      const session = ptyAgents.terminate(taskId.slice(4));
      if (!session) {
        sendJson(response, 404, { error: "PTY session not found" });
        return;
      }
      sendJson(response, 200, { session });
      return;
    }

    if (taskId.startsWith("codex:")) {
      const threadId = taskId.slice("codex:".length);
      const previous = managedCodexSessions.get(taskId) ?? store.getSession(taskId);
      if (!previous) {
        sendJson(response, 404, { error: "Codex session not found" });
        return;
      }
      const activeTurnId = previous.external?.activeTurnId ?? previous.rawStatus?.activeTurnId ?? null;
      if (!activeTurnId) {
        sendJson(response, 409, { error: "Codex session does not have an active turn to interrupt" });
        return;
      }
      codexClient
        .interruptTurn(threadId, activeTurnId)
        .then(() => {
          const session = {
            ...previous,
            status: "cancelled",
            progress: 1,
            activityStatus: null,
            summary: previous.summary || "Interrupted by user.",
            updatedAt: now(),
            capabilities: {
              ...(previous.capabilities ?? {}),
              canInterrupt: false
            },
            external: {
              ...previous.external,
              activeTurnId: null,
              rawStatus: "cancelled"
            }
          };
          upsertManagedCodexSession(session);
          emitEvent("CodexThreadCancelled", { session, threadId, turnId: activeTurnId });
          sendJson(response, 200, { session });
        })
        .catch((error) => {
          console.log(`[codex] interrupt failed thread=${threadId} turn=${activeTurnId} error=${JSON.stringify(error.message)}`);
          sendJson(response, 502, { error: error.message, adapter: "codex-app-server" });
        });
      return;
    }

    const session = sessions.get(taskId);
    if (!session) {
      sendJson(response, 404, { error: "Task not found" });
      return;
    }

    session.status = "cancelled";
    session.summary = "Cancelled by user.";
    session.updatedAt = now();
    emitEvent("TaskCancelled", { session });
    sendJson(response, 200, { session });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

const server = http.createServer(route);

await store.initialize();
console.log(`[store] SQLite ready at ${store.dbPath}`);
configureChoiceParserRuntime({
  ...(store.settings().choiceParser ?? {}),
  agentProxy: store.settings().agentProxy
});

seedSessions();
setInterval(updateMockProgress, 2500).unref();

server.listen(port, "127.0.0.1", () => {
  console.log(`Corptie backend (${environmentName}) listening on http://127.0.0.1:${port}`);
});

process.on("SIGINT", async () => {
  await codexClient.close();
  await store.save();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await codexClient.close();
  await store.save();
  process.exit(0);
});

function normalizeEnvironment(value = "") {
  const normalized = String(value || "").toLowerCase();
  return normalized === "dev" || normalized === "development" ? "development" : "production";
}
