import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { resolveExternalCommand } from "../utils/externalCommand.mjs";
import {
  contractError,
  createReceiptId,
  hashCanonical,
  searchArtifactRef,
  sha256Hex,
  signReceipt,
  snapshotReceiptRef,
  toolsetValidationReceiptRef,
  validateToolsetValidationReceipt,
  validateProjectCodeReceipt,
} from "./projectCodeContracts.mjs";
import { queryTextSymbolIndex } from "./projectCodeIndexStore.mjs";
import { assertContainedSearchScope, assertContainedSourceFile, rejectedPathFact } from "./projectCodePaths.mjs";
import { cleanupReceiptRef, runReceiptRef } from "./projectCodeRunIsolationPort.mjs";
import { isValidatedSnapshotLease } from "./projectCodeValidationLease.mjs";

const execFileAsync = promisify(execFile);
const resultKinds = new Set(["file", "text", "class", "struct", "enum", "protocol", "function", "method", "property", "import", "call", "test", "semantic"]);
const searchInputFields = new Set(["snapshot", "validationLease", "sessionContext", "searchScenarioId", "query", "mode", "paths", "languages", "kinds", "limit", "minResults", "timeoutMs", "signal", "toolsetValidationReceipt", "toolsetRequired"]);
const pointReadInputFields = new Set(["snapshot", "validationLease", "sessionContext", "path", "startLine", "lineCount", "maxBytes", "maxScanBytes", "signal"]);

export class ProjectCodeSearchService {
  constructor(options = {}) {
    if (!options.snapshotBuilder) throw new TypeError("ProjectCodeSearchService requires snapshotBuilder.");
    this.snapshotBuilder = options.snapshotBuilder;
    this.indexStore = options.indexStore ?? null;
    this.runIsolationPort = options.runIsolationPort ?? null;
    this.rgPath = options.rgPath ?? resolveExternalCommand("rg", { environmentVariables: ["CORPTIE_RG_PATH"] });
    this.now = options.now ?? (() => new Date().toISOString());
    this.receiptId = options.receiptId ?? (() => createReceiptId("search"));
    this.limiter = options.limiter ?? new ProjectCodeQueryLimiter();
    this.telemetrySink = options.telemetrySink ?? null;
    this.maxCachedWorktrees = options.maxCachedWorktrees ?? 32;
    this.nonBlockingIndexWarmup = options.nonBlockingIndexWarmup === true;
    this.previousL2ByWorktree = new Map();
  }

