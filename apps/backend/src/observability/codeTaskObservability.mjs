import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DependencyContractManifest, codedError } from "./dependencyContractManifest.mjs";

export const CODE_TASK_OBSERVATION_SCHEMA_VERSION = 3;
export const CODE_TASK_REPORT_SCHEMA_VERSION = 4;
export const CODE_TASK_ANALYSIS_VERSION = "ct-obs-code-task-r4-a1";
export const INTERVAL_CLASSES = Object.freeze([
  "host.queue", "session.readiness", "worktree.readiness", "context.assembly", "provider.queue",
  "provider.model_sampling", "provider.opaque", "tool.dispatch", "tool.execute", "tool.result_serialization",
  "process.test", "process.build", "process.search", "process.version_control", "process.service_start",
  "process.cleanup", "artifact.operation", "user.wait", "approval.wait", "recovery.retry"
]);

const TERMINAL_EVENTS = new Set(["turn.execution.completed", "turn.execution.failed", "turn.execution.cancelled"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out", "abandoned"]);
const OPERATION_KINDS = new Set(["isolated_run", "tool_call", "operation", "receipt"]);
const SOURCE_RECEIPT_KINDS = new Set(["repository_source_snapshot", "toolset_validation", "search"]);
const RUN_RECEIPT_SCHEMA_VERSION = 6;
const TOOLSET_VALIDATION_RECEIPT_SCHEMA_VERSION = 3;
const DROP_REASONS = new Set(["sampling", "backpressure", "quota", "data_root_unavailable", "producer_gap", "unknown"]);
const SAFE_ATTRIBUTE_KEYS = new Set([
  "phase", "spanKey", "intervalClass", "operation", "operationSet", "classificationSource",
  "classificationConfidence", "attempt", "retryGroupId", "terminalStatus", "providerCapabilityClass",
  "staticSystemBytes", "artifactIndexBytes", "materializedToolCount", "toolSchemaBytes",
  "repeatedDeliverySurfaceCount", "toolSearchCount", "toolLoadCount", "inputTokens", "cachedInputTokens",
  "deliverySurfaceFingerprint", "metricCompleteness", "dropReason", "droppedCount", "clockResolutionNano",
  "durationPrecision", "searchExecuted", "status", "errorCode"
]);
const SAFE_SCALAR_MAX = 256;

export class CodeTaskObservabilityService {
  constructor({ store, environment = "development", dataRootResolver, resolveArtifactPin, now = () => new Date(),
    quotaBytes, rawTtlDays, summaryTtlDays, maxCleanupEntries = 500, beforeLegacyCutover = null } = {}) {
    if (!store?.selectOne) throw new Error("CodeTaskObservabilityService requires a Corptie Store.");
    if (!new Set(["development", "production", "test"]).has(environment)) throw new Error("Invalid observability environment.");
    this.store = store;
    this.environment = environment;
    this.dataRootResolver = dataRootResolver;
    this.now = now;
    this.quotaBytes = quotaBytes ?? (environment === "production" ? 20 * 1024 ** 3 : 2 * 1024 ** 3);
    this.rawTtlDays = rawTtlDays ?? (environment === "production" ? 30 : 3);
    this.summaryTtlDays = summaryTtlDays ?? (environment === "production" ? 180 : 30);
    this.maxCleanupEntries = Math.min(500, Math.max(1, maxCleanupEntries));
    this.manifest = new DependencyContractManifest({ resolveArtifactPin });
    this.beforeLegacyCutover = beforeLegacyCutover;
    this.rawStore = null;
    this.rawCaptureStatus = "not_initialized";
    this.pendingObservations = [];
    this.pendingFingerprints = new Map();
    this.pendingFlushScheduled = false;
    this.persistenceError = null;
  }

  initialize() {
    if (!this.store.db) throw new Error("CodeTaskObservabilityService requires an initialized Corptie Store.");
    this.#initializeSchema();
    const dependencyManifest = this.manifest.verify();
    try {
      const configuredRoot = typeof this.dataRootResolver === "function" ? this.dataRootResolver() : null;
      this.rawStore = new ExternalObservationStore({ configuredRoot, environment: this.environment,
        quotaBytes: this.quotaBytes, rawTtlDays: this.rawTtlDays, maxCleanupEntries: this.maxCleanupEntries, now: this.now });
      this.rawStore.initialize();
      this.rawCaptureStatus = "available";
    } catch (error) {
      this.rawStore = null;
      this.rawCaptureStatus = "data_root_unavailable";
      this.initializationDiagnostic = { code: error.code ?? "OBSERVATION_DATA_ROOT_UNAVAILABLE" };
    }
    this.cleanupCompactSummaries();
    return { schemaVersion: CODE_TASK_REPORT_SCHEMA_VERSION, analysisVersion: CODE_TASK_ANALYSIS_VERSION,
      dependencyManifest, rawCaptureStatus: this.rawCaptureStatus,
      retention: { rawTtlDays: this.rawTtlDays, summaryTtlDays: this.summaryTtlDays, quotaBytes: this.quotaBytes } };
  }

  ingestProviderEvent(context = {}) {
    const envelope = providerObservationEnvelope(context);
    if (!envelope) return { state: "skipped", reason: "event_without_turn" };
    const receipts = authoritativeProviderReceipts(context);
    if (!receipts.ok) return { state: "skipped", reason: receipts.reason };
    const result = this.recordObservation({ observation: envelope.observation(receipts), authority: receipts.authority });
    if (envelope.terminal && result.state !== "quarantined") {
      result.report = this.project(receipts.authority.turnExecutionReceipt.turnExecutionId);
      result.cutover = this.finalizeLegacyCutover(receipts.authority.turnExecutionReceipt.turnExecutionId);
    }
    return result;
  }

  recordObservation({ observation: input, authority }) {
    if (this.persistenceError) throw this.persistenceError;
    const normalized = normalizeObservation(input, authority, this.manifest);
    const pendingFingerprint = this.pendingFingerprints.get(normalized.observationId);
    if (pendingFingerprint) {
      if (pendingFingerprint !== normalized.idempotencyFingerprint) {
        throw codedError("OBSERVATION_ID_CONFLICT", "The Observation id was replayed with different canonical content.", 409);
      }
      return { state: "duplicate", observationId: normalized.observationId };
    }
    const existing = this.store.selectOne(
      "SELECT canonical_fingerprint FROM observation_correlation_index WHERE observation_id=?", [normalized.observationId]
    );
    if (existing) {
      if (existing.canonical_fingerprint !== normalized.idempotencyFingerprint) {
        throw codedError("OBSERVATION_ID_CONFLICT", "The Observation id was replayed with different canonical content.", 409);
      }
      return { state: "duplicate", observationId: normalized.observationId };
    }
    const nowIso = this.now().toISOString();
    this.#ensureExecution(normalized, authority, nowIso);
    if (!this.rawStore) {
      this.#recordDrop(normalized.turnExecutionId, "data_root_unavailable", 1, nowIso);
      return { state: "quarantined", observationId: normalized.observationId, rawCaptureStatus: "data_root_unavailable" };
    }
    let pointer;
    try {
      pointer = this.rawStore.reserve(normalized.turnExecutionId, normalized);
    } catch (error) {
      const reason = error.code === "OBSERVATION_RAW_QUOTA_EXCEEDED" ? "quota" : "data_root_unavailable";
      this.#recordDrop(normalized.turnExecutionId, reason, 1, nowIso);
      return { state: "quarantined", observationId: normalized.observationId, rawCaptureStatus: reason };
    }
    this.pendingObservations.push({ normalized, pointer, nowIso });
    this.pendingFingerprints.set(normalized.observationId, normalized.idempotencyFingerprint);
    this.#schedulePendingFlush();
    return { state: "accepted", observationId: normalized.observationId, droppedAttributeCount: normalized.droppedAttributeCount };
  }

  project(turnExecutionId) {
    const row = this.#executionRow(turnExecutionId);
    const observations = this.#readObservations(row);
    const projection = projectTimeline(observations, row);
    const contextGrowth = this.#contextGrowth(row, observations);
    const report = buildReport(row, projection, contextGrowth, this.rawCaptureStatus);
    const summaryHash = sha256(stableStringify(report));
    const completeReport = { ...report, summaryHash };
    const nowIso = this.now().toISOString();
    this.store.db.run(
      `INSERT INTO observation_turn_summaries (
        turn_execution_id,logical_session_id,turn_id,task_id,objective_id,repository_id,worktree_id,
        finalized,ended_at,analysis_version,summary_hash,summary_json,computed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(turn_execution_id) DO UPDATE SET finalized=excluded.finalized,ended_at=excluded.ended_at,
        analysis_version=excluded.analysis_version,summary_hash=excluded.summary_hash,summary_json=excluded.summary_json,
        computed_at=excluded.computed_at`,
      [row.turn_execution_id, row.logical_session_id, row.turn_id, row.task_id, row.objective_id,
        row.repository_id, row.worktree_id, projection.finalized ? 1 : 0, projection.endedAt,
        CODE_TASK_ANALYSIS_VERSION, summaryHash, JSON.stringify(completeReport), nowIso]
    );
    this.store.db.run(
      "UPDATE observation_turn_executions SET projection_state=?, status=?, updated_at=? WHERE turn_execution_id=?",
      [projection.finalized ? "final" : "partial", projection.terminalStatus ?? "running", nowIso, turnExecutionId]
    );
    return completeReport;
  }

  summary(turnExecutionId, context = {}) {
    const row = this.#executionRow(turnExecutionId);
    this.#authorize(row, context, false);
    const summary = this.store.selectOne("SELECT summary_json FROM observation_turn_summaries WHERE turn_execution_id=?", [turnExecutionId]);
    return summary ? JSON.parse(summary.summary_json) : this.project(turnExecutionId);
  }

  latestSummary(logicalSessionId, context = {}) {
    const row = this.store.selectOne(
      `SELECT s.summary_json,e.* FROM observation_turn_summaries s JOIN observation_turn_executions e
       ON e.turn_execution_id=s.turn_execution_id WHERE e.logical_session_id=?
       ORDER BY COALESCE(s.ended_at,s.computed_at) DESC,e.turn_execution_id DESC LIMIT 1`, [logicalSessionId]
    );
    if (!row) return null;
    this.#authorize(row, context, false);
    return JSON.parse(row.summary_json);
  }

  executions(logicalSessionId, turnId, context = {}) {
    const rows = this.store.selectAll(
      "SELECT * FROM observation_turn_executions WHERE logical_session_id=? AND turn_id=? ORDER BY created_at,turn_execution_id",
      [logicalSessionId, turnId]
    );
    return rows.map((row) => { this.#authorize(row, context, false); return executionProjection(row); });
  }

  executionReceiptForTurn(logicalSessionId, turnId, context = {}) {
    const row = this.store.selectOne(
      `SELECT * FROM observation_turn_executions WHERE logical_session_id=? AND turn_id=?
       ORDER BY created_at DESC,turn_execution_id DESC LIMIT 1`, [logicalSessionId, turnId]
    );
    if (!row) return null;
    this.#authorize(row, context, false);
    return this.#executionReceipt(row);
  }

  executionReceipt(turnExecutionId, context = {}) {
    const row = this.#executionRow(turnExecutionId);
    this.#authorize(row, context, false);
    return this.#executionReceipt(row);
  }

  terminalObservation(turnExecutionId, context = {}) {
    const row = this.#executionRow(turnExecutionId);
    this.#authorize(row, context, true);
    return this.#readObservations(row).findLast((item) => TERMINAL_EVENTS.has(item.eventType)) ?? null;
  }

  exportReceipt(turnExecutionId, context = {}) {
    const exported = this.export(turnExecutionId, "corptie-json-v4", context);
    const terminal = exported.timeline.findLast((item) => item.kind === "event" && TERMINAL_EVENTS.has(item.eventType));
    if (!terminal) throw codedError("OBSERVATION_TERMINAL_MISSING", "A terminal authoritative Observation is required.", 409);
    const report = exported.report;
    const wallClockMs = report.wall?.wallClockMs;
    const unattributedMs = report.unattributed?.durationMs ?? null;
    const payload = {
      schemaVersion: 4, analysisVersion: report.analysisVersion, identity: report.identity,
      sourceIdentity: report.sourceIdentity, versions: report.versions, wall: report.wall,
      wallPartition: report.wallPartition,
      inclusive: { ...report.inclusive,
        modelInclusiveMs: report.inclusive?.["provider.model_sampling"] ?? null,
        toolInclusiveMs: report.inclusive?.["tool.execute"] ?? null,
        modelInvocationCount: 0, samplingCount: 0, toolCallCount: 0 },
      unattributed: { unattributedMs, ratio: wallClockMs ? unattributedMs / wallClockMs : 0 },
      contextGrowth: report.contextGrowth, completeness: report.completeness,
      diagnostics: report.diagnostics,
      samplePolicy: { ...report.samplePolicy, observabilityLevel: "event-stream" },
      sourceReceiptIds: [terminal.observationId], summaryHash: null
    };
    const { summaryHash: _, ...unsigned } = payload;
    payload.summaryHash = sha256(stableStringify(unsigned));
    return Object.freeze(payload);
  }

  timeline(turnExecutionId, { cursor, limit = 200, context = {} } = {}) {
    const row = this.#executionRow(turnExecutionId);
    this.#authorize(row, context, true);
    const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
    const offset = decodeCursor(cursor);
    const observations = this.#readObservations(row);
    const projected = pagedTimeline(observations, row, offset, boundedLimit);
    const page = projected.items;
    return { schemaVersion: 4, turnExecutionId, items: page,
      nextCursor: offset + page.length < projected.total ? encodeCursor(offset + page.length) : null,
      completeness: projected.completeness };
  }

  spans(turnExecutionId, options = {}) {
    const row = this.#executionRow(turnExecutionId);
    this.#authorize(row, options.context ?? {}, true);
    const boundedLimit = Math.max(1, Math.min(1000, Number(options.limit) || 200));
    const offset = decodeCursor(options.cursor);
    const observations = this.#readObservations(row);
    const paired = pairSpans(observations, null, observations.at(-1)?.observedAtUnixNano ?? null, []);
    const ordered = isOrdered(paired.spans, compareTimeline) ? paired.spans : paired.spans.sort(compareTimeline);
    const items = ordered.slice(offset, offset + boundedLimit).map((span) => ({ kind: "span", ...span }));
    return { schemaVersion: 4, turnExecutionId, items,
      nextCursor: offset + items.length < ordered.length ? encodeCursor(offset + items.length) : null,
      completeness: lightweightCompleteness(observations, row) };
  }

  correlations(turnExecutionId, context = {}) {
    const row = this.#executionRow(turnExecutionId);
    this.#authorize(row, context, false);
    return { schemaVersion: 4, turnExecutionId, items: this.store.selectAll(
      `SELECT observation_id AS observationId,operation_kind AS operationKind,operation_id AS operationId,run_id AS runId
       FROM observation_correlation_index WHERE turn_execution_id=? ORDER BY observed_at_unix_nano,producer_sequence,observation_id`, [turnExecutionId]
    ).map((item) => ({ ...item, operationRef: item.operationKind ? { kind: item.operationKind, id: item.operationId } : null,
      operationKind: undefined, operationId: undefined })) };
  }

  export(turnExecutionId, format = "corptie-json-v4", context = {}) {
    const row = this.#executionRow(turnExecutionId);
    this.#authorize(row, context, true);
    const report = this.summary(turnExecutionId, context);
    const projection = projectTimeline(this.#readObservations(row), row);
    if (format === "corptie-json-v4") return { schemaVersion: 4, format, report, timeline: projection.timeline };
    if (format === "otlp") return toOtlp(report, projection.spans);
    throw codedError("OBSERVATION_EXPORT_FORMAT_UNSUPPORTED", "Unsupported observability export format.", 400);
  }

  cleanup() {
    this.#flushPending();
    const raw = this.rawStore ? this.rawStore.cleanup() : { deleted: 0, status: "data_root_unavailable" };
    return { raw, compactDeleted: this.cleanupCompactSummaries() };
  }

  flush() {
    this.#flushPending();
  }

  #executionReceipt(row) {
    const observations = this.#readObservations(row);
    const ref = observations.flatMap((item) => item.receiptRefs ?? [])
      .find((item) => item.kind === "turn_execution");
    if (!ref?.receiptId) throw codedError("OBSERVATION_EXECUTION_RECEIPT_MISSING", "Turn execution receipt is unavailable.", 409);
    return { schemaVersion: 1, receiptId: ref.receiptId, turnExecutionId: row.turn_execution_id,
      turnId: row.turn_id, logicalSessionId: row.logical_session_id,
      providerBindingId: row.provider_binding_id, bindingGeneration: Number(row.binding_generation),
      status: row.status, projectionState: row.projection_state };
  }

  cleanupCompactSummaries() {
    const cutoff = new Date(this.now().getTime() - this.summaryTtlDays * 86_400_000).toISOString();
    const rows = this.store.selectAll(
      "SELECT turn_execution_id FROM observation_turn_summaries WHERE computed_at<? ORDER BY computed_at LIMIT ?",
      [cutoff, this.maxCleanupEntries]
    );
    for (const row of rows) this.store.db.run("DELETE FROM observation_turn_summaries WHERE turn_execution_id=?", [row.turn_execution_id]);
    return rows.length;
  }

  finalizeLegacyCutover(turnExecutionId) {
    this.#flushPending();
    const migration = this.store.selectOne(
      "SELECT state FROM observation_schema_migrations WHERE migration_id='code_task_observability_v4'"
    );
    if (migration?.state === "completed") return { state: "completed", idempotentReplay: true };
    const proof = this.store.selectOne(
      `SELECT e.turn_execution_id FROM observation_turn_executions e
       JOIN observation_turn_summaries s ON s.turn_execution_id=e.turn_execution_id
       JOIN observation_correlation_index c ON c.turn_execution_id=e.turn_execution_id
       WHERE e.turn_execution_id=? AND s.finalized=1 AND c.producer='provider_event_ingestion' LIMIT 1`,
      [turnExecutionId]
    );
    if (!proof) throw codedError("OBSERVATION_CUTOVER_PROOF_REQUIRED", "A finalized production-path observation is required before legacy cutover.", 409);
    const timestamp = this.now().toISOString();
    this.store.db.run("BEGIN IMMEDIATE");
    try {
      if (typeof this.beforeLegacyCutover === "function") this.beforeLegacyCutover({ turnExecutionId });
      this.store.db.run("DROP TABLE IF EXISTS turn_time_summaries");
      this.store.db.run("DROP TABLE IF EXISTS turn_trace_runs");
      this.store.db.run(
        `UPDATE observation_schema_migrations SET state='completed',proof_turn_execution_id=?,completed_at=?,updated_at=?
         WHERE migration_id='code_task_observability_v4'`,
        [turnExecutionId, timestamp, timestamp]
      );
      this.store.db.run(
        `INSERT INTO observation_migration_audit (audit_id,migration_id,event,turn_execution_id,created_at)
         VALUES (?,?,?,?,?)`,
        [`observation-cutover:${sha256(turnExecutionId)}`, "code_task_observability_v4", "legacy_cutover_completed", turnExecutionId, timestamp]
      );
      this.store.db.run("COMMIT");
      return { state: "completed", idempotentReplay: false };
    } catch (error) {
      this.store.db.run("ROLLBACK");
      throw error;
    }
  }

  #initializeSchema() {
    const timestamp = this.now().toISOString();
    this.store.db.run("BEGIN IMMEDIATE");
    try {
      this.store.db.run(`
      CREATE TABLE IF NOT EXISTS observation_turn_executions (
        turn_execution_id TEXT PRIMARY KEY, logical_session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        objective_id TEXT, task_id TEXT, provider_binding_id TEXT NOT NULL, binding_generation INTEGER NOT NULL,
        repository_id TEXT, worktree_id TEXT, source_commit_oid TEXT, source_tree_oid TEXT,
        status TEXT NOT NULL DEFAULT 'running', projection_state TEXT NOT NULL DEFAULT 'partial',
        observation_count INTEGER NOT NULL DEFAULT 0, dropped_event_count INTEGER NOT NULL DEFAULT 0,
        dropped_reasons_json TEXT NOT NULL DEFAULT '{}', raw_manifest_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(logical_session_id,provider_binding_id,binding_generation,turn_id,turn_execution_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observation_execution_session_turn
        ON observation_turn_executions(logical_session_id,turn_id,created_at);
      CREATE TABLE IF NOT EXISTS observation_correlation_index (
        observation_id TEXT PRIMARY KEY, turn_execution_id TEXT NOT NULL, logical_session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL, producer TEXT NOT NULL, producer_sequence INTEGER NOT NULL,
        observed_at_unix_nano TEXT NOT NULL, operation_kind TEXT, operation_id TEXT, run_id TEXT,
        canonical_fingerprint TEXT NOT NULL, raw_offset INTEGER NOT NULL, raw_length INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(turn_execution_id) REFERENCES observation_turn_executions(turn_execution_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_observation_correlation_turn
        ON observation_correlation_index(turn_execution_id,observed_at_unix_nano,producer_sequence,observation_id);
      CREATE TABLE IF NOT EXISTS observation_turn_summaries (
        turn_execution_id TEXT PRIMARY KEY, logical_session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        task_id TEXT, objective_id TEXT, repository_id TEXT, worktree_id TEXT, finalized INTEGER NOT NULL,
        ended_at TEXT, analysis_version TEXT NOT NULL, summary_hash TEXT NOT NULL, summary_json TEXT NOT NULL,
        computed_at TEXT NOT NULL,
        FOREIGN KEY(turn_execution_id) REFERENCES observation_turn_executions(turn_execution_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_observation_summary_session ON observation_turn_summaries(logical_session_id,ended_at);
      CREATE INDEX IF NOT EXISTS idx_observation_summary_task ON observation_turn_summaries(task_id,ended_at);
      CREATE TABLE IF NOT EXISTS observation_schema_migrations (
        migration_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('ready','completed')),
        proof_turn_execution_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observation_migration_audit (
        audit_id TEXT PRIMARY KEY, migration_id TEXT NOT NULL, event TEXT NOT NULL,
        turn_execution_id TEXT, created_at TEXT NOT NULL
      );
      `);
      this.store.db.run(
        `INSERT INTO observation_schema_migrations (migration_id,state,started_at,updated_at)
         VALUES ('code_task_observability_v4','ready',?,?) ON CONFLICT(migration_id) DO NOTHING`,
        [timestamp, timestamp]
      );
      this.store.db.run(
        `INSERT INTO observation_migration_audit (audit_id,migration_id,event,created_at)
         VALUES ('code-task-observability-v4-ready','code_task_observability_v4','new_path_ready',?)
         ON CONFLICT(audit_id) DO NOTHING`,
        [timestamp]
      );
      this.store.db.run("COMMIT");
    } catch (error) {
      this.store.db.run("ROLLBACK");
      throw error;
    }
  }

  #ensureExecution(observation, authority, nowIso) {
    const existing = this.store.selectOne("SELECT * FROM observation_turn_executions WHERE turn_execution_id=?", [observation.turnExecutionId]);
    if (existing) {
      if (existing.logical_session_id !== observation.identity.logicalSessionId || existing.turn_id !== observation.identity.turnId
        || existing.provider_binding_id !== observation.identity.providerBindingId
        || Number(existing.binding_generation) !== observation.identity.bindingGeneration) {
        throw codedError("OBSERVATION_IDENTITY_CHAIN_MISMATCH", "Turn execution identity conflicts with its existing projection.", 409);
      }
      return;
    }
    this.store.db.run(
      `INSERT INTO observation_turn_executions (
        turn_execution_id,logical_session_id,turn_id,objective_id,task_id,provider_binding_id,binding_generation,
        repository_id,worktree_id,source_commit_oid,source_tree_oid,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [observation.turnExecutionId, observation.identity.logicalSessionId, observation.identity.turnId,
        observation.identity.objectiveId ?? null, observation.identity.taskId ?? null,
        observation.identity.providerBindingId, observation.identity.bindingGeneration,
        observation.identity.repositoryId ?? null, observation.identity.worktreeId ?? null,
        observation.sourceIdentity?.sourceCommitOid ?? authority.startupBindingReceipt?.sourceCommitOid ?? null,
        observation.sourceIdentity?.sourceTreeOid ?? authority.startupBindingReceipt?.sourceTreeOid ?? null, nowIso, nowIso]
    );
  }

  #recordDrop(turnExecutionId, reason, count, nowIso) {
    const row = this.store.selectOne("SELECT dropped_reasons_json FROM observation_turn_executions WHERE turn_execution_id=?", [turnExecutionId]);
    if (!row) return;
    const reasons = parseJson(row.dropped_reasons_json, {}); reasons[reason] = Number(reasons[reason] ?? 0) + count;
    this.store.db.run(
      "UPDATE observation_turn_executions SET dropped_event_count=dropped_event_count+?,dropped_reasons_json=?,updated_at=? WHERE turn_execution_id=?",
      [count, JSON.stringify(reasons), nowIso, turnExecutionId]
    );
  }

  #executionRow(turnExecutionId) {
    this.#flushPending();
    const row = this.store.selectOne("SELECT * FROM observation_turn_executions WHERE turn_execution_id=?", [turnExecutionId]);
    if (!row) throw codedError("TURN_EXECUTION_NOT_FOUND", "Turn execution not found.", 404);
    return row;
  }

  #schedulePendingFlush() {
    if (this.pendingFlushScheduled) return;
    this.pendingFlushScheduled = true;
    queueMicrotask(() => {
      this.pendingFlushScheduled = false;
      try {
        this.#flushPending();
      } catch (error) {
        this.persistenceError = error;
      }
    });
  }

  #flushPending() {
    if (this.persistenceError) throw this.persistenceError;
    if (this.pendingObservations.length === 0) return;
    const batch = this.pendingObservations.splice(0);
    try {
      for (const { pointer } of batch) this.rawStore.commit(pointer);
      this.store.runInTransaction(() => {
        for (const { normalized, pointer, nowIso } of batch) {
          this.store.db.run(
            `INSERT INTO observation_correlation_index (
              observation_id,turn_execution_id,logical_session_id,turn_id,producer,producer_sequence,observed_at_unix_nano,
              operation_kind,operation_id,run_id,canonical_fingerprint,raw_offset,raw_length,created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [normalized.observationId, normalized.turnExecutionId, normalized.identity.logicalSessionId, normalized.identity.turnId,
              normalized.producer, normalized.producerSequence, normalized.observedAtUnixNano,
              normalized.operationRef?.kind ?? null, normalized.operationRef?.id ?? null, normalized.runId ?? null,
              normalized.idempotencyFingerprint, pointer.offset, pointer.length, nowIso]
          );
          this.store.db.run(
            `UPDATE observation_turn_executions SET observation_count=observation_count+1, raw_manifest_json=?, updated_at=?
             WHERE turn_execution_id=?`,
            [JSON.stringify(pointer.manifest), nowIso, normalized.turnExecutionId]
          );
        }
      });
      for (const { normalized } of batch) this.pendingFingerprints.delete(normalized.observationId);
    } catch (error) {
      this.pendingObservations.unshift(...batch);
      this.persistenceError = error;
      throw error;
    }
  }

  #readObservations(row) {
    if (!this.rawStore) return [];
    const observations = this.rawStore.read(row.turn_execution_id);
    return isOrdered(observations, compareObservation) ? observations : observations.sort(compareObservation);
  }

  #authorize(row, context, raw) {
    if (context?.kind === "local_user") return;
    if (!context?.logicalSessionId) throw codedError("OBSERVATION_PERMISSION_DENIED", "Authenticated Session context is required.", 403);
    if (context.logicalSessionId !== row.logical_session_id) {
      if (!(context.taskId && context.taskId === row.task_id && context.canReadRelatedObservability === true)) {
        throw codedError("OBSERVATION_PERMISSION_DENIED", "The Session cannot read this observability scope.", 403);
      }
    }
    if (raw && context.canReadRawObservability !== true) {
      throw codedError("OBSERVATION_RAW_PERMISSION_DENIED", "Raw observability permission is required.", 403);
    }
  }

  #contextGrowth(row, observations) {
    const metrics = contextMetrics(observations);
    if (!metrics) return emptyContextGrowth();
    const previous = this.store.selectOne(
      `SELECT summary_json FROM observation_turn_summaries WHERE logical_session_id=? AND turn_execution_id<>?
       ORDER BY COALESCE(ended_at,computed_at) DESC LIMIT 1`, [row.logical_session_id, row.turn_execution_id]
    );
    const previousMetrics = previous ? JSON.parse(previous.summary_json).contextGrowth : null;
    const comparable = previousMetrics && previousMetrics.catalogVersion === metrics.catalogVersion
      && previousMetrics.providerCapabilityRevision === metrics.providerCapabilityRevision;
    return { ...metrics,
      contextBytesDeltaFromPreviousExecution: comparable && metrics.contextBytes != null && previousMetrics.contextBytes != null
        ? metrics.contextBytes - previousMetrics.contextBytes : null,
      toolSchemaBytesDeltaFromCatalogBaseline: comparable && metrics.toolSchemaBytes != null && previousMetrics.toolSchemaBytes != null
        ? metrics.toolSchemaBytes - previousMetrics.toolSchemaBytes : null,
      comparisonKey: comparable ? `${row.logical_session_id}:${metrics.catalogVersion}:${metrics.providerCapabilityRevision}` : null };
  }
}

