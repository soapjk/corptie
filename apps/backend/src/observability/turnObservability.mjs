import { createHash, randomUUID } from "node:crypto";

export const TURN_ANALYSIS_VERSION = "corptie-turn-v3";
export const TURN_CATEGORIES = Object.freeze([
  "queue", "dispatch", "context", "model", "tool", "mcp", "persistence", "delivery", "other"
]);
export const OBSERVABILITY_LEVELS = Object.freeze(["native", "event-stream", "boundary-only"]);
export const DEVELOPMENT_OPERATIONS = Object.freeze([
  "history.read", "code.search", "code.read", "code.edit", "shell", "git", "test", "build",
  "mcp", "model.reasoning", "persistence", "other"
]);
export const ACTIVITY_PHASES = Object.freeze([
  "task-planning", "provider-reasoning", "progress-update", "result-synthesis",
  "code-navigation", "implementation", "verification", "context-loading", "tool-execution", "unknown"
]);

const ALLOWED_ATTRIBUTES = new Set([
  "corptie.tenant.id", "corptie.session.id", "corptie.logical_turn.id", "corptie.turn_run.id",
  "corptie.provider.id", "corptie.provider_session.id", "corptie.binding.id", "corptie.agent.id",
  "corptie.objective.id", "corptie.work_item.id", "corptie.workspace.id", "corptie.environment",
  "corptie.category", "corptie.observability_level", "corptie.event.type", "corptie.retry.count",
  "corptie.recovery", "corptie.operation", "corptie.activity.phase", "service.name", "span.kind", "otel.status_code", "error.type", "error.code",
  "http.request.method", "http.response.status_code", "rpc.system", "rpc.method", "db.system",
  "gen_ai.system", "gen_ai.request.model", "gen_ai.operation.name", "tool.name", "mcp.server.name",
  "code.file.path", "code.line.number", "code.function.name"
]);
const SENSITIVE_KEY = /(prompt|completion|output|content|body|text|message|command|shell|file|token|cookie|authorization|auth|secret|password|credential|api[_-]?key|header)/i;
const SAFE_CODE_LOCATION_KEYS = new Set(["code.file.path", "code.line.number", "code.function.name"]);

export class TelemetryGateway {
  constructor({ environment = "development", tenantId = "local", retentionDays, credentialId } = {}) {
    if (!/^(development|production|test)$/.test(environment)) throw new Error("Invalid telemetry environment.");
    this.environment = environment;
    this.tenantId = tenantId;
    this.retentionDays = retentionDays ?? (environment === "production" ? 30 : 3);
    this.credentialId = credentialId ?? `corptie-otlp-${environment}`;
  }

  sanitizeAttributes(input = {}, required = {}) {
    const output = {
      "corptie.tenant.id": this.tenantId,
      "corptie.environment": this.environment,
      ...required
    };
    for (const [key, value] of Object.entries(input ?? {})) {
      if (!ALLOWED_ATTRIBUTES.has(key) || (SENSITIVE_KEY.test(key) && !SAFE_CODE_LOCATION_KEYS.has(key))) continue;
      if (key === "code.file.path") {
        const path = safeRelativeCodePath(value);
        if (path) output[key] = path;
        continue;
      }
      if (key === "code.line.number") {
        const line = Number(value);
        if (Number.isSafeInteger(line) && line > 0 && line <= 10_000_000) output[key] = line;
        continue;
      }
      if (key === "code.function.name") {
        const name = String(value ?? "").trim();
        if (name && name.length <= 200 && !/[\r\n]/.test(name)) output[key] = name;
        continue;
      }
      if (key === "corptie.activity.phase") {
        if (ACTIVITY_PHASES.includes(value)) output[key] = value;
        continue;
      }
      if (["string", "number", "boolean"].includes(typeof value)) output[key] = value;
    }
    return output;
  }

  sanitizeSpan(span, required = {}) {
    const startTimeUnixNano = nanoString(span.startTimeUnixNano ?? span.start_time_unix_nano);
    const endTimeUnixNano = nanoString(span.endTimeUnixNano ?? span.end_time_unix_nano);
    if (BigInt(endTimeUnixNano) < BigInt(startTimeUnixNano)) throw new Error("Span end precedes start.");
    return {
      traceId: safeId(span.traceId ?? span.trace_id, 64, "traceId"),
      spanId: safeId(span.spanId ?? span.span_id, 32, "spanId"),
      parentSpanId: optionalId(span.parentSpanId ?? span.parent_span_id, 32),
      name: safeName(span.name),
      startTimeUnixNano,
      endTimeUnixNano,
      status: normalizedStatus(span.status),
      attributes: this.sanitizeAttributes(normalizedAttributes(span.attributes), required),
      events: normalizedEvents(span.events, this)
    };
  }
}

