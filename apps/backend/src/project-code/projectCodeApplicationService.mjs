import { randomUUID } from "node:crypto";
import { contractError, validateProjectCodeReceipt, validateToolsetValidationReceipt } from "./projectCodeContracts.mjs";
import { createValidatedSnapshotLease } from "./projectCodeValidationLease.mjs";

export class ProjectCodeSearchApplicationService {
  constructor(options = {}) {
    for (const field of ["store", "startupReceipts", "snapshotBuilder", "searchService"]) {
      if (!options[field]) throw new TypeError(`ProjectCodeSearchApplicationService requires ${field}.`);
      this[field] = options[field];
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.toolsetReceipts = options.toolsetReceipts ?? null;
    this.snapshotFlights = new Map();
    this.snapshotCache = new Map();
    this.maxCachedSnapshots = options.maxCachedSnapshots ?? 32;
    this.prewarmFlights = new Map();
    this.prewarmStates = new Map();
  }

  async createSnapshot(input = {}) {
    const context = this.#context(input);
    const snapshot = await this.#buildCurrentSnapshot(context, input.sourceDeclarations ?? [], input.signal);
    await validateProjectCodeReceipt(snapshot.receipt, "RepositorySourceSnapshotReceipt");
    this.#persist("RepositorySourceSnapshotReceipt", snapshot.receipt, context);
    this.#cacheSnapshot(snapshot);
    return Object.freeze({ receipt: snapshot.receipt, rejectedPaths: Object.freeze(snapshot.rejectedPaths) });
  }

  async search(input = {}) {
    const context = this.#context(input);
    const responseDetail = normalizeChoice(input.responseDetail, "compact", ["compact", "full"], "responseDetail");
    const snapshotPolicy = normalizeChoice(input.snapshotPolicy, "reuse_current", ["reuse_current", "require_exact", "create_new"], "snapshotPolicy");
    const resolved = await this.#resolveSnapshot({ ...input, snapshotPolicy }, context);
    const snapshot = resolved.snapshot;
    const toolsetValidationReceipt = input.toolsetValidationReceipt
      ?? await this.#resolveToolsetReceipt(input.toolsetValidationReceiptId, context);
    if (toolsetValidationReceipt) await validateToolsetValidationReceipt(toolsetValidationReceipt);
    const result = await this.searchService.search({
      snapshot,
      validationLease: resolved.validationLease,
      sessionContext: context.sessionContext,
      searchScenarioId: input.searchScenarioId ?? `project-code:${randomUUID()}`,
      query: input.query,
      mode: input.mode,
      paths: input.paths,
      languages: input.languages,
      kinds: input.kinds,
      limit: input.limit,
      minResults: input.minResults,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      toolsetValidationReceipt,
      toolsetRequired: input.toolsetRequired === true
    });
    this.#persist("SearchReceipt", result.receipt, context);
    if (responseDetail === "full") {
      return Object.freeze({ snapshotReceipt: snapshot.receipt, searchReceipt: result.receipt, results: result.results });
    }
    return compactSearchPresentation(snapshot.receipt, result, { snapshotReused: resolved.reused });
  }

  async pointRead(input = {}) {
    const context = this.#context(input);
    const resolved = await this.#resolveSnapshot({ ...input, snapshotPolicy: input.snapshotPolicy ?? "require_exact" }, context);
    const snapshot = resolved.snapshot;
    return this.searchService.pointRead({
      snapshot,
      validationLease: resolved.validationLease,
      sessionContext: context.sessionContext,
      path: input.path,
      startLine: input.startLine,
      lineCount: input.lineCount,
      maxBytes: input.maxBytes,
      maxScanBytes: input.maxScanBytes,
      signal: input.signal
    });
  }

  prewarm(input = {}) {
    const context = this.#context(input);
    const key = [context.startupReceipt.worktreeId, context.startupReceipt.startupOperationId,
      context.startupReceipt.bindingGeneration].join(":");
    const running = this.prewarmFlights.get(key);
    if (running) return running;
    const started = performance.now();
    this.#setPrewarmState(key, context, { status: "building", startedAt: this.now(), durationMs: null, errorCode: null });
    const promise = this.#performPrewarm(context, started, input.sourceDeclarations ?? [])
      .catch((error) => {
        this.#setPrewarmState(key, context, {
          status: "failed", startedAt: this.prewarmStates.get(key)?.startedAt ?? null,
          durationMs: elapsedMilliseconds(started), errorCode: error?.code ?? "PROJECT_CODE_PREWARM_FAILED"
        });
        throw error;
      })
      .finally(() => this.prewarmFlights.delete(key));
    this.prewarmFlights.set(key, promise);
    return promise;
  }

  prewarmSummary() {
    const states = [...this.prewarmStates.values()];
    const latest = states.at(-1);
    return Object.freeze({
      building: states.filter((state) => state.status === "building").length,
      ready: states.filter((state) => state.status === "ready").length,
      failed: states.filter((state) => state.status === "failed").length,
      latest: latest ? Object.freeze({
        status: latest.status,
        durationMs: latest.durationMs,
        snapshotMs: latest.snapshotMs ?? null,
        indexMs: latest.indexMs ?? null,
        indexHit: latest.indexHit ?? false,
        incremental: latest.incremental ?? false,
        documentCount: latest.documentCount ?? 0,
        errorCode: latest.errorCode
      }) : null
    });
  }

  getReceipt(input = {}) {
    const context = this.#context(input);
    const stored = this.store.getProjectCodeReceipt(requiredText(input.receiptId, "receiptId"), context.sessionContext.logicalSessionId);
    if (!stored) throw contractError("RECEIPT_NOT_FOUND", "The requested project-code receipt is unavailable.", 404);
    return Object.freeze({ receiptType: stored.receiptType, receipt: Object.freeze(stored.receipt) });
  }

  #context(input) {
    const logicalSessionId = requiredText(input.logicalSessionId, "logicalSessionId");
    const ownership = this.store.assertLogicalWorkSessionBinding(logicalSessionId);
    const logical = this.store.getLogicalSession(logicalSessionId);
    const session = ownership.sessionId ? this.store.getSession(ownership.sessionId) : null;
    const task = this.store.getTask(ownership.taskId);
    const startupReceipt = this.startupReceipts.require(logicalSessionId);
    if (!logical?.activeBinding || !session || !task
      || startupReceipt.worktreeId !== logical.activeBinding.worktreeId
      || startupReceipt.canonicalWorktreePath !== logical.activeBinding.boundCwd
      || startupReceipt.workId !== ownership.workId
      || startupReceipt.taskId !== ownership.taskId) {
      throw contractError("STARTUP_BINDING_STALE", "Project-code request does not match the active Work Session route.");
    }
    const sessionContext = Object.freeze({
      workId: ownership.workId,
      taskId: ownership.taskId,
      logicalSessionId
    });
    const binding = Object.freeze({
      repositoryId: startupReceipt.repositoryId,
      worktreeId: startupReceipt.worktreeId,
      canonicalWorktreePath: startupReceipt.canonicalWorktreePath,
      providerBindingId: startupReceipt.providerBindingId,
      bindingGeneration: startupReceipt.bindingGeneration,
      repositoryInventoryVersion: startupReceipt.repositoryInventoryVersion,
      workspaceResourceVersion: startupReceipt.workspaceResourceVersion,
      resourceVersion: startupReceipt.resourceVersion
    });
    return Object.freeze({ logical, session, task, startupReceipt, sessionContext, binding });
  }

  async #resolveSnapshot(input, context) {
    if (input.snapshotPolicy === "require_exact") {
      return this.#loadSnapshot(requiredText(input.snapshotReceiptId, "snapshotReceiptId"), context, input.signal, true);
    }
    if (input.snapshotPolicy === "reuse_current") {
      const stored = input.snapshotReceiptId
        ? this.store.getProjectCodeReceipt(input.snapshotReceiptId, context.sessionContext.logicalSessionId)
        : this.store.getLatestProjectCodeSnapshot?.(context.sessionContext.logicalSessionId);
      if (stored?.receiptType === "RepositorySourceSnapshotReceipt") {
        try { return await this.#loadSnapshot(stored.receipt.receiptId, context, input.signal, true); }
        catch (error) { if (error?.code !== "SOURCE_SNAPSHOT_STALE") throw error; }
      }
    }
    const snapshot = await this.#buildCurrentSnapshot(context, input.sourceDeclarations ?? [], input.signal);
    await validateProjectCodeReceipt(snapshot.receipt, "RepositorySourceSnapshotReceipt");
    this.#persist("RepositorySourceSnapshotReceipt", snapshot.receipt, context);
    this.#cacheSnapshot(snapshot);
    return Object.freeze({ snapshot, validationLease: createValidatedSnapshotLease(snapshot, this.snapshotBuilder), reused: false });
  }

  async #loadSnapshot(receiptId, context, signal, reused = false) {
    const stored = this.store.getProjectCodeReceipt(requiredText(receiptId, "snapshotReceiptId"), context.sessionContext.logicalSessionId);
    if (!stored || stored.receiptType !== "RepositorySourceSnapshotReceipt") {
      throw contractError("SOURCE_SNAPSHOT_REQUIRED", "The requested authoritative RepositorySourceSnapshotReceipt is unavailable.", 404);
    }
    await validateProjectCodeReceipt(stored.receipt, "RepositorySourceSnapshotReceipt");
    const cached = this.snapshotCache.get(receiptId);
    if (cached?.receipt?.receiptHash === stored.receipt.receiptHash) {
      this.snapshotCache.delete(receiptId);
      this.snapshotCache.set(receiptId, cached);
      return Object.freeze({ snapshot: cached, validationLease: createValidatedSnapshotLease(cached, this.snapshotBuilder), reused });
    }
    const current = await this.#buildCurrentSnapshot(context, [], signal);
    for (const field of ["repositoryId", "worktreeId", "sourceCommitOid", "sourceTreeOid", "sourceFingerprint"]) {
      if (current.receipt[field] !== stored.receipt[field]) {
        throw contractError("SOURCE_SNAPSHOT_STALE", `Persisted Snapshot ${field} no longer matches current source state.`);
      }
    }
    const snapshot = Object.freeze({ ...current, receipt: Object.freeze(stored.receipt) });
    this.#cacheSnapshot(snapshot);
    return Object.freeze({ snapshot, validationLease: createValidatedSnapshotLease(snapshot, this.snapshotBuilder), reused });
  }

  #cacheSnapshot(snapshot) {
    const key = snapshot.receipt.receiptId;
    this.snapshotCache.delete(key);
    this.snapshotCache.set(key, snapshot);
    while (this.snapshotCache.size > this.maxCachedSnapshots) this.snapshotCache.delete(this.snapshotCache.keys().next().value);
  }

  async #performPrewarm(context, started, sourceDeclarations) {
    const snapshotStarted = performance.now();
    const snapshot = await this.#buildCurrentSnapshot(context, sourceDeclarations);
    await validateProjectCodeReceipt(snapshot.receipt, "RepositorySourceSnapshotReceipt");
    this.#persist("RepositorySourceSnapshotReceipt", snapshot.receipt, context);
    this.#cacheSnapshot(snapshot);
    const snapshotMs = elapsedMilliseconds(snapshotStarted);
    const index = await this.searchService.prewarm({ snapshot });
    const key = [context.startupReceipt.worktreeId, context.startupReceipt.startupOperationId,
      context.startupReceipt.bindingGeneration].join(":");
    const state = this.#setPrewarmState(key, context, {
      status: index.status,
      startedAt: this.prewarmStates.get(key)?.startedAt ?? null,
      durationMs: elapsedMilliseconds(started),
      snapshotMs,
      indexMs: index.durationMs,
      indexHit: index.indexHit,
      incremental: index.incremental,
      documentCount: index.documentCount ?? 0,
      sourceFingerprint: snapshot.receipt.sourceFingerprint,
      errorCode: null
    });
    return Object.freeze({ ...state, snapshotReceiptId: snapshot.receipt.receiptId });
  }

  #setPrewarmState(key, context, details) {
    const state = Object.freeze({
      worktreeId: context.startupReceipt.worktreeId,
      logicalSessionId: context.sessionContext.logicalSessionId,
      ...details
    });
    this.prewarmStates.delete(key);
    this.prewarmStates.set(key, state);
    while (this.prewarmStates.size > this.maxCachedSnapshots) this.prewarmStates.delete(this.prewarmStates.keys().next().value);
    return state;
  }

  async #buildCurrentSnapshot(context, sourceDeclarations, signal) {
    const key = [context.sessionContext.logicalSessionId, context.startupReceipt.startupOperationId,
      context.binding.bindingGeneration, context.binding.worktreeId, JSON.stringify(sourceDeclarations)].join(":");
    if (!this.snapshotFlights.has(key)) {
      this.snapshotFlights.set(key, this.snapshotBuilder.build({
        startupReceipt: context.startupReceipt,
        binding: context.binding,
        sessionContext: context.sessionContext,
        sourceDeclarations,
        signal
      }).finally(() => this.snapshotFlights.delete(key)));
    }
    return this.snapshotFlights.get(key);
  }

  #persist(receiptType, receipt, context) {
    this.store.putProjectCodeReceipt({
      receiptId: receipt.receiptId,
      receiptType,
      logicalSessionId: context.sessionContext.logicalSessionId,
      workId: context.sessionContext.workId,
      taskId: context.sessionContext.taskId,
      repositoryId: receipt.repositoryId ?? context.startupReceipt.repositoryId,
      worktreeId: receipt.worktreeId ?? context.startupReceipt.worktreeId,
      sourceFingerprint: receipt.sourceFingerprint,
      receiptHash: receipt.receiptHash,
      receipt,
      createdAt: receipt.createdAt ?? this.now()
    });
  }

  async #resolveToolsetReceipt(receiptId, context) {
    if (receiptId == null) return null;
    if (!this.toolsetReceipts?.require) {
      throw contractError("TOOLSET_CONTRACT_UNRESOLVED", "The authoritative Toolset receipt resolver is unavailable.", 503);
    }
    const receipt = await this.toolsetReceipts.require({ receiptId, context });
    if (!receipt || receipt.receiptId !== receiptId) {
      throw contractError("TOOLSET_CONTRACT_UNRESOLVED", "The authoritative ToolsetValidationReceipt is unavailable.", 404);
    }
    return receipt;
  }
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw contractError("QUERY_INVALID", `${field} is required.`, 400);
  return text;
}

