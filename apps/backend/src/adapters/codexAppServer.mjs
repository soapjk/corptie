import { spawn } from "node:child_process";
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
    // thread/start creates an in-memory thread before Codex has written its
    // first rollout. Such a thread can accept turn/start in this app-server
    // process, but thread/resume is invalid until the first turn exists.
    this.freshThreadIds = new Set();
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
      this.freshThreadIds.clear();
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
        version: "0.5.4"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: []
      }
    });

    this.initialized = true;
  }

  async setThreadName(threadId, name) {
    await this.initialize();
    return this.request("thread/name/set", { threadId, name });
  }

  // Product history reads remain Store-only. This transport read is exposed
  // solely to the explicit, audited legacy-history repair workflow so old
  // rollouts can be materialized once without turning GET into a hidden write.
  async readThreadForLegacyHistoryRepair(threadId) {
    await this.initialize();
    return this.request("thread/read", {
      threadId,
      includeTurns: true
    });
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
      this.freshThreadIds.delete(threadId);
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
      this.freshThreadIds.add(result.thread.id);
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

  bindThreadToolContext(threadId, options = {}) {
    if (options.dynamicToolAgentId) {
      this.dynamicToolAgentsByThread.set(threadId, options.dynamicToolAgentId);
      this.dynamicToolMetadataByThread.set(threadId, options.dynamicToolMetadata ?? null);
    }
    this.threadResumeFingerprints.set(threadId, threadResumeFingerprint(options));
    return { alreadyLoaded: true, toolContextBound: true, thread: { id: threadId } };
  }

  async ensureThreadResumed(threadId, options = {}) {
    await this.initialize();
    const fingerprint = threadResumeFingerprint(options);
    if (this.freshThreadIds.has(threadId)) {
      if (options.dynamicToolAgentId) {
        this.dynamicToolAgentsByThread.set(threadId, options.dynamicToolAgentId);
        this.dynamicToolMetadataByThread.set(threadId, options.dynamicToolMetadata ?? null);
      }
      this.threadResumeFingerprints.set(threadId, fingerprint);
      return { alreadyLoaded: true, fresh: true, thread: { id: threadId } };
    }
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
    const result = await this.request("turn/start", {
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
    this.freshThreadIds.delete(threadId);
    return result;
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
    this.freshThreadIds.clear();
  }

  liveItemsForThread(threadId) {
    return [
      ...Array.from(this.liveItemsByThread.get(threadId)?.values() ?? []),
      ...Array.from(this.serverRequestsByThread.get(threadId)?.values() ?? [])
        .map((request) => mapServerRequestToItem(threadId, request))
        .filter(Boolean)
    ];
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
        pending.reject(codexResponseError(message.error));
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
      const completedTurnId = turn.id ?? turnId ?? null;
      const terminalStatus = turn.status
        ?? (turn.error ? "failed" : "completed");
      if (completedTurnId) {
        for (const [itemId, item] of items) {
          if (item.turnId !== completedTurnId) continue;
          items.set(itemId, { ...item, turnStatus: terminalStatus });
        }
      }
      if (!turn.error) {
        return;
      }
      const index = items.size + 1;
      items.set(`${threadId}:turn-completed:${turn.id ?? index}`, {
        id: `${threadId}:turn-completed:${turn.id ?? index}`,
        turnId: completedTurnId ?? threadId,
        turnStatus: terminalStatus,
        type: "taskComplete",
        title: turn.error ? "Turn failed" : "Turn completed",
        text: turn.error?.message ?? "",
        status: terminalStatus
      });
    }
  }
}

export function codexResponseError(payload) {
  const error = new Error(JSON.stringify(payload));
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (/^(?:no rollout found for thread id\b|thread not found:|failed to resolve rollout path\b.*\bfile does not exist$)/i.test(message)) {
    error.code = "PROVIDER_SESSION_UNAVAILABLE";
    error.safeToRetry = true;
  }
  return error;
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

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function mapCodexThreadToSession(thread) {
  const preview = thread.preview || thread.name || "Untitled Codex thread";
  const cwd = thread.cwd ? ` in ${thread.cwd}` : "";

  const permissions = codexPermissionsFromThread(thread);
  return {
    id: `codex:${thread.id}`,
    title: preview.length > 72 ? `${preview.slice(0, 69)}...` : preview,
    agent: "Codex",
    // This mapper is used only for thread/start command responses. Product
    // execution state is projected from persisted lifecycle events.
    status: "complete",
    progress: 1,
    summary: `${thread.source || "codex"} thread${cwd}`,
    capabilities: codexAppServerCapabilities(),
    updatedAt: new Date((thread.updatedAt ?? thread.createdAt ?? Date.now() / 1000) * 1000).toISOString(),
    accent: "cyan",
    external: {
      provider: "codex-app-server",
      threadId: thread.id,
      sessionId: thread.sessionId,
      connectionStatus: "app-server connected",
      rawStatus: "transport-ready",
      cwd: thread.cwd,
      source: thread.source,
      currentModel: thread.currentModel ?? thread.model ?? null,
      currentReasoningLevel: thread.currentReasoningLevel ?? thread.reasoningEffort ?? null,
      ...(permissions ?? {})
    }
  };
}

// Migration-only projection of a Provider-native thread. Live notifications
// continue to flow through ProviderEventIngestionService; this function never
// participates in ordinary Session reads or message dispatch.
export function mapCodexThreadToLegacyTimelineItems(thread) {
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
    throw new TypeError("Codex legacy history repair requires a thread object.");
  }
  const items = [];
  for (const turn of thread.turns ?? []) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn) || !turn.id) {
      throw new TypeError("Codex legacy history repair encountered an invalid turn.");
    }
    for (const item of turn.items ?? []) {
      if (!item || typeof item !== "object" || Array.isArray(item) || !item.id) {
        throw new TypeError("Codex legacy history repair encountered an invalid item.");
      }
      const mapped = mapThreadItem(turn, item);
      if (mapped.type !== "taskComplete") items.push(mapped);
    }
  }
  return items;
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

function mapThreadItem(turn, item) {
  const mapped = {
    id: item.id,
    turnId: turn.id,
    turnStatus: turn.status,
    type: item.type,
    title: itemTitle(item),
    text: itemText(item),
    status: item.status ?? null,
    presentationRole: normalizedCodexPresentationRole(item.phase ?? item.presentationRole),
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

function normalizedCodexPresentationRole(value) {
  const normalized = typeof value === "string"
    ? value.trim().toLowerCase().replaceAll("-", "_")
    : "";
  if (["final", "finalanswer", "final_answer"].includes(normalized)) return "final_answer";
  if (["analysis", "commentary", "progress"].includes(normalized)) return "commentary";
  return normalized || null;
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