export class TurnTraceAnalyzer {
  analyze({ identity, spans, observabilityLevel = "native", errors = [], retryCount = 0, recovered = false }) {
    if (!OBSERVABILITY_LEVELS.includes(observabilityLevel)) throw new Error("Unsupported observability level.");
    const normalized = spans.map(normalizeForAnalysis).sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
    const traceStart = Math.min(...normalized.map((span) => span.startMs));
    const traceEnd = Math.max(...normalized.map((span) => span.endMs));
    if (!Number.isFinite(traceStart) || !Number.isFinite(traceEnd)) throw new Error("A Turn trace requires at least one valid span.");
    const byId = new Map(normalized.map((span) => [span.spanId, span]));
    const children = new Map(normalized.map((span) => [span.spanId, []]));
    const roots = [];
    for (const span of normalized) {
      const parent = span.parentSpanId ? byId.get(span.parentSpanId) : null;
      if (parent && span.startMs >= parent.startMs && span.endMs <= parent.endMs) children.get(parent.spanId).push(span);
      else roots.push(span);
    }
    const wallClockMs = round(traceEnd - traceStart);
    const inclusiveMs = Object.fromEntries(TURN_CATEGORIES.map((category) => [category, 0]));
    const operationInclusiveMs = Object.fromEntries(DEVELOPMENT_OPERATIONS.map((operation) => [operation, 0]));
    for (const span of normalized) {
      inclusiveMs[span.category] += span.durationMs;
      operationInclusiveMs[span.operation] += span.durationMs;
    }
    for (const category of TURN_CATEGORIES) inclusiveMs[category] = round(inclusiveMs[category]);
    for (const operation of DEVELOPMENT_OPERATIONS) operationInclusiveMs[operation] = round(operationInclusiveMs[operation]);
    const coveredMs = intervalUnionMs(normalized.map((span) => [span.startMs, span.endMs]));
    const criticalPathMs = round(Math.min(wallClockMs, criticalForestMs(roots, children)));
    const unattributedMs = round(Math.max(0, wallClockMs - coveredMs));
    const exact = observabilityLevel !== "boundary-only";
    const categories = Object.fromEntries(TURN_CATEGORIES.map((category) => [category, {
      inclusiveMs: exact ? inclusiveMs[category] : null,
      estimateMs: exact ? null : inclusiveMs[category],
      precise: exact
    }]));
    const developmentOperations = Object.fromEntries(DEVELOPMENT_OPERATIONS.map((operation) => [operation, {
      inclusiveMs: exact ? operationInclusiveMs[operation] : null,
      estimateMs: exact ? null : operationInclusiveMs[operation],
      precise: exact
    }]));
    const sanitizedErrors = errors.map(safeError);
    return {
      ...identity,
      analysisVersion: TURN_ANALYSIS_VERSION,
      observabilityLevel,
      wallClockMs,
      inclusiveMs: exact ? inclusiveMs : null,
      estimatedInclusiveMs: exact ? null : inclusiveMs,
      criticalPathMs: exact ? criticalPathMs : null,
      estimatedCriticalPathMs: exact ? null : criticalPathMs,
      unattributedMs: exact ? unattributedMs : null,
      estimatedUnattributedMs: exact ? null : unattributedMs,
      categories,
      developmentOperations,
      spanCount: normalized.length,
      dataCompleteness: completeness(observabilityLevel, normalized, unattributedMs, wallClockMs),
      errors: sanitizedErrors,
      retryCount: Math.max(0, Number(retryCount) || 0),
      recovered: recovered === true,
      anomalies: detectAnomalies({ wallClockMs, unattributedMs, inclusiveMs, errors: sanitizedErrors, retryCount }),
      startedAt: new Date(traceStart).toISOString(),
      endedAt: new Date(traceEnd).toISOString()
    };
  }
}

export class TurnObservabilityService {
  constructor({ store, environment = "development", tenantId = "local" }) {
    if (!store?.getSession || !store?.selectOne) throw new Error("TurnObservabilityService requires a Corptie Store.");
    this.store = store;
    this.gateway = new TelemetryGateway({ environment, tenantId });
    this.analyzer = new TurnTraceAnalyzer();
  }