class ExternalObservationStore {
  constructor({ configuredRoot, environment, quotaBytes, rawTtlDays, maxCleanupEntries, now }) {
    this.configuredRoot = configuredRoot; this.environment = environment; this.quotaBytes = quotaBytes;
    this.rawTtlDays = rawTtlDays; this.maxCleanupEntries = maxCleanupEntries; this.now = now;
  }
  initialize() {
    if (typeof this.configuredRoot !== "string" || !this.configuredRoot.trim()) throw storageError("OBSERVATION_DATA_ROOT_UNAVAILABLE");
    const resolved = realpathSync(resolve(this.configuredRoot));
    if (!resolved.startsWith(`/Volumes/${sep}`) && !resolved.startsWith("/Volumes/")) throw storageError("OBSERVATION_EXTERNAL_DATA_ROOT_REQUIRED");
    this.root = join(resolved, "observability", this.environment, "raw");
    mkdirSync(this.root, { recursive: true, mode: 0o700 }); chmodSync(this.root, 0o700);
    this.objectSizes = new Map();
    this.usageBytes = this.#scanUsage(); this.cleanup();
  }
  reserve(turnExecutionId, observation) {
    const path = this.#path(turnExecutionId); const data = `${stableStringify(observation)}\n`;
    const length = Buffer.byteLength(data);
    if (this.usageBytes + length > this.quotaBytes) throw storageError("OBSERVATION_RAW_QUOTA_EXCEEDED");
    const offset = this.objectSizes.get(path) ?? 0;
    this.objectSizes.set(path, offset + length);
    this.usageBytes += length;
    return { path, data, firstWrite: offset === 0, offset, length,
      manifest: { storage: "external_data_root", objectId: basename(path), byteLength: offset + length,
      rawTtlDays: this.rawTtlDays, quotaBytes: this.quotaBytes } };
  }
  commit(pointer) {
    appendFileSync(pointer.path, pointer.data, { encoding: "utf8", mode: 0o600 });
    if (!pointer.firstWrite) return;
    chmodSync(pointer.path, 0o600);
    const logicalNow = this.now();
    utimesSync(pointer.path, logicalNow, logicalNow);
  }
  read(turnExecutionId) {
    const path = this.#path(turnExecutionId); if (!existsSync(path)) return [];
    const data = readFileSync(path, "utf8"); const observations = [];
    let start = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data.charCodeAt(index) !== 10) continue;
      if (index > start) observations.push(JSON.parse(data.slice(start, index)));
      start = index + 1;
    }
    if (start < data.length) observations.push(JSON.parse(data.slice(start)));
    return observations;
  }
  cleanup() {
    const cutoff = this.now().getTime() - this.rawTtlDays * 86_400_000; let deleted = 0;
    const entries = readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"));
    for (const entry of entries) {
      if (deleted >= this.maxCleanupEntries) break;
      const path = join(this.root, entry.name); const stat = statSync(path);
      if (stat.mtimeMs < cutoff) {
        unlinkSync(path);
        this.objectSizes.delete(path);
        this.usageBytes = Math.max(0, this.usageBytes - stat.size);
        deleted += 1;
      }
    }
    return { status: "completed", deleted, usageBytes: this.usageBytes, quotaBytes: this.quotaBytes };
  }
  #path(turnExecutionId) { return join(this.root, `${sha256(turnExecutionId)}.ndjson`); }
  #scanUsage() {
    return readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isFile()).reduce((total, entry) => {
      const path = join(this.root, entry.name);
      const size = statSync(path).size;
      this.objectSizes.set(path, size);
      return total + size;
    }, 0);
  }
}

