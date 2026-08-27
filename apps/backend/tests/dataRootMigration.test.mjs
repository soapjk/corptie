import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactService } from "../src/application/artifactService.mjs";
import { defaultCorptieDataRoot, resolveDataRootLayout } from "../src/runtime/dataRootLayout.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-data-root-"));
  const sourceRoot = join(directory, "source");
  const selectorPath = join(directory, "bootstrap", "data-root.json");
  const store = new CorptieStore({ dataRoot: sourceRoot, rootSelectionPath: selectorPath });
  await store.initialize();
  const objective = store.createObjective({ id: "objective:migration", name: "Migration" });
  store.upsertSession({
    id: "session:migration", title: "Migration", provider: "codex-app-server",
    status: "idle", sessionKind: "objectiveChat", objectiveId: objective.id
  });
  const artifactService = new ArtifactService({ store });
  await artifactService.initialize();
  const artifact = await artifactService.create(
    { kind: "local_user", actorId: "local", objectiveId: objective.id },
    { title: "Evidence", content: "content whose sha256 must survive migration" }
  );
  await Promise.all([
    writeFile(join(store.layout.logsDirectory, "backend.out.log"), "preserved log\n"),
    writeFile(join(store.layout.runtimeDirectory, "runtime.json"), "{\"ready\":true}\n"),
    writeFile(join(store.layout.backupsDirectory, "manifest.json"), "{\"backup\":true}\n"),
    writeFile(join(store.layout.stateDirectory, "state.json"), "{\"state\":true}\n")
  ]);
  store.setDataRootDidChangeListener(({ current }) => artifactService.useDataRoot(current));
  return { directory, sourceRoot, selectorPath, store, artifactService, artifact };
}

test("default root is ~/.corptie and Development derives an isolated environment subtree", () => {
  assert.equal(defaultCorptieDataRoot({ homeDir: "/Users/example" }), "/Users/example/.corptie");
  const production = resolveDataRootLayout("/Users/example/.corptie", "production");
  const development = resolveDataRootLayout("/Users/example/.corptie", "development");
  assert.equal(production.environmentRoot, "/Users/example/.corptie");
  assert.equal(development.environmentRoot, "/Users/example/.corptie/development");
  assert.equal(production.databasePath, "/Users/example/.corptie/database/corptie.sqlite");
  assert.equal(development.databasePath, "/Users/example/.corptie/development/database/corptie.sqlite");
});

test("migration copies managed subtrees, verifies data, switches atomically, and survives restart", async () => {
  const f = await fixture();
  const targetRoot = join(f.directory, "target");
  try {
    const migrationPromise = f.store.updateSettings({ dataRoot: targetRoot });
    assert.throws(
      () => f.store.createObjective({ id: "objective:racing", name: "Racing write" }),
      { code: "DATA_ROOT_MIGRATION_IN_PROGRESS" }
    );
    const settings = await migrationPromise;
    assert.equal(settings.dataRoot, targetRoot);
    assert.equal(settings.migration.databaseIntegrity, "ok");
    assert.equal(settings.migration.keyRecordCounts.objectives, 1);
    assert.equal(settings.migration.keyRecordCounts.sessions, 1);
    assert.equal(settings.migration.artifactCount, 1);
    assert.equal(f.store.getObjective("objective:migration").name, "Migration");
    assert.equal(
      (await f.artifactService.get(
        { kind: "local_user", actorId: "local", objectiveId: "objective:migration" },
        f.artifact.artifactId
      )).content,
      "content whose sha256 must survive migration"
    );
    for (const relative of [
      ["logs", "backend.out.log"], ["runtimes", "runtime.json"],
      ["backups", "manifest.json"], ["state", "state.json"], ["config", "settings.json"]
    ]) await access(join(targetRoot, ...relative));
    await access(join(f.sourceRoot, "database", "corptie.sqlite"));
    assert.equal(JSON.parse(await readFile(f.selectorPath, "utf8")).dataRoot, targetRoot);

    await f.store.close();
    const restarted = new CorptieStore({ rootSelectionPath: f.selectorPath });
    await restarted.initialize();
    const restartedArtifacts = new ArtifactService({ store: restarted });
    await restartedArtifacts.initialize();
    assert.equal(restarted.settings().dataRoot, targetRoot);
    assert.equal(restarted.getObjective("objective:migration").name, "Migration");
    assert.equal(
      (await restartedArtifacts.get(
        { kind: "local_user", actorId: "local", objectiveId: "objective:migration" },
        f.artifact.artifactId
      )).content,
      "content whose sha256 must survive migration"
    );
    await restarted.close();
  } finally {
    await f.store.close().catch(() => {});
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("failed migration preserves both the active root and an occupied target", async () => {
  const f = await fixture();
  const targetRoot = join(f.directory, "occupied-target");
  try {
    await mkdir(targetRoot);
    await writeFile(join(targetRoot, "user-owned.txt"), "do not overwrite");
    await assert.rejects(() => f.store.setDataRoot(targetRoot), { code: "DATA_ROOT_TARGET_NOT_EMPTY" });
    assert.equal(f.store.settings().dataRoot, f.sourceRoot);
    assert.equal(f.store.getObjective("objective:migration").name, "Migration");
    assert.equal(await readFile(join(targetRoot, "user-owned.txt"), "utf8"), "do not overwrite");
    assert.equal(JSON.parse(await readFile(f.selectorPath, "utf8")).dataRoot, f.sourceRoot);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("migration refuses to race an active Provider turn", async () => {
  const f = await fixture();
  try {
    f.store.db.run(
      `INSERT INTO session_turns (
         session_id, binding_id, routing_version, turn_id, execution_status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      ["session:migration", "binding:migration", 1, "turn:migration", "running", "2026-08-27T00:00:00.000Z"]
    );
    await assert.rejects(() => f.store.setDataRoot(join(f.directory, "target")), {
      code: "DATA_ROOT_MIGRATION_BUSY"
    });
    assert.equal(f.store.settings().dataRoot, f.sourceRoot);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("unknown and retired independent path fields are rejected", async () => {
  const f = await fixture();
  try {
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
