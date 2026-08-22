import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { codexPermissionsFromThread } from "../utils/codexPermissions.mjs";
import { createInterface } from "node:readline";
import { createdAtFrom, nowIso } from "../utils/timestamps.mjs";
import { providerRawMetadataJSON } from "../utils/providerRawMetadata.mjs";
import { defaultWorkspacePath } from "../utils/workspacePaths.mjs";

function threadResumeFingerprint(options = {}) {
  return JSON.stringify({
    cwd: options.cwd ?? null,
    runtimeWorkspaceRoots: options.runtimeWorkspaceRoots ?? null,
    config: options.config ?? null,
    developerInstructions: options.developerInstructions ?? null,
    dynamicTools: options.dynamicTools ?? null,
    dynamicToolAgentId: options.dynamicToolAgentId ?? null,
    dynamicToolMetadata: options.dynamicToolMetadata ?? null
  });
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server", "--listen", "stdio://"];
    this.env = options.env ?? process.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.onNotification = typeof options.onNotification === "function" ? options.onNotification : null;
    this.onDynamicToolCall = typeof options.onDynamicToolCall === "function" ? options.onDynamicToolCall : null;
    this.process = null;
    this.readline = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.liveItemsByThread = new Map();
    this.turnDiffsByThread = new Map();
    this.tokenUsageByThread = new Map();
    this.serverRequestsByThread = new Map();
    this.recentApprovedCommands = new Map();
    this.dynamicToolAgentsByThread = new Map();
    this.dynamicToolMetadataByThread = new Map();
    this.threadResumeFingerprints = new Map();
    this.threadResumePromises = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    const env = typeof this.env === "function" ? this.env() : this.env;
    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => {
      this.notifications.push({
        method: "stderr",
        params: { chunk, createdAt: nowIso() }
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
      this.threadResumeFingerprints.clear();
      this.threadResumePromises.clear();
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
        name: "corptie",
        title: "Corptie",
        version: "0.5.2"
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
    }, params.requestTimeoutMs ?? this.requestTimeoutMs);
  }

  async readThread(threadId, options = {}) {
    await this.initialize();
    return this.request("thread/read", {
      threadId,
      includeTurns: options.includeTurns ?? true
    });
  }

  async setThreadName(threadId, name) {
    await this.initialize();
    return this.request("thread/name/set", { threadId, name });
  }

  async deleteThread(threadId) {
    await this.initialize();
    try {
      return await this.request("thread/delete", { threadId });
    } finally {
      this.liveItemsByThread.delete(threadId);
      this.turnDiffsByThread.delete(threadId);
      this.tokenUsageByThread.delete(threadId);
      this.serverRequestsByThread.delete(threadId);
      this.dynamicToolAgentsByThread.delete(threadId);
      this.dynamicToolMetadataByThread.delete(threadId);
      this.threadResumeFingerprints.delete(threadId);
      this.threadResumePromises.delete(threadId);
    }
  }

  async startThread(options = {}) {
    await this.initialize();
    const result = await this.request("thread/start", {
      cwd: options.cwd ?? defaultWorkspacePath(),
      approvalPolicy: options.approvalPolicy ?? "on-request",
      sandbox: options.sandbox ?? "workspace-write",
      model: options.model ?? undefined,
      modelProvider: options.modelProvider ?? undefined,
      config: options.config ?? undefined,
      developerInstructions: options.developerInstructions ?? undefined,
      dynamicTools: options.dynamicTools ?? undefined,
      runtimeWorkspaceRoots: options.runtimeWorkspaceRoots ?? undefined,
      permissions: options.permissions ?? undefined,
      threadSource: options.threadSource ?? "user",
      ephemeral: options.ephemeral ?? false
    }, options.requestTimeoutMs ?? 30000);
    if (result?.thread?.id && options.dynamicToolAgentId) {
      this.dynamicToolAgentsByThread.set(result.thread.id, options.dynamicToolAgentId);
      this.dynamicToolMetadataByThread.set(result.thread.id, options.dynamicToolMetadata ?? null);
    }
    if (result?.thread?.id) {
      this.threadResumeFingerprints.set(result.thread.id, threadResumeFingerprint(options));
    }
    return result;
  }

  async resumeThread(threadId, options = {}) {
    await this.initialize();
    const result = await this.request("thread/resume", {
      threadId,
      cwd: options.cwd ?? undefined,
      runtimeWorkspaceRoots: options.runtimeWorkspaceRoots ?? undefined,
      approvalPolicy: options.approvalPolicy ?? undefined,
      approvalsReviewer: options.approvalsReviewer ?? undefined,
      sandbox: options.sandbox ?? undefined,
      permissions: options.permissions ?? undefined,
      model: options.model ?? undefined,
      modelProvider: options.modelProvider ?? undefined,
      config: options.config ?? undefined,
      developerInstructions: options.developerInstructions ?? undefined,
      excludeTurns: options.excludeTurns ?? undefined,
      initialTurnsPage: options.initialTurnsPage ?? undefined
    }, options.requestTimeoutMs ?? 30000);
    if (options.dynamicToolAgentId) {
      this.dynamicToolAgentsByThread.set(threadId, options.dynamicToolAgentId);
      this.dynamicToolMetadataByThread.set(threadId, options.dynamicToolMetadata ?? null);
    }
    this.threadResumeFingerprints.set(threadId, threadResumeFingerprint(options));
    return result;
  }

  async ensureThreadResumed(threadId, options = {}) {
    await this.initialize();
    const fingerprint = threadResumeFingerprint(options);
    if (this.threadResumeFingerprints.get(threadId) === fingerprint) {
      return { alreadyLoaded: true, thread: { id: threadId } };
    }
    const pending = this.threadResumePromises.get(threadId);
    if (pending) {
      try {
        await pending.promise;
      } catch {
        // A speculative prewarm must not make the foreground send inherit its
        // failure. Retry below using the caller's current runtime context.
      }
      if (this.threadResumeFingerprints.get(threadId) === fingerprint) {
        return { alreadyLoaded: true, coalesced: true, thread: { id: threadId } };
      }
    }
    const promise = this.resumeThread(threadId, options);
    const entry = { fingerprint, promise };
    this.threadResumePromises.set(threadId, entry);
    try {
      return await promise;
    } finally {
      if (this.threadResumePromises.get(threadId) === entry) {
        this.threadResumePromises.delete(threadId);
      }
    }
  }

  async forkThread(threadId, options = {}) {
    await this.initialize();
    const result = await this.request("thread/fork", {
      threadId,
      lastTurnId: options.lastTurnId ?? undefined,
      beforeTurnId: options.beforeTurnId ?? undefined,
      cwd: options.cwd ?? undefined,
      runtimeWorkspaceRoots: options.runtimeWorkspaceRoots ?? undefined,
      approvalPolicy: options.approvalPolicy ?? undefined,
      approvalsReviewer: options.approvalsReviewer ?? undefined,
      sandbox: options.sandbox ?? undefined,
      permissions: options.permissions ?? undefined,
      model: options.model ?? undefined,
      modelProvider: options.modelProvider ?? undefined,
      config: options.config ?? undefined,
      developerInstructions: options.developerInstructions ?? undefined,
      threadSource: options.threadSource ?? "user",
      ephemeral: options.ephemeral ?? false,
      excludeTurns: options.excludeTurns ?? false,
      deferGoalContinuation: options.deferGoalContinuation ?? true
    }, options.requestTimeoutMs ?? 30000);
    if (result?.thread?.id && options.dynamicToolAgentId) {
      this.dynamicToolAgentsByThread.set(result.thread.id, options.dynamicToolAgentId);
      this.dynamicToolMetadataByThread.set(result.thread.id, options.dynamicToolMetadata ?? null);
    }
    if (result?.thread?.id) {
      this.threadResumeFingerprints.set(result.thread.id, threadResumeFingerprint(options));
    }
    return result;
  }

  async updateThreadSettings(threadId, options = {}) {
    await this.initialize();
    return this.request("thread/settings/update", {
      threadId,
      cwd: options.cwd ?? undefined,
      approvalPolicy: options.approvalPolicy ?? undefined,
      approvalsReviewer: options.approvalsReviewer ?? undefined,
      sandboxPolicy: options.sandboxPolicy ?? undefined,
      permissions: options.permissions ?? undefined,
      model: options.model ?? undefined,
      serviceTier: options.serviceTier ?? undefined,
      effort: options.reasoningEffort ?? undefined,
      summary: options.reasoningSummary ?? undefined,
      collaborationMode: options.collaborationMode ?? undefined,
      personality: options.personality ?? undefined
    }, options.requestTimeoutMs ?? this.requestTimeoutMs);
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
      additionalContext: options.additionalContext ?? undefined,
      cwd: options.cwd ?? undefined,
      approvalPolicy: options.approvalPolicy ?? undefined,
      sandboxPolicy: options.sandboxPolicy ?? undefined,
      model: options.model ?? undefined,
      effort: options.reasoningEffort ?? undefined
    });
  }

  async interruptTurn(threadId, turnId) {
    await this.initialize();
    return this.request("turn/interrupt", {
      threadId,
      turnId
    });
  }

  async readAccountRateLimits() {
    await this.initialize();
    return this.request("account/rateLimits/read", undefined);
  }

  async runChoiceParser(options = {}) {
    const timeoutMs = options.timeoutMs ?? 30000;
    const prompt = options.prompt ?? "";
    const cwd = options.cwd ?? defaultWorkspacePath();
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
      sandboxPolicy: { type: "readOnly" },
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

  async runEphemeralPrompt(options = {}) {
    const timeoutMs = options.timeoutMs ?? 120000;
    const prompt = options.prompt ?? "";
    const cwd = options.cwd ?? defaultWorkspacePath();
    const notificationStart = this.notifications.length;
    const startedAt = Date.now();
    let threadId = null;
    const permissionProfile = options.permissionProfile ?? "read-only";
    if (!["read-only", "workspace-write"].includes(permissionProfile)) {
      const error = new Error(`Unsupported background permission profile: ${permissionProfile}`);
      error.code = "CAPABILITY_UNSUPPORTED";
      throw error;
    }
    const writableRoots = options.runtimeWorkspaceRoots ?? [cwd];
    const sandbox = permissionProfile === "workspace-write" ? "workspace-write" : "read-only";
    const sandboxPolicy = permissionProfile === "workspace-write"
      ? { type: "workspaceWrite", writableRoots, networkAccess: false }
      : { type: "readOnly" };
    try {
      const started = await this.startThread({
        cwd,
        runtimeWorkspaceRoots: writableRoots,
        approvalPolicy: "never",
        sandbox,
        model: options.model,
        developerInstructions: options.developerInstructions,
        threadSource: options.threadSource,
        ephemeral: true
      });
      threadId = started?.thread?.id ?? null;
      if (!threadId) throw new Error("Codex thread/start returned no ephemeral thread id.");
      const turn = await this.startTurn(threadId, prompt, {
        cwd,
        approvalPolicy: "never",
        sandboxPolicy,
        model: options.model,
        reasoningEffort: options.reasoningEffort
      });
      const turnId = turn?.turn?.id ?? null;
      if (!turnId) throw new Error("Codex turn/start returned no ephemeral turn id.");
      while (Date.now() - startedAt < timeoutMs) {
        const completed = this.notifications.slice(notificationStart).find((message) => {
          return message.method === "turn/completed"
            && message.params?.threadId === threadId
            && message.params?.turn?.id === turnId;
        });
        if (completed) {
          const status = String(completed.params?.turn?.status ?? "completed").toLowerCase();
          if (status !== "completed") {
            const detail = completed.params?.turn?.error?.message || status || "failed";
            throw new Error(`Codex ephemeral turn failed (${detail}).`);
          }
          return {
            text: this.latestAgentMessageText(threadId, turnId),
            threadId,
            turnId,
            durationMs: Date.now() - startedAt
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      throw new Error("Timed out while waiting for the Codex ephemeral turn.");
    } finally {
      if (threadId) {
        await this.deleteThread(threadId).catch(() => {});
      }
    }
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

    const startedAt = nowIso();
    const notification = {
      method: "corptie/codexExecResumeStarted",
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
        method: "corptie/codexExecResumeOutput",
        params: { threadId, stream: "stdout", chunk, createdAt: nowIso() }
      });
    });
    child.stderr.on("data", (chunk) => {
      this.notifications.push({
        method: "corptie/codexExecResumeOutput",
        params: { threadId, stream: "stderr", chunk, createdAt: nowIso() }
      });
    });
    child.on("exit", (code, signal) => {
      this.notifications.push({
        method: "corptie/codexExecResumeExited",
        params: { threadId, code, signal, createdAt: nowIso() }
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
    this.threadResumeFingerprints.clear();
    this.threadResumePromises.clear();
  }

  liveItemsForThread(threadId) {
    return [
      ...Array.from(this.liveItemsByThread.get(threadId)?.values() ?? []),
      ...Array.from(this.serverRequestsByThread.get(threadId)?.values() ?? [])
        .map((request) => mapServerRequestToItem(threadId, request))
        .filter(Boolean)
    ];
  }

  turnDiffsForThread(threadId) {
    return new Map(this.turnDiffsByThread.get(threadId) ?? []);
  }

  tokenUsageForThread(threadId) {
    return this.tokenUsageByThread.get(threadId) ?? null;
  }

  respondToApproval(threadId, input = {}) {
    const requests = this.serverRequestsByThread.get(threadId);
    const request = Array.from(requests?.values() ?? []).reverse().find((candidate) => {
      return isApprovalServerRequest(candidate);
    });
    if (!request) {
      return Promise.reject(new Error("No active Codex app-server approval request"));
    }

    const approved = input.approved === true;
    const decision = approved
      ? approvalDecisionForRequest(request, input.optionId)
      : denialDecisionForRequest(request);
    console.log("[codex-app-server] approval response", JSON.stringify({
      threadId,
      requestId: request.requestId,
      approved,
      optionId: input.optionId ?? null,
      decision
    }));
    if (approved) {
      this.rememberApprovedCommand(threadId, request);
    }
    this.removeServerRequest(threadId, request.requestId);
    return this.respondToServerRequest(request.requestId, { decision });
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.process || !this.process.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }

    const id = this.nextRequestId++;
    const message = { method, id, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);

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
          createdAt: nowIso()
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
    this.onNotification?.(message);
  }

  handleServerRequest(message) {
    if (message.method === "item/tool/call") {
      this.handleDynamicToolCall(message);
      return;
    }
    const request = {
      method: message.method,
      params: {
        ...(message.params ?? {}),
        requestId: message.id,
        createdAt: nowIso()
      }
    };
    this.notifications.push(request);

    const threadId = request.params.threadId;
    if (threadId && isApprovalServerRequest(request)) {
      if (this.autoApproveRequestIfAllowed(threadId, request)) {
        return;
      }
      console.log("[codex-app-server] approval request", JSON.stringify({
        threadId,
        requestId: message.id,
        method: message.method,
        params: request.params
      }));
      if (!this.serverRequestsByThread.has(threadId)) {
        this.serverRequestsByThread.set(threadId, new Map());
      }
      this.serverRequestsByThread.get(threadId).set(message.id, {
        ...request,
        requestId: message.id
      });
      this.onNotification?.({
        method: "corptie/codexApprovalRequested",
        params: {
          threadId,
          requestId: message.id,
          createdAt: request.params.createdAt
        }
      });
    }
  }

  async handleDynamicToolCall(message) {
    const params = message.params ?? {};
    const agentId = this.dynamicToolAgentsByThread.get(params.threadId);
    try {
      if (!this.onDynamicToolCall || !agentId) {
        throw new Error(`No Corptie dynamic-tool identity is bound to thread ${params.threadId ?? "unknown"}.`);
      }
      const value = await this.onDynamicToolCall({
        ...params,
        agentId,
        metadata: this.dynamicToolMetadataByThread.get(params.threadId) ?? null
      });
      await this.respondToServerRequest(message.id, {
        contentItems: [{ type: "inputText", text: JSON.stringify(value, null, 2) }],
        success: true
      });
    } catch (error) {
      await this.respondToServerRequest(message.id, {
        contentItems: [{
          type: "inputText",
          text: JSON.stringify({
            code: error.code ?? "COLLABORATION_ERROR",
            error: error.message
          })
        }],
        success: false
      }).catch(() => {});
    }
  }

  autoApproveRequestIfAllowed(threadId, request) {
    const approvalKey = approvedCommandKey(threadId, request);
    if (!approvalKey) {
      return false;
    }
    const approvedAt = this.recentApprovedCommands.get(approvalKey);
    if (!approvedAt || Date.now() - approvedAt > 60_000) {
      this.recentApprovedCommands.delete(approvalKey);
      return false;
    }
    const decision = approvalDecisionForRequest(request, "accept_with_execpolicy_amendment");
    console.log("[codex-app-server] approval auto-response", JSON.stringify({
      threadId,
      requestId: request.requestId,
      approvalKey,
      decision
    }));
    this.rememberApprovedCommand(threadId, request);
    this.respondToServerRequest(request.requestId, { decision }).catch((error) => {
      console.error("[codex-app-server] approval auto-response failed", error);
    });
    return true;
  }

  rememberApprovedCommand(threadId, request) {
    const approvalKey = approvedCommandKey(threadId, request);
    if (approvalKey) {
      this.recentApprovedCommands.set(approvalKey, Date.now());
    }
  }

  respondToServerRequest(id, result) {
    if (!this.process || !this.process.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    return Promise.resolve({ ok: true });
  }

  removeServerRequest(threadId, requestId) {
    const requests = this.serverRequestsByThread.get(threadId);
    if (!requests) {
      return;
    }
    requests.delete(requestId);
    if (requests.size === 0) {
      this.serverRequestsByThread.delete(threadId);
    }
  }

  captureLiveItem(message) {
    const method = message.method;
    const params = message.params ?? {};
    const threadId = params.threadId;
    const turnId = params.turnId;
    if (!threadId) {
      return;
    }

    if (method === "turn/diff/updated" && turnId && typeof params.diff === "string") {
      if (!this.turnDiffsByThread.has(threadId)) {
        this.turnDiffsByThread.set(threadId, new Map());
      }
      this.turnDiffsByThread.get(threadId).set(turnId, params.diff);
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const usage = normalizeCodexTokenUsage(params.tokenUsage ?? params.usage, params);
      if (usage) {
        this.tokenUsageByThread.set(threadId, usage);
      }
      return;
    }

    if (!this.liveItemsByThread.has(threadId)) {
      this.liveItemsByThread.set(threadId, new Map());
    }
    const items = this.liveItemsByThread.get(threadId);

    if ((method === "item/started" || method === "item/completed") && params.item) {
      // Item completion and turn completion are separate lifecycle events. An
      // agent message may finish while the turn continues with more work, so
      // never promote item/completed into a terminal turn status.
      const item = mapThreadItem({ id: turnId ?? threadId, status: "inProgress" }, params.item);
      item.id = params.item.id ?? `${threadId}:${items.size}`;
      item.turnStatus = "inProgress";
      item.status = params.item.status ?? (method === "item/completed" ? "completed" : "inProgress");
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
      if (!turn.error) {
        return;
      }
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

export function normalizeCodexTokenUsage(rawUsage, fallback = {}) {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const active = rawUsage.last ?? rawUsage.lastUsage ?? rawUsage.last_usage
    ?? rawUsage.lastTokenUsage ?? rawUsage.last_token_usage
    ?? rawUsage.total ?? rawUsage.totalUsage ?? rawUsage.total_usage
    ?? rawUsage.totalTokenUsage ?? rawUsage.total_token_usage ?? rawUsage;
  const usedTokens = finiteNumber(active.totalTokens ?? active.total_tokens ?? rawUsage.totalTokens);
  const contextWindow = finiteNumber(
    rawUsage.modelContextWindow
      ?? rawUsage.model_context_window
      ?? rawUsage.contextWindow
      ?? fallback.modelContextWindow
  );
  if (usedTokens == null && contextWindow == null) return null;
  const remainingTokens = usedTokens != null && contextWindow != null
    ? Math.max(0, contextWindow - usedTokens)
    : null;
  return {
    usedTokens,
    contextWindow,
    remainingTokens,
    usedPercent: usedTokens != null && contextWindow
      ? Math.min(100, Math.max(0, usedTokens / contextWindow * 100))
      : null
  };
}

export async function readCodexRolloutTokenUsage(path) {
  if (!path) return null;
  try {
    return tokenUsageFromCodexRolloutText(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export function tokenUsageFromCodexRolloutText(text = "") {
  const lines = String(text).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes('"token_count"')) continue;
    try {
      const entry = JSON.parse(lines[index]);
      const payload = entry?.type === "event_msg" ? entry.payload : null;
      if (payload?.type !== "token_count") continue;
      const usage = normalizeCodexTokenUsage(payload.info);
      if (usage) return usage;
    } catch {
      // Ignore partial or malformed rollout lines and keep searching backwards.
    }
  }
  return null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function mapCodexThreadToSession(thread) {
  const status = mapCodexStatus(thread.status, thread.turns);
  const preview = thread.preview || thread.name || "Untitled Codex thread";
  const cwd = thread.cwd ? ` in ${thread.cwd}` : "";
  const items = threadItems(thread);
  const latestAgentText = latestAgentMessageTextFromItems(items);

  const permissions = codexPermissionsFromThread(thread);
  return {
    id: `codex:${thread.id}`,
    title: preview.length > 72 ? `${preview.slice(0, 69)}...` : preview,
    agent: "Codex",
    status,
    progress: status === "running" ? 0.5 : 1,
    summary: latestAgentText || `${thread.source || "codex"} thread${cwd}`,
    capabilities: codexAppServerCapabilities(),
    updatedAt: new Date((thread.updatedAt ?? thread.createdAt ?? Date.now() / 1000) * 1000).toISOString(),
    accent: "cyan",
    external: {
      provider: "codex-app-server",
      threadId: thread.id,
      sessionId: thread.sessionId,
      connectionStatus: "app-server connected",
      rawStatus: thread.status,
      cwd: thread.cwd,
      source: thread.source,
      currentModel: thread.currentModel ?? thread.model ?? null,
      currentReasoningLevel: thread.currentReasoningLevel ?? thread.reasoningEffort ?? null,
      ...(permissions ?? {})
    }
  };
}

export function mapCodexThreadToDetail(thread, liveItems = [], turnDiffs = new Map()) {
  const items = threadItems(thread);
  const turnOrder = threadTurnOrder(thread);

  const mergedItems = mergeItems(items, liveItems.filter((item) => item.type !== "taskComplete"), turnOrder);
  attachTurnFileChanges(mergedItems, turnDiffs);

  return {
    id: thread.id,
    title: thread.name || thread.preview || "Untitled Codex thread",
    status: mapCodexStatus(thread.status, thread.turns),
    source: thread.source,
    connectionStatus: "app-server connected",
    cwd: thread.cwd,
    createdAt: new Date((thread.createdAt ?? Date.now() / 1000) * 1000).toISOString(),
    updatedAt: new Date((thread.updatedAt ?? thread.createdAt ?? Date.now() / 1000) * 1000).toISOString(),
    rawStatus: thread.status,
    currentModel: thread.currentModel ?? thread.model ?? null,
    currentReasoningLevel: thread.currentReasoningLevel ?? thread.reasoningEffort ?? null,
    capabilities: codexAppServerCapabilities(),
    canSend: true,
    sendUnavailableReason: null,
    turnCount: thread.turns?.length ?? 0,
    items: mergedItems
  };
}

function threadItems(thread) {
  const items = [];
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      const mapped = mapThreadItem(turn, item);
      if (mapped.type !== "taskComplete") {
        items.push(mapped);
      }
    }
  }
  return items;
}

function threadTurnOrder(thread) {
  const order = new Map();
  for (const [index, turn] of (thread.turns ?? []).entries()) {
    if (turn.id) {
      order.set(turn.id, index);
    }
  }
  return order;
}

function latestAgentMessageTextFromItems(items = []) {
  for (const item of items.slice().reverse()) {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (item.type === "agentMessage" && text) {
      return text;
    }
  }
  return "";
}

function codexAppServerCapabilities() {
  return {
    canSend: true,
    canSwitchModel: true,
    canSwitchReasoning: true,
    canInterrupt: true,
    canReconnect: false
  };
}

function mergeItems(historyItems, liveItems, turnOrder = new Map()) {
  const merged = new Map();
  const signatures = new Set();
  const itemIdsBySignature = new Map();
  for (const item of historyItems) {
    merged.set(item.id, item);
    const signature = itemSignature(item);
    signatures.add(signature);
    itemIdsBySignature.set(signature, item.id);
  }
  for (const item of liveItems) {
    const signature = itemSignature(item);
    if (signatures.has(signature)) {
      const existingId = itemIdsBySignature.get(signature);
      const existing = existingId ? merged.get(existingId) : null;
      if (existing && !existing.createdAt && item.createdAt) {
        merged.set(existingId, { ...existing, createdAt: item.createdAt });
      }
      continue;
    }
    merged.set(item.id, item);
    signatures.add(signature);
    itemIdsBySignature.set(signature, item.id);
  }
  return Array.from(merged.values()).sort((left, right) => {
    const leftTurn = turnOrder.has(left.turnId) ? turnOrder.get(left.turnId) : Number.MAX_SAFE_INTEGER;
    const rightTurn = turnOrder.has(right.turnId) ? turnOrder.get(right.turnId) : Number.MAX_SAFE_INTEGER;
    if (leftTurn !== rightTurn) {
      return leftTurn - rightTurn;
    }
    return itemDisplayRank(left) - itemDisplayRank(right);
  });
}

function itemSignature(item) {
  return `${item.turnId}|${item.type}|${item.text}`;
}

function itemDisplayRank(item) {
  switch (item.type) {
    case "userMessage":
      return 0;
    case "reasoning":
    case "plan":
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "webSearch":
    case "warning":
      return 1;
    case "approval":
      return 2;
    case "agentMessage":
      return 2;
    default:
      return 3;
  }
}

function isApprovalServerRequest(request) {
  const params = request.params ?? {};
  return Boolean(params.approvalId) || /approval/i.test(request.method ?? "");
}

function mapServerRequestToItem(threadId, request) {
  if (!isApprovalServerRequest(request)) {
    return null;
  }
  const params = request.params ?? {};
  const command = typeof params.command === "string" ? params.command.trim() : "";
  const cwd = typeof params.cwd === "string" ? params.cwd.trim() : (typeof params.workdir === "string" ? params.workdir.trim() : "");
  const reason = typeof params.reason === "string" ? params.reason.trim() : (typeof params.justification === "string" ? params.justification.trim() : "");
  const body = [
    command ? `Codex wants approval to run this command:\n${command}` : "Codex wants approval to run a command.",
    cwd ? `Working directory:\n${cwd}` : "",
    reason ? `Reason:\n${reason}` : ""
  ].filter(Boolean).join("\n\n");

  return {
    id: `${threadId}:app-server-approval:${params.requestId ?? params.approvalId}`,
    turnId: params.turnId ?? threadId,
    turnStatus: "waiting_approval",
    type: "approval",
    title: "Codex approval",
    text: body,
    options: approvalOptionsForRequest(request),
    status: "pending",
    createdAt: params.createdAt ?? null
  };
}

function approvalOptionsForRequest(request) {
  const decisions = Array.isArray(request.params?.availableDecisions) ? request.params.availableDecisions : [];
  const approveDecision = approvalOptionIdForDecision(preferredApprovalDecision(decisions));
  const denyDecision = decisions.includes("cancel") ? "cancel" : (decisions.includes("denied") ? "denied" : "deny");
  const options = [
    { id: approveDecision, label: approveDecision === "approved_for_session" ? "Approve for session" : "Approve", role: "approve", index: 0, selected: false },
    { id: denyDecision, label: "Deny", role: "deny", index: 1, selected: false }
  ];
  return options;
}

function approvalDecisionForRequest(request, optionId = "") {
  const decisions = Array.isArray(request.params?.availableDecisions) ? request.params.availableDecisions : [];
  if (optionId === "accept_with_execpolicy_amendment") {
    const amendmentDecision = decisions.find((decision) => {
      return decision && typeof decision === "object" && decision.acceptWithExecpolicyAmendment;
    });
    if (amendmentDecision) {
      return amendmentDecision;
    }
  }
  if (optionId && decisions.some((decision) => decision === optionId)) {
    return optionId;
  }
  return preferredApprovalDecision(decisions) ?? "approved";
}

function denialDecisionForRequest(request) {
  const decisions = Array.isArray(request.params?.availableDecisions) ? request.params.availableDecisions : [];
  return decisions.includes("cancel") ? "cancel" : (decisions.includes("denied") ? "denied" : "deny");
}

function approvedCommandKey(threadId, request) {
  const params = request.params ?? {};
  const commandName = approvedCommandName(params);
  if (!commandName || commandName !== "ps") {
    return null;
  }
  const turnId = params.turnId ?? "";
  if (!turnId) {
    return null;
  }
  return `${threadId}:${turnId}:${commandName}`;
}

function approvedCommandName(params) {
  const amendment = Array.isArray(params.proposedExecpolicyAmendment) ? params.proposedExecpolicyAmendment : [];
  if (typeof amendment[0] === "string" && amendment[0].trim()) {
    return commandBasename(amendment[0]);
  }
  const actions = Array.isArray(params.commandActions) ? params.commandActions : [];
  for (const action of actions) {
    const name = firstShellCommandName(action?.command);
    if (name) {
      return name;
    }
  }
  return firstShellCommandName(params.command);
}

function firstShellCommandName(command) {
  if (typeof command !== "string") {
    return null;
  }
  const withoutWrapper = command.match(/(?:^|\s)(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])(.*?)\1/)?.[2] ?? command;
  const firstSegment = withoutWrapper.split("|")[0]?.trim() ?? "";
  const firstToken = firstSegment.match(/(?:^|\s)([^\s]+)/)?.[1] ?? "";
  return commandBasename(firstToken);
}

function commandBasename(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  return text.split("/").pop();
}

function preferredApprovalDecision(decisions) {
  const amendmentDecision = decisions.find((decision) => {
    return decision && typeof decision === "object" && decision.acceptWithExecpolicyAmendment;
  });
  if (amendmentDecision) {
    return amendmentDecision;
  }
  return decisions.find((decision) => decision === "accept")
    ?? decisions.find((decision) => typeof decision === "string" && /^approved/.test(decision))
    ?? null;
}

function approvalOptionIdForDecision(decision) {
  if (decision && typeof decision === "object" && decision.acceptWithExecpolicyAmendment) {
    return "accept_with_execpolicy_amendment";
  }
  if (typeof decision === "string" && decision) {
    return decision;
  }
  return "approved";
}

export async function readCodexRolloutDetail(thread, readError) {
  const reason = friendlyCodexError(readError);
  const fallbackItem = {
    id: `${thread.id}:read-error`,
    turnId: thread.id,
    turnStatus: "completed",
    type: "warning",
    title: "Codex detail fallback",
    text: `This thread is currently read-only in Corptie.\n${reason}`,
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

    return mapCodexThreadListDetail(thread, [fallbackItem, ...items]);
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
    status: mapCodexStatus(thread.status, thread.turns),
    source: thread.source,
    connectionStatus: "app-server disconnected",
    cwd: thread.cwd,
    createdAt: new Date((thread.createdAt ?? Date.now() / 1000) * 1000).toISOString(),
    updatedAt: new Date((thread.updatedAt ?? thread.createdAt ?? Date.now() / 1000) * 1000).toISOString(),
    rawStatus: thread.status,
    canSend: false,
    sendUnavailableReason: "Codex app-server cannot resume this thread. It can be displayed from local history, but Corptie cannot safely send a follow-up yet.",
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

/**
 * 从 codex rollout JSONL 文本中提取干净的逐条对话消息。
 *
 * codex 的 rollout 是 app-server 的持久化事件流（每条一行 JSON），其中
 * `response_item` type=message 承载了完整的 user/assistant 对话正文（role 为
 * user / assistant / developer）。developer 是系统提示（应过滤），user 是用户
 * 输入，assistant 是 agent 的逐条回复（含过程性播报与最终回复）。
 *
 * 与 readCodexRolloutDetail 的区别：这里只返回「对话消息」这一层（按 rollout
 * 时间顺序、每条仅一次），不掺入 function_call / reasoning / warning 等内部 item，
 * 适合作为 DSH session.history 在 surface 事件缺失时的干净回退数据源。
 *
 * 额外过滤两类非对话正文：
 *   1. developer role（系统提示，如身份定义、multi-agent 模式说明）。
 *   2. codex 注入的「系统上下文 user 消息」——codex 会在每个 turn 把
 *      <recommended_plugins> / <environment_context> 等 XML 式上下文块以 role=user
 *      的 message 注入对话流（不是用户真实输入）。这类块以 "<" 开头（首个非空白
 *      字符是 "<"），据此过滤。
 *
 * @param {string} text - rollout 文件全文（JSONL）
 * @returns {Array<{role: 'user'|'assistant', text: string, index: number}>}
 *   按 rollout 原始顺序的对话消息；text 为空的消息会被跳过。
 */
export function parseCodexRolloutConversation(text) {
  const messages = [];
  if (typeof text !== "string" || !text) return messages;

  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // 对话正文只存在于 response_item 的 message 类型（对应 mapRolloutEntry 的
    // case "message"）。event_msg 的 agent_message/final_answer 是「状态播报」，
    // 与 response_item 的 assistant message 正文重叠，跳过以避免重复。
    if (entry.type !== "response_item") continue;
    const payload = entry.payload ?? {};
    if (payload.type !== "message") continue;

    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = contentText(payload.content);
    if (!text) continue;

    // codex 注入的系统上下文块（role=user 但内容是 <xxx> 标签，非用户真实输入）。
    if (role === "user" && text.trimStart().startsWith("<")) continue;

    messages.push({ role, text, index });
  }

  return messages;
}

/**
 * 从 codex rollout JSONL 文本提取完整的有序时间线（对话 + 工具调用/结果）。
 *
 * 与 parseCodexRolloutConversation 相比，这里保留 rollout 里所有「可见」的
 * response_item 条目，按原始顺序返回，供 DSH 轨迹（trajectory）视图还原原生
 * DSH 的详细程度：agent 在一个 turn 内会交替产生 assistant message 与工具调用
 * （custom_tool_call / custom_tool_call_output），这些正是 DSH 轨迹里
 * tool/call + tool/result 事件的数据源。
 *
 * 条目 shape：
 *   { kind:'message', role:'user'|'assistant', text, index }
 *   { kind:'tool-call', callId, name, arguments, index }
 *   { kind:'tool-output', callId, output, index }
 *
 * 过滤规则与 parseCodexRolloutConversation 一致：
 *   - 只读 response_item；跳过 event_msg 状态播报。
 *   - 跳过 developer 系统提示与 codex 注入的 "<xxx" 系统上下文 user 消息。
 *   - reasoning 的 content 是 encrypted_content（不可读），summary 常为空，
 *     故不产出 reasoning 条目（无明文可渲染）。
 *
 * 工具调用的 payload 有两套历史命名：新 rollout 用 custom_tool_call /
 * custom_tool_call_output（含 call_id / name / input / output），旧 rollout 用
 * function_call / function_call_output（含 name / arguments / output）。两者都支持。
 *
 * @param {string} text - rollout 文件全文（JSONL）
 * @returns {Array<object>} 有序时间线条目。
 */
export function parseCodexRolloutTimeline(text) {
  const items = [];
  if (typeof text !== "string" || !text) return items;

  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "response_item") continue;
    const payload = entry.payload ?? {};
    const ptype = payload.type;

    if (ptype === "message") {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = contentText(payload.content);
      if (!text) continue;
      if (role === "user" && text.trimStart().startsWith("<")) continue;
      items.push({ kind: "message", role, text, index, createdAt: rolloutEntryTimestamp(entry, payload) });
      continue;
    }

    if (ptype === "custom_tool_call" || ptype === "function_call") {
      const callId = payload.call_id ?? payload.callId ?? payload.id ?? "";
      const name = payload.name ?? payload.tool ?? "";
      const argumentsText = payload.input ?? payload.arguments ?? "";
      items.push({
        kind: "tool-call",
        callId: String(callId),
        name: String(name),
        arguments: typeof argumentsText === "string" ? argumentsText : JSON.stringify(argumentsText ?? {}),
        index,
        createdAt: rolloutEntryTimestamp(entry, payload),
      });
      continue;
    }

    if (ptype === "custom_tool_call_output" || ptype === "function_call_output") {
      const callId = payload.call_id ?? payload.callId ?? "";
      const output = toolOutputText(payload.output);
      items.push({ kind: "tool-output", callId: String(callId), output, index, createdAt: rolloutEntryTimestamp(entry, payload) });
      continue;
    }

    // reasoning / 其它内部条目：无明文，跳过。
  }

  return items;
}

function rolloutEntryTimestamp(entry, payload) {
  return entry?.timestamp ?? entry?.created_at ?? entry?.createdAt
    ?? payload?.timestamp ?? payload?.created_at ?? payload?.createdAt
    ?? null;
}

/** 归一化工具输出（字符串或 ContentPart 数组）为纯文本。 */
function toolOutputText(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return output == null ? "" : String(output);
  return output
    .map((item) => item?.text ?? item?.output_text ?? item?.input_text ?? "")
    .filter(Boolean)
    .join("\n");
}

function mapThreadItem(turn, item) {
  const mapped = {
    id: item.id,
    turnId: turn.id,
    turnStatus: turn.status,
    type: item.type,
    title: itemTitle(item),
    text: itemText(item),
    status: item.status ?? null,
    presentationRole: item.phase ?? item.presentationRole ?? null,
    createdAt: createdAtFrom(item, turn),
    rawMetadataJSON: providerRawMetadataJSON("codex-app-server", item, { source: "provider_item" })
  };
  if (item.type === "fileChange") {
    mapped.fileChanges = (item.changes ?? []).map((change) => ({
      path: change.path,
      kind: fileChangeKind(change.kind),
      diff: change.diff ?? ""
    }));
  }
  return mapped;
}

function attachTurnFileChanges(items, turnDiffs) {
  const byTurn = new Map();
  for (const item of items) {
    if (!byTurn.has(item.turnId)) {
      byTurn.set(item.turnId, []);
    }
    byTurn.get(item.turnId).push(item);
  }

  for (const [turnId, turnItems] of byTurn) {
    const changes = turnItems
      .filter((item) => item.type === "fileChange")
      .flatMap((item) => item.fileChanges ?? []);
    if (changes.length === 0) {
      continue;
    }
    const finalAgentMessage = turnItems.slice().reverse().find((item) => item.type === "agentMessage");
    if (!finalAgentMessage) {
      continue;
    }
    const latestByPath = new Map();
    for (const change of changes) {
      latestByPath.set(change.path, change);
    }
    finalAgentMessage.fileChanges = Array.from(latestByPath.values()).map(({ path, kind }) => ({ path, kind }));
    finalAgentMessage.turnDiff = turnDiffs.get(turnId) || changes.map((change) => change.diff).filter(Boolean).join("\n");
  }
}

function fileChangeKind(kind) {
  if (typeof kind === "string") {
    return kind;
  }
  if (kind && typeof kind.type === "string") {
    return kind.type;
  }
  return "update";
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

function mapCodexStatus(status, turns = []) {
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
      case "interrupted":
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
    case "notLoaded":
      return statusFromLatestTurn(turns) ?? "complete";
    case "idle":
    default:
      return "complete";
  }
}

function statusFromLatestTurn(turns = []) {
  const latestStatus = turns.at(-1)?.status;
  const value = typeof latestStatus === "object" ? latestStatus?.type : latestStatus;
  switch (value) {
    case "running":
    case "active":
    case "inProgress":
      return "running";
    case "failed":
    case "systemError":
      return "failed";
    case "interrupted":
    case "cancelled":
      return "cancelled";
    case "complete":
    case "completed":
      return "complete";
    default:
      return null;
  }
}