  initialize() {
    if (!this.store.db) throw new Error("TurnObservabilityService requires an initialized Corptie Store.");
    this.store.db.run(`
      CREATE TABLE IF NOT EXISTS turn_trace_runs (
        turn_run_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
        logical_turn_id TEXT NOT NULL, binding_id TEXT NOT NULL, provider_id TEXT NOT NULL,
        provider_session_id TEXT, agent_id TEXT, objective_id TEXT, work_item_id TEXT, workspace_id TEXT,
        observability_level TEXT NOT NULL CHECK (observability_level IN ('native','event-stream','boundary-only')),
        trace_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', retry_count INTEGER NOT NULL DEFAULT 0,
        recovered INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, ended_at TEXT, raw_trace_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(session_id, binding_id, logical_turn_id, turn_run_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_turn_trace_runs_session ON turn_trace_runs(session_id, ended_at DESC, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_turn_trace_runs_work_item ON turn_trace_runs(work_item_id, ended_at DESC);
      CREATE INDEX IF NOT EXISTS idx_turn_trace_runs_objective ON turn_trace_runs(objective_id, ended_at DESC);
      CREATE TABLE IF NOT EXISTS turn_time_summaries (
        turn_run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, logical_turn_id TEXT NOT NULL,
        work_item_id TEXT, objective_id TEXT, ended_at TEXT NOT NULL, summary_json TEXT NOT NULL,
        analysis_version TEXT NOT NULL, computed_at TEXT NOT NULL,
        FOREIGN KEY (turn_run_id) REFERENCES turn_trace_runs(turn_run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_turn_time_summaries_session ON turn_time_summaries(session_id, ended_at DESC);
      CREATE INDEX IF NOT EXISTS idx_turn_time_summaries_work_item ON turn_time_summaries(work_item_id, ended_at DESC);
      CREATE INDEX IF NOT EXISTS idx_turn_time_summaries_objective ON turn_time_summaries(objective_id, ended_at DESC);
    `);
    const cutoff = new Date(Date.now() - this.gateway.retentionDays * 86_400_000).toISOString();
    this.store.db.run("DELETE FROM turn_trace_runs WHERE COALESCE(ended_at, started_at) < ?", [cutoff]);
    return { environment: this.gateway.environment, credentialId: this.gateway.credentialId, retentionDays: this.gateway.retentionDays };
  }

