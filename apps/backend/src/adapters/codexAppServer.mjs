import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

export class CodexAppServerClient {
  constructor(options = {}) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server", "--listen", "stdio://"];
    this.env = options.env ?? process.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.process = null;
    this.readline = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.liveItemsByThread = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => {
      this.notifications.push({
        method: "stderr",
        params: { chunk, createdAt: new Date().toISOString() }
      });
    });

    this.process.on("exit", (code, signal) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`Codex app-server exited before response (${code ?? signal})`));
      }
      this.pending.clear();
      this.initialized = false;
      this.process = null;
      this.readline = null;
    });

    this.readline = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity
    });

    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "copets",
        title: "Copets",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: []
      }
    });

    this.initialized = true;
  }

  async listThreads(params = {}) {
    await this.initialize();
    return this.request("thread/list", {
      limit: params.limit ?? 12,
      archived: params.archived ?? false,
      useStateDbOnly: params.useStateDbOnly ?? true,
      cwd: params.cwd ?? undefined,
      searchTerm: params.searchTerm ?? undefined,
      sourceKinds: params.sourceKinds ?? undefined,
      sortKey: params.sortKey ?? "updated_at",
      sortDirection: params.sortDirection ?? "desc"
    });
  }

  async readThread(threadId, options = {}) {
    await this.initialize();
    return this.request("thread/read", {
      threadId,
      includeTurns: options.includeTurns ?? true
    });
  }

  async startThread(options = {}) {
    await this.initialize();
    return this.request("thread/start", {
      cwd: options.cwd ?? process.cwd(),
      approvalPolicy: options.approvalPolicy ?? "on-request",
      sandbox: options.sandbox ?? "workspace-write",
      model: options.model ?? undefined,
      modelProvider: options.modelProvider ?? undefined,
      threadSource: "user",
      ephemeral: options.ephemeral ?? false
    });
  }

  async resumeThread(threadId) {
    await this.initialize();
    return this.request("thread/resume", {
      threadId
    });
  }

  async startTurn(threadId, text, options = {}) {
    await this.initialize();
    return this.request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text,
          text_elements: []
        }
      ],
      cwd: options.cwd ?? undefined,
      approvalPolicy: options.approvalPolicy ?? undefined,
      sandboxPolicy: options.sandboxPolicy ?? undefined,
      model: options.model ?? undefined
    });
  }

  async runChoiceParser(options = {}) {
    const timeoutMs = options.timeoutMs ?? 30000;
    const prompt = options.prompt ?? "";
    const cwd = options.cwd ?? process.cwd();
    const model = options.model ?? undefined;
    const notificationStart = this.notifications.length;
    const liveStart = this.liveItemsByThread.size;
    const startedAt = Date.now();
    const started = await this.startThread({
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      model,
      ephemeral: true
    });
    const threadId = started.thread.id;
    const turn = await this.startTurn(threadId, prompt, {
      cwd,
      approvalPolicy: "never",
      model
    });
    const turnId = turn.turn.id;
    while (Date.now() - startedAt < timeoutMs) {
      const text = this.latestAgentMessageText(threadId, turnId);
      if (text) {
        return {
          text,
          threadId,
          turnId,
          durationMs: Date.now() - startedAt
        };
      }
      const completed = this.notifications.slice(notificationStart).some((message) => {
        return message.method === "turn/completed"
          && message.params?.threadId === threadId
          && message.params?.turn?.id === turnId;
      });
      if (completed) {
        return {
          text: this.latestAgentMessageText(threadId, turnId) ?? "",
          threadId,
          turnId,
          durationMs: Date.now() - startedAt
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return {
      text: this.latestAgentMessageText(threadId, turnId) ?? "",
      threadId,
      turnId,
      durationMs: Date.now() - startedAt,
      timedOut: true,
      notificationCount: this.notifications.length - notificationStart,
      liveThreadCount: this.liveItemsByThread.size - liveStart
    };
  }

  latestAgentMessageText(threadId, turnId) {
    const items = Array.from(this.liveItemsByThread.get(threadId)?.values() ?? []);
    const agentMessages = items.filter((item) => item.turnId === turnId && item.type === "agentMessage" && item.text);
    return agentMessages.at(-1)?.text ?? "";
  }

  async execResumeThread(threadId, text) {
    await this.initialize();

    const childCodex = this.command;
    const child = spawn(childCodex, ["exec", "resume", "--json", threadId, text], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const startedAt = new Date().toISOString();
    const notification = {
      method: "copets/codexExecResumeStarted",
      params: {
        threadId,
        pid: child.pid,
        startedAt
      }
    };

    this.notifications.push(notification);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.notifications.push({
        method: "copets/codexExecResumeOutput",
        params: { threadId, stream: "stdout", chunk, createdAt: new Date().toISOString() }
      });
    });
    child.stderr.on("data", (chunk) => {
      this.notifications.push({
        method: "copets/codexExecResumeOutput",
        params: { threadId, stream: "stderr", chunk, createdAt: new Date().toISOString() }
      });
    });
    child.on("exit", (code, signal) => {
      this.notifications.push({
        method: "copets/codexExecResumeExited",
        params: { threadId, code, signal, createdAt: new Date().toISOString() }
      });
    });

    return {
      mode: "codex-exec-resume",
      pid: child.pid,
      startedAt
    };
  }

  async close() {
    if (!this.process) {
      return;
    }

    this.process.kill("SIGTERM");
    this.process = null;
    this.readline?.close();
    this.readline = null;
    this.initialized = false;
  }

  liveItemsForThread(threadId) {
    return Array.from(this.liveItemsByThread.get(threadId)?.values() ?? []);
  }

  request(method, params) {
    if (!this.process || !this.process.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }

    const id = this.nextRequestId++;
    const message = { method, id, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.notifications.push({
        method: "parseError",
        params: {
          line,
          error: error.message,
          createdAt: new Date().toISOString()
        }
      });
      return;
    }

    if ("id" in message && "method" in message) {
      this.handleServerRequest(message);
      return;
    }

    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if ("error" in message) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.notifications.push(message);
    this.captureLiveItem(message);
  }

  handleServerRequest(message) {
    this.notifications.push({
      method: message.method,
      params: {
        ...(message.params ?? {}),
        requestId: message.id,
        createdAt: new Date().toISOString()
      }
    });
  }

  captureLiveItem(message) {
    const method = message.method;
    const params = message.params ?? {};
    const threadId = params.threadId;
    const turnId = params.turnId;
    if (!threadId) {
      return;
    }

    if (!this.liveItemsByThread.has(threadId)) {
      this.liveItemsByThread.set(threadId, new Map());
    }
    const items = this.liveItemsByThread.get(threadId);

    if ((method === "item/started" || method === "item/completed") && params.item) {
      const item = mapThreadItem({ id: turnId ?? threadId, status: method === "item/completed" ? "completed" : "inProgress" }, params.item);
      item.id = params.item.id ?? `${threadId}:${items.size}`;
      item.turnStatus = method === "item/completed" ? "completed" : "inProgress";
      items.set(item.id, item);
      return;
    }

    if (method === "error") {
      const error = params.error ?? {};
      const index = items.size + 1;
      items.set(`${threadId}:error:${index}`, {
        id: `${threadId}:error:${index}`,
        turnId: turnId ?? threadId,
        turnStatus: params.willRetry ? "inProgress" : "failed",
        type: "error",
        title: params.willRetry ? "Codex reconnecting" : "Codex error",
        text: [error.message, error.additionalDetails].filter(Boolean).join("\n"),
        status: params.willRetry ? "retrying" : "failed"
      });
      return;
    }

    if (method === "turn/completed") {
      const turn = params.turn ?? {};
      const index = items.size + 1;
      items.set(`${threadId}:turn-completed:${turn.id ?? index}`, {
        id: `${threadId}:turn-completed:${turn.id ?? index}`,
        turnId: turn.id ?? turnId ?? threadId,
        turnStatus: turn.status ?? "completed",
        type: "taskComplete",
        title: turn.error ? "Turn failed" : "Turn completed",
        text: turn.error?.message ?? "",
        status: turn.status ?? "completed"
      });
    }
  }
}

export function mapCodexThreadToSession(thread) {
  const status = mapCodexStatus(thread.status);
  const preview = thread.preview || thread.name || "Untitled Codex thread";
  const cwd = thread.cwd ? ` in ${thread.cwd}` : "";

  return {
    id: `codex:${thread.id}`,
    title: preview.length > 72 ? `${preview.slice(0, 69)}...` : preview,
    agent: "Codex",
    status,
    progress: status === "running" ? 0.5 : 1,
    summary: `${thread.source || "codex"} thread${cwd}`,
    updatedAt: new Date((thread.updatedAt ?? thread.createdAt ?? Date.now() / 1000) * 1000).toISOString(),
    accent: "cyan",
    external: {
      provider: "codex-app-server",
      threadId: thread.id,
      sessionId: thread.sessionId,
      rawStatus: thread.status,
      cwd: thread.cwd,
      source: thread.source
    }
  };
}

export function mapCodexThreadToDetail(thread, liveItems = []) {
  const items = [];
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      items.push(mapThreadItem(turn, item));
    }
  }

  const mergedItems = mergeItems(items, liveItems);

  return {
    id: thread.id,
    title: thread.name || thread.preview || "Untitled Codex thread",
    status: mapCodexStatus(thread.status),
    source: thread.source,
    connectionStatus: "app-server connected",
    cwd: thread.cwd,
    createdAt: new Date((thread.createdAt ?? Date.now() / 1000) * 1000).toISOString(),
    updatedAt: new Date((thread.updatedAt ?? thread.createdAt ?? Date.now() / 1000) * 1000).toISOString(),
    rawStatus: thread.status,
    canSend: true,
    sendUnavailableReason: null,
    turnCount: thread.turns?.length ?? 0,
    items: mergedItems.slice(-60)
  };
}

