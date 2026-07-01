import http from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import {
  CodexAppServerClient,
  mapCodexThreadToDetail,
  mapCodexThreadToSession,
  readCodexRolloutDetail
} from "./adapters/codexAppServer.mjs";
import { PtyAgentManager } from "./adapters/ptyAgentManager.mjs";
import { CopetsStore } from "./store/copetsStore.mjs";

const environmentName = normalizeEnvironment(process.env.COPETS_ENV);
const port = Number(process.env.COPETS_BACKEND_PORT ?? (environmentName === "development" ? 47322 : 47321));
const execFileAsync = promisify(execFile);

const sessions = new Map();
const managedCodexSessions = new Map();
const eventLog = [];
const sseClients = new Set();
const codexClient = new CodexAppServerClient();
const store = new CopetsStore();
const ptyAgents = new PtyAgentManager({ store, settingsProvider: () => store.settings() });
let codexModelsCache = null;

const statuses = new Set(["running", "blocked", "complete", "failed", "cancelled"]);

function now() {
  return new Date().toISOString();
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
    console.log(`[codex-pty] bound ${options.copetsSessionId} to ${match.id}`);
    return match;
  } catch (error) {
    console.log(`[codex-pty] session id binding pending/failed for ${options.copetsSessionId}: ${error.message}`);
    return null;
  }
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
    command: options.command || "codex",
    args: ["resume", ...(options.resumeOptions ?? []), options.agentSessionId],
    strategy: options.strategy,
    agentSessionId: options.agentSessionId,
    cwd: options.cwd,
    resolvedAt: now(),
    rolloutPath: options.rolloutPath
  };

  const session = ptyAgents.updateSession(options.copetsSessionId, {
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

  const { stdout } = await execFileAsync("codex", ["debug", "models"], {
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
    canSend: true,
    sendUnavailableReason: null,
    turnCount: Math.max(1, new Set(items.map((item) => item.turnId)).size),
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
  const allowed = new Set(["on-request", "on-failure", "never"]);
  return allowed.has(approval) ? approval : "on-request";
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
      service: "copets-backend",
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
      .then((input) => {
        return store.updateSettings(input);
      })
      .then((settings) => {
        sendJson(response, 200, settings);
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message });
      });
    return;
  }

  if (request.method === "GET" && url.pathname === "/sessions") {
    const includeMock = url.searchParams.get("includeMock") === "true";
    const includeCodexHistory = url.searchParams.get("includeCodexHistory") === "true";
    const archived = url.searchParams.get("archived") === "true";

    if (!includeCodexHistory) {
      const mockSessions = includeMock ? Array.from(sessions.values()) : [];
      const ptySessions = ptyAgents.list({ archived });
      sendJson(response, 200, {
        sessions: [...ptySessions, ...(archived ? [] : managedCodexSessions.values()), ...(archived ? [] : mockSessions)],
        sources: {
          pty: {
            ok: true,
            count: ptySessions.length
          },
          codex: {
            ok: true,
            count: managedCodexSessions.size,
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
        const codexSessions = result.data.map(mapCodexThreadToSession);
        const knownIds = new Set(codexSessions.map((session) => session.id));
        const managedSessions = Array.from(managedCodexSessions.values())
          .filter((session) => !knownIds.has(session.id));
        const mockSessions = includeMock ? Array.from(sessions.values()) : [];
        const ptySessions = ptyAgents.list({ archived });

        sendJson(response, 200, {
          sessions: [...ptySessions, ...(archived ? [] : managedSessions), ...(archived ? [] : codexSessions), ...(archived ? [] : mockSessions)],
          sources: {
            pty: {
              ok: true,
              count: ptySessions.length
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
        const id = normalizeSessionId(decodeURIComponent(sessionArchiveMatch[1]));
        const archived = input.archived !== false;
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
        emitEvent(pinned ? "SessionPinned" : "SessionUnpinned", { session });
        sendJson(response, 200, { session });
      });
    return;
  }

  if (request.method === "POST" && url.pathname === "/sessions/reorder") {
    readJson(request)
      .then((input) => {
        const sessionIds = Array.isArray(input.sessionIds) ? input.sessionIds : [];
        const sessions = ptyAgents.reorder(sessionIds);
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
        const id = normalizeSessionId(decodeURIComponent(sessionDeleteMatch[1]));
        if (Object.prototype.hasOwnProperty.call(input, "avatarPath")) {
          const session = ptyAgents.updateAvatar(id, input.avatarPath);
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
        const session = ptyAgents.rename(id, title);
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
    const id = normalizeSessionId(decodeURIComponent(sessionDeleteMatch[1]));
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

  if (request.method === "POST" && url.pathname === "/codex/pty-sessions") {
    readJson(request)
      .then((input) => {
        const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
        const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : process.cwd();
        return assertDirectory(cwd).then(() => ({ input, prompt, cwd }));
      })
      .then(async ({ input, prompt, cwd }) => {
        const existingSessionId = typeof input.existingSessionId === "string" ? input.existingSessionId.trim() : "";
        const sandbox = normalizeCodexSandbox(input.sandbox);
        const approval = normalizeCodexApprovalPolicy(input.approvalPolicy);
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
            command: input.command || "codex",
            args: resumeArgs,
            cwd,
            initialPrompt: "",
            resume: {
              command: input.command || "codex",
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
        if (prompt) {
          args.push(prompt);
        }

        const launchWindowStartedAt = new Date(Date.now() - 5000).toISOString();
        const session = ptyAgents.start({
          title: input.title || prompt || "Codex CLI",
          agentName: "Codex CLI",
          provider: "codex-pty",
          accent: "cyan",
          command: input.command || "codex",
          args,
          cwd,
          initialPrompt: prompt,
          resume: {
            command: input.command || "codex",
            args: [],
            strategy: "pending-codex-session-id",
            cwd,
            currentReasoningLevel: reasoningLevel || null,
            resumeOptions
          },
          currentReasoningLevel: reasoningLevel || null,
          phase: prompt ? "starting" : "awaiting_first_input",
          canResume: false
        });

        if (prompt) {
          bindCodexPtySessionWhenAvailable({
            copetsSessionId: session.external.sessionId,
            command: input.command || "codex",
            cwd,
            resumeOptions,
            startedAfter: launchWindowStartedAt
          });
        } else {
          ptyAgents.updateSession(session.external.sessionId, {
            phase: "awaiting_first_input",
            canResume: false,
            summary: "Codex CLI is ready; send your first instruction to bind a session id."
          });
        }

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

  const ptySessionMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)$/);
  if (request.method === "GET" && ptySessionMatch) {
    const sessionId = decodeURIComponent(ptySessionMatch[1]);
    const detail = ptyAgents.detail(sessionId);
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
        const session = ptyAgents.get(sessionId);
        const shouldBindCodexSession = session?.provider === "codex-pty" && !session.agentSessionId;
        const bindStartedAt = session?.createdAt ?? new Date(Date.now() - 5000).toISOString();
        ptyAgents.write(sessionId, text, {
          submit: input.submit !== false
        });
        if (shouldBindCodexSession) {
          bindCodexPtySessionWhenAvailable({
            copetsSessionId: sessionId,
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
    const session = ptyAgents.terminate(sessionId);
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
        const session = ptyAgents.respondToPtyChoice(sessionId, {
          optionId: input.optionId,
          optionIndex: input.optionIndex
        });
        emitEvent("PtySessionChoiceSelected", { sessionId, optionId: input.optionId, optionIndex: input.optionIndex });
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
          model: input.model
        });

        const session = {
          ...mapCodexThreadToSession({
            ...started.thread,
            preview: title,
            name: title,
            cwd,
            updatedAt: Date.now() / 1000,
            status: "running",
            source: "copets"
          }),
          title,
          summary: `Copets-managed Codex task in ${cwd}`
        };
        managedCodexSessions.set(session.id, session);

        emitEvent("CodexThreadCreated", { threadId, session, turn: turn.turn });
        console.log(`[codex] created thread=${threadId} turn=${turn.turn?.id ?? "unknown"}`);

        sendJson(response, 201, {
          thread: started.thread,
          turn: turn.turn,
          session,
          mode: "app-server-stdio",
          visibleInCodexDesktop: false,
          warning: "Started through Copets' app-server connection. Codex Desktop may not show this thread immediately."
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
      .then((result) => {
        sendJson(response, 200, {
          thread: mapCodexThreadToDetail(result.thread, codexClient.liveItemsForThread(threadId))
        });
      })
      .catch(async (error) => {
        const managedSession = managedCodexSessions.get(`codex:${threadId}`);
        if (managedSession) {
          sendJson(response, 200, {
            thread: createManagedCodexDetail(
              managedSession,
              codexClient.liveItemsForThread(threadId),
              error
            ),
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

        try {
          await codexClient.resumeThread(threadId);
          const result = await codexClient.startTurn(threadId, text);
          emitEvent("CodexTurnStarted", { threadId, turn: result.turn, mode: "app-server" });
          console.log(`[codex] send accepted by app-server thread=${threadId} turn=${result.turn?.id ?? "unknown"}`);
          sendJson(response, 202, {
            turn: result.turn,
            mode: "app-server-stdio",
            visibleInCodexDesktop: false,
            warning: "Sent through Copets' stdio app-server connection. Codex Desktop may not refresh this thread."
          });
        } catch (appServerError) {
          console.log(`[codex] app-server send failed thread=${threadId} error=${appServerError.message}`);
          if (!allowBackgroundFallback) {
            sendJson(response, 502, {
              error: "Codex app-server could not resume this thread, so the message was not sent.",
              rawError: appServerError.message,
              adapter: "codex-app-server",
              visibleInCodexDesktop: false,
              hint: "This thread is read-only in Copets until we connect to the Codex Desktop control socket or find a supported resume path."
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
    if (cancelMatch[1].startsWith("pty:")) {
      const session = ptyAgents.terminate(cancelMatch[1].slice(4));
      if (!session) {
        sendJson(response, 404, { error: "PTY session not found" });
        return;
      }
      sendJson(response, 200, { session });
      return;
    }

    const session = sessions.get(cancelMatch[1]);
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

seedSessions();
setInterval(updateMockProgress, 2500).unref();

server.listen(port, "127.0.0.1", () => {
  console.log(`Copets backend (${environmentName}) listening on http://127.0.0.1:${port}`);
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