export function authoritativeProviderReceipts({ event, binding, sessionEvent } = {}) {
  const startup = binding?.providerMetadata?.startupBindingReceipt ?? null;
  if (!startup) return { ok: false, reason: "startup_binding_receipt_unavailable" };
  if (startup.schemaVersion !== 2 || startup.status !== "ready" || !startup.startupOperationId || !startup.receiptHash) {
    return { ok: false, reason: "startup_binding_receipt_invalid" };
  }
  const mapping = binding?.providerMetadata?.startupProviderBindingMapping ?? null;
  const mappingValid = mapping?.startupProviderBindingId === startup.providerBindingId
    && mapping?.providerBindingId === binding.bindingId
    && mapping?.startupBindingGeneration === startup.bindingGeneration
    && mapping?.providerBindingGeneration === binding.routingVersion;
  if (startup.logicalSessionId !== binding.logicalSessionId
    || (!mappingValid && startup.providerBindingId !== binding.bindingId)
    || nullable(startup.worktreeId) !== nullable(binding.worktreeId)) {
    return { ok: false, reason: "startup_binding_receipt_scope_mismatch" };
  }
  const turnId = optionalId(event?.turnId, "turnId");
  if (!turnId) return { ok: false, reason: "event_without_turn" };
  const turnDigest = sha256(stableStringify({ startupOperationId: startup.startupOperationId,
    providerBindingId: startup.providerBindingId, bindingGeneration: startup.bindingGeneration, turnId }));
  const turnExecutionId = `turn_execution:${turnDigest.slice(0, 32)}`;
  const turnExecutionReceipt = Object.freeze({ schemaVersion: 1,
    receiptId: `turn_execution_receipt:${turnDigest.slice(0, 32)}`, turnExecutionId, turnId,
    logicalSessionId: startup.logicalSessionId, providerBindingId: startup.providerBindingId,
    bindingGeneration: startup.bindingGeneration, sourceSessionEventId: sessionEvent?.eventId ?? null });
  const identity = Object.freeze({ objectiveId: startup.objectiveId, taskId: startup.taskId,
    logicalSessionId: startup.logicalSessionId, providerBindingId: startup.providerBindingId,
    bindingGeneration: startup.bindingGeneration, repositoryId: startup.repositoryId,
    worktreeId: startup.worktreeId, turnId });
  const toolHostAppliedReceipt = binding?.providerMetadata?.toolHostAppliedReceipt ?? null;
  return { ok: true, authority: { identity, startupBindingReceipt: startup, turnExecutionReceipt, toolHostAppliedReceipt } };
}

