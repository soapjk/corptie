import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { createTaskAndSession } from "../src/application/taskCreationApplicationService.mjs";
import { createControlPlaneProjection } from "../src/application/controlPlaneProjection.mjs";

test("pending and failed creation is hidden from lists, hierarchy and delta; retry publishes one complete pair", async t => {
  const root = await mkdtemp(join(tmpdir(), "corptie-task-creation-"));
  const store = new CorptieStore({ dataRoot: root, dbPath: join(root, "store.sqlite"), configPath: join(root, "config.json") });
  await store.initialize();
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const events = [];
  const workService = new WorkApplicationService({ store, onEntityChanged: (type, data) => events.push({ type, ...data }) });
  const agent = store.createAgent({ name: "Worker", role: "independentContributor" });
  const work = workService.createWork({ name: "Creation", contributorAgentIds: [agent.agentId] });
  const projection = createControlPlaneProjection({ store, environmentName: "test", decorateSessionForClient: x => x });
  let taskId;
  const options = { workService, sourceSessionId: "logical:source", providerId: "test", idempotencyKey: "atomic",
    taskInput: { workId: work.id, title: "Atomic", mainAgentId: agent.agentId } };
  await assert.rejects(createTaskAndSession({ ...options, startWorkSession: async command => {
    taskId = command.taskId;
    assert.equal(store.getTask(taskId).creation_state, "pending");
    assert.deepEqual(store.listTasksByWork(work.id), []);
    assert.deepEqual(store.listTasks(), []);
    assert.equal(projection.readControlPlaneEntity("task", taskId), null);
    assert.equal(JSON.stringify(store.listTaskHierarchyPage({ workId: work.id })).includes(taskId), false);
    assert.equal(events.some(event => event.type === "TaskChanged" && event.action === "created"), false);
    throw Object.assign(new Error("Provider unavailable"), { code: "PROVIDER_UNAVAILABLE" });
  } }), { code: "PROVIDER_UNAVAILABLE" });
  assert.equal(store.getTask(taskId).creation_state, "failed");
  assert.equal(store.getTask(taskId).creation_error_code, "PROVIDER_UNAVAILABLE");
  assert.deepEqual(store.listTasks(), []);
  assert.throws(() => store.setTaskCreationState(taskId, "ready"), { code: "TASK_SESSION_BINDING_INCOMPLETE" });
  const created = await createTaskAndSession({ ...options, startWorkSession: async command => {
    store.upsertSession({ id: "session:companion", title: "Companion", sessionKind: "worker", workId: work.id,
      taskId: command.taskId, agentId: agent.agentId, provider: "test", status: "idle" });
    store.bindSessionToTask("session:companion", command.taskId, work.id);
    return { status: "ready", session: store.getSession("session:companion") };
  } });
  assert.equal(created.task.id, taskId);
  assert.equal(store.getTask(taskId).creation_state, "ready");
  assert.equal(store.listTasksByWork(work.id).length, 1);
  assert.equal(projection.readControlPlaneEntity("task", taskId).currentSessionId, "session:companion");
  const revision = store.stateRevision();
  await createTaskAndSession({ ...options, startWorkSession: async () => assert.fail("Replay must not start another Session") });
  assert.equal(store.stateRevision(), revision, "successful idempotent replay does not invalidate the UI again");
  const child = store.createTask({ id: "task:staged-child", workId: work.id, parentTaskId: taskId,
    title: "Child", mainAgentId: agent.agentId }, {}, { creationPending: true,
    expectedParentResourceVersion: store.getTask(taskId).resource_version });
  assert.equal(store.hasTaskChildren(taskId), true, "in-flight children still protect the parent");
  assert.throws(() => store.markTaskDeletion(taskId, "deleted"), /TASK_HIERARCHY_DEPENDENCY/);
  store.setTaskCreationState(child.id, "failed", "START_FAILED");
  assert.equal(store.hasTaskChildren(taskId), false, "failed creation evidence is not a live child Task");
  store.markTaskDeletion(taskId, "deleted");
  assert.equal(store.getTask(child.id).parent_task_id, taskId, "audit relationships remain retained");
});