  ingestProviderEvent({ event, binding, measurement = null }) {
    if (!event?.turnId || !binding?.sessionId) return null;
    const terminal = ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type);
    const session = this.store.getSession(binding.sessionId);
    if (!session) return null;
    const row = this.store.selectOne(
      `SELECT * FROM turn_trace_runs WHERE session_id=? AND binding_id=? AND logical_turn_id=? ORDER BY started_at DESC LIMIT 1`,
      [binding.sessionId, event.bindingId, event.turnId]
    );
    const occurredAt = event.occurredAt ?? event.receivedAt ?? new Date().toISOString();
    const runId = row?.turn_run_id ?? `turn_run:${randomUUID()}`;
    const level = providerObservabilityLevel(event.payload?.observabilityLevel ?? event.payload?.telemetryMode);
    const identity = this.identityFor({ session, event, binding, turnRunId: runId });
    const previousSpans = parseJson(row?.raw_trace_json, []);
    const phase = eventSpan(event, runId, previousSpans);
    const lifecycle = measurement && measurement.projectionEndedAtMs >= measurement.projectionStartedAtMs
      ? lifecycleSpan(event, runId, measurement)
      : null;
    const spans = [phase, lifecycle].filter(Boolean).reduce(
      (items, span) => [...items, this.gateway.sanitizeSpan(span, identityAttributes(identity, level))],
      previousSpans
    );
    const startedAt = row?.started_at ?? occurredAt;
    const endedAt = terminal ? occurredAt : null;
    const timestamp = event.receivedAt ?? occurredAt;
    this.store.db.run(
      `INSERT INTO turn_trace_runs (turn_run_id,tenant_id,session_id,logical_turn_id,binding_id,provider_id,provider_session_id,
       agent_id,objective_id,work_item_id,workspace_id,observability_level,trace_id,status,retry_count,recovered,started_at,ended_at,raw_trace_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(turn_run_id) DO UPDATE SET observability_level=excluded.observability_level,status=excluded.status,
       retry_count=excluded.retry_count,recovered=excluded.recovered,ended_at=COALESCE(excluded.ended_at,turn_trace_runs.ended_at),
       raw_trace_json=excluded.raw_trace_json,updated_at=excluded.updated_at`,
      [runId, identity.tenantId, identity.sessionId, identity.logicalTurnId, identity.bindingId, identity.providerId,
       identity.providerSessionId, identity.agentId, identity.objectiveId, identity.workItemId, identity.workspaceId, level,
       spans[0]?.traceId ?? traceIdFor(runId), terminal ? event.type.slice(5) : "running",
       Number(event.payload?.retryCount ?? row?.retry_count ?? 0), event.payload?.recovered === true ? 1 : Number(row?.recovered ?? 0),
       startedAt, endedAt, JSON.stringify(spans), row?.created_at ?? timestamp, timestamp]
    );
    if (terminal) return this.computeAndPersist(runId, { fallbackStart: startedAt, fallbackEnd: endedAt });
    return { turnRunId: runId, status: "running" };
  }

  ingestOTLP(input) {
    const identity = validatedIdentity(input.identity);
    const level = providerObservabilityLevel(input.observabilityLevel ?? "native");
    const spans = extractOtlpSpans(input).map((span) => this.gateway.sanitizeSpan(span, identityAttributes(identity, level)));
    if (spans.length === 0) throw apiError("TRACE_EMPTY", "OTLP payload has no spans.", 400);
    const session = this.store.getSession(identity.sessionId);
    if (!session) throw apiError("SESSION_NOT_FOUND", "Session not found.", 404);
    const runId = identity.turnRunId;
    const start = new Date(Math.min(...spans.map((span) => Number(BigInt(span.startTimeUnixNano) / 1_000_000n)))).toISOString();
    const end = new Date(Math.max(...spans.map((span) => Number(BigInt(span.endTimeUnixNano) / 1_000_000n)))).toISOString();
    const now = new Date().toISOString();
    this.store.db.run(
      `INSERT INTO turn_trace_runs (turn_run_id,tenant_id,session_id,logical_turn_id,binding_id,provider_id,provider_session_id,
       agent_id,objective_id,work_item_id,workspace_id,observability_level,trace_id,status,retry_count,recovered,started_at,ended_at,raw_trace_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'completed',?,?,?,?,?,?,?)
       ON CONFLICT(turn_run_id) DO UPDATE SET raw_trace_json=excluded.raw_trace_json, ended_at=excluded.ended_at, status='completed', updated_at=excluded.updated_at`,
      [runId, identity.tenantId, identity.sessionId, identity.logicalTurnId, identity.bindingId, identity.providerId,
       identity.providerSessionId, identity.agentId, identity.objectiveId, identity.workItemId, identity.workspaceId, level,
       spans[0].traceId, Number(input.retryCount ?? 0), input.recovered === true ? 1 : 0, start, end, JSON.stringify(spans), now, now]
    );
    return this.computeAndPersist(runId, { errors: input.errors ?? [] });
  }

  computeAndPersist(turnRunId, { errors = [], fallbackStart, fallbackEnd } = {}) {
    const row = this.runRow(turnRunId);
    if (!row) throw apiError("TURN_RUN_NOT_FOUND", "Turn Run not found.", 404);
    let spans = parseJson(row.raw_trace_json, []);
    if (spans.length === 0 && fallbackStart && fallbackEnd) spans = [this.gateway.sanitizeSpan({
      traceId: row.trace_id, spanId: spanIdFor(`${turnRunId}:boundary`), name: "provider.boundary",
      startTimeUnixNano: millisToNano(Date.parse(fallbackStart)), endTimeUnixNano: millisToNano(Date.parse(fallbackEnd)),
      attributes: { "corptie.category": "other" }
    }, identityAttributes(identityFromRow(row), "boundary-only"))];
    const report = this.analyzer.analyze({
      identity: identityFromRow(row), spans, observabilityLevel: row.observability_level,
      errors, retryCount: row.retry_count, recovered: Boolean(row.recovered)
    });
    const now = new Date().toISOString();
    this.store.db.run(
      `INSERT INTO turn_time_summaries (turn_run_id,session_id,logical_turn_id,work_item_id,objective_id,ended_at,summary_json,analysis_version,computed_at)
       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(turn_run_id) DO UPDATE SET summary_json=excluded.summary_json,analysis_version=excluded.analysis_version,computed_at=excluded.computed_at`,
      [turnRunId, row.session_id, row.logical_turn_id, row.work_item_id, row.objective_id, report.endedAt, JSON.stringify(report), TURN_ANALYSIS_VERSION, now]
    );
    return report;
  }

  latestCompleted(sessionId) {
    this.requireSession(sessionId);
    return this.summaryFromRow(this.store.selectOne(
      `SELECT summary_json FROM turn_time_summaries WHERE session_id=? ORDER BY ended_at DESC, turn_run_id DESC LIMIT 1`, [sessionId]
    ));
  }

  turnSummary(sessionId, turnId) {
    this.requireSession(sessionId);
    return this.summaryFromRow(this.store.selectOne(
      `SELECT summary_json FROM turn_time_summaries WHERE session_id=? AND logical_turn_id=? ORDER BY ended_at DESC LIMIT 1`,
      [sessionId, turnId]
    ));
  }

  aggregate(scope, id, limit = 100) {
    const columns = { session: "session_id", "work-item": "work_item_id", objective: "objective_id" };
    const column = columns[scope];
    if (!column) throw apiError("SCOPE_INVALID", "Unsupported summary scope.", 400);
    const rows = this.store.selectAll(
      `SELECT summary_json FROM turn_time_summaries WHERE ${column}=? ORDER BY ended_at DESC LIMIT ?`,
      [id, Math.max(1, Math.min(500, Number(limit) || 100))]
    ).map((row) => JSON.parse(row.summary_json));
    return aggregateReports(scope, id, rows);
  }

  rawTrace(turnRunId) {
    const row = this.runRow(turnRunId);
    if (!row) throw apiError("TURN_RUN_NOT_FOUND", "Turn Run not found.", 404);
    return { identity: identityFromRow(row), observabilityLevel: row.observability_level, spans: parseJson(row.raw_trace_json, []) };
  }

  export(turnRunId, format = "json") {
    const trace = this.rawTrace(turnRunId);
    const summary = this.summaryFromRow(this.store.selectOne("SELECT summary_json FROM turn_time_summaries WHERE turn_run_id=?", [turnRunId]));
    if (format === "json") return { schemaVersion: 1, summary, trace };
    if (format !== "otlp") throw apiError("EXPORT_FORMAT_INVALID", "Export format must be json or otlp.", 400);
    return toOtlp(trace);
  }

  runRow(id) { return this.store.selectOne("SELECT * FROM turn_trace_runs WHERE turn_run_id=?", [id]); }
  requireSession(id) { if (!this.store.getSession(id)) throw apiError("SESSION_NOT_FOUND", "Session not found.", 404); }
  summaryFromRow(row) { if (!row) throw apiError("TURN_SUMMARY_NOT_FOUND", "Completed Turn summary not found.", 404); return JSON.parse(row.summary_json); }

  identityFor({ session, event, binding, turnRunId }) {
    return {
      tenantId: this.gateway.tenantId, sessionId: session.id, logicalTurnId: event.turnId, turnRunId,
      providerId: event.providerId, providerSessionId: event.providerSessionId, bindingId: event.bindingId,
      agentId: session.agentId ?? null, objectiveId: session.objectiveId ?? null, workItemId: session.workItemId ?? null,
      workspaceId: this.store.getLogicalSessionByLegacySessionId(session.id)?.activeWorkspaceId ?? null
    };
  }
}