function providerObservationEnvelope({ event, measurement, sessionEvent } = {}) {
  if (!event?.turnId) return null;
  const mapped = providerEventMapping(event);
  if (!mapped) return null;
  return { terminal: mapped.terminal === true, observation(receipts) {
    const { authority } = receipts; const startup = authority.startupBindingReceipt;
    const execution = authority.turnExecutionReceipt;
    const receiptRefs = [
      { kind: "startup_binding", receiptId: startup.startupOperationId, producer: "startup_binding", producerSchemaVersion: startup.schemaVersion },
      { kind: "turn_execution", receiptId: execution.receiptId, producer: "session_execution", producerSchemaVersion: execution.schemaVersion }
    ];
    const host = authority.toolHostAppliedReceipt;
    const versions = {};
    if (host) {
      receiptRefs.push({ kind: "tool_host_applied", receiptId: host.receiptId, producer: "tool_host", producerSchemaVersion: host.schemaVersion ?? 1 });
      versions.catalogVersion = host.appliedCatalogVersion ?? null;
      versions.desiredMaterializationVersion = host.requestedVersion ?? null;
      versions.appliedMaterializationVersion = host.appliedVersion ?? null;
      versions.providerCapabilityRevision = host.providerCapabilityRevision ?? null;
    }
    const observedAt = event.occurredAt ?? event.receivedAt;
    const sequence = event.providerSequence ?? sessionEvent?.sequence ?? 0;
    const operationRef = mapped.operationKind
      ? { kind: mapped.operationKind, id: event.itemId ?? event.providerEventId }
      : null;
    const safeAttributes = { ...mapped.safeAttributes };
    if (measurement && Number.isFinite(measurement.projectionStartedAtMs) && Number.isFinite(measurement.projectionEndedAtMs)) {
      safeAttributes.durationPrecision = "host_monotonic";
    }
    return { schemaVersion: 3,
      observationId: `observation:provider:${sha256(`${event.providerId}:${event.providerSessionId}:${event.providerEventId}:${mapped.eventType}`).slice(0, 40)}`,
      turnExecutionId: execution.turnExecutionId, runId: null, operationRef, identity: authority.identity,
      sourceIdentity: { sourceCommitOid: startup.sourceCommitOid ?? null, sourceTreeOid: startup.sourceTreeOid ?? null },
      versions, receiptRefs, producer: "provider_event_ingestion", producerEventId: event.providerEventId,
      eventType: mapped.eventType, observedAtUnixNano: isoToNano(observedAt), monotonicNano: null,
      clockDomainId: `provider:${event.providerId}`, sourceOccurredAtUnixNano: event.occurredAt ? isoToNano(event.occurredAt) : null,
      sourceClockQuality: event.occurredAt ? "bounded" : "unknown", producerSequence: sequence,
      safeAttributes, status: "accepted", errorCode: mapped.errorCode ?? null };
  } };
}

function providerEventMapping(event) {
  const spanKey = event.itemId ?? event.providerEventId;
  const interval = (eventType, intervalClass, operationKind = null) => ({ eventType, operationKind,
    safeAttributes: { spanKey, intervalClass, providerCapabilityClass: providerCapabilityClass(event) } });
  switch (event.type) {
    case "turn.started": return { eventType: "turn.execution.accepted", safeAttributes: { providerCapabilityClass: providerCapabilityClass(event) } };
    case "turn.completed": return { eventType: "turn.execution.completed", terminal: true, safeAttributes: { terminalStatus: "completed", providerCapabilityClass: providerCapabilityClass(event) } };
    case "turn.failed": return { eventType: "turn.execution.failed", terminal: true, errorCode: safeErrorCode(event), safeAttributes: { terminalStatus: "failed", providerCapabilityClass: providerCapabilityClass(event) } };
    case "turn.cancelled": return { eventType: "turn.execution.cancelled", terminal: true, safeAttributes: { terminalStatus: "cancelled", providerCapabilityClass: providerCapabilityClass(event) } };
    case "assistant.message.started": return interval("interval.started", "provider.model_sampling");
    case "assistant.message.completed": return interval("interval.completed", "provider.model_sampling");
    case "tool.started": return interval("interval.started", "tool.execute", "tool_call");
    case "tool.completed": return interval("interval.completed", "tool.execute", "tool_call");
    case "tool.failed": return { ...interval("interval.failed", "tool.execute", "tool_call"), errorCode: safeErrorCode(event) };
    case "approval.requested": return interval("interval.started", "approval.wait", "operation");
    case "approval.resolved": return interval("interval.completed", "approval.wait", "operation");
    case "usage.updated": return { eventType: "context.metrics", safeAttributes: providerContextMetrics(event) };
    default: return { eventType: "progress", safeAttributes: { providerCapabilityClass: providerCapabilityClass(event) } };
  }
}

function providerCapabilityClass(event) {
  const value = String(event.payload?.providerCapabilityClass ?? event.payload?.observabilityLevel ?? "opaque");
  return ["native", "event_stream", "boundary_only", "opaque"].includes(value) ? value : "opaque";
}
function providerContextMetrics(event) {
  const safe = { providerCapabilityClass: providerCapabilityClass(event) };
  for (const key of ["inputTokens", "cachedInputTokens", "staticSystemBytes", "artifactIndexBytes", "materializedToolCount", "toolSchemaBytes"]) {
    const value = event.payload?.[key]; if (Number.isSafeInteger(value) && value >= 0) safe[key] = value;
  }
  return safe;
}
function safeErrorCode(event) {
  const value = String(event.payload?.errorCode ?? event.payload?.code ?? "PROVIDER_EVENT_FAILED");
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "PROVIDER_EVENT_FAILED";
}
function isoToNano(value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw codedError("OBSERVATION_TIME_INVALID", "Provider event time is invalid.", 400);
  return String(BigInt(Math.trunc(milliseconds)) * 1_000_000n);
}