  async search(input) {
    assertClosedInput(input, searchInputFields, "search");
    const query = validateQuery(input.query);
    const filters = validateFilters(input.languages, input.kinds);
    const paths = validatePaths(input.paths);
    const timeoutMs = normalizeInteger(input.timeoutMs, 5_000, 250, 10_000, "timeoutMs");
    const started = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort("timeout"); }, timeoutMs);
    const externalAbort = () => controller.abort("cancelled");
    input.signal?.addEventListener("abort", externalAbort, { once: true });
    if (input.signal?.aborted) controller.abort("cancelled");
    const state = initialExecutionState(timeoutMs);
    let release = null;
    let results = [];
    let toolsetPointer = null;
    let isolation = { runReceiptRef: null, runId: null, cleanupReceiptRef: null };
    try {
      const queueStarted = performance.now();
      release = await this.limiter.acquire(input.sessionContext?.logicalSessionId, controller.signal);
      state.latency.queueMs = elapsed(queueStarted);
      const bindingStarted = performance.now();
      await validateProjectCodeReceipt(input.snapshot.receipt, "RepositorySourceSnapshotReceipt");
      assertReceiptIdentity(input.snapshot.receipt, input.sessionContext);
      state.latency.bindingVerifyMs = elapsed(bindingStarted);
      const freshnessStarted = performance.now();
      if (!isValidatedSnapshotLease(input.validationLease, input.snapshot)) {
        await this.snapshotBuilder.assertCurrent(input.snapshot, { signal: controller.signal });
      }
      state.latency.snapshotVerifyMs = elapsed(freshnessStarted);
      const toolsetStarted = performance.now();
      toolsetPointer = await verifyToolsetEcho(input.toolsetValidationReceipt, input.snapshot.receipt, input.toolsetRequired === true);
      state.latency.toolsetVerifyMs = elapsed(toolsetStarted);
      const resolvedScope = await this.#resolveScope(input.snapshot, paths, state.rejectedPaths);
      const scope = resolvedScope.candidates
        .filter((candidate) => filters.languages.size === 0 || filters.languages.has(candidate.language));
      if (scope.length === 0 && paths.length > 0 && resolvedScope.allowedTargets.length === 0) {
        state.outcome = "rejected";
        state.errorCode = "PATH_OUTSIDE_SCOPE";
        state.layers.push(layerFact("L0", "skipped", { skippedReason: "NO_ALLOWED_PATH" }));
      } else {
        const execution = await this.#executeLayers({ ...input, paths, query, scope, scopeTargets: resolvedScope.allowedTargets, signal: controller.signal, state });
        results = execution.results.filter((result) => filters.kinds.size === 0 || filters.kinds.has(result.kind));
        isolation = execution.isolation;
        state.outcome = execution.outcome;
        state.errorCode = execution.errorCode;
      }
      if (isValidatedSnapshotLease(input.validationLease, input.snapshot)) {
        const postStarted = performance.now();
        await input.validationLease.verifyAfter({ signal: controller.signal });
        state.latency.snapshotVerifyMs += elapsed(postStarted);
      }
    } catch (error) {
      if (error?.isolation) isolation = error.isolation;
      if (controller.signal.aborted || error?.name === "AbortError" || error?.code === "QUERY_CANCELLED") {
        state.outcome = timedOut ? "timeout" : "cancelled";
        state.errorCode = timedOut ? "QUERY_TIMEOUT" : "QUERY_CANCELLED";
        state.cancellation = { requested: !timedOut, observed: true, stage: state.stage, reasonCode: state.errorCode };
        state.timeout = { budgetMs: timeoutMs, timedOut, stage: state.stage };
        if (state.layers.length === 0) state.layers.push(layerFact("L0", "skipped", { skippedReason: state.errorCode }));
      } else if (isExpectedSearchError(error)) {
        state.outcome = "failed";
        state.errorCode = error.code;
        results = [];
        if (error.rejectedPath) state.rejectedPaths.push(error.rejectedPath);
        if (state.layers.length === 0) state.layers.push(layerFact("L0", "failed", { degradedReason: error.code }));
      } else {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", externalAbort);
      release?.();
    }
    // SearchReceipt deliberately permits either a fully closed Run/Cleanup
    // chain or no isolation projection. A cleanup failure remains authoritative
    // in RunIsolation audit storage, but cannot be projected as a partial edge.
    if (!isolation.runReceiptRef || !isolation.runId || !isolation.cleanupReceiptRef) {
      isolation = { runReceiptRef: null, runId: null, cleanupReceiptRef: null };
    }
    state.latency.totalMs = elapsed(started);
    const receipt = await this.#createReceipt({
      input: { ...input, paths }, query, state, results, toolsetPointer, isolation, timeoutMs
    });
    this.#recordTelemetry(receipt);
    return Object.freeze({ results: Object.freeze(results), receipt });
  }

  async pointRead(input) {
    assertClosedInput(input, pointReadInputFields, "point read");
    const maxBytes = normalizeInteger(input.maxBytes, 64 * 1024, 1, 64 * 1024, "maxBytes");
    const maxScanBytes = normalizeInteger(input.maxScanBytes, 8 * 1024 * 1024, 1, 64 * 1024 * 1024, "maxScanBytes");
    const startLine = normalizeInteger(input.startLine, 1, 1, Number.MAX_SAFE_INTEGER, "startLine");
    const lineCount = normalizeInteger(input.lineCount, 200, 1, 2_000, "lineCount");
    await validateProjectCodeReceipt(input.snapshot.receipt, "RepositorySourceSnapshotReceipt");
    assertReceiptIdentity(input.snapshot.receipt, input.sessionContext);
    if (!isValidatedSnapshotLease(input.validationLease, input.snapshot)) {
      await this.snapshotBuilder.assertCurrent(input.snapshot, { signal: input.signal });
    }
    const safe = await assertContainedSourceFile(input.snapshot.canonicalWorktreePath, input.path);
    if (!input.snapshot.candidates.some((candidate) => candidate.path === safe.relativePath)) {
      throw contractError("PATH_OUTSIDE_SCOPE", "The requested source path is not contained by this Snapshot.", 403);
    }
    const handle = await open(safe.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      const window = await readLineWindow(handle, { startLine, lineCount, maxBytes, maxScanBytes, size: before.size, signal: input.signal });
      const after = await handle.stat();
      if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw contractError("SOURCE_SNAPSHOT_STALE", "Source changed while the point-read window was being read.");
      }
      if (isValidatedSnapshotLease(input.validationLease, input.snapshot)) await input.validationLease.verifyAfter({ signal: input.signal });
      return Object.freeze({
        path: safe.relativePath,
        startLine,
        lines: Object.freeze(window.lines),
        nextStartLine: startLine + window.lines.length,
        eof: window.eof,
        truncated: window.truncatedReason !== null,
        truncatedReason: window.truncatedReason
      });
    } finally { await handle.close(); }
  }

  async prewarm({ snapshot, signal } = {}) {
    if (!snapshot?.receipt) throw new TypeError("ProjectCodeSearchService.prewarm requires snapshot.");
    if (!this.indexStore) {
      return Object.freeze({ status: "unsupported", indexHit: false, incremental: false, durationMs: 0 });
    }
    const started = performance.now();
    const previousIndex = this.previousL2ByWorktree.get(snapshot.receipt.worktreeId) ?? null;
    const built = await this.indexStore.warmLayer(snapshot, "L2", { signal, previousIndex });
    lruSet(this.previousL2ByWorktree, snapshot.receipt.worktreeId, {
      documentsByHash: new Map(built.index.documents.map((document) => [document.contentHash, document]))
    }, this.maxCachedWorktrees);
    return Object.freeze({
      status: "ready",
      indexHit: built.indexHit,
      incremental: built.incremental,
      durationMs: elapsed(started),
      documentCount: built.index.documents.length,
      sourceFingerprint: snapshot.receipt.sourceFingerprint
    });
  }

  async #executeLayers(input) {
    const mode = normalizeMode(input.mode);
    const minResults = normalizeInteger(input.minResults, 1, 1, 20, "minResults");
    const limit = normalizeInteger(input.limit, 12, 1, 50, "limit");
    const all = [];
    let isolation = { runReceiptRef: null, runId: null, cleanupReceiptRef: null };
    const autoPlan = mode === "auto" ? planAutoQuery(input.query) : null;
    let l2Attempted = false;
    if (mode === "semantic" && !this.#l3Available(input.snapshot)) {
      throw contractError("SEMANTIC_LANGUAGE_UNVALIDATED", "L3 semantic search is unavailable for this Snapshot language set.", 503);
    }
    const runLayer = async (layer, operation) => {
      input.state.stage = "execute";
      const started = performance.now();
      try {
        const value = await operation();
        const latencyMs = elapsed(started);
        input.state.latency.layerMs[layer] = latencyMs;
        input.state.layers.push(layerFact(layer, value.status ?? "executed", {
          candidateCount: value.candidateCount ?? input.scope.length,
          resultCount: value.results.length,
          indexHit: value.indexHit ?? false,
          isolationRequired: value.isolationRequired ?? false,
          latencyMs,
          skippedReason: value.skippedReason ?? null,
          degradedReason: value.degradedReason ?? null
        }));
        all.push(...value.results);
        if (value.isolation) isolation = value.isolation;
      } catch (error) {
        input.state.latency.layerMs[layer] = elapsed(started);
        throw error;
      }
    };

    if (mode === "auto" && autoPlan === "symbol") {
      l2Attempted = true;
      try {
        await runLayer("L2", () => this.#runL2(input, limit));
      } catch (error) {
        if (error?.code === "INDEX_WARMING") {
          input.state.layers.push(layerFact("L2", "skipped", { skippedReason: "INDEX_WARMING" }));
          await runLayer("L0", () => this.#runL0ForInput(input, limit));
        } else {
          if (error?.code !== "DATA_ROOT_UNAVAILABLE") throw error;
          input.state.layers.push(layerFact("L2", "degraded", { degradedReason: "DATA_ROOT_UNAVAILABLE" }));
        }
      }
      if (deduplicate(all).length >= minResults) return success(deduplicate(all).slice(0, limit), isolation,
        input.state.layers.some((fact) => fact.status === "degraded") ? "degraded" : "success");
    }
    if (mode === "auto" && autoPlan === "lexical") {
      l2Attempted = true;
      try {
        await runLayer("L2", () => this.#runL2(input, limit));
      } catch (error) {
        if (error?.code === "INDEX_WARMING") {
          input.state.layers.push(layerFact("L2", "skipped", { skippedReason: "INDEX_WARMING" }));
          await runLayer("L0", () => this.#runL0ForInput(input, limit));
        } else {
          if (error?.code !== "DATA_ROOT_UNAVAILABLE") throw error;
          input.state.layers.push(layerFact("L2", "degraded", { degradedReason: "DATA_ROOT_UNAVAILABLE" }));
        }
      }
      if (deduplicate(all).length >= minResults) return success(deduplicate(all).slice(0, limit), isolation,
        input.state.layers.some((fact) => fact.status === "degraded") ? "degraded" : "success");
    }
    if (mode === "exact" || (mode === "auto" && autoPlan === "exact")) {
      await runLayer("L0", () => this.#runL0ForInput(input, limit));
      if (mode === "exact" || deduplicate(all).length >= minResults) return success(deduplicate(all).slice(0, limit), isolation);
    }
    if (["auto", "files"].includes(mode)) {
      await runLayer("L1", () => this.#runL1(input, limit));
      if (mode === "files" || deduplicate(all).length >= minResults) return success(deduplicate(all).slice(0, limit), isolation);
    }
    if (["auto", "symbols", "semantic"].includes(mode) && !l2Attempted) {
      if (mode === "semantic" && !this.indexStore) {
        input.state.layers.push(layerFact("L2", "skipped", { skippedReason: "SEMANTIC_DIRECT_L3" }));
      } else {
        try {
          await runLayer("L2", () => this.#runL2(input, limit));
        } catch (error) {
          if (error?.code === "INDEX_WARMING") {
            input.state.layers.push(layerFact("L2", "skipped", { skippedReason: "INDEX_WARMING" }));
            await runLayer("L0", () => this.#runL0ForInput(input, limit));
          } else {
            if (!(["auto", "semantic"].includes(mode)) || error?.code !== "DATA_ROOT_UNAVAILABLE") throw error;
            input.state.layers.push(layerFact("L2", "degraded", { degradedReason: "DATA_ROOT_UNAVAILABLE" }));
          }
        }
      }
      if (mode === "symbols" || (mode === "auto" && deduplicate(all).length >= minResults)) {
        return success(deduplicate(all).slice(0, limit), isolation, input.state.layers.some((fact) => fact.status === "degraded") ? "degraded" : "success");
      }
    }
    if (["auto", "semantic"].includes(mode) && this.#l3Available(input.snapshot)
      && (mode === "semantic" || input.toolsetValidationReceipt)) {
      const value = await this.#runL3(input, limit);
      await runLayer("L3", async () => value);
      isolation = value.isolation;
    } else if (mode === "auto" && this.#l3Available(input.snapshot) && !input.toolsetValidationReceipt) {
      input.state.layers.push(layerFact("L3", "skipped", { skippedReason: "TOOLSET_CONTRACT_UNRESOLVED" }));
    } else if (mode === "semantic") {
      throw contractError("SEMANTIC_LANGUAGE_UNVALIDATED", "L3 semantic search is unavailable for this Snapshot language set.", 503);
    }
    return success(deduplicate(all).slice(0, limit), isolation, input.state.layers.some((fact) => fact.status === "degraded") ? "degraded" : "success");
  }

  async #runL0(query, scope, options) {
    if (scope.length === 0) return { results: [], candidateCount: 0, indexHit: false, isolationRequired: false };
    const args = ["--json", "--fixed-strings", "--line-number", "--color", "never", "--no-follow", "--hidden", "--max-filesize", "8M",
      "-g", "!.git/**", "-g", "!.corptie/worktrees/**", "-g", "!node_modules/**", "-g", "!vendor/**",
      "-g", "!Pods/**", "-g", "!Carthage/**", "-g", "!.gradle/**", "-g", "!target/**", "-g", "!coverage/**",
      "-g", "!.build/**", "-g", "!build/**", "-g", "!DerivedData/**", "-g", "!dist/**", "-g", "!out/**"];
    if (!options.allowGenerated) args.push("-g", "!generated/**", "-g", "!codegen/**");
    args.push("--", query);
    args.push(...options.targets);
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync(this.rgPath, args, {
        cwd: options.root,
        encoding: "utf8", maxBuffer: 32 * 1024 * 1024, signal: options.signal, env: minimalSearchEnvironment()
      }));
    } catch (error) {
      if (error?.code !== 1) throw error;
      stdout = error.stdout ?? "";
    }
    const results = parseRgJson(stdout).filter((result) => options.allowedPaths.has(result.path)).slice(0, options.limit);
    return { results, candidateCount: scope.length, indexHit: false, isolationRequired: false };
  }

  #runL0ForInput(input, limit) {
    return this.#runL0(input.query, input.scope, {
      signal: input.signal,
      limit,
      root: input.snapshot.canonicalWorktreePath,
      targets: (input.paths?.length ?? 0) > 0
        ? input.scopeTargets
        : input.snapshot.declarations.length > 0 ? input.snapshot.declarations.map((entry) => entry.path) : ["."],
      allowedPaths: new Set(input.scope.map((entry) => entry.path)),
      allowGenerated: input.snapshot.declarations.some((entry) => entry.generatedAllowed)
    });
  }

  async #runL1(input, limit) {
    const needle = input.query.toLocaleLowerCase("en-US");
    if (!this.indexStore) {
      return { results: fileResults(input.scope, needle, limit), candidateCount: input.scope.length, indexHit: false, isolationRequired: false, status: "degraded", degradedReason: "INDEX_STORE_DISABLED" };
    }
    try {
      let built = this.nonBlockingIndexWarmup ? this.indexStore.readyLayer?.(input.snapshot, "L1") : null;
      if (!built && this.nonBlockingIndexWarmup) {
        void this.indexStore.warmLayer(input.snapshot, "L1").catch(() => {});
        return {
          results: fileResults(input.scope, needle, limit), candidateCount: input.scope.length,
          indexHit: false, isolationRequired: false, status: "degraded", degradedReason: "INDEX_WARMING"
        };
      }
      built ??= await this.indexStore.ensureLayer(input.snapshot, "L1", { signal: input.signal });
      const allowed = new Set(input.scope.map((candidate) => candidate.path));
      const candidates = built.index.files.filter((file) => allowed.has(file.path)).map((file) => ({ path: file.path, language: file.language }));
      return { results: fileResults(candidates, needle, limit), candidateCount: candidates.length, indexHit: built.indexHit, isolationRequired: false };
    } catch (error) {
      if (error?.code !== "DATA_ROOT_UNAVAILABLE") throw error;
      return { results: fileResults(input.scope, needle, limit), candidateCount: input.scope.length, indexHit: false, isolationRequired: false, status: "degraded", degradedReason: "DATA_ROOT_UNAVAILABLE" };
    }
  }

  async #runL2(input, limit) {
    if (!this.indexStore) throw contractError("DATA_ROOT_UNAVAILABLE", "L2 requires the external project-code index store.", 503);
    const previousIndex = this.previousL2ByWorktree.get(input.snapshot.receipt.worktreeId) ?? null;
    let built = this.nonBlockingIndexWarmup ? this.indexStore.readyLayer?.(input.snapshot, "L2") : null;
    if (!built && this.nonBlockingIndexWarmup) {
      void this.indexStore.warmLayer(input.snapshot, "L2", { previousIndex }).catch(() => {});
      throw contractError("INDEX_WARMING", "The project-code index is warming in the background.", 503);
    }
    built ??= await this.indexStore.ensureLayer(input.snapshot, "L2", { signal: input.signal, previousIndex });
    lruSet(this.previousL2ByWorktree, input.snapshot.receipt.worktreeId, {
      documentsByHash: new Map(built.index.documents.map((document) => [document.contentHash, document]))
    }, this.maxCachedWorktrees);
    const allowed = new Set(input.scope.map((candidate) => candidate.path));
    return {
      results: queryTextSymbolIndex(built.index, input.query, {
        signal: input.signal,
        limit: 50,
        includeText: input.mode === "semantic" || (input.mode === "auto" && planAutoQuery(input.query) === "lexical")
      }).filter((result) => allowed.has(result.path)).slice(0, limit),
      candidateCount: built.index.documents.length,
      indexHit: built.indexHit,
      isolationRequired: false
    };
  }

  async #runL3(input, limit) {
    if (!this.runIsolationPort) throw contractError("RUN_ISOLATION_REQUIRED_FAILED", "L3 requires the approved RunIsolationScenarioPort.", 503);
    const preparedStarted = performance.now();
    input.state.stage = "prepareRun";
    const prepared = await this.runIsolationPort.prepareRun({
      snapshot: input.snapshot,
      sessionContext: input.sessionContext,
      toolsetValidationReceipt: input.toolsetValidationReceipt ?? null,
      idempotencyKey: `search:${input.searchScenarioId}:prepare`
    });
    input.state.latency.isolationPrepareMs = elapsed(preparedStarted);
    let execution;
    let cleanup;
    let isolation = { runReceiptRef: null, runId: prepared.runContext.runId, cleanupReceiptRef: null };
    let executionError = null;
    let cleanupError = null;
    try {
      input.state.stage = "execute";
      execution = await this.runIsolationPort.execute({
        prepared,
        snapshot: input.snapshot,
        sessionContext: input.sessionContext,
        query: input.query,
        queryHash: sha256Hex(Buffer.from(input.query)),
        limit,
        signal: input.signal,
        idempotencyKey: `search:${input.searchScenarioId}:execute`
      });
      isolation = { ...isolation, runReceiptRef: runReceiptRef(execution.receipt) };
    } catch (error) {
      executionError = error;
    } finally {
      input.state.stage = "cleanup";
      const cleanupStarted = performance.now();
      try {
        cleanup = await this.runIsolationPort.cleanup({
          prepared,
          snapshot: input.snapshot,
          sessionContext: input.sessionContext,
          expectedResourceVersion: execution?.receipt?.resourceVersion ?? prepared.runContext.resourceVersion,
          policy: "success_default",
          idempotencyKey: `search:${input.searchScenarioId}:cleanup`
        });
        isolation = { ...isolation, cleanupReceiptRef: cleanupReceiptRef(cleanup.receipt) };
      } catch (error) {
        cleanupError = error;
      } finally {
        input.state.latency.cleanupMs = elapsed(cleanupStarted);
      }
    }
    if (cleanupError) {
      cleanupError.isolation = isolation;
      throw cleanupError;
    }
    if (executionError) {
      executionError.isolation = isolation;
      throw executionError;
    }
    if (!execution?.receipt || !cleanup?.receipt
      || execution.receipt.runId !== prepared.runContext.runId
      || cleanup.receipt.runId !== prepared.runContext.runId) {
      const error = contractError("RUN_RECEIPT_REFERENCE_MISMATCH", "L3 Run/Cleanup receipts do not close over one runId.");
      error.isolation = isolation;
      throw error;
    }
    if (execution.receipt.state === "cancelled") {
      const error = contractError("QUERY_CANCELLED", "RunIsolation cancelled the semantic query.");
      error.name = "AbortError";
      error.isolation = isolation;
      throw error;
    }
    if (execution.receipt.state !== "completed" || execution.receipt.outcome !== "passed") {
      const error = contractError("RUN_EXECUTION_FAILED", "RunIsolation semantic execution did not pass.", 503);
      error.isolation = isolation;
      throw error;
    }
    return {
      results: sanitizeSemanticResults(execution.results ?? [], limit),
      candidateCount: input.scope.length,
      indexHit: false,
      isolationRequired: true,
      isolation
    };
  }

  #l3Available(snapshot) {
    const capabilities = this.runIsolationPort?.capabilities;
    if (capabilities?.localSemantic !== true || capabilities?.networkAccess !== false) return false;
    const allowed = new Set(capabilities.languages ?? []);
    return snapshot.candidates.length > 0 && snapshot.candidates.every((candidate) => allowed.has(candidate.language));
  }

  async #resolveScope(snapshot, paths, rejected) {
    if (paths.length === 0) return { candidates: snapshot.candidates, allowedTargets: [] };
    const allowed = new Map();
    const allowedTargets = new Set();
    for (const path of paths) {
      try {
        const safe = await assertContainedSearchScope(snapshot.canonicalWorktreePath, path);
        const matches = safe.kind === "file"
          ? snapshot.candidates.filter((entry) => entry.path === safe.relativePath)
          : snapshot.candidates.filter((entry) => entry.path.startsWith(`${safe.relativePath}/`));
        if (safe.kind === "file" && matches.length === 0) {
          rejected.push(rejectedPathFact(path, "PATH_NOT_IN_SNAPSHOT", { revealRelative: true }));
          continue;
        }
        allowedTargets.add(safe.relativePath);
        for (const candidate of matches) allowed.set(candidate.path, candidate);
      } catch (error) {
        rejected.push(error.rejectedPath ?? rejectedPathFact(path, error.code ?? "PATH_INVALID"));
      }
    }
    return { candidates: [...allowed.values()], allowedTargets: [...allowedTargets] };
  }

  async #createReceipt({ input, query, state, results, toolsetPointer, isolation, timeoutMs }) {
    const cappedRejected = state.rejectedPaths.slice(0, 100);
    const fields = {
      receiptId: this.receiptId(), schemaVersion: 1, resourceVersion: 1, artifactRef: searchArtifactRef(), createdAt: this.now(),
      searchScenarioId: requiredText(input.searchScenarioId, "searchScenarioId", 128),
      startupBindingRef: input.snapshot.receipt.startupBindingRef,
      snapshotReceiptRef: snapshotReceiptRef(input.snapshot.receipt),
      sourceFingerprint: input.snapshot.receipt.sourceFingerprint,
      toolsetValidationReceiptRef: toolsetPointer,
      runIsolationReceiptRef: isolation.runReceiptRef,
      runId: isolation.runId,
      cleanupReceiptRef: isolation.cleanupReceiptRef,
      queryHash: sha256Hex(Buffer.from(query.normalize("NFC"), "utf8")),
      scopeHash: hashCanonical({ paths: (input.paths ?? []).map((path) => sha256Hex(Buffer.from(String(path).normalize("NFC")))) }),
      indexVersion: indexVersion(state.layers, this.indexStore),
      candidateCategories: candidateCategories(input.snapshot, state.layers),
      layers: state.layers,
      latency: state.latency,
      resultSummary: summarizeResults(results),
      cancellation: state.cancellation,
      timeout: state.timeout,
      rejectedPaths: cappedRejected,
      rejectedPathOverflowCount: Math.max(0, state.rejectedPaths.length - cappedRejected.length),
      evidenceRefs: evidenceRefs(input.snapshot.receipt, state.layers),
      outcome: state.outcome,
      errorCode: state.outcome === "success" ? null : state.errorCode,
    };
    const receipt = signReceipt(fields);
    await validateProjectCodeReceipt(receipt, "SearchReceipt");
    if (Buffer.byteLength(JSON.stringify(receipt)) > 64 * 1024) throw contractError("RECEIPT_REFERENCE_MISMATCH", "SearchReceipt exceeds 64 KiB.");
    return receipt;
  }

  #recordTelemetry(receipt) {
    if (typeof this.telemetrySink !== "function") return;
    this.telemetrySink(Object.freeze({
      receiptId: receipt.receiptId,
      sourceFingerprintPrefix: receipt.sourceFingerprint.slice(0, 12),
      outcome: receipt.outcome,
      errorCode: receipt.errorCode,
      layers: receipt.layers.map(({ layer, status, candidateCount, resultCount, latencyMs, indexHit, isolationRequired }) => ({ layer, status, candidateCount, resultCount, latencyMs, indexHit, isolationRequired })),
      latency: receipt.latency,
      resultCount: receipt.resultSummary.count,
      rejectedPathCount: receipt.rejectedPaths.length + receipt.rejectedPathOverflowCount
    }));
  }
}