function mergeItems(historyItems, liveItems) {
  const merged = new Map();
  const signatures = new Set();
  for (const item of historyItems) {
    merged.set(item.id, item);
    signatures.add(itemSignature(item));
  }
  for (const item of liveItems) {
    const signature = itemSignature(item);
    if (signatures.has(signature)) {
      continue;
    }
    merged.set(item.id, item);
    signatures.add(signature);
  }
  return Array.from(merged.values());
}

function itemSignature(item) {
  return `${item.turnId}|${item.type}|${item.text}`;
}

export async function readCodexRolloutDetail(thread, readError) {
  const reason = friendlyCodexError(readError);
  const fallbackItem = {
    id: `${thread.id}:read-error`,
    turnId: thread.id,
    turnStatus: "completed",
    type: "warning",
    title: "Codex detail fallback",
    text: `This thread is currently read-only in Copets.\n${reason}`,
    status: null
  };

  if (!thread.path) {
    return mapCodexThreadListDetail(thread, [fallbackItem]);
  }

  try {
    const text = await readFile(thread.path, "utf8");
    const items = [];

    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) {
        continue;
      }

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const mapped = mapRolloutEntry(thread.id, index, entry);
      if (mapped) {
        items.push(mapped);
      }
    }

    return mapCodexThreadListDetail(thread, [fallbackItem, ...items.slice(-59)]);
  } catch (error) {
    return mapCodexThreadListDetail(thread, [
      fallbackItem,
      {
        id: `${thread.id}:fallback-error`,
        turnId: thread.id,
        turnStatus: "failed",
        type: "error",
        title: "Rollout read failed",
        text: error.message,
        status: null
      }
    ]);
  }
}

