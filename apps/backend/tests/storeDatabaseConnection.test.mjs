import test from "node:test";
import assert from "node:assert/strict";
import { configureStoreDatabase } from "../src/store/storeDatabaseConnection.mjs";

test("writable connections retain WAL durability and integrity pragmas", () => {
  const statements = [];
  configureStoreDatabase({ run: (sql) => statements.push(sql) });
  assert.deepEqual(statements, [
    "PRAGMA journal_mode = WAL", "PRAGMA synchronous = FULL",
    "PRAGMA busy_timeout = 5000", "PRAGMA foreign_keys = ON"
  ]);
});

test("read workers set query-only and bounded cache without writable pragmas", () => {
  const statements = [];
  configureStoreDatabase({ run: (sql) => statements.push(sql) }, {
    readOnly: true, readCacheSizeKiB: 1, readMmapSizeBytes: -1
  });
  assert.deepEqual(statements, [
    "PRAGMA query_only = ON", "PRAGMA cache_size = -1024", "PRAGMA mmap_size = 0",
    "PRAGMA temp_store = MEMORY", "PRAGMA busy_timeout = 5000", "PRAGMA foreign_keys = ON"
  ]);
});