export class ProjectCodeQueryLimiter {
  constructor(options = {}) {
    this.perSession = options.perSession ?? 2;
    this.global = options.global ?? 8;
    this.queueTimeoutMs = options.queueTimeoutMs ?? 250;
    this.activeGlobal = 0;
    this.activeBySession = new Map();
    this.queue = [];
  }

  acquire(sessionId, signal) {
    const id = requiredText(sessionId, "logicalSessionId", 512);
    if (this.#available(id)) return Promise.resolve(this.#claim(id));
    return new Promise((resolve, reject) => {
      const item = { id, resolve, reject, signal };
      item.timer = setTimeout(() => {
        this.queue = this.queue.filter((entry) => entry !== item);
        reject(contractError("QUERY_BUSY", "Project-code query concurrency limit is busy.", 429));
      }, this.queueTimeoutMs);
      item.abort = () => {
        clearTimeout(item.timer);
        this.queue = this.queue.filter((entry) => entry !== item);
        const error = new Error("Project-code query was cancelled while queued.");
        error.name = "AbortError";
        reject(error);
      };
      signal?.addEventListener("abort", item.abort, { once: true });
      this.queue.push(item);
    });
  }

  #available(id) { return this.activeGlobal < this.global && (this.activeBySession.get(id) ?? 0) < this.perSession; }
  #claim(id) {
    this.activeGlobal += 1;
    this.activeBySession.set(id, (this.activeBySession.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeGlobal -= 1;
      const remaining = (this.activeBySession.get(id) ?? 1) - 1;
      if (remaining > 0) this.activeBySession.set(id, remaining); else this.activeBySession.delete(id);
      this.#drain();
    };
  }
  #drain() {
    for (const item of [...this.queue]) {
      if (!this.#available(item.id)) continue;
      this.queue = this.queue.filter((entry) => entry !== item);
      clearTimeout(item.timer);
      item.signal?.removeEventListener("abort", item.abort);
      item.resolve(this.#claim(item.id));
    }
  }
}

async function verifyToolsetEcho(receipt, snapshot, required) {
  if (!receipt) {
    if (required) throw contractError("TOOLSET_CONTRACT_UNRESOLVED", "This search surface requires a ToolsetValidationReceipt.", 503);
    return null;
  }
  await validateToolsetValidationReceipt(receipt);
  const echo = receipt.snapshotRef;
  const echoedId = echo?.receiptId;
  const echoedFingerprint = echo?.sourceFingerprint;
  if (echoedId !== snapshot.receiptId || echoedFingerprint !== snapshot.sourceFingerprint) {
    throw contractError("TOOLSET_SNAPSHOT_MISMATCH", "Toolset validation did not echo the authoritative Snapshot receipt and fingerprint.");
  }
  return toolsetValidationReceiptRef(receipt);
}

function initialExecutionState(timeoutMs) {
  return {
    stage: "queue", outcome: "success", errorCode: null, layers: [], rejectedPaths: [],
    latency: { totalMs: 0, bindingVerifyMs: 0, snapshotVerifyMs: 0, toolsetVerifyMs: 0, isolationPrepareMs: 0, queueMs: 0, layerMs: { L0: 0, L1: 0, L2: 0, L3: 0 }, fusionMs: 0, cleanupMs: 0 },
    cancellation: { requested: false, observed: false, stage: null, reasonCode: null },
    timeout: { budgetMs: timeoutMs, timedOut: false, stage: null }
  };
}

function layerFact(layer, status, values = {}) {
  return Object.freeze({
    layer, status, skippedReason: values.skippedReason ?? null, degradedReason: values.degradedReason ?? null,
    candidateCount: values.candidateCount ?? 0, resultCount: values.resultCount ?? 0,
    latencyMs: values.latencyMs ?? 0, indexHit: values.indexHit ?? false, isolationRequired: values.isolationRequired ?? false
  });
}

function success(results, isolation, outcome = "success") { return { results, isolation, outcome, errorCode: outcome === "success" ? null : "SHALLOW_LAYER_DEGRADED" }; }

function fileResults(candidates, needle, limit) {
  return candidates.filter((entry) => entry.path.toLocaleLowerCase("en-US").includes(needle)).slice(0, limit)
    .map((entry) => ({ path: entry.path, line: 1, symbol: null, kind: "file", score: basenameScore(entry.path, needle), snippet: "" }));
}

function parseRgJson(stdout) {
  const results = [];
  for (const line of String(stdout).split("\n")) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "match") continue;
    const data = event.data;
    const path = data.path?.text?.normalize("NFC").replace(/^\.\//, "");
    if (!path) continue;
    results.push({ path, line: data.line_number ?? 1, symbol: null, kind: "text", score: 1, snippet: singleLine(data.lines?.text ?? "") });
  }
  return deduplicate(results);
}

function sanitizeSemanticResults(results, limit) {
  return results.slice(0, limit).map((entry) => ({
    path: String(entry.path).normalize("NFC"), line: Math.max(1, Number(entry.line) || 1),
    symbol: entry.symbol == null ? null : String(entry.symbol).slice(0, 256), kind: resultKinds.has(entry.kind) ? entry.kind : "semantic",
    score: Math.max(0, Math.min(1, Number(entry.score) || 0)), snippet: singleLine(entry.snippet ?? "")
  }));
}

function summarizeResults(results) {
  const kindCounts = {};
  for (const result of results) if (resultKinds.has(result.kind)) kindCounts[result.kind] = (kindCounts[result.kind] ?? 0) + 1;
  const top = results.reduce((score, result) => Math.max(score, result.score), 0);
  return {
    count: results.length, truncated: false, kindCounts,
    topScoreBand: results.length === 0 ? "none" : top >= 0.85 ? "high" : top >= 0.5 ? "medium" : "low",
    resultDigest: hashCanonical(results)
  };
}

function indexVersion(layers) {
  const l2 = layers.some((fact) => fact.layer === "L2" && ["executed", "degraded"].includes(fact.status));
  const l3 = layers.some((fact) => fact.layer === "L3" && fact.status === "executed");
  return { catalogSchema: 1, textSymbolSchema: l2 ? 5 : null, semanticSchema: l3 ? 1 : null, generationHashes: [] };
}

function candidateCategories(snapshot, layers) {
  const categories = new Set(["tracked_baseline"]);
  for (const entry of snapshot.overlayEntries ?? []) {
    if (entry.state === "add") categories.add("dirty_added");
    else if (entry.state === "modify" || entry.state === "typechange") categories.add("dirty_modified");
    else if (entry.state === "rename") categories.add("dirty_renamed");
    else if (entry.state === "tombstone") categories.add("dirty_deleted");
  }
  if (layers.some((fact) => fact.layer === "L1")) categories.add("language_catalog");
  if (layers.some((fact) => fact.layer === "L2")) { categories.add("text_posting"); categories.add("symbol"); }
  if (layers.some((fact) => fact.layer === "L3")) categories.add("semantic");
  return [...categories];
}

function evidenceRefs(snapshot, layers) {
  return [
    { type: "artifact", locatorHash: sha256Hex(Buffer.from(snapshot.artifactRef.artifactId)), contentHash: snapshot.artifactRef.contentHash },
    ...layers.map((fact) => ({ type: "local_result", locatorHash: hashCanonical({ layer: fact.layer, status: fact.status }), contentHash: null }))
  ];
}

function assertReceiptIdentity(receipt, session) {
  for (const field of ["workId", "taskId", "logicalSessionId"]) {
    if (receipt[field] !== session?.[field]) throw contractError("SNAPSHOT_CONTRACT_MISMATCH", `Snapshot ${field} does not match the authenticated Session.`);
  }
}

function validateQuery(value) {
  const query = typeof value === "string" ? value.normalize("NFC") : "";
  if (query.length < 1 || [...query].length > 500 || query.includes("\0")) throw contractError("QUERY_INVALID", "Search query must contain 1 to 500 Unicode scalar values.", 400);
  return query;
}

function validateFilters(languages, kinds) {
  const normalize = (value, field) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 32 || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw contractError("UNSUPPORTED_OPTION", `${field} must be an array of at most 32 non-empty strings.`, 400);
    }
    return [...new Set(value.map((entry) => entry.trim().toLocaleLowerCase("en-US")))];
  };
  const languageValues = normalize(languages, "languages");
  const kindValues = normalize(kinds, "kinds");
  if (kindValues.some((kind) => !resultKinds.has(kind))) throw contractError("UNSUPPORTED_OPTION", "kinds contains an unsupported result kind.", 400);
  return { languages: new Set(languageValues), kinds: new Set(kindValues) };
}

