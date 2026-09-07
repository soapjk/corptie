import assert from "node:assert/strict";
import test from "node:test";
import { TaskSummaryRepository } from "../src/store/taskSummaryRepository.mjs";
import { presentTaskSummary, taskSummaryDefinitionHash, TASK_SUMMARY_PROMPT_VERSION } from "../src/application/taskSummaryContract.mjs";

test("cancelling absent summary work leaves a newly created Task untouched", () => {
  const writes = [];
  const task = { id: "task:new", resource_version: 1, user_summary_json: null };
  const repository = new TaskSummaryRepository({
    getTask: () => task,
    runInTransaction: (body) => body(),
    db: { run: (sql) => writes.push(sql) },
    scheduleSave: () => assert.fail("No Task change should be saved")
  });
  repository.cancel(task.id);
  assert.equal(task.resource_version, 1);
  assert.equal(task.user_summary_json, null);
  assert.equal(writes.some((sql) => /UPDATE tasks\b/.test(sql)), false);
});

test("repeated capability blockers do not rewrite Task versions or job generations", () => {
  const repository = new TaskSummaryRepository({
    runInTransaction: (body) => body(),
    selectOne: () => ({ status: "blocked", error_code: "BACKGROUND_AGENT_UNAVAILABLE" }),
    db: { run: () => assert.fail("same blocker must be a no-op") }
  });
  repository.block("task:1", "BACKGROUND_AGENT_UNAVAILABLE");
});

test("cancelling an existing summary still invalidates its content", () => {
  const writes = [];
  const content = { focus: "Previous focus" };
  const repository = new TaskSummaryRepository({
    getTask: () => ({ user_summary_json: JSON.stringify({ state: "ready", content }) }),
    runInTransaction: (body) => body(),
    db: { run: (sql, parameters) => writes.push({ sql, parameters }) },
    scheduleSave: () => {}
  });
  repository.cancel("task:existing");
  const update = writes.find(({ sql }) => /UPDATE tasks\b/.test(sql));
  assert.deepEqual(JSON.parse(update.parameters[0]), { state: "stale", content });
});

test("read projection downgrades stale summaries without modifying persisted content", () => {
  const task = { title: "Task", description: "Definition", revision: 2,
    current_session_id: "session:1", lifecycle_state: "in_progress", execution_status: "idle" };
  const summary = { state: "ready", content: { schemaVersion: 1, focus: "Focus", basis: {
    taskRevision: 2, sessionID: "session:1", lifecycleState: "in_progress",
    definitionHash: taskSummaryDefinitionHash(task), promptVersion: TASK_SUMMARY_PROMPT_VERSION
  } } };
  task.user_summary_json = JSON.stringify(summary);
  assert.deepEqual(presentTaskSummary(task), summary);
  for (const patch of [{ revision: 3 }, { description: "Changed without revision" },
    { current_session_id: "session:2" }, { archived: true }, { execution_status: "running" },
    { deletion_status: "deleting" }, { lifecycle_state: "done" }]) {
    const projected = presentTaskSummary({ ...task, ...patch });
    assert.equal(projected.state, "stale");
    assert.deepEqual(projected.content, summary.content);
  }
  assert.equal(JSON.parse(task.user_summary_json).state, "ready");
});

function fixture() {
  const writes = [];
  const published = [];
  const repository = new TaskSummaryRepository({
    runInTransaction: (body) => body(),
    db: { run: (sql, parameters) => writes.push({ sql, parameters }) }
  });
  const claim = { taskID: "task:1", generation: 2, operationID: "summary:2", basis: { hash: "basis:2" } };
  repository.get = () => ({ generation: 2, operation_id: "summary:2", status: "running" });
  repository.basis = () => claim.basis;
  repository.publish = (...values) => published.push(values);
  return { repository, claim, writes, published };
}

test("successful summary stores exactly the content published to the card", () => {
  const { repository, claim, writes, published } = fixture();
  assert.equal(repository.complete(claim, { focus: "Focus", sourceRefs: ["message:1"] }, {
    providerId: "provider:1", inputHash: "input:hash"
  }), true);
  assert.match(writes[0].sql, /INSERT INTO task_summary_versions/);
  assert.deepEqual(writes[0].parameters.slice(0, 5), ["task:1", 2, "summary:2", "basis:2", "input:hash"]);
  assert.match(writes[0].parameters[5], /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(writes[0].parameters[6]), published[0][2]);
  assert.equal(published[0][1], "ready");
});

test("superseded operation cannot create history or replace the card", () => {
  const { repository, claim, writes, published } = fixture();
  repository.get = () => ({ generation: 3, operation_id: "summary:3", status: "running" });
  assert.equal(repository.complete(claim, {}), false);
  assert.deepEqual(writes, []);
  assert.deepEqual(published, []);
});

test("changed basis schedules a fresh generation without recording stale success", () => {
  const { repository, claim, writes, published } = fixture();
  repository.basis = () => ({ hash: "new-basis" });
  const requested = [];
  repository.request = (id) => requested.push(id);
  assert.equal(repository.complete(claim, {}), false);
  assert.deepEqual(requested, ["task:1"]);
  assert.deepEqual(writes, []);
  assert.deepEqual(published, []);
});
