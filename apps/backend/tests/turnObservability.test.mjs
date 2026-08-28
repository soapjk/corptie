import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { TelemetryGateway, TurnObservabilityService, TurnTraceAnalyzer, TURN_CATEGORIES } from "../src/observability/turnObservability.mjs";
import { handleTurnObservabilityHttpRequest } from "../src/observability/turnObservabilityHttpApi.mjs";

const nano = (milliseconds) => String(BigInt(milliseconds) * 1_000_000n);
const span = (id, start, end, category, parentSpanId = null) => ({
  traceId: "trace-1", spanId: id, parentSpanId, name: `${category}.operation`,
  startTimeUnixNano: nano(start), endTimeUnixNano: nano(end), status: "ok",
  attributes: { "corptie.category": category }, events: []
});
const identity = {
  tenantId: "tenant:test", sessionId: "session:test", logicalTurnId: "turn:test", turnRunId: "turn_run:test",
  providerId: "codex-app-server", providerSessionId: "provider-session:test", bindingId: "binding:test",
  agentId: "agent:test", objectiveId: "objective:test", workItemId: "work-item:test", workspaceId: "worktree:test"
};

test("analyzer preserves identity and handles nested and parallel spans without double-counting wall time", () => {
  const report = new TurnTraceAnalyzer().analyze({ identity, observabilityLevel: "native", spans: [
    span("root", 0, 100, "dispatch"),
    span("model", 10, 80, "model", "root"),
    { ...span("tool-a", 20, 60, "tool", "model"), name: "code.search", attributes: {
      "corptie.category": "tool", "corptie.operation": "code.search",
      "code.file.path": "apps/backend/src/server.mjs", "code.line.number": 6985, "code.function.name": "route"
    } },
    span("mcp-b", 20, 70, "mcp", "model"),
    span("delivery", 90, 100, "delivery", "root")
  ], errors: [{ code: "RETRIED", message: "must not leak" }], retryCount: 1, recovered: true });
  assert.equal(report.wallClockMs, 100);
  assert.equal(report.inclusiveMs.dispatch, 100);
  assert.equal(report.inclusiveMs.model, 70);
  assert.equal(report.inclusiveMs.tool, 40);
  assert.equal(report.inclusiveMs.mcp, 50);
  assert.equal(report.developmentOperations["code.search"].inclusiveMs, 40);
  assert.equal(report.criticalPathMs, 100);
  assert.equal(report.unattributedMs, 0);
  assert.equal(report.retryCount, 1);
  assert.equal(report.recovered, true);
  assert.equal(report.errors[0].message, "redacted");
  assert.equal(report.turnRunId, identity.turnRunId);
});

test("analyzer exposes gaps as unattributed and boundary-only values only as estimates", () => {
  const analyzer = new TurnTraceAnalyzer();
  const exact = analyzer.analyze({ identity, observabilityLevel: "event-stream", spans: [
    span("first", 0, 20, "queue"), span("second", 50, 100, "model")
  ] });
  assert.equal(exact.wallClockMs, 100);
  assert.equal(exact.unattributedMs, 30);
  const boundary = analyzer.analyze({ identity, observabilityLevel: "boundary-only", spans: [span("boundary", 0, 100, "other")] });
  assert.equal(boundary.inclusiveMs, null);
  assert.equal(boundary.criticalPathMs, null);
  assert.equal(boundary.categories.other.precise, false);
  assert.equal(boundary.categories.other.estimateMs, 100);
  assert.equal(boundary.dataCompleteness.status, "boundary-only");
});

