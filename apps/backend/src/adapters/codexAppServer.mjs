import { spawn } from "node:child_process";
import { executeCodexSlashCommand } from "./codexSlashCommands.mjs";
import { createHash, randomUUID } from "node:crypto";
import { CodexStdioTransport } from "./codexStdioTransport.mjs";
export { codexResponseError } from "./codexStdioTransport.mjs";
import { nowIso } from "../utils/timestamps.mjs";
import { CodexLiveThreadCache } from "./codexLiveThreadCache.mjs";
import {
  isApprovalServerRequest, mapServerRequestToItem, approvalDecisionForRequest,
  denialDecisionForRequest, approvedCommandKey
} from "./codexApprovalProtocol.mjs";
export {
  mapCodexThreadToSession, mapCodexThreadToLegacyTimelineItems, normalizeCodexTokenUsage
} from "./codexThreadProjection.mjs";
import { codexUserInputItem, codexUserInputResponse, normalizeCodexUserInputRequest } from "./codexUserInput.mjs";
import { structuredRequest, structuredResponse } from "../application/structuredInteraction.mjs";
import { defaultWorkspacePath } from "../utils/workspacePaths.mjs";
import { createCodexBackgroundOperations } from "./codexBackgroundOperations.mjs";
import {
  providerContractHashFromReceipt,
  toolDefinitionsContractHash
} from "../application/hostToolCatalog.mjs";

