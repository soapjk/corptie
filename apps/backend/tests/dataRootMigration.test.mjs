import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactService } from "../src/application/artifactService.mjs";
import { DataRootMigrationCoordinator } from "../src/runtime/dataRootMigrationCoordinator.mjs";
import { defaultCorptieDataRoot, resolveDataRootLayout } from "../src/runtime/dataRootLayout.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture(options = {}) {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-data-root-"));
  const sourceRoot = join(directory, "source");
  const selectorPath = join(directory, "bootstrap", "data-root.json");
  const store = new CorptieStore({
    dataRoot: sourceRoot,
    rootSelectionPath: selectorPath,
    manageProcessEnvironment: false
  });
  await store.initialize();
  const objective = store.createObjective({ id: "objective:migration", name: "Migration" });
  store.upsertSession({
    id: "session:migration", title: "Migration", provider: "codex-app-server",
    status: "idle", sessionKind: "objectiveChat", objectiveId: objective.id
  });
  const artifacts = new ArtifactService({ store });
  await artifacts.initialize();
  const artifact = await artifacts.create(
    { kind: "local_user", actorId: "local", objectiveId: objective.id },
    { title: "Evidence", content: "content whose sha256 must survive migration" }
  );
  await Promise.all([
    writeFile(join(store.layout.logsDirectory, "backend.out.log"), "preserved log\n"),
    writeFile(join(store.layout.runtimeDirectory, "codex.json"), "{\"ready\":true}\n"),
    writeFile(join(store.layout.runtimeDirectory, "claude.json"), "{\"ready\":true}\n"),
    writeFile(join(store.layout.runtimeDirectory, "openclacky.json"), "{\"ready\":true}\n"),
    writeFile(join(store.layout.stateDirectory, "skill-cache.json"), "{\"ready\":true}\n")
  ]);
  const coordinator = new DataRootMigrationCoordinator({
    store,
    environment: "production",
    selectionPath: selectorPath,
    inspectBlockers: options.inspectBlockers,
    quiesce: options.quiesce
  });
  await coordinator.initialize();
  return { directory, sourceRoot, selectorPath, store, artifacts, artifact, coordinator };
}

test("default root and Development layout remain isolated", () => {
  assert.equal(defaultCorptieDataRoot({ homeDir: "/Users/example" }), "/Users/example/.corptie");
  const production = resolveDataRootLayout("/Users/example/.corptie", "production");
  const development = resolveDataRootLayout("/Users/example/.corptie", "development");
  assert.equal(production.databasePath, "/Users/example/.corptie/database/corptie.sqlite");
  assert.equal(development.databasePath, "/Users/example/.corptie/development/database/corptie.sqlite");
});