function normalizeObservation(input, authority, manifest) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw codedError("OBSERVATION_INVALID", "Observation must be an object.");
  rejectUnknown(input, ["schemaVersion", "observationId", "turnExecutionId", "runId", "operationRef", "identity", "sourceIdentity",
    "versions", "receiptRefs", "producer", "producerEventId", "eventType", "observedAtUnixNano", "monotonicNano",
    "clockDomainId", "sourceOccurredAtUnixNano", "sourceClockQuality", "producerSequence", "safeAttributes", "status", "errorCode",
    "idempotencyFingerprint"]);
  if (input.schemaVersion !== CODE_TASK_OBSERVATION_SCHEMA_VERSION) throw codedError("OBSERVATION_SCHEMA_UNSUPPORTED", "Observation schemaVersion must be 3.");
  const identity = requiredIdentity(input.identity); const trusted = authority?.identity;
  if (!trusted || !sameIdentity(identity, trusted)) throw codedError("OBSERVATION_IDENTITY_CHAIN_MISMATCH", "Observation identity does not match the authoritative binding.", 409);
  const startup = authority.startupBindingReceipt;
  if (startup?.providerBindingId === identity.providerBindingId && startup.bindingGeneration !== identity.bindingGeneration) {
    throw codedError("PROVIDER_BINDING_GENERATION_STALE", "StartupBindingReceipt generation is stale for this Observation.", 409);
  }
  if (!startup || startup.schemaVersion !== 2 || startup.status !== "ready" || !startup.startupOperationId || !startup.receiptHash
    || nullable(startup.objectiveId) !== nullable(identity.objectiveId) || nullable(startup.taskId) !== nullable(identity.taskId)
    || startup.logicalSessionId !== identity.logicalSessionId || startup.providerBindingId !== identity.providerBindingId
    || startup.bindingGeneration !== identity.bindingGeneration
    || nullable(startup.repositoryId) !== nullable(identity.repositoryId) || nullable(startup.worktreeId) !== nullable(identity.worktreeId)) {
    throw codedError("OBSERVATION_RECEIPT_REQUIRED", "A matching StartupBindingReceipt is required.", 409);
  }
  const execution = authority.turnExecutionReceipt;
  if (!execution || execution.turnExecutionId !== input.turnExecutionId || execution.turnId !== identity.turnId
    || execution.logicalSessionId !== identity.logicalSessionId) {
    throw codedError("OBSERVATION_RECEIPT_REQUIRED", "A matching TurnExecutionReceipt is required.", 409);
  }
  const receiptRefs = normalizeReceiptRefs(input.receiptRefs);
  requireReceiptRef(receiptRefs, "startup_binding", startup.startupOperationId);
  requireReceiptRef(receiptRefs, "turn_execution", execution.receiptId);
  const operationRef = normalizeOperationRef(input.operationRef);
  const runId = optionalId(input.runId, "runId");
  if (runId) {
    if (operationRef?.kind !== "isolated_run" || operationRef.id !== runId) throw codedError("RUN_ISOLATION_RECEIPT_REQUIRED", "runId requires an isolated_run operationRef.", 409);
    const runReceipt = authority.runIsolationReceipt;
    validateRunIsolationReceipt(runReceipt, { runId, authority, manifest });
    requireReceiptRef(receiptRefs, "run_isolation", runReceipt.receiptId);
  } else if (operationRef?.kind === "isolated_run") {
    throw codedError("RUN_ISOLATION_RECEIPT_REQUIRED", "isolated_run requires runId and a Run Isolation receipt.", 409);
  }
  const sourceIdentity = normalizeSourceIdentity(input.sourceIdentity, startup);
  const versions = normalizeVersions(input.versions, authority, receiptRefs, manifest, sourceIdentity);
  const safe = sanitizeAttributes(input.safeAttributes);
  const normalized = {
    schemaVersion: 3, observationId: requiredId(input.observationId, "observationId"),
    turnExecutionId: requiredId(input.turnExecutionId, "turnExecutionId"), runId, operationRef, identity, sourceIdentity,
    versions, receiptRefs, producer: requiredId(input.producer, "producer"),
    producerEventId: requiredId(input.producerEventId, "producerEventId"), eventType: requiredId(input.eventType, "eventType"),
    observedAtUnixNano: nano(input.observedAtUnixNano, "observedAtUnixNano"),
    monotonicNano: input.monotonicNano == null ? null : nano(input.monotonicNano, "monotonicNano"),
    clockDomainId: requiredId(input.clockDomainId, "clockDomainId"),
    sourceOccurredAtUnixNano: input.sourceOccurredAtUnixNano == null ? null : nano(input.sourceOccurredAtUnixNano, "sourceOccurredAtUnixNano"),
    sourceClockQuality: enumValue(input.sourceClockQuality, ["authoritative", "bounded", "opaque", "unknown"], "sourceClockQuality"),
    producerSequence: boundedInteger(input.producerSequence, 0, Number.MAX_SAFE_INTEGER, "producerSequence"),
    safeAttributes: safe.attributes, status: enumValue(input.status, ["received", "accepted", "quarantined"], "status"),
    errorCode: optionalId(input.errorCode, "errorCode"), droppedAttributeCount: safe.dropped
  };
  normalized.idempotencyFingerprint = sha256(stableStringify(normalized));
  return normalized;
}

function normalizeVersions(input = {}, authority, receiptRefs, manifest, sourceIdentity) {
  rejectUnknown(input, ["catalogVersion", "desiredMaterializationVersion", "appliedMaterializationVersion", "toolsetVersion", "sourceFingerprint", "providerCapabilityRevision"]);
  const output = Object.fromEntries(Object.keys(input).map((key) => [key, input[key] == null ? null : requiredId(input[key], key)]));
  const host = authority.toolHostAppliedReceipt;
  if (host) {
    requireReceiptRef(receiptRefs, "tool_host_applied", host.receiptId);
    exactNullable(output.catalogVersion, host.appliedCatalogVersion, "CATALOG_VERSION_MISMATCH");
    exactNullable(output.desiredMaterializationVersion, host.requestedVersion, "MATERIALIZATION_VERSION_MISMATCH");
    exactNullable(output.appliedMaterializationVersion, host.appliedVersion, "MATERIALIZATION_VERSION_MISMATCH");
    exactNullable(output.providerCapabilityRevision, host.providerCapabilityRevision, "PROVIDER_CAPABILITY_REVISION_MISMATCH");
  } else if ([output.catalogVersion, output.desiredMaterializationVersion, output.appliedMaterializationVersion, output.providerCapabilityRevision].some((v) => v != null)) {
    throw codedError("OBSERVATION_RECEIPT_REQUIRED", "Tool Host version aliases require an applied receipt.", 409);
  }
  const sourceRequested = sourceIdentity?.snapshotReceiptId || output.sourceFingerprint || output.toolsetVersion
    || receiptRefs.some((ref) => SOURCE_RECEIPT_KINDS.has(ref.kind));
  if (sourceRequested) manifest.requireResolved();
  if (sourceIdentity?.snapshotReceiptId || output.sourceFingerprint) {
    const snapshot = authority.repositorySourceSnapshotReceipt;
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.receiptId !== sourceIdentity.snapshotReceiptId
      || snapshot.sourceFingerprint !== output.sourceFingerprint) {
      throw codedError("SOURCE_SNAPSHOT_REFERENCE_MISMATCH", "Snapshot identity must come from the authoritative RepositorySourceSnapshotReceipt.", 409);
    }
    validateCanonicalReceipt(snapshot, "SOURCE_SNAPSHOT_RECEIPT_HASH_MISMATCH");
    manifest.requireArtifactRef("search_snapshot_schema", snapshot.artifactRef,
      { receiptType: "RepositorySourceSnapshotReceipt", schemaVersion: 1 });
    requireReceiptRef(receiptRefs, "repository_source_snapshot", snapshot.receiptId);
    const downstreamRefs = [
      authority.toolsetValidationReceipt?.snapshotRef,
      authority.searchReceipt?.snapshotReceiptRef,
      authority.runIsolationReceipt?.repositorySourceSnapshotReceiptRef
    ].filter(Boolean);
    for (const downstream of downstreamRefs) {
      if (downstream.receiptId !== snapshot.receiptId || downstream.sourceFingerprint !== snapshot.sourceFingerprint) {
        throw codedError("SOURCE_SNAPSHOT_REFERENCE_MISMATCH", "A downstream receipt changed snapshot identity.", 409);
      }
    }
    if (authority.toolsetValidationReceipt) {
      validateToolsetReceipt(authority.toolsetValidationReceipt, { manifest, snapshot });
    }
    if (authority.searchReceipt) {
      validateSearchReceipt(authority.searchReceipt, { manifest, snapshot, authority });
    }
  }
  if (output.toolsetVersion != null) {
    const toolset = authority.toolsetValidationReceipt;
    if (!toolset || toolset.schemaVersion !== TOOLSET_VALIDATION_RECEIPT_SCHEMA_VERSION
      || toolset.toolsetVersion !== output.toolsetVersion) {
      throw codedError("TOOLSET_VERSION_MISMATCH", "toolsetVersion must come from ToolsetValidationReceipt.", 409);
    }
    validateToolsetReceipt(toolset, { manifest, snapshot: authority.repositorySourceSnapshotReceipt });
    requireReceiptRef(receiptRefs, "toolset_validation", toolset.receiptId);
  }
  return { catalogVersion: output.catalogVersion ?? null,
    desiredMaterializationVersion: output.desiredMaterializationVersion ?? null,
    appliedMaterializationVersion: output.appliedMaterializationVersion ?? null,
    toolsetVersion: output.toolsetVersion ?? null, sourceFingerprint: output.sourceFingerprint ?? null,
    providerCapabilityRevision: output.providerCapabilityRevision ?? null };
}

function validateRunIsolationReceipt(runReceipt, { runId, authority, manifest }) {
  rejectUnknown(runReceipt, ["completedAt", "credentialLeaseRefs", "dataLeaseRef", "dataRootBindingId", "error", "eventRefs",
    "fencingToken", "logicalSessionId", "metricsRef", "mode", "outcome", "portLeaseRefs", "processLeaseRefs", "readyAt",
    "receiptHash", "receiptId", "repositoryId", "repositorySourceSnapshotReceiptRef", "resourceVersion", "runContextHash",
    "runId", "schemaVersion", "sourceFingerprint", "startedAt", "startupBindingReceiptRef", "state", "stoppedAt",
    "toolsetValidationReceiptPointer", "taskId", "worktreeId"]);
  if (!runReceipt || runReceipt.schemaVersion !== RUN_RECEIPT_SCHEMA_VERSION || runReceipt.runId !== runId
    || !runReceipt.receiptId || !/^(run|dev):.+$/.test(runReceipt.runId)
    || !Number.isSafeInteger(runReceipt.resourceVersion) || runReceipt.resourceVersion < 1
    || (runReceipt.sourceFingerprint != null && !/^[a-f0-9]{64}$/.test(runReceipt.sourceFingerprint))) {
    throw codedError("RUN_ISOLATION_RECEIPT_REQUIRED", "A matching RunReceipt v6 is required.", 409);
  }
  validateCanonicalReceipt(runReceipt, "RUN_ISOLATION_RECEIPT_HASH_MISMATCH");
  manifest.requireResolved();
  const snapshot = authority.repositorySourceSnapshotReceipt;
  const snapshotRef = runReceipt.repositorySourceSnapshotReceiptRef;
  if (snapshotRef != null) {
    if (!snapshot || !sameReceiptPointer(snapshotRef, snapshot, ["receiptId", "receiptHash", "sourceFingerprint", "schemaVersion", "resourceVersion"])
      || runReceipt.sourceFingerprint !== snapshot.sourceFingerprint) {
      throw codedError("RUN_SOURCE_FINGERPRINT_MISMATCH", "RunReceipt changed the authoritative source snapshot identity.", 409);
    }
  } else if (runReceipt.sourceFingerprint != null) {
    throw codedError("RUN_SOURCE_FINGERPRINT_MISMATCH", "RunReceipt sourceFingerprint requires a snapshot receipt.", 409);
  }
  const pointer = runReceipt.toolsetValidationReceiptPointer;
  if (pointer == null) return;
  rejectUnknown(pointer, ["receiptId", "receiptHash", "resourceVersion", "toolsetVersion", "validationPlanIdentity", "sourceFingerprint"]);
  if (!/^toolset_validation_receipt:[A-Za-z0-9_-]+$/.test(pointer.receiptId ?? "")
    || !/^[a-f0-9]{64}$/.test(pointer.receiptHash ?? "")
    || !Number.isSafeInteger(pointer.resourceVersion) || pointer.resourceVersion < 1
    || !/^ptv1:[a-f0-9]{64}$/.test(pointer.toolsetVersion ?? "")
    || !/^vp1:[a-f0-9]{64}$/.test(pointer.validationPlanIdentity ?? "")
    || !/^[a-f0-9]{64}$/.test(pointer.sourceFingerprint ?? "")) {
    throw codedError("RUN_TOOLSET_RECEIPT_POINTER_MISMATCH", "RunReceipt Toolset pointer is malformed.", 409);
  }
  const toolset = authority.toolsetValidationReceipt;
  if (!toolset || toolset.schemaVersion !== TOOLSET_VALIDATION_RECEIPT_SCHEMA_VERSION) {
    throw codedError("RUN_TOOLSET_RECEIPT_UNRESOLVED", "RunReceipt Toolset pointer could not be resolved.", 409);
  }
  validateToolsetReceipt(toolset, { manifest, snapshot });
  if (!sameReceiptPointer(pointer, toolset,
    ["receiptId", "receiptHash", "resourceVersion", "toolsetVersion", "validationPlanIdentity"])
    || pointer.sourceFingerprint !== toolset.snapshotRef?.sourceFingerprint
    || pointer.sourceFingerprint !== runReceipt.sourceFingerprint
    || pointer.sourceFingerprint !== snapshot?.sourceFingerprint) {
    throw codedError("RUN_TOOLSET_RECEIPT_POINTER_MISMATCH", "RunReceipt Toolset pointer differs from the verified receipt.", 409);
  }
}