function eventSpan(event, runId, existing) {
  const time = Date.parse(event.occurredAt ?? event.receivedAt);
  if (!Number.isFinite(time)) return null;
  const previous = existing.at(-1);
  const start = previous ? Number(BigInt(previous.endTimeUnixNano) / 1_000_000n) : time;
  const end = Math.max(start + 0.001, time);
  return {
    traceId: previous?.traceId ?? traceIdFor(runId), spanId: spanIdFor(`${runId}:${event.providerEventId}`),
    parentSpanId: null, name: event.type, startTimeUnixNano: millisToNano(start), endTimeUnixNano: millisToNano(end),
    status: event.type === "turn.failed" || event.type === "tool.failed" ? "error" : "ok",
    attributes: { "corptie.category": categoryForEvent(event), "corptie.operation": operationForEvent(event),
      "corptie.activity.phase": activityPhaseForEvent(event), "corptie.event.type": event.type,
      "error.code": event.payload?.error?.code, "tool.name": event.payload?.toolName, "mcp.server.name": event.payload?.mcpServer }
  };
}

function lifecycleSpan(event, runId, measurement) {
  return {
    traceId: traceIdFor(runId),
    spanId: spanIdFor(`${runId}:${event.providerEventId}:projection`),
    parentSpanId: null,
    name: "corptie.provider-event.persist",
    startTimeUnixNano: millisToNano(measurement.projectionStartedAtMs),
    endTimeUnixNano: millisToNano(Math.max(measurement.projectionStartedAtMs + 0.001, measurement.projectionEndedAtMs)),
    status: "ok",
    attributes: { "corptie.category": "persistence", "corptie.operation": "persistence", "corptie.event.type": event.type, "db.system": "sqlite" }
  };
}

function categoryForEvent(event) {
  if (operationForEvent(event) === "model.reasoning") return "model";
  if (event.type === "turn.started") return "dispatch";
  if (event.type.startsWith("tool.")) return event.payload?.mcpServer ? "mcp" : "tool";
  if (event.type.startsWith("assistant.")) return "model";
  if (event.type === "usage.updated") return "context";
  if (event.type.startsWith("user.")) return "queue";
  if (event.type.startsWith("turn.")) return "delivery";
  return "other";
}

