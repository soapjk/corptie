import assert from "node:assert/strict";
import test from "node:test";
import { createTaskSessionProjection } from "../src/application/taskSessionProjection.mjs";

const drain = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const events = [];
  const patches = [];
  const extracted = [];
  const task = { id: "task", current_session_id: "current", execution_status: "idle", lifecycle_state: "active" };
  const extractor = { extractFromSession: async (id) => { extracted.push(id); return []; } };
  const projection = createTaskSessionProjection({
    store: {
      getTaskBySessionId: () => task,
      updateTask: (_id, patch) => { patches.push(patch); task.execution_status = patch.executionStatus ?? task.execution_status; return task; },
      getTask: () => task
    },
    memoryExtractor: extractor,
    emitEvent: (...args) => events.push(args),
    sessionWithLogicalWorkspace: (session) => session
  });
  return { task, extractor, projection, events, patches, extracted };
}

test("replaced sessions cannot project execution or enqueue memory extraction", async () => {
  const f = fixture();
  f.projection.settleEntityTaskFromSession({ id: "old", status: "complete" });
  await drain();
  assert.deepEqual(f.patches, []);
  assert.deepEqual(f.extracted, []);
});

test("settlement changes execution only and does not complete the task lifecycle", async () => {
  const f = fixture();
  f.projection.settleEntityTaskFromSession({ id: "current", status: "complete" });
  assert.deepEqual(f.patches, [{ executionStatus: "completed" }]);
  assert.equal(f.task.lifecycle_state, "active");
  assert.equal(f.events[0][1].action, "execution-status-updated");
  await drain();
  assert.equal(f.projection.pendingMemoryCount, 0);
});

test("memory extraction is serialized per session and only the latest operation releases its slot", async () => {
  const f = fixture();
  const releases = [];
  f.extractor.extractFromSession = () => new Promise((resolve) => releases.push(resolve));
  f.projection.settleEntityTaskFromSession({ id: "current", status: "idle" });
  f.projection.settleEntityTaskFromSession({ id: "current", status: "idle" });
  await drain();
  assert.equal(releases.length, 1);
  assert.equal(f.projection.pendingMemoryCount, 1);
  releases[0]([{ id: "memory" }]);
  await drain();
  assert.equal(releases.length, 2);
  assert.equal(f.projection.pendingMemoryCount, 1);
  assert.deepEqual(f.events[0][1].memoryIds, ["memory"]);
  releases[1]([]);
  await drain();
  assert.equal(f.projection.pendingMemoryCount, 0);
});
