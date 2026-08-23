import { performance } from "node:perf_hooks";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { StateSyncService } from "../src/application/stateSyncService.mjs";

const directory = await mkdtemp(join(tmpdir(), "corptie-sqlite-performance-"));
const dbPath = join(directory, "corptie.sqlite");
const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });

try {
  await store.initialize();
  store.upsertSession({
    id: "performance-session",
    title: "Performance",
    agent: "Benchmark",
    provider: "codex-app-server",
    status: "complete"
  });

  const scales = [];
  for (const target of [300_000, 500_000]) {
    const existing = Number(store.selectOne(
      "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?",
      ["performance-session"]
    ).count);
    if (existing < target) seedEvents(store, existing + 1, target);

    const cursorDurations = measure(50, () => store.listSessionMessageCursors());
    const firstPageDurations = measure(50, () => store.listSessionEventPage(
      "performance-session",
      { limit: 200 }
    ));
    const historyPageDurations = measure(50, () => store.listSessionEventPage(
      "performance-session",
      { beforeSequence: target - 10_000, limit: 200 }
    ));
    const plans = explainHotQueries(store);
    scales.push({
      events: target,
      databaseBytes: (await stat(dbPath)).size,
      cursorP95Milliseconds: percentile(cursorDurations, 0.95),
      firstPageP95Milliseconds: percentile(firstPageDurations, 0.95),
      historyPageP95Milliseconds: percentile(historyPageDurations, 0.95),
      plans
    });
  }

  const stateSync = benchmarkStateSyncClients();
  await new Promise((resolve) => setImmediate(resolve));
  store.resetEventLoopDelayMetrics();
  for (let index = 0; index < 20; index += 1) {
    store.listSessionMessageCursors();
    store.listSessionEventPage("performance-session", { limit: 200 });
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const queryMetrics = store.queryMetrics({ limit: 20 });
  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    node: process.version,
    scales,
    stateSync,
    eventLoopDelayMilliseconds: queryMetrics.eventLoopDelayMilliseconds,
    topReadQueries: queryMetrics.queries.filter((query) => query.operation !== "run")
  }, null, 2)}\n`);
} finally {
  await store.close();
  await rm(directory, { recursive: true, force: true });
}

function seedEvents(targetStore, start, target) {
  // One setup statement keeps fixture generation out of the measured hot read
  // paths. Product reads below still go through the instrumented Store API.
  targetStore.db.run(`
    WITH RECURSIVE generated(sequence) AS (
      SELECT ?
      UNION ALL SELECT sequence + 1 FROM generated WHERE sequence < ?
    )
    INSERT INTO session_events (
      event_id, session_id, log_id, sequence, type, producer, surface,
      source_event_seqs_json, call_id, source_json, payload_json,
      has_agent_message, created_at
    )
    SELECT 'benchmark:' || sequence, 'performance-session', 'log:performance-session',
           sequence,
           CASE WHEN sequence % 1000 = 0 THEN 'AgentTurnCompleted' ELSE 'tool/call' END,
           'benchmark', 0, NULL, NULL, NULL, '{}',
           CASE WHEN sequence % 1000 = 0 THEN 1 ELSE 0 END,
           '2026-01-01T00:00:00.000Z'
    FROM generated
  `, [start, target]);
}

function explainHotQueries(targetStore) {
  const cursor = targetStore.selectAll(`EXPLAIN QUERY PLAN
    SELECT session_id, MAX(sequence)
    FROM session_events WHERE has_agent_message = 1 GROUP BY session_id`)
    .map((row) => row.detail);
  const timeline = targetStore.selectAll(`EXPLAIN QUERY PLAN
    SELECT event_id, sequence FROM session_events
    WHERE session_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`,
  ["performance-session", 250_000, 200]).map((row) => row.detail);
  return { cursor, timeline };
}

function benchmarkStateSyncClients() {
  const results = [];
  for (const clients of [1, 3, 5]) {
    let projections = 0;
    const service = new StateSyncService({
      store: {
        stateRevision: () => 1,
        oldestStateChangeRevision: () => 1,
        stateChangesAfter: () => [{
          revision: 1,
          entityType: "session",
          entityId: "performance-session",
          operation: "upsert"
        }]
      },
      snapshot: () => {
        projections += 1;
        return { sessions: [{ id: "performance-session", status: "complete" }] };
      }
    });
    for (let index = 0; index < clients; index += 1) service.snapshot();
    results.push({ clients, snapshotBuilds: projections });
  }
  return results;
}

function measure(iterations, operation) {
  const durations = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    operation();
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

function percentile(values, fraction) {
  const sorted = values.toSorted((left, right) => left - right);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 1000) / 1000;
}