function operationForEvent(event) {
  const item = event.rawPayload?.item ?? event.payload?.item ?? {};
  const itemType = String(item.type ?? event.payload?.item?.type ?? "");
  const tool = String(event.payload?.toolName ?? item.toolName ?? item.tool ?? "").toLowerCase();
  if (itemType === "reasoning" || itemType === "plan" || itemType === "agentMessage") return "model.reasoning";
  if (itemType === "fileChange" || itemType === "workspaceWrite") return "code.edit";
  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") return "mcp";
  if (itemType === "imageView") return "code.read";
  if (itemType === "commandExecution") return operationForCommand(item.command);
  if (event.payload?.mcpServer || tool.includes("mcp")) return "mcp";
  if (tool.includes("apply_patch") || tool.includes("write") || tool.includes("edit")) return "code.edit";
  if (tool.includes("search") || tool === "rg" || tool.includes("grep")) return "code.search";
  if (tool.includes("read") || tool.includes("open")) return "code.read";
  if (tool.includes("git")) return "git";
  if (tool.includes("test")) return "test";
  if (tool.includes("build") || tool.includes("compile")) return "build";
  if (event.type.startsWith("tool.")) return "shell";
  if (event.type.startsWith("assistant.")) return "model.reasoning";
  if (event.type === "usage.updated") return "history.read";
  if (event.type.startsWith("turn.")) return "persistence";
  return "other";
}

function operationForCommand(value) {
  const command = String(value ?? "").toLowerCase();
  if (!command) return "shell";
  if (/(^|[;&|]\s*)(rg|grep|find|fd)(\s|$)/.test(command)) return "code.search";
  if (/(^|[;&|]\s*)git(\s|$)/.test(command)) return "git";
  if (/\b(swift test|npm test|node --test|pytest|xcodebuild[^;&|]*\btest\b|cargo test|go test)\b/.test(command)) return "test";
  if (/\b(swift build|npm run build|xcodebuild|cargo build|go build|compile|linker)\b/.test(command)) return "build";
  if (/(^|[;&|]\s*)(sed|head|tail|cat|bat)(\s|$)/.test(command)) return "code.read";
  return "shell";
}

function activityPhaseForEvent(event) {
  const item = event.rawPayload?.item ?? event.payload?.item ?? {};
  const itemType = String(item.type ?? event.payload?.item?.type ?? "");
  const role = String(item.phase ?? item.presentationRole ?? event.payload?.item?.presentationRole ?? "")
    .toLowerCase().replaceAll("-", "_");
  if (itemType === "plan") return "task-planning";
  if (itemType === "reasoning") return "provider-reasoning";
  if (itemType === "agentMessage") {
    return ["final", "finalanswer", "final_answer"].includes(role) ? "result-synthesis" : "progress-update";
  }
  const operation = operationForEvent(event);
  if (operation === "history.read") return "context-loading";
  if (operation === "code.search" || operation === "code.read") return "code-navigation";
  if (operation === "code.edit") return "implementation";
  if (operation === "test" || operation === "build") return "verification";
  if (["shell", "git", "mcp"].includes(operation)) return "tool-execution";
  return "unknown";
}

function providerObservabilityLevel(value) {
  const normalized = String(value ?? "event-stream").toLowerCase();
  if (["native", "otel", "otlp"].includes(normalized)) return "native";
  if (["boundary", "boundary-only", "black-box", "blackbox"].includes(normalized)) return "boundary-only";
  return "event-stream";
}

function normalizeForAnalysis(span) {
  const startMs = Number(BigInt(span.startTimeUnixNano) / 1_000n) / 1000;
  const endMs = Number(BigInt(span.endTimeUnixNano) / 1_000n) / 1000;
  const category = TURN_CATEGORIES.includes(span.attributes?.["corptie.category"])
    ? span.attributes["corptie.category"] : "other";
  const declaredOperation = span.attributes?.["corptie.operation"];
  const operation = DEVELOPMENT_OPERATIONS.includes(declaredOperation) ? declaredOperation : inferOperation(span);
  return { ...span, startMs, endMs, durationMs: Math.max(0, endMs - startMs), category, operation };
}

function inferOperation(span) {
  const value = `${span.name ?? ""} ${span.attributes?.["tool.name"] ?? ""} ${span.attributes?.["rpc.method"] ?? ""}`.toLowerCase();
  if (/history|timeline|memory|context\.load/.test(value)) return "history.read";
  if (/search|ripgrep|\brg\b|grep|symbol\.find/.test(value)) return "code.search";
  if (/file\.read|code\.read|source\.read/.test(value)) return "code.read";
  if (/apply.patch|file\.write|code\.edit|source\.edit/.test(value)) return "code.edit";
  if (/\bgit\b/.test(value)) return "git";
  if (/\btest\b|xctest/.test(value)) return "test";
  if (/build|compile|linker/.test(value)) return "build";
  if (/mcp/.test(value)) return "mcp";
  if (/model|assistant|reason|gen.ai/.test(value)) return "model.reasoning";
  if (/persist|sqlite|database|summary/.test(value)) return "persistence";
  if (/shell|exec|terminal|process/.test(value)) return "shell";
  return "other";
}

