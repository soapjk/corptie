import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("evolving a Task atomically freezes its prior revision as an immutable snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "corptie-task-revision-"));
  const store = new CorptieStore({
    dbPath: path.join(directory, "corptie.sqlite"),
    configPath: path.join(directory, "config.json")
  });
  try {
    await store.initialize();
    const objective = store.createObjective({ name: "Continuous work" });
    const task = store.createTask({
      objectiveId: objective.id,
      title: "First problem",
      goal: "Finish the first problem",
      acceptanceCriteria: "First result accepted",
      verificationCriteria: "First test passes"
    });
    store.upsertSession({
      id: "session:task-revision",
      title: "Task conversation",
      agent: "agent:test",
      provider: "test",
      status: "running"
    });
    store.bindSessionToTask("session:task-revision", task.id, objective.id);

    const result = store.reviseTask(task.id, {
      expectedRevision: 1,
      createdBySessionId: "session:task-revision",
      executionSummary: "First problem completed.",
      completionEvidence: [{ kind: "test", value: "passed" }],
      next: {
        title: "Second problem",
        goal: "Finish the second problem",
        acceptanceCriteria: "Second result accepted",
        verificationCriteria: "Second test passes"
      }
    });

    assert.equal(result.task.title, "Second problem");
    assert.equal(result.task.revision, 2);
    assert.equal(result.task.lifecycle_state, "in_progress");
    assert.equal(result.task.current_snapshot_id, result.snapshot.id);
    assert.equal(result.snapshot.title, "First problem");
    assert.equal(result.snapshot.version, 1);
    assert.deepEqual(result.snapshot.completionEvidence, [{ kind: "test", value: "passed" }]);
    assert.throws(
      () => store.db.run("UPDATE task_snapshots SET title='mutated' WHERE id=?", [result.snapshot.id]),
      /TASK_SNAPSHOT_IMMUTABLE/
    );
    assert.throws(
      () => store.reviseTask(task.id, {
        expectedRevision: 1,
        createdBySessionId: "session:task-revision",
        next: { title: "Stale rewrite" }
      }),
      (error) => error.code === "TASK_REVISION_CONFLICT"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