test("migration verifies a full copy, commits only the selector, and requires restart", async () => {
  let quiesced = 0;
  const f = await fixture({ quiesce: async () => { quiesced += 1; } });
  const targetRoot = join(f.directory, "target");
  try {
    const operation = await f.coordinator.migrate(targetRoot);
    assert.equal(operation.phase, "restartRequired");
    assert.equal(operation.restartRequired, true);
    assert.equal(operation.receipt.databaseIntegrity, "ok");
    assert.equal(operation.receipt.artifactCount, 1);
    assert.equal(quiesced, 1);
    assert.equal(f.store.settings().dataRoot, f.sourceRoot, "old process must never hot-rebind");
    assert.equal(f.store.db.writeBlocked, true);
    const selection = JSON.parse(await readFile(f.selectorPath, "utf8"));
    assert.equal(selection.dataRoot, targetRoot);
    assert.equal(selection.operationId, operation.operationId);
    for (const name of ["codex.json", "claude.json", "openclacky.json"]) {
      await access(join(targetRoot, "runtimes", name));
    }
    await access(join(targetRoot, "state", "skill-cache.json"));
    await access(join(f.sourceRoot, "database", "corptie.sqlite"));

    f.store.db.setWriteBlocked(false);
    await f.store.close();
    const restarted = new CorptieStore({
      rootSelectionPath: f.selectorPath,
      manageProcessEnvironment: false
    });
    await restarted.initialize();
    const recovered = new DataRootMigrationCoordinator({ store: restarted, selectionPath: f.selectorPath });
    const status = await recovered.initialize();
    assert.equal(restarted.settings().dataRoot, targetRoot);
    assert.equal(status.phase, "completed");
    assert.equal(status.operationId, operation.operationId);
    assert.equal(restarted.getObjective("objective:migration").name, "Migration");
    await restarted.close();
  } finally {
    f.store.db?.setWriteBlocked(false);
    await f.store.close().catch(() => {});
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("preflight blockers and occupied targets preserve the original authority", async () => {
  const f = await fixture({ inspectBlockers: () => [{ kind: "active_session_turns", count: 1 }] });
  try {
    await assert.rejects(() => f.coordinator.migrate(join(f.directory, "target")), {
      code: "DATA_ROOT_MIGRATION_BUSY"
    });
    assert.equal(JSON.parse(await readFile(f.selectorPath, "utf8")).dataRoot, f.sourceRoot);
    assert.equal(f.store.db.writeBlocked, false);

    const occupied = join(f.directory, "occupied");
    await mkdir(occupied);
    await writeFile(join(occupied, "owned.txt"), "preserve");
    const cleanCoordinator = new DataRootMigrationCoordinator({ store: f.store, selectionPath: f.selectorPath });
    await cleanCoordinator.initialize();
    await assert.rejects(() => cleanCoordinator.migrate(occupied), { code: "DATA_ROOT_TARGET_NOT_EMPTY" });
    assert.equal(await readFile(join(occupied, "owned.txt"), "utf8"), "preserve");
    assert.equal(JSON.parse(await readFile(f.selectorPath, "utf8")).dataRoot, f.sourceRoot);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("source Artifact corruption fails preflight with a stable recoverable error before copying", async () => {
  let quiesced = 0;
  const f = await fixture({ quiesce: async () => { quiesced += 1; } });
  const targetRoot = join(f.directory, "target");
  try {
    const version = f.store.selectOne(
      "SELECT artifact_id, version, storage_key FROM artifact_versions WHERE artifact_id = ?",
      [f.artifact.artifactId]
    );
    await rm(join(f.store.layout.artifactsDirectory, version.storage_key));

    await assert.rejects(() => f.coordinator.migrate(targetRoot), (error) => {
      assert.equal(error.code, "DATA_ROOT_ARTIFACT_MISSING");
      assert.equal(error.message, "Artifact content referenced by the active database is missing.");
      assert.deepEqual(error.details, {
        artifactId: version.artifact_id,
        version: version.version,
        storageKey: version.storage_key
      });
      assert.doesNotMatch(error.message, /ENOENT|\/Volumes|\/Users/);
      return true;
    });

    assert.equal(f.coordinator.status().phase, "failed");
    assert.equal(f.coordinator.status().error.code, "DATA_ROOT_ARTIFACT_MISSING");
    assert.equal(quiesced, 0, "source integrity must be checked before persistent writers stop");
    assert.equal(JSON.parse(await readFile(f.selectorPath, "utf8")).dataRoot, f.sourceRoot);
    await assert.rejects(() => access(targetRoot), { code: "ENOENT" });
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("interrupted pre-commit operations recover as failed without activating the target", async () => {
  const f = await fixture();
  try {
    const operationPath = `${f.selectorPath}.migration-operation.json`;
    await writeFile(operationPath, JSON.stringify({
      schemaVersion: 1,
      operationId: "data_root_migration:interrupted",
      generation: 7,
      phase: "copying",
      sourceDataRoot: f.sourceRoot,
      targetDataRoot: join(f.directory, "target"),
      history: []
    }));
    const recovered = new DataRootMigrationCoordinator({ store: f.store, selectionPath: f.selectorPath });
    const status = await recovered.initialize();
    assert.equal(status.phase, "failed");
    assert.equal(status.error.code, "DATA_ROOT_MIGRATION_INTERRUPTED");
    assert.equal(JSON.parse(await readFile(f.selectorPath, "utf8")).dataRoot, f.sourceRoot);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("every pre-commit crash phase preserves one active root and recovery is idempotent", async () => {
  const phases = ["preflight", "quiescing", "checkpointing", "copying", "verifying", "switching"];
  for (const phase of phases) {
    const f = await fixture();
    try {
      const operationPath = `${f.selectorPath}.migration-operation.json`;
      await writeFile(operationPath, JSON.stringify({
        schemaVersion: 1,
        operationId: `data_root_migration:crash:${phase}`,
        generation: 2,
        phase,
        sourceDataRoot: f.sourceRoot,
        targetDataRoot: join(f.directory, "target"),
        history: [{ phase, at: "2026-08-28T00:00:00.000Z" }]
      }));
      const first = new DataRootMigrationCoordinator({ store: f.store, selectionPath: f.selectorPath });
      assert.equal((await first.initialize()).phase, "failed", phase);
      const second = new DataRootMigrationCoordinator({ store: f.store, selectionPath: f.selectorPath });
      const repeated = await second.initialize();
      assert.equal(repeated.phase, "failed", phase);
      assert.equal(repeated.history.length, 2, `recovery must not repeat ${phase}`);
      assert.equal(JSON.parse(await readFile(f.selectorPath, "utf8")).dataRoot, f.sourceRoot);
    } finally {
      await f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("restart handoff phases recover to completed exactly once after selector commit", async () => {
  for (const phase of ["restartRequired", "reconnecting"]) {
    const f = await fixture();
    try {
      const operationId = `data_root_migration:handoff:${phase}`;
      const targetRoot = join(f.directory, "target");
      await writeFile(f.selectorPath, JSON.stringify({
        dataRoot: targetRoot, generation: 3, operationId
      }));
      await writeFile(`${f.selectorPath}.migration-operation.json`, JSON.stringify({
        schemaVersion: 1,
        operationId,
        generation: 3,
        phase,
        sourceDataRoot: f.sourceRoot,
        targetDataRoot: targetRoot,
        history: [{ phase, at: "2026-08-28T00:00:00.000Z" }]
      }));
      const first = new DataRootMigrationCoordinator({ store: f.store, selectionPath: f.selectorPath });
      const completed = await first.initialize();
      assert.equal(completed.phase, "completed");
      const second = new DataRootMigrationCoordinator({ store: f.store, selectionPath: f.selectorPath });
      assert.equal((await second.initialize()).history.length, 2);
    } finally {
      await f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("a post-quiesce failure resumes old-root services without changing authority", async () => {
  const f = await fixture();
  let resumed = 0;
  try {
    const coordinator = new DataRootMigrationCoordinator({
      store: f.store,
      selectionPath: f.selectorPath,
      quiesce: async () => {},
      resume: async () => { resumed += 1; },
      migrateRoot: async () => {
        const error = new Error("injected copy failure");
        error.code = "DATA_ROOT_COPY_FAILED";
        throw error;
      }
    });
    await coordinator.initialize();
    await assert.rejects(() => coordinator.migrate(join(f.directory, "target")), {
      code: "DATA_ROOT_COPY_FAILED"
    });
    assert.equal(resumed, 1);
    assert.equal(f.store.migrationInProgress, false);
    assert.equal(f.store.db.writeBlocked, false);
    assert.equal(JSON.parse(await readFile(f.selectorPath, "utf8")).dataRoot, f.sourceRoot);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Store refuses direct hot rebinding and rejects unknown path fields", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.store.updateSettings({ dataRoot: join(f.directory, "target") }), {
      code: "DATA_ROOT_MIGRATION_COORDINATOR_REQUIRED"
    });
    await assert.rejects(() => f.store.updateSettings({ logDir: "/tmp/logs" }), {
      code: "DEPRECATED_SETTINGS_PATH_FIELD"
    });
    await assert.rejects(() => f.store.updateSettings({ mysteryPath: "/tmp/value" }), {
      code: "UNKNOWN_SETTINGS_FIELD"
    });
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