function validatePaths(paths) {
  if (paths === undefined) return [];
  if (!Array.isArray(paths) || paths.length > 100 || paths.some((path) => typeof path !== "string" || !path)) {
    throw contractError("UNSUPPORTED_OPTION", "paths must be an array of at most 100 non-empty strings.", 400);
  }
  return [...new Set(paths)];
}

async function readLineWindow(handle, options) {
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const lines = [];
  let pending = "";
  let currentLine = 1;
  let position = 0;
  let outputBytes = 0;
  let reachedEof = false;
  let truncatedReason = null;

  const capture = (value) => {
    if (currentLine < options.startLine) return true;
    const remaining = options.maxBytes - outputBytes;
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > remaining) {
      lines.push(truncateUtf8(value, remaining));
      outputBytes = options.maxBytes;
      truncatedReason = "output_bytes";
      return false;
    }
    lines.push(value);
    outputBytes += bytes;
    if (lines.length >= options.lineCount) {
      truncatedReason = "line_count";
      return false;
    }
    return true;
  };

  while (!truncatedReason && position < options.size && position < options.maxScanBytes) {
    if (options.signal?.aborted) {
      const error = new Error("Project-code point read was cancelled.");
      error.name = "AbortError";
      error.code = "QUERY_CANCELLED";
      throw error;
    }
    const requested = Math.min(chunk.length, options.size - position, options.maxScanBytes - position);
    const { bytesRead } = await handle.read(chunk, 0, requested, position);
    if (bytesRead === 0) { reachedEof = true; break; }
    position += bytesRead;
    pending += decoder.write(chunk.subarray(0, bytesRead));
    let newline;
    while (!truncatedReason && (newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (!capture(line)) break;
      currentLine += 1;
    }
    if (!truncatedReason && currentLine >= options.startLine && Buffer.byteLength(pending, "utf8") > options.maxBytes - outputBytes) {
      capture(pending);
    }
  }

  if (!truncatedReason && position >= options.size) {
    pending += decoder.end();
    reachedEof = true;
    if (pending.length > 0 && currentLine >= options.startLine) capture(pending.replace(/\r$/, ""));
  }
  if (!truncatedReason && !reachedEof && position >= options.maxScanBytes) {
    if (currentLine < options.startLine) {
      throw contractError("POINT_READ_SCAN_LIMIT", "The requested start line exceeds the point-read scan budget.", 413);
    }
    truncatedReason = "scan_bytes";
  }
  return { lines, eof: reachedEof && truncatedReason !== "line_count" && truncatedReason !== "output_bytes", truncatedReason };
}