function criticalForestMs(roots, children) {
  const weight = (span) => {
    const directChildren = children.get(span.spanId) ?? [];
    const childCoverage = intervalUnionMs(directChildren.map((child) => [child.startMs, child.endMs]));
    return Math.max(0, span.durationMs - childCoverage)
      + maximumNonOverlappingWeight(directChildren, weight);
  };
  return maximumNonOverlappingWeight(roots, weight);
}

function maximumNonOverlappingWeight(spans, weight) {
  const sorted = [...spans].sort((left, right) => left.endMs - right.endMs || left.startMs - right.startMs);
  const best = new Array(sorted.length + 1).fill(0);
  for (let index = 1; index <= sorted.length; index += 1) {
    const current = sorted[index - 1];
    let previous = index - 1;
    while (previous > 0 && sorted[previous - 1].endMs > current.startMs) previous -= 1;
    best[index] = Math.max(best[index - 1], best[previous] + weight(current));
  }
  return best.at(-1) ?? 0;
}

function intervalUnionMs(intervals) {
  const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return 0;
  let total = 0, [start, end] = sorted[0];
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else { total += end - start; start = nextStart; end = nextEnd; }
  }
  return total + end - start;
}

function completeness(level, spans, unattributed, wall) {
  const ratio = wall > 0 ? Math.max(0, Math.min(1, 1 - unattributed / wall)) : 1;
  return { status: level === "boundary-only" ? "boundary-only" : ratio >= 0.98 ? "complete" : ratio >= 0.7 ? "partial" : "sparse",
    coverageRatio: round(ratio), exact: level !== "boundary-only", spanCount: spans.length };
}

function aggregateReports(scope, id, reports) {
  const total = Object.fromEntries(TURN_CATEGORIES.map((category) => [category, 0]));
  const operations = Object.fromEntries(DEVELOPMENT_OPERATIONS.map((operation) => [operation, 0]));
  for (const report of reports) {
    for (const category of TURN_CATEGORIES) total[category] += report.categories?.[category]?.inclusiveMs ?? report.categories?.[category]?.estimateMs ?? 0;
    for (const operation of DEVELOPMENT_OPERATIONS) operations[operation] += report.developmentOperations?.[operation]?.inclusiveMs ?? report.developmentOperations?.[operation]?.estimateMs ?? 0;
  }
  for (const category of TURN_CATEGORIES) total[category] = round(total[category]);
  for (const operation of DEVELOPMENT_OPERATIONS) operations[operation] = round(operations[operation]);
  return { scope, id, turnCount: reports.length, wallClockMs: round(reports.reduce((sum, report) => sum + report.wallClockMs, 0)), categories: total, developmentOperations: operations, latestTurn: reports[0] ?? null };
}

function detectAnomalies({ wallClockMs, unattributedMs, inclusiveMs, errors, retryCount }) {
  const anomalies = [];
  if (wallClockMs > 0 && unattributedMs / wallClockMs > 0.2) anomalies.push({ code: "HIGH_UNATTRIBUTED_TIME", severity: "warning" });
  if (Number(retryCount) > 0) anomalies.push({ code: "TURN_RETRIED", severity: "info", count: Number(retryCount) });
  if (errors.length > 0) anomalies.push({ code: "TURN_ERRORS", severity: "error", count: errors.length });
  const dominant = TURN_CATEGORIES.map((category) => [category, inclusiveMs[category]])
    .sort((left, right) => right[1] - left[1])[0];
  if (wallClockMs > 0 && dominant?.[1] / wallClockMs > 0.8) anomalies.push({ code: "DOMINANT_STAGE", severity: "info", category: dominant[0] });
  return anomalies;
}

function identityAttributes(identity, level) {
  return Object.fromEntries(Object.entries({ "corptie.tenant.id": identity.tenantId, "corptie.session.id": identity.sessionId,
    "corptie.logical_turn.id": identity.logicalTurnId, "corptie.turn_run.id": identity.turnRunId,
    "corptie.provider.id": identity.providerId, "corptie.provider_session.id": identity.providerSessionId,
    "corptie.binding.id": identity.bindingId, "corptie.agent.id": identity.agentId, "corptie.objective.id": identity.objectiveId,
    "corptie.work_item.id": identity.workItemId, "corptie.workspace.id": identity.workspaceId,
    "corptie.observability_level": level }).filter(([, value]) => value != null));
}