test("gateway applies a strict whitelist and strips prompts, output, files, shell, tokens, cookies, and auth", () => {
  const gateway = new TelemetryGateway({ environment: "development", tenantId: "tenant:test" });
  const sanitized = gateway.sanitizeSpan({
    traceId: "trace-safe", spanId: "span-safe", name: "model.operation", startTimeUnixNano: nano(0), endTimeUnixNano: nano(1),
    attributes: {
      "corptie.session.id": "session:test", "corptie.category": "model", "gen_ai.request.model": "gpt-test",
      "corptie.operation": "code.read", "code.file.path": "apps/backend/src/server.mjs", "code.line.number": 6985,
      "code.function.name": "route",
      "user.prompt": "secret prompt", "model.output": "secret output", "file.content": "secret file",
      "shell.command": "rm anything", "authorization": "Bearer secret", "cookie": "secret", "api_key": "secret",
      "unknown.personal_data": "secret"
    }, events: [{ name: "safe.event", timeUnixNano: nano(0), attributes: { "message.content": "secret", "error.code": "SAFE_CODE" } }]
  });
  assert.deepEqual(Object.keys(sanitized.attributes).sort(), [
    "code.file.path", "code.function.name", "code.line.number", "corptie.category", "corptie.environment",
    "corptie.operation", "corptie.session.id", "corptie.tenant.id", "gen_ai.request.model"
  ]);
  assert.deepEqual(sanitized.events[0].attributes, { "error.code": "SAFE_CODE", "corptie.tenant.id": "tenant:test", "corptie.environment": "development" });
  assert.equal(JSON.stringify(sanitized).includes("secret"), false);
  assert.equal(gateway.sanitizeAttributes({ "code.file.path": "/Users/person/private.swift" })["code.file.path"], undefined);
  assert.equal(gateway.sanitizeAttributes({ "code.file.path": "../outside.swift" })["code.file.path"], undefined);
});

