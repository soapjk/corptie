import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { repairRelocatedCodexRolloutPaths } from "../src/runtime/codexRolloutPathRepair.mjs";

test("Codex startup repairs copied rollout absolute paths exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-codex-rollout-repair-"));
  try {
    const oldHome = join(directory, "old", "runtimes", "codex");
    const codexHome = join(directory, "new", "runtimes", "codex");
    const relativeRollout = join("2026", "08", "27", "rollout-thread-a.jsonl");
    const oldRollout = join(oldHome, "sessions", relativeRollout);
    const relocatedRollout = join(codexHome, "sessions", relativeRollout);
    await mkdir(join(codexHome, "sessions", "2026", "08", "27"), { recursive: true });
    await writeFile(relocatedRollout, '{"type":"session_meta"}\n');

    const statePath = join(codexHome, "state_5.sqlite");
    const database = new DatabaseSync(statePath);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    database.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)")
      .run("thread-a", oldRollout);
    database.close();

    const first = await repairRelocatedCodexRolloutPaths(codexHome);
    assert.equal(first.checked, true);
    assert.equal(first.repairedCount, 1);
    assert.deepEqual(first.repairs, [{ id: "thread-a", from: oldRollout, to: relocatedRollout }]);

    const reopened = new DatabaseSync(statePath, { readOnly: true });
    assert.equal(
      reopened.prepare("SELECT rollout_path FROM threads WHERE id = ?").get("thread-a").rollout_path,
      relocatedRollout
    );
    reopened.close();

    const second = await repairRelocatedCodexRolloutPaths(codexHome);
    assert.equal(second.checked, true);
    assert.equal(second.repairedCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex startup does not guess when the old rollout still exists or the relocated file is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-codex-rollout-guard-"));
  try {
    const oldHome = join(directory, "old", "runtimes", "codex");
    const codexHome = join(directory, "new", "runtimes", "codex");
    const retainedOldRollout = join(oldHome, "sessions", "2026", "08", "27", "rollout-thread-retained.jsonl");
    const missingOldRollout = join(oldHome, "sessions", "2026", "08", "27", "rollout-thread-missing.jsonl");
    await mkdir(join(oldHome, "sessions", "2026", "08", "27"), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(retainedOldRollout, "retained\n");

    const statePath = join(codexHome, "state_5.sqlite");
    const database = new DatabaseSync(statePath);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    const insert = database.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)");
    insert.run("thread-retained", retainedOldRollout);
    insert.run("thread-missing", missingOldRollout);
    database.close();

    const result = await repairRelocatedCodexRolloutPaths(codexHome);
    assert.equal(result.repairedCount, 0);

    const reopened = new DatabaseSync(statePath, { readOnly: true });
    assert.deepEqual(
      reopened.prepare("SELECT id, rollout_path FROM threads ORDER BY id").all()
        .map((row) => ({ ...row })),
      [
        { id: "thread-missing", rollout_path: missingOldRollout },
        { id: "thread-retained", rollout_path: retainedOldRollout }
      ]
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