function threadResumeFingerprint(options = {}) {
  return JSON.stringify({
    cwd: options.cwd ?? null,
    runtimeWorkspaceRoots: options.runtimeWorkspaceRoots ?? null,
    config: options.config ?? null,
    developerInstructions: options.developerInstructions ?? null,
    dynamicTools: options.dynamicTools ?? null,
    dynamicToolConfirmation: options.dynamicToolConfirmation ?? null,
    dynamicToolAgentId: options.dynamicToolAgentId ?? null,
    dynamicToolMetadata: options.dynamicToolMetadata ?? null
  });
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.onNotification = typeof options.onNotification === "function" ? options.onNotification : null;
    this.onDynamicToolCall = typeof options.onDynamicToolCall === "function" ? options.onDynamicToolCall : null;
    this.notifications = [];
    // Codex plan snapshots have no native event ID or revision. Distinguish
    // physical notifications, including A -> B -> A within the same turn.
    this.planNotificationRunId = randomUUID();
    this.planNotificationSequence = 0;
    this.liveThreadCache = new CodexLiveThreadCache({
      expireTurnRequests: (threadId, turnId) => {
        for (const request of this.serverRequestsByThread.get(threadId)?.values() ?? []) {
          if ((request.interaction || request.method === "item/tool/requestUserInput")
            && request.params?.turnId === turnId) {
            this.removeServerRequest(threadId, request.requestId);
          }
        }
      }
    });
    this.serverRequestsByThread = new Map();
    this.recentApprovedCommands = new Map();
    this.dynamicToolAgentsByThread = new Map();
    this.dynamicToolMetadataByThread = new Map();
    this.confirmedToolSchemasByThread = new Map();
    this.threadResumeFingerprints = new Map();
    this.threadResumePromises = new Map();
    this.recoveryStabilizationThreads = new Map();
    // thread/start creates an in-memory thread before Codex has written its
    // first rollout. Such a thread can accept turn/start in this app-server
    // process, but thread/resume is invalid until the first turn exists.
    this.freshThreadIds = new Set();
    this.transport = new CodexStdioTransport({
      ...options,
      onDiagnostic: (message) => this.notifications.push(message),
      onNotification: (message) => this.handleNotification(message),
      onServerRequest: (message) => this.handleServerRequest(message),
      onBeforeClear: () => this.expireGenerationInteractions(),
      onCleared: () => this.clearGenerationThreadState()
    });
    this.backgroundOperations = createCodexBackgroundOperations({
      initialize: () => this.initialize(),
      request: (...args) => this.request(...args),
      startThread: (options) => this.startThread(options),
      startTurn: (...args) => this.startTurn(...args),
      unsubscribeThread: (threadId) => this.unsubscribeThread(threadId),
      deleteThread: (threadId) => this.deleteThread(threadId),
      latestAgentMessageText: (...args) => this.latestAgentMessageText(...args),
      notificationCount: () => this.notifications.length,
      notificationsSince: (index) => this.notifications.slice(index),
      liveThreadCount: () => this.liveThreadCache.threadCount
    });
  }

  initialize() {
    return this.transport.initialize();
  }

  get command() { return this.transport.command; }
  get requestTimeoutMs() { return this.transport.requestTimeoutMs; }
  get runtimeUserAgent() { return this.transport.runtimeUserAgent; }
  set runtimeUserAgent(value) { this.transport.runtimeUserAgent = value; }

  async setThreadName(threadId, name) {
    await this.initialize();
    return this.request("thread/name/set", { threadId, name });
  }

  async executeCommand(threadId, command) {
    await this.initialize();
    return executeCodexSlashCommand(
      (method, params) => this.request(method, params), threadId, command
    );
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

  // A Provider-switch target may have been created immediately before the
  // backend crashed. Verify that exact empty thread without calling
  // thread/resume (which requires a rollout) or starting a model Turn.
  async inspectEmptyThreadForRouteCommit(threadId, options = {}) {
    await this.initialize();
    this.requireThreadToolPlanConfirmation(threadId, options);
    const result = await this.request("thread/read", {
      threadId,
      includeTurns: true
    }, options.requestTimeoutMs ?? 30000);
    if (result?.thread?.id !== threadId) {
      const error = new Error("Codex returned a different thread during route recovery.");
      error.code = "PROVIDER_SWITCH_TARGET_MISMATCH";
      throw error;
    }
    if (!Array.isArray(result.thread.turns) || result.thread.turns.length !== 0) {
      const error = new Error("The uncommitted Provider-switch target is not an empty thread.");
      error.code = "PROVIDER_SWITCH_TARGET_NOT_EMPTY";
      throw error;
    }
    this.bindThreadToolContext(threadId, options);
    return result;
  }

  async deleteThread(threadId) {
    await this.initialize();
    try {
      return await this.request("thread/delete", { threadId });
    } finally {
      this.releaseThreadRuntimeState(threadId);
    }
  }

  // Stop this app-server connection from retaining the Thread while preserving
  // its rollout on disk. A later thread/resume restores the same Provider
  // Thread and conversation history.
  async unsubscribeThread(threadId) {
    await this.initialize();
    try {
      return await this.request("thread/unsubscribe", { threadId });
    } finally {
      this.releaseThreadRuntimeState(threadId);
    }
  }

  // Provider archival is Codex's immediate unload primitive: it shuts down the
  // loaded Thread and moves (rather than deletes) its rollout. Missing active
  // rollout means the Thread is already archived or otherwise not resident,
  // which is already a successful runtime-release outcome.
  async archiveThread(threadId) {
    await this.initialize();
    try {
      return await this.request("thread/archive", { threadId });
    } catch (error) {
      if (!/thread not found|no rollout found/i.test(String(error?.message ?? ""))) throw error;
      return { status: "already-released" };
    } finally {
      this.releaseThreadRuntimeState(threadId);
    }
  }

  async unarchiveThread(threadId) {
    await this.initialize();
    try {
      return await this.request("thread/unarchive", { threadId });
    } catch (error) {
      // Active pre-cutover Threads were never Provider-archived. In that case
      // there is nothing to restore and the ordinary resume path remains valid.
      if (!/thread not found|archived.*not found|no archived/i.test(String(error?.message ?? ""))) throw error;
      return { status: "already-active" };
    }
  }

  releaseThreadRuntimeState(threadId) {
    this.liveThreadCache.releaseThread(threadId);
    this.serverRequestsByThread.delete(threadId);
    this.dynamicToolAgentsByThread.delete(threadId);
    this.dynamicToolMetadataByThread.delete(threadId);
    this.threadResumeFingerprints.delete(threadId);
    this.threadResumePromises.delete(threadId);
    this.freshThreadIds.delete(threadId);
    this.confirmedToolSchemasByThread.delete(threadId);
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
      ephemeral: options.ephemeral ?? false,
      ...(options.environments !== undefined ? { environments: options.environments } : {}),
      ...(options.baseInstructions !== undefined ? { baseInstructions: options.baseInstructions } : {})
    }, options.requestTimeoutMs ?? 30000);
    if (result?.thread?.id && options.dynamicToolAgentId) {
      this.dynamicToolAgentsByThread.set(result.thread.id, options.dynamicToolAgentId);
      this.dynamicToolMetadataByThread.set(result.thread.id, options.dynamicToolMetadata ?? null);
    }
    if (result?.thread?.id) {
      const definitions = options.dynamicTools ?? [];
      this.threadResumeFingerprints.set(result.thread.id, threadResumeFingerprint(options));
      this.freshThreadIds.add(result.thread.id);
      this.confirmedToolSchemasByThread.set(result.thread.id, {
        schema: JSON.stringify(definitions),
        providerDefinitionsHash: hashToolDefinitions(definitions),
        providerContractHash: toolDefinitionsContractHash(definitions),
        providerDefinitionsCount: definitions.length,
        definitionFreshness: "current",
        providerObservationKind: "thread_start_accepted",
        providerRevision: `thread-start:${result.thread.id}:${result.thread.updatedAt ?? result.thread.createdAt ?? "confirmed"}`
      });
    }
    return result;
  }

  confirmThreadToolPlan(threadId, definitions = []) {
    const confirmed = this.confirmedToolSchemasByThread.get(threadId);
    if (!confirmed || confirmed.providerContractHash !== toolDefinitionsContractHash(definitions)) {
      const error = new Error("Codex did not confirm this Tool schema on thread/start.");
      error.code = "PROVIDER_TOOL_APPLICATION_UNCONFIRMED";
      throw error;
    }
    return { ...confirmed, threadId };
  }

  restoreThreadToolPlanConfirmation(threadId, definitions = [], proof = {}) {
    const providerRevision = typeof proof.providerRevision === "string" ? proof.providerRevision.trim() : "";
    const revisionMatchesThread = providerRevision.startsWith(`thread-start:${threadId}:`)
      || providerRevision.startsWith(`thread-fork-inherited:${threadId}:`);
    const definitionsHash = hashToolDefinitions(definitions);
    const providerContractHash = providerContractHashFromReceipt(proof, definitions);
    const requestedContractHash = toolDefinitionsContractHash(definitions);
    const hasCompatibleContract = providerContractHash === requestedContractHash;
    const hasDefinitionHash = typeof proof.providerDefinitionsHash === "string"
      && proof.providerDefinitionsHash.trim().length > 0;
    const providerObservationKind = providerRevision.startsWith(`thread-start:${threadId}:`)
      ? "thread_start_accepted"
      : "thread_fork_inherited";
    const hasExactCount = proof.providerDefinitionsCount === definitions.length;
    const hasExactObservation = proof.providerObservationKind === providerObservationKind;
    if (!revisionMatchesThread || !hasCompatibleContract || !hasDefinitionHash
      || !hasExactCount || !hasExactObservation) {
      const error = new Error("Persisted Codex Tool confirmation did not match this thread and Tool schema.");
      error.code = "PROVIDER_TOOL_APPLICATION_UNCONFIRMED";
      throw error;
    }
    const confirmation = {
      schema: JSON.stringify(definitions),
      providerRevision,
      providerDefinitionsHash: proof.providerDefinitionsHash,
      providerContractHash,
      providerDefinitionsCount: definitions.length,
      providerObservationKind,
      definitionFreshness: proof.providerDefinitionsHash === definitionsHash
        ? "current"
        : "stale_compatible",
      restored: true
    };
    this.confirmedToolSchemasByThread.set(threadId, confirmation);
    return { ...confirmation, threadId };
  }

  async resumeThread(threadId, options = {}) {
    await this.initialize();
    this.requireThreadToolPlanConfirmation(threadId, options);
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
    this.requireThreadToolPlanConfirmation(threadId, options);
    if (options.dynamicToolAgentId) {
      this.dynamicToolAgentsByThread.set(threadId, options.dynamicToolAgentId);
      this.dynamicToolMetadataByThread.set(threadId, options.dynamicToolMetadata ?? null);
    }
    this.threadResumeFingerprints.set(threadId, threadResumeFingerprint(options));
    return { alreadyLoaded: true, toolContextBound: true, thread: { id: threadId } };
  }

  async ensureThreadResumed(threadId, options = {}) {
    await this.initialize();
    this.requireThreadToolPlanConfirmation(threadId, options);
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
    const sourceConfirmation = this.requireThreadToolPlanConfirmation(threadId, options, {
      mismatchCode: "PROVIDER_TOOL_SCHEMA_FORK_UNSUPPORTED"
    });
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
      this.freshThreadIds.add(result.thread.id);
      if (sourceConfirmation) {
        this.confirmedToolSchemasByThread.set(result.thread.id, {
          schema: sourceConfirmation.schema,
          providerDefinitionsHash: sourceConfirmation.providerDefinitionsHash,
          providerContractHash: sourceConfirmation.providerContractHash,
          providerDefinitionsCount: sourceConfirmation.providerDefinitionsCount,
          definitionFreshness: sourceConfirmation.definitionFreshness,
          providerObservationKind: "thread_fork_inherited",
          providerRevision: `thread-fork-inherited:${result.thread.id}:${threadId}:${result.thread.updatedAt ?? result.thread.createdAt ?? "confirmed"}`
        });
      }
    }
    return result;
  }

  async clearThreadGoal(threadId) {
    return this.request("thread/goal/clear", { threadId });
  }

  requireThreadToolPlanConfirmation(threadId, options = {}, overrides = {}) {
    if (!Array.isArray(options.dynamicTools)) return null;
    const definitions = options.dynamicTools;
    let confirmed = this.confirmedToolSchemasByThread.get(threadId) ?? null;
    if (!confirmed && options.dynamicToolConfirmation) {
      try {
        this.restoreThreadToolPlanConfirmation(threadId, definitions, options.dynamicToolConfirmation);
        confirmed = this.confirmedToolSchemasByThread.get(threadId) ?? null;
      } catch (error) {
        throw toolPlanConfirmationError(error, overrides.mismatchCode);
      }
    }
    if (!confirmed || confirmed.providerContractHash !== toolDefinitionsContractHash(definitions)) {
      throw toolPlanConfirmationError(null, overrides.mismatchCode);
    }
    return confirmed;
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

  async startTurn(threadId, message, options = {}) {
    await this.initialize();
    const result = await this.request("turn/start", {
      threadId,
      input: codexTurnInput(message),
      additionalContext: options.additionalContext ?? undefined,
      cwd: options.cwd ?? undefined,
      approvalPolicy: options.approvalPolicy ?? undefined,
      sandboxPolicy: options.sandboxPolicy ?? undefined,
      model: options.model ?? undefined,
      effort: options.reasoningEffort ?? undefined,
      ...(options.environments !== undefined ? { environments: options.environments } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {})
    });
    this.freshThreadIds.delete(threadId);
    return result;
  }

  async stabilizeRecoveryThread(threadId, options = {}) {
    await this.initialize();
    this.requireThreadToolPlanConfirmation(threadId, options, {
      mismatchCode: "RECOVERY_TOOL_CONFIRMATION_MISMATCH"
    });
    const notificationStart = this.notifications.length;
    const timeoutMs = options.timeoutMs ?? 90_000;
    const startedAt = Date.now();
    const state = { toolAttempts: 0 };
    this.recoveryStabilizationThreads.set(threadId, state);
    try {
      const started = await this.startTurn(
        threadId,
        "<corptie_recovery_stabilization authorization=\"no_tools\">This is an internal persistence checkpoint. Do not call tools, inspect files, or perform side effects. Reply exactly CORPTIE_RECOVERY_STABILIZED.</corptie_recovery_stabilization>",
        {
          cwd: options.cwd,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
          model: options.model,
          reasoningEffort: options.reasoningEffort
        }
      );
      const turnId = started?.turn?.id ?? null;
      if (!turnId) throw recoveryStabilizationError("RECOVERY_STABILIZATION_TURN_MISSING", "Codex did not create the recovery stabilization Turn.");
      while (Date.now() - startedAt < timeoutMs) {
        const completed = this.notifications.slice(notificationStart).find((message) => {
          return message.method === "turn/completed"
            && message.params?.threadId === threadId
            && message.params?.turn?.id === turnId;
        });
        if (completed) {
          const status = String(completed.params?.turn?.status ?? "completed").toLowerCase();
          if (status !== "completed" || completed.params?.turn?.error) {
            throw recoveryStabilizationError(
              "RECOVERY_STABILIZATION_TURN_FAILED",
              "Codex could not complete the recovery stabilization Turn."
            );
          }
          if (state.toolAttempts > 0) {
            throw recoveryStabilizationError(
              "RECOVERY_STABILIZATION_SIDE_EFFECT_ATTEMPTED",
              "The recovery stabilization Turn attempted to call a Tool and was rejected."
            );
          }
          const turnItems = this.liveThreadCache.itemsForThread(threadId)
            .filter((item) => item.turnId === turnId);
          const sideEffectItem = turnItems.find((item) => [
            "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView"
          ].includes(item.type));
          if (sideEffectItem) {
            throw recoveryStabilizationError(
              "RECOVERY_STABILIZATION_SIDE_EFFECT_ATTEMPTED",
              `The recovery stabilization Turn attempted ${sideEffectItem.type} and was rejected.`
            );
          }
          const text = this.latestAgentMessageText(threadId, turnId).trim();
          const snapshot = await this.request("thread/read", { threadId, includeTurns: true }, options.requestTimeoutMs ?? 30_000);
          const persisted = snapshot?.thread?.id === threadId
            && Array.isArray(snapshot.thread.turns)
            && snapshot.thread.turns.some((turn) => turn?.id === turnId && String(turn?.status ?? "completed").toLowerCase() === "completed");
          if (!persisted) {
            throw recoveryStabilizationError(
              "RECOVERY_STABILIZATION_NOT_PERSISTED",
              "Codex did not expose a persisted completed Turn for the recovery Session."
            );
          }
          return {
            durable: true,
            providerObservationKind: "recovery_stabilization_turn_completed",
            providerThreadId: threadId,
            turnId,
            toolAttempts: 0,
            acknowledgementMatched: text === "CORPTIE_RECOVERY_STABILIZED"
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      throw recoveryStabilizationError(
        "RECOVERY_STABILIZATION_TIMEOUT",
        "Timed out while waiting for Codex to persist the recovery Session."
      );
    } finally {
      this.recoveryStabilizationThreads.delete(threadId);
    }
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
    return this.backgroundOperations.runChoiceParser(options);
  }

  async runEphemeralPrompt(options = {}) {
    return this.backgroundOperations.runEphemeralPrompt(options);
  }

  latestAgentMessageText(threadId, turnId) {
    return this.liveThreadCache.latestAgentMessageText(threadId, turnId);
  }

  async execResumeThread(threadId, text) {
    await this.initialize();

    const childCodex = typeof this.command === "function" ? this.command() : this.command;
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
    await this.transport.close();
  }

  expireGenerationInteractions() {
    // A server request cannot be answered after its app-server generation is
    // gone. Persist that fact before dropping the in-memory request map so
    // clients do not keep presenting an answerable card after a reconnect.
    for (const [threadId, requests] of this.serverRequestsByThread) {
      for (const request of requests.values()) {
        if (request.interaction || request.method === "item/tool/requestUserInput") {
          this.emitUserInputNotification(threadId, request, "corptie/codexUserInputResolved", "expired");
        }
      }
    }
  }

  clearGenerationThreadState() {
    this.threadResumeFingerprints.clear();
    this.threadResumePromises.clear();
    this.freshThreadIds.clear();
    this.confirmedToolSchemasByThread.clear();
    this.serverRequestsByThread.clear();
  }

  liveItemsForThread(threadId) {
    return [
      ...this.liveThreadCache.itemsForThread(threadId),
      ...Array.from(this.serverRequestsByThread.get(threadId)?.values() ?? [])
        .map((request) => mapServerRequestToItem(threadId, request))
        .filter(Boolean)
    ];
  }

  attachManagedImagesToLiveItem(threadId, itemId, images) {
    return this.liveThreadCache.attachManagedImagesToLiveItem(threadId, itemId, images);
  }

  tokenUsageForThread(threadId) {
    return this.liveThreadCache.tokenUsageForThread(threadId);
  }

  respondToApproval(threadId, input = {}) {
    const requests = this.serverRequestsByThread.get(threadId);
    const request = Array.from(requests?.values() ?? []).reverse().find((candidate) => {
      return isApprovalServerRequest(candidate);
    });
    if (!request) {
      return Promise.reject(new Error("No active Codex app-server approval request"));
    }
    if (input.itemId && mapServerRequestToItem(threadId, request)?.id !== input.itemId) {
      return Promise.reject(Object.assign(new Error("Approval request is no longer current"), {
        code: "APPROVAL_NOT_PENDING"
      }));
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

  respondToUserInput(threadId, input = {}) {
    const requests = this.serverRequestsByThread.get(threadId);
    const request = Array.from(requests?.values() ?? []).find((candidate) =>
      (candidate.interaction || candidate.method === "item/tool/requestUserInput")
      && input.itemId === `${threadId}:app-server-user-input:${String(candidate.requestId)}`);
    if (!request || request.responding || request.responded) {
      return Promise.reject(Object.assign(new Error("Codex user-input request is no longer pending"), {
        code: "USER_INPUT_NOT_PENDING"
      }));
    }
    let response;
    try {
      response = request.interaction ? structuredResponse(request, input) : codexUserInputResponse(request, input.answers);
    } catch (error) {
      return Promise.reject(error);
    }
    request.responding = true;
    request.cancelled = input.action === "cancel";
    return this.respondToServerRequest(request.requestId, response).then(
      (result) => {
        request.responding = false;
        request.responded = true;
        if (this.serverRequestsByThread.get(threadId)?.get(request.requestId) === request) {
          this.emitUserInputNotification(threadId, request, "corptie/codexUserInputSubmitted", input.action === "cancel" ? "cancelled" : "submitted");
        }
        return result;
      },
      (error) => {
        request.responding = false;
        throw error;
      }
    );
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    return this.transport.request(method, params, timeoutMs);
  }

  handleLine(line) {
    this.transport.handleLine(line);
  }

  handleNotification(message) {
    if (message.method === "turn/plan/updated" && !message.params?.providerEventId) {
      message = {
        ...message,
        params: {
          ...(message.params ?? {}),
          providerEventId: `codex-plan:${this.planNotificationRunId}:${++this.planNotificationSequence}`
        }
      };
    }
    if (message.method === "serverRequest/resolved") {
      this.notifications.push(message);
      this.resolveServerRequest(message.params);
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
    if (threadId && ["item/permissions/requestApproval", "mcpServer/elicitation/request"].includes(request.method)) {
      try {
        request.interaction = structuredRequest(request);
        request.requestId = message.id;
        if (!this.serverRequestsByThread.has(threadId)) this.serverRequestsByThread.set(threadId, new Map());
        this.serverRequestsByThread.get(threadId).set(message.id, request);
        this.emitUserInputNotification(threadId, request, "corptie/codexUserInputRequested", "pending");
      } catch (error) { this.rejectUnsupportedRequest(message, error.message); }
      return;
    }
    if (threadId && request.method === "item/tool/requestUserInput"
      && normalizeCodexUserInputRequest({ ...request, requestId: message.id })) {
      if (!this.serverRequestsByThread.has(threadId)) {
        this.serverRequestsByThread.set(threadId, new Map());
      }
      const pendingRequest = {
        ...request,
        requestId: message.id
      };
      this.serverRequestsByThread.get(threadId).set(message.id, pendingRequest);
      this.emitUserInputNotification(threadId, pendingRequest, "corptie/codexUserInputRequested", "pending");
      return;
    }
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
          createdAt: request.params.createdAt,
          // Keep the request's public item with the notification: ingestion may
          // run after the pending-request cache has already been cleared.
          item: mapServerRequestToItem(threadId, request)
        }
      });
      return;
    }
    this.rejectUnsupportedRequest(message, "当前客户端尚不支持这种交互请求。");
  }

  rejectUnsupportedRequest(message, reason) {
    const threadId = message.params?.threadId;
    if (threadId) this.onNotification?.({ method: "item/completed", params: { threadId,
      turnId: message.params?.turnId ?? threadId, item: { id: `${threadId}:unsupported:${message.id}`,
        type: "warning", title: "交互未支持", text: `${reason}\n${message.method}`, status: "failed" } } });
    // Explicitly close the native request; never leave a hidden waiter alive.
    const result = message.method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" }
      : message.method === "mcpServer/elicitation/request" ? { action: "cancel", content: null } : null;
    if (result) void this.respondToServerRequest(message.id, result).catch(() => {});
    else this.transport.rejectUnsupportedRequest(message.id);
  }

  emitUserInputNotification(threadId, request, method, status) {
    const item = codexUserInputItem(threadId, request);
    if (!item) return;
    const notification = {
      method,
      params: {
        threadId,
        requestId: request.requestId,
        turnId: item.turnId,
        providerEventId: `codex-user-input:${this.planNotificationRunId}:${++this.planNotificationSequence}`,
        createdAt: nowIso(),
        item: { ...item, status,
          turnStatus: method === "corptie/codexUserInputResolved" ? "inProgress" : item.turnStatus }
      }
    };
    this.notifications.push(notification);
    this.onNotification?.(notification);
  }

  resolveServerRequest(params = {}) {
    const threadId = params.threadId;
    const requestId = params.requestId;
    const request = this.serverRequestsByThread.get(threadId)?.get(requestId);
    if (!request) return;
    this.removeServerRequest(threadId, requestId);
    if (request.interaction || request.method === "item/tool/requestUserInput") {
      this.emitUserInputNotification(threadId, request, "corptie/codexUserInputResolved",
        request.cancelled ? "cancelled" : request.responding || request.responded ? "submitted" : "expired");
    }
  }

  async handleDynamicToolCall(message) {
    const params = message.params ?? {};
    const agentId = this.dynamicToolAgentsByThread.get(params.threadId);
    try {
      const stabilization = this.recoveryStabilizationThreads.get(params.threadId);
      if (stabilization) {
        stabilization.toolAttempts += 1;
        const error = new Error("Tools are disabled during recovery stabilization.");
        error.code = "RECOVERY_STABILIZATION_TOOL_FORBIDDEN";
        throw error;
      }
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
    return this.transport.respondToServerRequest(id, result);
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
    this.liveThreadCache.captureLiveItem(message);
  }

  // Compatibility for existing adapter diagnostics and fixtures. These expose
  // the cache's maps, never a second copy of native runtime state.
  get liveItemsByThread() { return this.liveThreadCache.liveItemsByThread; }
  get turnDiffsByThread() { return this.liveThreadCache.turnDiffsByThread; }
  get tokenUsageByThread() { return this.liveThreadCache.tokenUsageByThread; }
}

export function codexTurnInput(message) {
  if (typeof message === "string") {
    return [{ type: "text", text: message, text_elements: [] }];
  }
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  const images = Array.isArray(message?.images) ? message.images : [];
  return [
    ...(text ? [{ type: "text", text, text_elements: [] }] : []),
    ...images.map((image) => {
      const path = typeof image?.absolutePath === "string" ? image.absolutePath.trim() : "";
      if (!path) {
        const error = new Error("Codex image input requires a resolved local path.");
        error.code = "CHAT_IMAGE_MISSING";
        throw error;
      }
      return { type: "localImage", path };
    })
  ];
}

function recoveryStabilizationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hashToolDefinitions(definitions) {
  return createHash("sha256").update(stableToolDefinitions(definitions)).digest("hex");
}

function stableToolDefinitions(value) {
  if (Array.isArray(value)) return `[${value.map(stableToolDefinitions).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableToolDefinitions(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// A missing native rollout discovered by thread/resume is proven to occur
// before turn/start, so the durable Corptie Delivery has not reached Codex.
// Keep this annotation at that pre-dispatch boundary; applying it to arbitrary
// app-server failures would make an ambiguous in-flight turn unsafe to retry.
export function codexPreDispatchRecoveryError(error) {
  const sessionUnavailable = error?.code === "PROVIDER_SESSION_UNAVAILABLE" && error?.safeToRetry === true;
  const toolSchemaUnconfirmed = error?.code === "PROVIDER_TOOL_APPLICATION_UNCONFIRMED";
  if (!sessionUnavailable && !toolSchemaUnconfirmed) return error;
  error.dispatchState = "not_sent";
  error.recoveryAction = "replace_provider_binding";
  error.replacementReason = error.code;
  return error;
}

function toolPlanConfirmationError(cause = null, code = "PROVIDER_TOOL_APPLICATION_UNCONFIRMED") {
  const error = new Error(
    code === "PROVIDER_TOOL_SCHEMA_FORK_UNSUPPORTED"
      ? "Codex thread/fork cannot replace the source thread Tool schema; create a fresh thread instead."
      : "Codex did not confirm the Tool schema installed on this thread.",
    cause ? { cause } : undefined
  );
  error.code = code;
  error.safeToRetry = true;
  return error;
}
