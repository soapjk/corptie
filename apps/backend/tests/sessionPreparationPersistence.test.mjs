import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWritableStoreDatabase } from "../src/store/storeDatabaseConnection.mjs";
import { RuntimeStateRepository } from "../src/store/repositories/runtimeStateRepository.mjs";
import { SessionPreparationCoordinator } from "../src/application/sessionPreparationCoordinator.mjs";

test("SQLite FULL WAL close/reopen retains unknown preparation without replay or secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-preparation-test-"));
  const path = join(directory, "preparation.sqlite");
  let database = openWritableStoreDatabase(path);
  let release;
  try {
    database.run("CREATE TABLE runtime_state (key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT)");
    const repository = new RuntimeStateRepository({ getDatabase: () => database,
      selectOne: (sql, params) => database.get(sql, params) });
    const persistence = { read: () => repository.getRuntimeState("session-preparations/v1"),
      write: snapshot => repository.setRuntimeState("session-preparations/v1", snapshot) };
    const resolveReference = async () => ({ sessionId: "session", logicalSessionId: "logical",
      bindingId: "binding", providerId: "provider", credential: "must-not-persist" });
    const coordinator = new SessionPreparationCoordinator({ resolveReference, persistence,
      verify: () => new Promise(resolve => { release = resolve; }), invalidate: () => {} });
    const first = await coordinator.start("session");
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!JSON.stringify(persistence.read()).includes("must-not-persist"));
    assert.equal(database.get("PRAGMA synchronous").synchronous, 2);
    database.close();
    database = openWritableStoreDatabase(path);
    let calls = 0;
    const restarted = new SessionPreparationCoordinator({ resolveReference, persistence,
      verify: async () => { calls++; return { ready: true }; }, invalidate: () => {} });
    assert.equal((await restarted.current("session")).remoteDisposition, "unknown");
    assert.equal((await restarted.start("session")).id, first.id);
    assert.equal(calls, 0);
    release({ ready: false });
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