function truncateUtf8(value, maxBytes) {
  if (maxBytes <= 0) return "";
  const source = Buffer.from(value, "utf8");
  if (source.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (source[end] & 0b11000000) === 0b10000000) end -= 1;
  return source.subarray(0, end).toString("utf8");
}

function normalizeMode(value) {
  const mode = value ?? "auto";
  if (!["auto", "exact", "files", "symbols", "semantic"].includes(mode)) throw contractError("UNSUPPORTED_OPTION", "Unsupported project-code search mode.", 400);
  return mode;
}

function planAutoQuery(query) {
  const value = String(query);
  if (/["'`{}();]|\.[A-Za-z0-9]{1,8}\b|[/\\]/u.test(value)) return "exact";
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value)) return "symbol";
  return "lexical";
}

function normalizeInteger(value, fallback, minimum, maximum, field) {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw contractError("UNSUPPORTED_OPTION", `${field} must be an integer from ${minimum} to ${maximum}.`, 400);
  return number;
}

function requiredText(value, field, maxLength = 512) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength) throw contractError("QUERY_INVALID", `${field} is required.`, 400);
  return text;
}

function deduplicate(results) {
  const seen = new Set();
  return results.filter((result) => {
    const key = `${result.path}\0${result.line}\0${result.symbol}\0${result.kind}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).map(normalizeResult);
}

function lruSet(map, key, value, maximum) {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) map.delete(map.keys().next().value);
}

function normalizeResult(result) { return { ...result, snippet: singleLine(result.snippet), score: Math.max(0, Math.min(1, result.score)) }; }
function singleLine(value) { return String(value).replace(/[\r\n]+/g, " ").trim().slice(0, 240); }
function basenameScore(path, needle) { return path.split("/").at(-1).toLocaleLowerCase("en-US").includes(needle) ? 0.95 : 0.75; }
function elapsed(started) { return Math.max(0, Number((performance.now() - started).toFixed(3))); }
function minimalSearchEnvironment() { return { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NO_PROXY: "*", no_proxy: "*" }; }
function isExpectedSearchError(error) { return typeof error?.code === "string" && /^(?:DATA_ROOT_|RUN_|SEMANTIC_|TOOLSET_|SNAPSHOT_|SOURCE_|PATH_|QUERY_|RECEIPT_)/.test(error.code); }
function assertClosedInput(input, allowed, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw contractError("QUERY_INVALID", `Project-code ${label} input must be an object.`, 400);
  for (const field of Object.keys(input)) if (!allowed.has(field)) throw contractError("UNSUPPORTED_OPTION", `Unknown project-code ${label} field: ${field}.`, 400);
}