function validateToolsetReceipt(toolset, { manifest, snapshot }) {
  rejectUnknown(toolset, ["actionReceipts", "artifactRef", "assertionReceipts", "cacheDisposition", "error", "expiresAt",
    "finishedAt", "identity", "outcome", "receiptHash", "receiptId", "resourceVersion", "schemaVersion", "snapshotRef",
    "startedAt", "toolsetVersion", "validationCacheKey", "validationPlanIdentity"]);
  if (!toolset || toolset.schemaVersion !== TOOLSET_VALIDATION_RECEIPT_SCHEMA_VERSION) {
    throw codedError("TOOLSET_RECEIPT_SCHEMA_INVALID", "ToolsetValidationReceipt schemaVersion must be 3.", 409);
  }
  if (!/^toolset_validation_receipt:[A-Za-z0-9_-]+$/.test(toolset.receiptId ?? "")
    || !Number.isSafeInteger(toolset.resourceVersion) || toolset.resourceVersion < 1
    || !/^ptv1:[a-f0-9]{64}$/.test(toolset.toolsetVersion ?? "")
    || !/^vp1:[a-f0-9]{64}$/.test(toolset.validationPlanIdentity ?? "")) {
    throw codedError("TOOLSET_RECEIPT_SCHEMA_INVALID", "ToolsetValidationReceipt identity fields are malformed.", 409);
  }
  validateCanonicalReceipt(toolset, "TOOLSET_RECEIPT_HASH_MISMATCH");
  manifest.requireArtifactRef("toolset_receipt_schema", toolset.artifactRef,
    { receiptType: "ToolsetValidationReceipt", schemaVersion: TOOLSET_VALIDATION_RECEIPT_SCHEMA_VERSION });
  if (!snapshot || !sameReceiptPointer(toolset.snapshotRef, snapshot,
    ["receiptId", "receiptHash", "sourceFingerprint", "schemaVersion", "resourceVersion"])) {
    throw codedError("SOURCE_SNAPSHOT_REFERENCE_MISMATCH", "ToolsetValidationReceipt changed the authoritative snapshot identity.", 409);
  }
}

function validateSearchReceipt(search, { manifest, snapshot, authority }) {
  if (!search || search.schemaVersion !== 1) {
    throw codedError("SEARCH_RECEIPT_SCHEMA_INVALID", "SearchReceipt schemaVersion must be 1.", 409);
  }
  validateCanonicalReceipt(search, "SEARCH_RECEIPT_HASH_MISMATCH");
  manifest.requireArtifactRef("search_snapshot_schema", search.artifactRef,
    { receiptType: "SearchReceipt", schemaVersion: 1 });
  if (!sameReceiptPointer(search.snapshotReceiptRef, snapshot,
    ["receiptId", "receiptHash", "sourceFingerprint", "schemaVersion", "resourceVersion"])
    || search.sourceFingerprint !== snapshot.sourceFingerprint) {
    throw codedError("SOURCE_SNAPSHOT_REFERENCE_MISMATCH", "SearchReceipt changed the authoritative snapshot identity.", 409);
  }
  if (search.toolsetValidationReceiptRef != null) {
    const toolset = authority.toolsetValidationReceipt;
    if (!toolset || !sameReceiptPointer(search.toolsetValidationReceiptRef, toolset,
      ["receiptId", "receiptHash", "schemaVersion", "resourceVersion"])) {
      throw codedError("SEARCH_TOOLSET_RECEIPT_POINTER_MISMATCH", "SearchReceipt changed the authoritative Toolset receipt identity.", 409);
    }
  }
  if (search.runIsolationReceiptRef != null) {
    const run = authority.runIsolationReceipt;
    if (!run || search.runIsolationReceiptRef.schemaVersion !== RUN_RECEIPT_SCHEMA_VERSION
      || !sameReceiptPointer(search.runIsolationReceiptRef, run,
        ["receiptId", "receiptHash", "schemaVersion", "resourceVersion", "runId"])
      || search.runId !== run.runId) {
      throw codedError("SEARCH_RUN_RECEIPT_POINTER_MISMATCH", "SearchReceipt changed the authoritative RunReceipt v6 identity.", 409);
    }
    manifest.requireArtifactRef("run_isolation_receipts", search.runIsolationReceiptRef.artifactRef,
      { receiptType: "RunReceipt", schemaVersion: RUN_RECEIPT_SCHEMA_VERSION });
  }
}

function validateCanonicalReceipt(receipt, code) {
  if (!/^[a-f0-9]{64}$/.test(receipt?.receiptHash ?? "")) {
    throw codedError(code, "The authoritative receipt hash is missing or malformed.", 409);
  }
  const canonical = { ...receipt };
  delete canonical.receiptHash;
  if (sha256(stableStringify(canonical)) !== receipt.receiptHash) {
    throw codedError(code, "The authoritative receipt hash does not match its canonical content.", 409);
  }
}

function sameReceiptPointer(pointer, receipt, fields) {
  return pointer != null && receipt != null && fields.every((field) => pointer[field] === receipt[field]);
}

function pagedTimeline(observations, row, offset, limit) {
  const watermark = observations.at(-1)?.observedAtUnixNano ?? null;
  const pairedSpans = pairSpans(observations, null, watermark, []).spans;
  const spans = isOrdered(pairedSpans, compareTimeline) ? pairedSpans : pairedSpans.sort(compareTimeline);
  const items = []; let eventIndex = 0; let spanIndex = 0; let visited = 0;
  const end = offset + limit;
  while ((eventIndex < observations.length || spanIndex < spans.length) && visited < end) {
    const event = observations[eventIndex]; const span = spans[spanIndex];
    const takeEvent = event && (!span || compareTimeline(event, span) <= 0);
    const value = takeEvent ? eventTimelineItem(event) : { kind: "span", ...span };
    if (takeEvent) eventIndex += 1; else spanIndex += 1;
    if (visited >= offset) items.push(value);
    visited += 1;
  }
  return { items, total: observations.length + spans.length, completeness: lightweightCompleteness(observations, row) };
}

function eventTimelineItem(observation) {
  return { kind: "event", observationId: observation.observationId,
    turnExecutionId: observation.turnExecutionId, eventType: observation.eventType, observedAtUnixNano: observation.observedAtUnixNano,
    producer: observation.producer, producerSequence: observation.producerSequence, operationRef: observation.operationRef,
    runId: observation.runId, safeAttributes: observation.safeAttributes, versions: observation.versions,
    sourceIdentity: observation.sourceIdentity, receiptRefs: observation.receiptRefs };
}

function lightweightCompleteness(observations, row) {
  const hasStart = observations.some((item) => item.eventType === "turn.execution.accepted");
  const hasTerminal = observations.some((item) => TERMINAL_EVENTS.has(item.eventType));
  const producerSequences = new Map(); let gapCount = 0;
  for (const item of observations) {
    const state = producerSequences.get(item.producer) ?? { min: item.producerSequence, max: item.producerSequence, values: new Set() };
    state.min = Math.min(state.min, item.producerSequence); state.max = Math.max(state.max, item.producerSequence);
    state.values.add(item.producerSequence); producerSequences.set(item.producer, state);
  }
  for (const state of producerSequences.values()) gapCount += Math.max(0, state.max - state.min + 1 - state.values.size);
  const persistedDrops = Number(row.dropped_event_count ?? 0);
  return { state: hasStart && hasTerminal && gapCount + persistedDrops === 0 ? "complete" : "partial",
    droppedEventCount: gapCount + persistedDrops, missingTerminal: !hasTerminal,
    rawCaptureStatus: row.raw_manifest_json ? "available" : "unavailable" };
}

function projectTimeline(observations, row) {
  const diagnostics = []; const dropped = parseJson(row.dropped_reasons_json, {});
  const sequences = new Map();
  for (const observation of observations) {
    const items = sequences.get(observation.producer) ?? [];
    items.push(observation.producerSequence); sequences.set(observation.producer, items);
  }
  for (const [producer, items] of sequences) {
    const ordered = [...new Set(items)].sort((left, right) => left - right);
    for (let index = 1; index < ordered.length; index += 1) {
      const prior = ordered[index - 1]; const received = ordered[index];
      if (received > prior + 1) diagnostics.push({ code: "DROPPED_EVENT", producer,
        expected: prior + 1, received, droppedCount: received - prior - 1, dropReason: "producer_gap" });
    }
  }
  for (const [dropReason, droppedCount] of Object.entries(dropped)) diagnostics.push({ code: "DROPPED_EVENT", dropReason, droppedCount });
  const wallStart = observations.find((item) => item.eventType === "turn.execution.accepted");
  const terminal = observations.findLast((item) => TERMINAL_EVENTS.has(item.eventType));
  if (!wallStart) diagnostics.push({ code: "HOST_QUEUE_ACCEPTED_MISSING" });
  if (!terminal) diagnostics.push({ code: "MISSING_TERMINAL_EVENT" });
  const watermark = observations.at(-1)?.observedAtUnixNano ?? wallStart?.observedAtUnixNano ?? "0";
  const wallStartNano = wallStart?.observedAtUnixNano ?? null; const wallEndNano = terminal?.observedAtUnixNano ?? watermark;
  const paired = pairSpans(observations, wallStartNano, wallEndNano, diagnostics);
  const analyzed = analyzeIntervals(paired.spans, wallStartNano, wallEndNano, terminal != null, diagnostics);
  const timeline = [...observations.map(eventTimelineItem),
    ...paired.spans.map((span) => ({ kind: "span", ...span }))].sort(compareTimeline);
  const droppedCount = diagnostics.filter((item) => item.code === "DROPPED_EVENT").reduce((sum, item) => sum + Number(item.droppedCount ?? 0), 0);
  return { ...analyzed, spans: paired.spans, timeline, finalized: Boolean(wallStart && terminal),
    terminalStatus: terminal ? terminal.eventType.split(".").at(-1) : null,
    endedAt: terminal ? nanoToIso(terminal.observedAtUnixNano) : null,
    completeness: { state: wallStart && terminal && droppedCount === 0 && !diagnostics.some((item) => item.code === "CLOCK_SKEW") ? "complete" : "partial",
      droppedEventCount: droppedCount, missingTerminal: !terminal, rawCaptureStatus: row.raw_manifest_json ? "available" : "unavailable" }, diagnostics };
}