test("development and production gateways use independent credential and retention policies", () => {
  const development = new TelemetryGateway({ environment: "development" });
  const production = new TelemetryGateway({ environment: "production" });
  assert.notEqual(development.credentialId, production.credentialId);
  assert.notEqual(development.retentionDays, production.retentionDays);
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-turn-observability-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  store.upsertSession({ id: "session:test", title: "Observed", agent: "Agent", provider: "provider:test", status: "complete", summary: "done" });
  const service = new TurnObservabilityService({ store, environment: "test", tenantId: "tenant:test" });
  const configuration = service.initialize();
  return { directory, store, service, configuration };
}

function otlpInput(overrides = {}) {
  return { identity, observabilityLevel: "native", spans: [
    span("queue", 1_000, 1_010, "queue"), span("dispatch", 1_010, 1_020, "dispatch"),
    span("context", 1_020, 1_030, "context"), span("model", 1_030, 1_080, "model"),
    span("tool", 1_040, 1_060, "tool", "model"), span("mcp", 1_045, 1_055, "mcp", "tool"),
    span("persistence", 1_080, 1_090, "persistence"), span("delivery", 1_090, 1_100, "delivery"),
    span("other", 1_025, 1_027, "other")
  ], ...overrides };
}

test("service persists precomputed summaries, resolves latest completed Turn, aggregates every scope and exports JSON/OTLP", async () => {
  const { directory, store, service, configuration } = await fixture();
  try {
    assert.equal(configuration.credentialId, "corptie-otlp-test");
    assert.equal(configuration.retentionDays, 3);
    const report = service.ingestOTLP(otlpInput());
    assert.equal(report.wallClockMs, 100);
    assert.deepEqual(Object.keys(report.categories), [...TURN_CATEGORIES]);
    assert.equal(service.latestCompleted(identity.sessionId).turnRunId, identity.turnRunId);
    assert.equal(service.turnSummary(identity.sessionId, identity.logicalTurnId).logicalTurnId, identity.logicalTurnId);
    const sessionAggregate = service.aggregate("session", identity.sessionId);
    assert.equal(sessionAggregate.turnCount, 1);
    assert.ok(sessionAggregate.developmentOperations["model.reasoning"] > 0);
    assert.equal(service.aggregate("work-item", identity.workItemId).turnCount, 1);
    assert.equal(service.aggregate("objective", identity.objectiveId).turnCount, 1);
    const trace = service.rawTrace(identity.turnRunId);
    assert.equal(trace.spans.length, 9);
    assert.equal(trace.spans.every((item) => item.attributes["corptie.session.id"] === identity.sessionId), true);
    assert.equal(trace.spans.every((item) => item.attributes["corptie.logical_turn.id"] === identity.logicalTurnId), true);
    assert.equal(trace.spans.every((item) => item.attributes["corptie.turn_run.id"] === identity.turnRunId), true);
    assert.equal(trace.identity.providerId, "codex-app-server");
    assert.equal(service.export(identity.turnRunId, "json").summary.turnRunId, identity.turnRunId);
    assert.equal(service.export(identity.turnRunId, "otlp").resourceSpans[0].scopeSpans[0].spans.length, 9);
    const persisted = JSON.stringify(service.rawTrace(identity.turnRunId));
    for (const forbidden of ["prompt", "completion", "file.content", "shell.command", "authorization", "cookie", "api_key"]) {
      assert.equal(persisted.includes(forbidden), false);
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("provider event adapter creates an independent run id and event-stream summary for the latest completed Turn", async () => {
  const { directory, store, service } = await fixture();
  try {
    const binding = { sessionId: "session:test", bindingId: "binding:event", providerId: "codex-app-server", providerSessionId: "codex:thread", logicalSessionId: "logical:test" };
    const base = { providerId: binding.providerId, providerSessionId: binding.providerSessionId, bindingId: binding.bindingId,
      turnId: "turn:event", payload: {}, receivedAt: "2026-08-28T02:00:00.000Z" };
    service.ingestProviderEvent({ event: { ...base, type: "turn.started", providerEventId: "e1", occurredAt: "2026-08-28T02:00:00.000Z" }, binding });
    service.ingestProviderEvent({ event: { ...base, type: "assistant.message.started", providerEventId: "e2", occurredAt: "2026-08-28T02:00:01.000Z" }, binding });
    const report = service.ingestProviderEvent({ event: { ...base, type: "turn.completed", providerEventId: "e3", occurredAt: "2026-08-28T02:00:02.000Z" }, binding });
    assert.match(report.turnRunId, /^turn_run:/);
    assert.equal(report.logicalTurnId, "turn:event");
    assert.equal(report.providerId, "codex-app-server");
    assert.equal(report.observabilityLevel, "event-stream");
    assert.equal(report.wallClockMs, 2_000);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("black-box Provider events persist boundary-only estimates and never claim exact timings", async () => {
  const { directory, store, service } = await fixture();
  try {
    const binding = { sessionId: "session:test", bindingId: "binding:black-box", providerId: "provider:black-box", providerSessionId: "black-box:thread" };
    const base = { providerId: binding.providerId, providerSessionId: binding.providerSessionId, bindingId: binding.bindingId,
      turnId: "turn:black-box", payload: { telemetryMode: "black-box" }, receivedAt: "2026-08-28T02:10:00.000Z" };
    service.ingestProviderEvent({ event: { ...base, type: "turn.started", providerEventId: "black-1", occurredAt: "2026-08-28T02:10:00.000Z" }, binding });
    const report = service.ingestProviderEvent({ event: { ...base, type: "turn.completed", providerEventId: "black-2", occurredAt: "2026-08-28T02:10:02.000Z" }, binding });
    assert.equal(report.observabilityLevel, "boundary-only");
    assert.equal(report.inclusiveMs, null);
    assert.equal(report.criticalPathMs, null);
    assert.equal(report.categories.delivery.precise, false);
    assert.ok(report.estimatedCriticalPathMs >= 0);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("summary endpoint stays below 200ms under normal local load and raw trace remains explicitly on-demand", async () => {
  const { directory, store, service } = await fixture();
  try {
    service.ingestOTLP(otlpInput());
    const request = { method: "GET" };
    const response = { status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    const url = new URL("http://localhost/sessions/session%3Atest/turn-observability/latest");
    const started = performance.now();
    for (let index = 0; index < 100; index += 1) {
      response.body = "";
      assert.equal(handleTurnObservabilityHttpRequest({ request, response, url, service }), true);
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).summary.turnRunId, identity.turnRunId);
    }
    const averageMs = (performance.now() - started) / 100;
    assert.ok(averageMs < 200, `average summary latency ${averageMs}ms`);
    assert.equal(response.body.includes("\"spans\""), false);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