function validatedIdentity(value = {}) {
  const required = ["tenantId", "sessionId", "logicalTurnId", "turnRunId", "providerId", "bindingId"];
  for (const field of required) if (typeof value[field] !== "string" || !value[field].trim()) throw apiError("IDENTITY_INVALID", `${field} is required.`, 400);
  return { tenantId: value.tenantId, sessionId: value.sessionId, logicalTurnId: value.logicalTurnId, turnRunId: value.turnRunId,
    providerId: value.providerId, providerSessionId: value.providerSessionId ?? null, bindingId: value.bindingId,
    agentId: value.agentId ?? null, objectiveId: value.objectiveId ?? null, workItemId: value.workItemId ?? null, workspaceId: value.workspaceId ?? null };
}

function identityFromRow(row) { return { tenantId: row.tenant_id, sessionId: row.session_id, logicalTurnId: row.logical_turn_id,
  turnRunId: row.turn_run_id, providerId: row.provider_id, providerSessionId: row.provider_session_id, bindingId: row.binding_id,
  agentId: row.agent_id, objectiveId: row.objective_id, workItemId: row.work_item_id, workspaceId: row.workspace_id }; }

function extractOtlpSpans(input) {
  if (Array.isArray(input.spans)) return input.spans;
  return (input.resourceSpans ?? []).flatMap((resource) => (resource.scopeSpans ?? resource.scope_spans ?? [])
    .flatMap((scope) => scope.spans ?? []));
}

function toOtlp(trace) { return { resourceSpans: [{ resource: { attributes: Object.entries(identityAttributes(trace.identity, trace.observabilityLevel)).map(([key, value]) => ({ key, value: otlpValue(value) })) },
  scopeSpans: [{ scope: { name: "corptie.turn-observability", version: TURN_ANALYSIS_VERSION }, spans: trace.spans.map((span) => ({ traceId: span.traceId, spanId: span.spanId,
    parentSpanId: span.parentSpanId || undefined, name: span.name, startTimeUnixNano: span.startTimeUnixNano, endTimeUnixNano: span.endTimeUnixNano,
    attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: otlpValue(value) })) })) }] }] }; }
function otlpValue(value) { return typeof value === "boolean" ? { boolValue: value } : typeof value === "number" ? { doubleValue: value } : { stringValue: String(value) }; }
function normalizedAttributes(value) { if (!Array.isArray(value)) return value && typeof value === "object" ? value : {};
  return Object.fromEntries(value.map((item) => [item.key, item.value?.stringValue ?? item.value?.intValue ?? item.value?.doubleValue ?? item.value?.boolValue]).filter(([key]) => key)); }
function normalizedEvents(events, gateway) { return (Array.isArray(events) ? events : []).slice(0, 100).map((event) => ({ name: safeName(event.name),
  timeUnixNano: nanoString(event.timeUnixNano ?? event.time_unix_nano), attributes: gateway.sanitizeAttributes(normalizedAttributes(event.attributes)) })); }
function normalizedStatus(status) { const code = typeof status === "object" ? status.code : status; return String(code ?? "unset").toLowerCase().includes("error") || Number(code) === 2 ? "error" : "ok"; }
function safeError(error) { return { code: String(error?.code ?? "UNKNOWN").slice(0, 120), type: String(error?.type ?? "error").slice(0, 120), message: "redacted" }; }
function safeId(value, max, field) { const text = String(value ?? "").trim(); if (!text || text.length > max || !/^[\w:.-]+$/.test(text)) throw new Error(`${field} is invalid.`); return text; }
function optionalId(value, max) { return value == null || value === "" ? null : safeId(value, max, "parentSpanId"); }
function safeName(value) {
  const name = String(value ?? "span").trim();
  return name && name.length <= 160 && /^[A-Za-z0-9_.:/-]+$/.test(name) ? name : "redacted.operation";
}
function safeRelativeCodePath(value) {
  const path = String(value ?? "").trim().replaceAll("\\", "/");
  if (!path || path.length > 500 || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return null;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}
function nanoString(value) { if (typeof value === "string" && /^\d+$/.test(value)) return value; if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(Math.trunc(value)); throw new Error("Invalid nanosecond timestamp."); }
function millisToNano(value) { return String(BigInt(Math.round(value * 1000)) * 1_000_000n / 1000n); }
function traceIdFor(value) { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
function spanIdFor(value) { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function round(value) { return Math.round(value * 1000) / 1000; }
function parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function apiError(code, message, statusCode) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