function pairSpans(observations, wallStartNano, wallEndNano, diagnostics) {
  const open = new Map(); const spans = [];
  for (const observation of observations) {
    if (!["interval.started", "interval.completed", "interval.failed", "interval.cancelled", "interval.timed_out"].includes(observation.eventType)) continue;
    const key = spanPairKey(observation); const isStart = observation.eventType === "interval.started";
    if (isStart) { open.set(key, observation); continue; }
    const start = open.get(key);
    if (!start) { diagnostics.push({ code: "ORPHAN_TERMINAL", observationId: observation.observationId }); continue; }
    open.delete(key); spans.push(spanFrom(start, observation));
  }
  for (const start of open.values()) {
    diagnostics.push({ code: "MISSING_TERMINAL_EVENT", observationId: start.observationId, spanKey: start.safeAttributes.spanKey });
    if (wallEndNano) spans.push(spanFrom(start, null, wallEndNano));
  }
  return { spans };
}

function spanFrom(start, terminal, watermark) {
  const intervalClass = normalizedIntervalClass(start.safeAttributes.intervalClass);
  const terminalStatus = terminal ? terminal.eventType.split(".").at(-1) : "abandoned";
  return { spanId: `span:${sha256(spanPairKey(start)).slice(0, 24)}`, traceId: `trace:${sha256(start.turnExecutionId).slice(0, 24)}`,
    turnExecutionId: start.turnExecutionId, runId: start.runId, operationRef: start.operationRef, parentSpanId: null, links: [],
    intervalClass, operation: safeText(start.safeAttributes.operation) ?? intervalClass,
    operationSet: Array.isArray(start.safeAttributes.operationSet) ? start.safeAttributes.operationSet.map(safeText).filter(Boolean) : [intervalClass],
    classificationSource: safeText(start.safeAttributes.classificationSource) ?? "structured_receipt",
    classificationConfidence: safeText(start.safeAttributes.classificationConfidence) ?? "high",
    startObservationId: start.observationId, endObservationId: terminal?.observationId ?? null,
    startObservedAtUnixNano: start.observedAtUnixNano, endObservedAtUnixNano: terminal?.observedAtUnixNano ?? watermark,
    startMonotonicNano: start.monotonicNano, endMonotonicNano: terminal?.monotonicNano ?? null,
    clockDomainId: start.clockDomainId, durationPrecision: safeText(start.safeAttributes.durationPrecision) ?? "exact",
    status: TERMINAL_STATUSES.has(terminalStatus) ? terminalStatus : "failed", attempt: Number(start.safeAttributes.attempt ?? 0),
    retryGroupId: safeText(start.safeAttributes.retryGroupId), receiptRefs: start.receiptRefs,
    safeAttributes: { providerCapabilityClass: start.safeAttributes.providerCapabilityClass ?? null } };
}

function analyzeIntervals(spans, wallStartNano, wallEndNano, finalized, diagnostics) {
  if (!wallStartNano || !wallEndNano) return emptyWall(finalized);
  const wallStart = BigInt(wallStartNano); const wallEnd = BigInt(wallEndNano);
  if (wallEnd < wallStart) { diagnostics.push({ code: "CLOCK_SKEW", reason: "wall_negative" }); return emptyWall(false); }
  const valid = [];
  for (const span of spans) {
    let start; let end;
    if (span.startMonotonicNano != null && span.endMonotonicNano != null) {
      start = BigInt(span.startObservedAtUnixNano);
      end = start + (BigInt(span.endMonotonicNano) - BigInt(span.startMonotonicNano));
    } else { start = BigInt(span.startObservedAtUnixNano); end = BigInt(span.endObservedAtUnixNano); }
    if (end < start || start > wallEnd || end < wallStart) { diagnostics.push({ code: "CLOCK_SKEW", spanId: span.spanId }); continue; }
    valid.push({ ...span, clippedStart: start < wallStart ? wallStart : start, clippedEnd: end > wallEnd ? wallEnd : end });
  }
  const events = valid.flatMap((span) => [
    { time: span.clippedStart, kind: "start", span }, { time: span.clippedEnd, kind: "end", span }
  ]).sort((left, right) => left.time < right.time ? -1 : left.time > right.time ? 1 : left.kind === right.kind ? 0 : left.kind === "end" ? -1 : 1);
  const atomicSegments = []; const active = new Map(); let unionNano = 0n; let overlapNano = 0n; let cursor = wallStart;
  for (let index = 0; index < events.length;) {
    const time = events[index].time;
    if (time > cursor && active.size > 0) {
      const duration = time - cursor; const activeSpans = [...active.values()];
      unionNano += duration; if (activeSpans.length > 1) overlapNano += duration;
      const activeClassSet = [...new Set(activeSpans.map((span) => span.intervalClass))].sort();
      atomicSegments.push({ startUnixNano: cursor.toString(), endUnixNano: time.toString(), durationMs: nanoMs(duration), activeClassSet,
        intervalIds: activeSpans.map((span) => span.spanId).sort() });
      if (activeSpans.length > 1 && diagnostics.length < 1000) diagnostics.push({ code: "INTERVAL_OVERLAP", overlapMs: nanoMs(duration), activeClassSet,
        intervalIds: activeSpans.map((span) => span.spanId).sort(),
        legalParallel: activeSpans.some((span) => span.operationRef?.id !== activeSpans[0].operationRef?.id) });
    }
    while (index < events.length && events[index].time === time && events[index].kind === "end") {
      active.delete(events[index].span.spanId); index += 1;
    }
    while (index < events.length && events[index].time === time && events[index].kind === "start") {
      active.set(events[index].span.spanId, events[index].span); index += 1;
    }
    cursor = time;
  }
  const wallNano = wallEnd - wallStart; const gapIntervals = gapsFromSegments(wallStart, wallEnd, atomicSegments);
  const unattributedNano = wallNano > unionNano ? wallNano - unionNano : 0n;
  const inclusive = {};
  for (const span of valid) inclusive[span.intervalClass] = round((inclusive[span.intervalClass] ?? 0) + nanoMs(span.clippedEnd - span.clippedStart));
  const wallClockMs = nanoMs(wallNano); const attributedUnionMs = nanoMs(unionNano); const unattributedMs = nanoMs(unattributedNano);
  const epsilonMs = 1;
  if (Math.abs(wallClockMs - attributedUnionMs - unattributedMs) > epsilonMs) diagnostics.push({ code: "WALL_PARTITION_NOT_CLOSED" });
  return { wall: { finalized, startUnixNano: wallStart.toString(), endUnixNano: wallEnd.toString(), wallClockMs: finalized ? wallClockMs : null,
      observedWatermarkMs: finalized ? null : wallClockMs, epsilonMs },
    wallPartition: { attributedUnionMs, unattributedMs, overlapMs: nanoMs(overlapNano), atomicSegments }, inclusive,
    unattributed: { durationMs: unattributedMs, gapIntervals } };
}

function buildReport(row, projection, contextGrowth, rawCaptureStatus) {
  const first = projection.timeline.find((item) => item.kind === "event");
  const versions = first?.versions ?? {};
  return { schemaVersion: 4, analysisVersion: CODE_TASK_ANALYSIS_VERSION,
    identity: { logicalSessionId: row.logical_session_id, turnId: row.turn_id, turnExecutionId: row.turn_execution_id,
      objectiveId: row.objective_id, taskId: row.task_id, providerBindingId: row.provider_binding_id,
      bindingGeneration: Number(row.binding_generation), repositoryId: row.repository_id, worktreeId: row.worktree_id },
    sourceIdentity: { sourceCommitOid: row.source_commit_oid, sourceTreeOid: row.source_tree_oid,
      snapshotReceiptId: first?.sourceIdentity?.snapshotReceiptId ?? null }, versions,
    wall: projection.wall, wallPartition: {
      ...projection.wallPartition,
      atomicSegmentCount: projection.wallPartition.atomicSegments.length,
      atomicSegments: projection.wallPartition.atomicSegments.slice(0, 256),
      atomicSegmentsTruncated: projection.wallPartition.atomicSegments.length > 256
    }, inclusive: projection.inclusive,
    unattributed: { ...projection.unattributed, gapIntervalCount: projection.unattributed.gapIntervals.length,
      gapIntervals: projection.unattributed.gapIntervals.slice(0, 256),
      gapIntervalsTruncated: projection.unattributed.gapIntervals.length > 256 }, contextGrowth,
    spanCount: projection.spans.length,
    completeness: { ...projection.completeness, rawCaptureStatus }, diagnostics: projection.diagnostics.slice(0, 500),
    samplePolicy: { criticalFactsSampled: false, sampledClasses: ["progress", "delta", "profiling"] },
    sourceReceiptIds: [...new Set(projection.spans.flatMap((span) => span.receiptRefs.map((ref) => ref.receiptId)))].sort() };
}

function contextMetrics(observations) {
  const item = observations.findLast((observation) => observation.eventType === "context.metrics"); if (!item) return null;
  const a = item.safeAttributes; const numeric = (key) => a[key] == null ? null : Number(a[key]);
  const contextBytes = [numeric("staticSystemBytes"), numeric("artifactIndexBytes")].every((v) => v == null) ? null
    : Number(numeric("staticSystemBytes") ?? 0) + Number(numeric("artifactIndexBytes") ?? 0);
  return { staticSystemBytes: numeric("staticSystemBytes"), artifactIndexBytes: numeric("artifactIndexBytes"), contextBytes,
    materializedToolCount: numeric("materializedToolCount"), toolSchemaBytes: numeric("toolSchemaBytes"),
    catalogVersion: item.versions.catalogVersion, desiredMaterializationVersion: item.versions.desiredMaterializationVersion,
    appliedMaterializationVersion: item.versions.appliedMaterializationVersion,
    providerCapabilityRevision: item.versions.providerCapabilityRevision,
    repeatedDeliverySurfaceCount: numeric("repeatedDeliverySurfaceCount"), toolSearchCount: numeric("toolSearchCount"),
    toolLoadCount: numeric("toolLoadCount"), inputTokens: numeric("inputTokens"), cachedInputTokens: numeric("cachedInputTokens"),
    metricCompleteness: safeText(a.metricCompleteness) ?? "partial", sourceReceiptIds: item.receiptRefs.map((ref) => ref.receiptId) };
}

