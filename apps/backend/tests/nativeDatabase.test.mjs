import assert from "node:assert/strict";
import test from "node:test";
import { NativeDatabase } from "../src/store/nativeDatabase.mjs";

test("native database preserves bindings, row objects and rollback on one connection", () => {
  const db = new NativeDatabase(":memory:");
  try {
    db.run("CREATE TABLE sample (flag INTEGER, optional TEXT)");
    db.run("INSERT INTO sample VALUES (?, ?)", [true, undefined]);
    assert.equal(db.getRowsModified(), 1);
    assert.deepEqual(db.get("SELECT * FROM sample"), { flag: 1, optional: null });
    assert.deepEqual(db.all("SELECT * FROM sample"), [{ flag: 1, optional: null }]);
    db.run("BEGIN");
    db.run("INSERT INTO sample VALUES (?, ?)", [false, "rolled back"]);
    db.run("ROLLBACK");
    assert.deepEqual([...db.iterate("SELECT * FROM sample")], [{ flag: 1, optional: null }]);
    assert.equal(db.get("SELECT * FROM sample WHERE flag = ?", false), null);
  } finally {
    db.close();
  }
});

test("write pause and early iteration retain errors and observability", () => {
  const db = new NativeDatabase(":memory:");
  try {
    db.run("CREATE TABLE sample (id INTEGER)");
    db.run("INSERT INTO sample VALUES (1), (2)");
    db.setWriteBlocked(true);
    assert.throws(() => db.run("INSERT INTO sample VALUES (3)"), {
      code: "DATA_ROOT_MIGRATION_IN_PROGRESS", statusCode: 503
    });
    db.run("SELECT * FROM sample");
    for (const row of db.iterate("SELECT * FROM sample", [], "early-close")) {
      assert.equal(row.id, 1);
      break;
    }
    const metric = db.queryMetrics().queries.find(item => item.source === "early-close");
    assert.equal(metric.totalRows, 1);
    assert.equal(metric.calls, 1);
    db.setWriteBlocked(false);
    db.run("INSERT INTO sample VALUES (?)", 3);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM sample").count, 3);
  } finally {
    db.close();
  }
});

test("SQLite errors retain identity and expose the actual database without SQL bindings", () => {
  const db = new NativeDatabase(":memory:");
  try {
    for (const operation of [
      () => db.run("INSERT INTO missing_table VALUES (?)", ["private-fixture-value"]),
      () => db.get("SELECT * FROM missing_table"),
      () => db.all("SELECT * FROM missing_table"),
      () => [...db.iterate("SELECT * FROM missing_table")]
    ]) {
      assert.throws(operation, error => {
        assert.equal(error.databasePath, ":memory:");
        assert.equal(error.code, "ERR_SQLITE_ERROR");
        assert.equal(typeof error.errcode, "number");
        assert.ok(error.stack);
        assert.ok(!JSON.stringify(error).includes("private-fixture-value"));
        return true;
      });
    }
  } finally { db.close(); }
});


test("contended writes retain SQLITE_BUSY and the exact database path", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "corptie-lock-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "locked.sqlite");
  const writer = new NativeDatabase(path), contender = new NativeDatabase(path);
  try {
    writer.run("CREATE TABLE sample (value INTEGER)");
    writer.run("BEGIN IMMEDIATE");
    writer.run("INSERT INTO sample VALUES (1)");
    assert.throws(() => contender.run("INSERT INTO sample VALUES (?)", [2]), error => {
      assert.equal(error.errcode, 5);
      assert.equal(error.databasePath, path);
      assert.match(error.message, /locked/);
      assert.ok(error.stack);
      return true;
    });
  } finally { writer.close(); contender.close(); }
});
