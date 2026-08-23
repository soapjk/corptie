import { createHash } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const MAX_DURATION_SAMPLES = 512;
const DEFAULT_SLOW_QUERY_MS = 50;

export class SqliteQueryObservability {
  constructor({ slowQueryMilliseconds = DEFAULT_SLOW_QUERY_MS, logger = console } = {}) {
    this.slowQueryMilliseconds = slowQueryMilliseconds;
    this.logger = logger;
    this.metrics = new Map();
    this.eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopDelay.enable();
  }

  measure(sql, source, operation, execute) {
    const startedAt = performance.now();
    let rowCount = 0;
    let estimatedResultBytes = 0;
    try {
      return execute({
        addRow: (row) => {
          rowCount += 1;
          estimatedResultBytes += estimateRowBytes(row);
        },
        addRows: (rows) => {
          rowCount += rows.length;
          for (const row of rows) estimatedResultBytes += estimateRowBytes(row);
        }
      });
    } finally {
      this.record({
        sql,
        source,
        operation,
        durationMilliseconds: performance.now() - startedAt,
        rowCount,
        estimatedResultBytes
      });
    }
  }

  record({ sql, source, operation, durationMilliseconds, rowCount, estimatedResultBytes }) {
    const normalizedSql = normalizeSql(sql);
    const fingerprint = createHash("sha256").update(normalizedSql).digest("hex").slice(0, 16);
    const key = `${operation}\0${fingerprint}\0${source}`;
    let metric = this.metrics.get(key);
    if (!metric) {
      metric = {
        fingerprint,
        normalizedSql: normalizedSql.length > 2_000
          ? `${normalizedSql.slice(0, 2_000)} …[truncated]`
          : normalizedSql,
        operation,
        source,
        calls: 0,
        totalMilliseconds: 0,
        maxMilliseconds: 0,
        totalRows: 0,
        estimatedResultBytes: 0,
        durations: []
      };
      this.metrics.set(key, metric);
    }
    metric.calls += 1;
    metric.totalMilliseconds += durationMilliseconds;
    metric.maxMilliseconds = Math.max(metric.maxMilliseconds, durationMilliseconds);
    metric.totalRows += rowCount;
    metric.estimatedResultBytes += estimatedResultBytes;
    metric.durations.push(durationMilliseconds);
    if (metric.durations.length > MAX_DURATION_SAMPLES) metric.durations.shift();

    if (durationMilliseconds >= this.slowQueryMilliseconds) {
      // Deliberately log only a one-way fingerprint and structural metadata.
      // Parameters, SQL literals, message text and payloads never enter this log.
      this.logger.warn?.(`[sqlite-slow] ${JSON.stringify({
        fingerprint,
        operation,
        source,
        durationMilliseconds: round(durationMilliseconds),
        rowCount,
        estimatedResultBytes
      })}`);
    }
  }

  snapshot({ limit = 100 } = {}) {
    const queries = [...this.metrics.values()]
      .sort((left, right) => right.totalMilliseconds - left.totalMilliseconds)
      .slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)))
      .map((metric) => ({
        fingerprint: metric.fingerprint,
        normalizedSql: metric.normalizedSql,
        operation: metric.operation,
        source: metric.source,
        calls: metric.calls,
        totalMilliseconds: round(metric.totalMilliseconds),
        averageMilliseconds: round(metric.totalMilliseconds / metric.calls),
        p95Milliseconds: round(percentile(metric.durations, 0.95)),
        maxMilliseconds: round(metric.maxMilliseconds),
        totalRows: metric.totalRows,
        estimatedResultBytes: metric.estimatedResultBytes
      }));
    const delay = this.eventLoopDelay;
    return {
      collectedAt: new Date().toISOString(),
      queries,
      eventLoopDelayMilliseconds: {
        mean: nanosecondsToMilliseconds(delay.mean),
        p50: nanosecondsToMilliseconds(delay.percentile(50)),
        p95: nanosecondsToMilliseconds(delay.percentile(95)),
        p99: nanosecondsToMilliseconds(delay.percentile(99)),
        max: nanosecondsToMilliseconds(delay.max)
      }
    };
  }

  resetEventLoopDelay() {
    this.eventLoopDelay.reset();
  }

  close() {
    this.eventLoopDelay.disable();
  }
}

export function queryCallerSource(stack = new Error().stack) {
  const lines = String(stack ?? "").split("\n").slice(1);
  const caller = lines.find((line) =>
    !line.includes("queryObservability.mjs")
    && !line.includes("CorptieStore.selectAll")
    && !line.includes("CorptieStore.selectOne")
    && !line.includes("CorptieStore.iterate")
    && !line.includes("NativeDatabase.run")
    && !line.includes("node:internal")
  );
  if (!caller) return "unknown";
  const match = caller.match(/(?:at\s+)?([^(/]+)?\s*\(?([^()]+:\d+):\d+\)?$/);
  if (!match) return "unknown";
  const functionName = match[1]?.trim() || "anonymous";
  const location = match[2]
    .replace(/^.*\/apps\/backend\//, "apps/backend/")
    .replace(/:\d+$/, "");
  return `${functionName}@${location}`;
}

export function normalizeSql(sql) {
  return String(sql)
    .replace(/'(?:''|[^'])*'/g, "?")
    .replace(/"(?:""|[^"])*"/g, "?")
    .replace(/\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b/gi, "?")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function estimateRowBytes(row) {
  if (!row || typeof row !== "object") return 0;
  let bytes = 0;
  for (const [key, value] of Object.entries(row)) {
    bytes += Buffer.byteLength(key);
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    else if (value instanceof Uint8Array) bytes += value.byteLength;
    else if (value != null) bytes += 8;
  }
  return bytes;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function nanosecondsToMilliseconds(value) {
  return round(Number.isFinite(value) ? value / 1_000_000 : 0);
}

function round(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}