function emptyContextGrowth() { return { staticSystemBytes: null, artifactIndexBytes: null, contextBytes: null,
  materializedToolCount: null, toolSchemaBytes: null, catalogVersion: null, desiredMaterializationVersion: null,
  appliedMaterializationVersion: null, providerCapabilityRevision: null, repeatedDeliverySurfaceCount: null,
  toolSearchCount: null, toolLoadCount: null, inputTokens: null, cachedInputTokens: null,
  contextBytesDeltaFromPreviousExecution: null, toolSchemaBytesDeltaFromCatalogBaseline: null,
  metricCompleteness: "unavailable", comparisonKey: null, sourceReceiptIds: [] }; }

function toOtlp(report, spans) {
  return { resourceSpans: [{
    resource: { attributes: [
      { key: "service.name", value: { stringValue: "corptie-observability" } },
      { key: "corptie.logical_session.id", value: { stringValue: report.identity.logicalSessionId } }
    ] },
    scopeSpans: [{
      scope: { name: "corptie.code-task-observability", version: CODE_TASK_ANALYSIS_VERSION },
      spans: spans.map((span) => ({
        traceId: span.traceId, spanId: span.spanId, name: span.operation,
        startTimeUnixNano: span.startObservedAtUnixNano, endTimeUnixNano: span.endObservedAtUnixNano,
        attributes: [
          { key: "corptie.interval.class", value: { stringValue: span.intervalClass } },
          { key: "corptie.turn_execution.id", value: { stringValue: span.turnExecutionId } },
          ...(span.runId ? [{ key: "corptie.run.id", value: { stringValue: span.runId } }] : [])
        ]
      }))
    }]
  }] };
}

function requiredIdentity(input) {
  if (!input || typeof input !== "object") throw codedError("OBSERVATION_IDENTITY_REQUIRED", "Observation identity is required.");
  rejectUnknown(input, ["objectiveId", "taskId", "logicalSessionId", "providerBindingId", "bindingGeneration", "repositoryId", "worktreeId", "turnId"]);
  return { objectiveId: optionalId(input.objectiveId, "objectiveId"), taskId: optionalId(input.taskId, "taskId"),
    logicalSessionId: requiredId(input.logicalSessionId, "logicalSessionId"), providerBindingId: requiredId(input.providerBindingId, "providerBindingId"),
    bindingGeneration: boundedInteger(input.bindingGeneration, 1, Number.MAX_SAFE_INTEGER, "bindingGeneration"),
    repositoryId: optionalId(input.repositoryId, "repositoryId"), worktreeId: optionalId(input.worktreeId, "worktreeId"),
    turnId: requiredId(input.turnId, "turnId") };
}
function normalizeSourceIdentity(input, startup) { if (input == null) return { sourceCommitOid: nullable(startup.sourceCommitOid), sourceTreeOid: nullable(startup.sourceTreeOid), snapshotReceiptId: null };
  rejectUnknown(input, ["sourceCommitOid", "sourceTreeOid", "snapshotReceiptId"]);
  exactNullable(input.sourceCommitOid, startup.sourceCommitOid, "OBSERVATION_IDENTITY_CHAIN_MISMATCH");
  exactNullable(input.sourceTreeOid, startup.sourceTreeOid, "OBSERVATION_IDENTITY_CHAIN_MISMATCH");
  return { sourceCommitOid: optionalId(input.sourceCommitOid, "sourceCommitOid"), sourceTreeOid: optionalId(input.sourceTreeOid, "sourceTreeOid"),
    snapshotReceiptId: optionalId(input.snapshotReceiptId, "snapshotReceiptId") }; }
function normalizeReceiptRefs(input) { if (!Array.isArray(input) || input.length === 0 || input.length > 64) throw codedError("OBSERVATION_RECEIPT_REQUIRED", "receiptRefs are required.");
  return input.map((ref) => { rejectUnknown(ref, ["kind", "receiptId", "producer", "producerSchemaVersion"]); return {
    kind: requiredId(ref.kind, "receiptRef.kind"), receiptId: requiredId(ref.receiptId, "receiptRef.receiptId"),
    producer: requiredId(ref.producer, "receiptRef.producer"), producerSchemaVersion: boundedInteger(ref.producerSchemaVersion, 1, 1000, "producerSchemaVersion") }; }); }
function normalizeOperationRef(input) { if (input == null) return null; rejectUnknown(input, ["kind", "id"]);
  return { kind: enumValue(input.kind, [...OPERATION_KINDS], "operationRef.kind"), id: requiredId(input.id, "operationRef.id") }; }
function sanitizeAttributes(input = {}) { if (!input || typeof input !== "object" || Array.isArray(input)) throw codedError("OBSERVATION_ATTRIBUTES_INVALID", "safeAttributes must be an object.");
  const attributes = {}; let dropped = 0;
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key)) { dropped += 1; continue; }
    if (key === "operationSet") { if (Array.isArray(value) && value.length <= 32) attributes[key] = value.map(safeText).filter(Boolean); else dropped += 1; continue; }
    if (["string", "number", "boolean"].includes(typeof value) && (typeof value !== "string" || value.length <= SAFE_SCALAR_MAX)) attributes[key] = value; else dropped += 1;
  }
  return { attributes, dropped }; }
function sameIdentity(a, b) { return ["objectiveId", "taskId", "logicalSessionId", "providerBindingId", "bindingGeneration", "repositoryId", "worktreeId", "turnId"]
  .every((key) => nullable(a[key]) === nullable(b[key])); }
function requireReceiptRef(refs, kind, receiptId) { if (!receiptId || !refs.some((ref) => ref.kind === kind && ref.receiptId === receiptId))
  throw codedError("OBSERVATION_RECEIPT_REQUIRED", `A matching ${kind} receipt reference is required.`, 409); }
function exactNullable(actual, expected, code) { if (nullable(actual) !== nullable(expected)) throw codedError(code, "A projected version or identity differs from its authoritative receipt.", 409); }
function spanPairKey(observation) { return [observation.turnExecutionId, observation.producer, observation.operationRef?.kind ?? "none",
  observation.operationRef?.id ?? "none", observation.safeAttributes.spanKey ?? "default", observation.safeAttributes.attempt ?? 0].join("|"); }
function normalizedIntervalClass(value) { const normalized = safeText(value); return INTERVAL_CLASSES.includes(normalized) ? normalized : "provider.opaque"; }
function compareObservation(a, b) { const an = BigInt(a.observedAtUnixNano); const bn = BigInt(b.observedAtUnixNano); return an < bn ? -1 : an > bn ? 1
  : a.producerSequence - b.producerSequence || a.observationId.localeCompare(b.observationId); }
function compareTimeline(a, b) { const av = BigInt(a.observedAtUnixNano ?? a.startObservedAtUnixNano); const bv = BigInt(b.observedAtUnixNano ?? b.startObservedAtUnixNano);
  return av < bv ? -1 : av > bv ? 1 : (a.observationId ?? a.spanId).localeCompare(b.observationId ?? b.spanId); }
function isOrdered(items, compare) { for (let index = 1; index < items.length; index += 1) if (compare(items[index - 1], items[index]) > 0) return false; return true; }
function gapsFromSegments(start, end, segments) { const gaps = []; let cursor = start;
  for (const segment of segments) { const segmentStart = BigInt(segment.startUnixNano); const segmentEnd = BigInt(segment.endUnixNano);
    if (segmentStart > cursor) gaps.push({ startUnixNano: cursor.toString(), endUnixNano: segmentStart.toString(), durationMs: nanoMs(segmentStart - cursor) });
    if (segmentEnd > cursor) cursor = segmentEnd; }
  if (cursor < end) gaps.push({ startUnixNano: cursor.toString(), endUnixNano: end.toString(), durationMs: nanoMs(end - cursor) }); return gaps; }
function emptyWall(finalized) { return { wall: { finalized, startUnixNano: null, endUnixNano: null, wallClockMs: null, observedWatermarkMs: null, epsilonMs: 1 },
  wallPartition: { attributedUnionMs: 0, unattributedMs: 0, overlapMs: 0, atomicSegments: [] }, inclusive: {}, unattributed: { durationMs: 0, gapIntervals: [] } }; }
function executionProjection(row) { return { turnExecutionId: row.turn_execution_id, logicalSessionId: row.logical_session_id, turnId: row.turn_id,
  status: row.status, projectionState: row.projection_state, observationCount: Number(row.observation_count), droppedEventCount: Number(row.dropped_event_count),
  providerBindingId: row.provider_binding_id, bindingGeneration: Number(row.binding_generation) }; }
function rejectUnknown(input, allowed) { for (const key of Object.keys(input ?? {})) if (!allowed.includes(key)) throw codedError("OBSERVATION_UNKNOWN_FIELD", `Unknown field: ${key}`); }
function requiredId(value, field) { if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n]/.test(value)) throw codedError("OBSERVATION_FIELD_INVALID", `${field} is invalid.`); return value.trim(); }
function optionalId(value, field) { return value == null ? null : requiredId(value, field); }
function enumValue(value, allowed, field) { if (!allowed.includes(value)) throw codedError("OBSERVATION_FIELD_INVALID", `${field} is invalid.`); return value; }
function boundedInteger(value, min, max, field) { if (!Number.isSafeInteger(value) || value < min || value > max) throw codedError("OBSERVATION_FIELD_INVALID", `${field} is invalid.`); return value; }
function nano(value, field) { const text = typeof value === "bigint" ? value.toString() : value; if (typeof text !== "string" || !/^\d{1,30}$/.test(text)) throw codedError("OBSERVATION_FIELD_INVALID", `${field} is invalid.`); BigInt(text); return text; }
function safeText(value) { if (typeof value !== "string") return null; const text = value.trim(); return text && text.length <= SAFE_SCALAR_MAX && !/[\r\n]/.test(text) ? text : null; }
function nullable(value) { return value == null ? null : value; }
function parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function nanoMs(value) { return round(Number(value) / 1_000_000); }
function nanoToIso(value) { return new Date(Number(BigInt(value) / 1_000_000n)).toISOString(); }
function round(value) { return Math.round(value * 1000) / 1000; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stableStringify(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`; }
function encodeCursor(offset) { return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url"); }
function decodeCursor(cursor) { if (!cursor) return 0; try { const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); return boundedInteger(parsed.offset, 0, Number.MAX_SAFE_INTEGER, "cursor.offset"); }
  catch { throw codedError("OBSERVATION_CURSOR_INVALID", "Timeline cursor is invalid.", 400); } }
function storageError(code) { const error = new Error(code); error.code = code; return error; }