function normalizeChoice(value, fallback, allowed, field) {
  const result = value ?? fallback;
  if (!allowed.includes(result)) throw contractError("UNSUPPORTED_OPTION", `${field} is unsupported.`, 400);
  return result;
}

function compactSearchPresentation(snapshot, result, options = {}) {
  const layers = result.receipt.layers.map((layer) => Object.freeze({
    layer: layer.layer, status: layer.status, indexHit: layer.indexHit,
    resultCount: layer.resultCount, latencyMs: layer.latencyMs,
    skippedReason: layer.skippedReason,
    degradedReason: layer.degradedReason
  }));
  const presentedResults = [...result.results];
  const response = {
    snapshot: Object.freeze({
      receiptId: snapshot.receiptId,
      sourceFingerprint: snapshot.sourceFingerprint,
      repositoryId: snapshot.repositoryId,
      worktreeId: snapshot.worktreeId,
      reused: options.snapshotReused === true
    }),
    search: Object.freeze({
      receiptId: result.receipt.receiptId,
      outcome: result.receipt.outcome,
      errorCode: result.receipt.errorCode,
      layers: Object.freeze(layers),
      totalMs: result.receipt.latency.totalMs,
      truncated: result.receipt.resultSummary.truncated === true
    }),
    results: presentedResults,
    guidance: result.results.length === 0 ? zeroResultGuidance(result.receipt) : null
  };
  while (presentedResults.length > 0 && Buffer.byteLength(JSON.stringify(response)) > 16 * 1024) {
    presentedResults.pop();
    response.search = Object.freeze({ ...response.search, truncated: true });
  }
  return Object.freeze({ ...response, results: Object.freeze(presentedResults) });
}

function zeroResultGuidance(receipt) {
  const degraded = receipt.layers.find((layer) => layer.status === "degraded");
  if (degraded) return `No results; ${degraded.layer} is degraded (${degraded.degradedReason}).`;
  return "No results in the selected Snapshot and scope; try symbols or semantic mode, or broaden paths.";
}

function elapsedMilliseconds(started) {
  return Math.max(0, Number((performance.now() - started).toFixed(3)));
}