function mapCodexThreadListDetail(thread, items) {
  return {
    id: thread.id,
    title: thread.name || thread.preview || "Untitled Codex thread",
    status: mapCodexStatus(thread.status),
    source: thread.source,
    connectionStatus: "app-server disconnected",
    cwd: thread.cwd,
    createdAt: new Date((thread.createdAt ?? Date.now() / 1000) * 1000).toISOString(),
    updatedAt: new Date((thread.updatedAt ?? thread.createdAt ?? Date.now() / 1000) * 1000).toISOString(),
    rawStatus: thread.status,
    canSend: false,
    sendUnavailableReason: "Codex app-server cannot resume this thread. It can be displayed from local history, but Copets cannot safely send a follow-up yet.",
    turnCount: countTurnMarkers(items),
    items
  };
}

function friendlyCodexError(error) {
  const message = error?.message ?? String(error ?? "");
  try {
    const parsed = JSON.parse(message);
    return parsed.message ?? message;
  } catch {
    return message;
  }
}

function mapRolloutEntry(threadId, index, entry) {
  if (entry.type === "event_msg") {
    const payload = entry.payload ?? {};
    if (payload.type === "agent_message" || payload.type === "final_answer") {
      return rolloutItem(threadId, index, "agentMessage", "Codex", payload.message ?? "", "completed");
    }
    if (payload.type === "task_complete") {
      return rolloutItem(threadId, index, "taskComplete", "Task complete", payload.last_agent_message ?? "", "completed");
    }
    return null;
  }

  if (entry.type !== "response_item") {
    return null;
  }

  const payload = entry.payload ?? {};
  switch (payload.type) {
    case "message":
      return rolloutItem(
        threadId,
        index,
        payload.role === "user" ? "userMessage" : "agentMessage",
        payload.role === "user" ? "User" : "Codex",
        contentText(payload.content),
        payload.phase ?? null
      );
    case "function_call":
      return rolloutItem(
        threadId,
        index,
        "commandExecution",
        payload.name ?? "Tool call",
        `${payload.name ?? "tool"} ${payload.arguments ?? ""}`,
        "started"
      );
    case "function_call_output":
      return rolloutItem(
        threadId,
        index,
        "commandExecution",
        "Tool output",
        truncate(payload.output ?? "", 1400),
        "completed"
      );
    case "reasoning":
      return rolloutItem(threadId, index, "reasoning", "Reasoning", (payload.summary ?? []).join("\n"), null);
    default:
      return null;
  }
}

