import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { queryCallerSource, SqliteQueryObservability } from "./queryObservability.mjs";

export class NativeDatabase {
  constructor(path, options = {}) {
    this.database = new DatabaseSync(path, { readOnly: options.readOnly === true });
    this.rowsModified = 0;
    this.observability = new SqliteQueryObservability();
    this.writeBlocked = false;
  }

  run(sql, params = []) {
    if (this.writeBlocked && isMutatingSQL(sql)) {
      const error = new Error("Persistent writes are paused while the data root is being migrated.");
      error.code = "DATA_ROOT_MIGRATION_IN_PROGRESS";
      error.statusCode = 503;
      throw error;
    }
    return this.observability.measure(sql, queryCallerSource(), "run", () => {
      const bindings = normalizeSqliteBindings(params);
      if (bindings.length > 0) {
        const result = this.database.prepare(sql).run(...bindings);
        this.rowsModified = Number(result.changes);
        return;
      }

      this.database.exec(sql);
      const result = this.database.prepare("SELECT changes() AS changes").get();
      this.rowsModified = Number(result?.changes ?? 0);
    });
  }

  setWriteBlocked(blocked) {
    this.writeBlocked = blocked === true;
  }

  all(sql, params = [], source = "unknown") {
    return this.observability.measure(sql, source, "selectAll", ({ addRows }) => {
      const rows = this.database.prepare(sql).all(...normalizeSqliteBindings(params));
      for (const row of rows) normalizeSqliteRowPrototype(row);
      addRows(rows);
      return rows;
    });
  }

  get(sql, params = [], source = "unknown") {
    return this.observability.measure(sql, source, "selectOne", ({ addRow }) => {
      const row = this.database.prepare(sql).get(...normalizeSqliteBindings(params)) ?? null;
      if (row) {
        normalizeSqliteRowPrototype(row);
        addRow(row);
      }
      return row;
    });
  }

  *iterate(sql, params = [], source = "unknown") {
    const startedAt = performance.now();
    let rowCount = 0;
    let estimatedResultBytes = 0;
    const iterator = this.database.prepare(sql).iterate(...normalizeSqliteBindings(params));
    try {
      for (const row of iterator) {
        normalizeSqliteRowPrototype(row);
        rowCount += 1;
        estimatedResultBytes += estimateSqliteRowBytes(row);
        yield row;
      }
    } finally {
      iterator.return?.();
      this.observability.record({
        sql,
        source,
        operation: "iterate",
        durationMilliseconds: performance.now() - startedAt,
        rowCount,
        estimatedResultBytes
      });
    }
  }

  queryMetrics(options = {}) {
    return this.observability.snapshot(options);
  }

  resetEventLoopDelayMetrics() {
    this.observability.resetEventLoopDelay();
  }

  getRowsModified() {
    return this.rowsModified;
  }

  checkpoint() {
    this.database.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  close() {
    this.observability.close();
    this.database.close();
  }
}

function estimateSqliteRowBytes(row) {
  let bytes = 0;
  for (const [key, value] of Object.entries(row ?? {})) {
    bytes += Buffer.byteLength(key);
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    else if (value instanceof Uint8Array) bytes += value.byteLength;
    else if (value != null) bytes += 8;
  }
  return bytes;
}

function normalizeSqliteRowPrototype(row) {
  // node:sqlite returns null-prototype records. Preserve the Store's historical
  // plain-object contract by mutating only the prototype; unlike `{ ...row }`,
  // this does not allocate or copy every column of every result row.
  if (Object.getPrototypeOf(row) === null) Object.setPrototypeOf(row, Object.prototype);
  return row;
}

function normalizeSqliteBindings(params) {
  return (Array.isArray(params) ? params : [params]).map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  });
}

function isMutatingSQL(sql) {
  const normalized = String(sql ?? "").trim().replace(/^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, "").toUpperCase();
  return !/^(?:SELECT|PRAGMA\s+(?:TABLE_INFO|INDEX_LIST|INDEX_INFO|QUICK_CHECK|INTEGRITY_CHECK|FOREIGN_KEY_CHECK)|EXPLAIN)\b/.test(normalized);
}