function rolloutItem(threadId, index, type, title, text, status) {
  return {
    id: `${threadId}:${index}`,
    turnId: threadId,
    turnStatus: status ?? "completed",
    type,
    title,
    text: text ?? "",
    status
  };
}

function contentText(content) {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => item.text ?? item.output_text ?? item.input_text ?? "")
    .filter(Boolean)
    .join("\n");
}

function countTurnMarkers(items) {
  return Math.max(1, new Set(items.map((item) => item.turnId)).size);
}

function mapThreadItem(turn, item) {
  return {
    id: item.id,
    turnId: turn.id,
    turnStatus: turn.status,
    type: item.type,
    title: itemTitle(item),
    text: itemText(item),
    status: item.status ?? null
  };
}

function itemTitle(item) {
  switch (item.type) {
    case "userMessage":
      return "User";
    case "agentMessage":
      return "Codex";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "commandExecution":
      return `Command ${item.status ?? ""}`.trim();
    case "fileChange":
      return `File changes ${item.status ?? ""}`.trim();
    case "mcpToolCall":
      return `MCP ${item.server}.${item.tool}`;
    case "dynamicToolCall":
      return `Tool ${item.tool}`;
    case "webSearch":
      return "Web search";
    default:
      return item.type;
  }
}

function itemText(item) {
  switch (item.type) {
    case "userMessage":
      return (item.content ?? [])
        .map((content) => content.type === "text" ? content.text : `[${content.type}]`)
        .join("\n");
    case "agentMessage":
      return item.text ?? "";
    case "reasoning":
      return [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
    case "plan":
      return item.text ?? "";
    case "commandExecution": {
      const output = item.aggregatedOutput ? `\n\n${truncate(item.aggregatedOutput, 1200)}` : "";
      return `$ ${item.command}${output}`;
    }
    case "fileChange":
      return `${item.changes?.length ?? 0} file change(s)`;
    case "mcpToolCall":
      return JSON.stringify(item.arguments ?? {}, null, 2);
    case "dynamicToolCall":
      return JSON.stringify(item.arguments ?? {}, null, 2);
    case "webSearch":
      return item.query ?? "";
    case "imageView":
      return item.path ?? "";
    default:
      return "";
  }
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text ?? "";
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function mapCodexStatus(status) {
  if (typeof status === "string") {
    switch (status) {
      case "running":
      case "active":
        return "running";
      case "blocked":
        return "blocked";
      case "failed":
      case "systemError":
        return "failed";
      case "cancelled":
        return "cancelled";
      case "complete":
      case "idle":
      default:
        return "complete";
    }
  }

  if (!status || typeof status !== "object") {
    return "complete";
  }

  switch (status.type) {
    case "active":
      return "running";
    case "systemError":
      return "failed";
    case "idle":
    case "notLoaded":
    default:
      return "complete";
  }
}
