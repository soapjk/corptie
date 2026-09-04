import assert from "node:assert/strict";
import test from "node:test";
import { createTaskAndSession } from "../src/application/taskCreationApplicationService.mjs";

function fixture() {
  const tasks = new Map();
  const sessions = new Map();
  let persistCount = 0;
  let startCount = 0;
  const workService = {
    store: {
      getTask: (id) => tasks.get(id) ?? null,
      getSession: (id) => sessions.get(id) ?? null
    },
    createTask: (input) => {
      persistCount += 1;
      const task = {
        id: input.id,
        work_id: input.workId,
        title: input.title,
        description: input.description ?? "",
        goal: input.goal ?? "",
        acceptance_criteria: input.acceptanceCriteria ?? "",
        verification_criteria: input.verificationCriteria ?? "",
        priority: input.priority ?? "medium",
        main_agent_id: input.mainAgentId,
        resource_version: 1,
        current_session_id: null
      };
      tasks.set(task.id, task);
      return task;
    },
    getTask: (id) => tasks.get(id)
  };
  const startWorkSession = async (command) => {
    startCount += 1;
    const session = { id: `session:${command.taskId}`, taskId: command.taskId };
    sessions.set(session.id, session);
    tasks.set(command.taskId, {
      ...tasks.get(command.taskId),
      current_session_id: session.id,
      resource_version: 2
    });
    return { status: "ready", session, receipt: { operationId: command.idempotencyKey } };
  };
  return {
    workService,
    startWorkSession,
    counts: () => ({ persistCount, startCount })
  };
}

test("canonical Task creation persists and starts one companion Session in one operation", async () => {
  const f = fixture();
  const created = await createTaskAndSession({
    workService: f.workService,
    startWorkSession: f.startWorkSession,
    taskInput: {
      workId: "work:one",
      title: "Atomic creation",
      mainAgentId: "agent:worker"
    },
    creationOrigin: { originType: "session", creatorSessionId: "session:source" },
    sourceSessionId: "session:source",
    providerId: "provider:test",
    idempotencyKey: "create-one"
  });

  assert.match(created.task.id, /^task:create:[a-f0-9]{64}$/);
  assert.equal(created.task.current_session_id, created.session.id);
  assert.deepEqual(f.counts(), { persistCount: 1, startCount: 1 });
});

test("canonical Task creation replays by source Session and idempotency key without duplicates", async () => {
  const f = fixture();
  const input = {
    workService: f.workService,
    startWorkSession: f.startWorkSession,
    taskInput: {
      workId: "work:one",
      title: "Idempotent creation",
      mainAgentId: "agent:worker"
    },
    creationOrigin: { originType: "session", creatorSessionId: "session:source" },
    sourceSessionId: "session:source",
    providerId: "provider:test",
    idempotencyKey: "same-key"
  };

  const first = await createTaskAndSession(input);
  const replay = await createTaskAndSession(input);

  assert.equal(replay.task.id, first.task.id);
  assert.equal(replay.session.id, first.session.id);
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(f.counts(), { persistCount: 1, startCount: 1 });
});

test("canonical Task creation rejects conflicting reuse of an idempotency key", async () => {
  const f = fixture();
  const base = {
    workService: f.workService,
    startWorkSession: f.startWorkSession,
    taskInput: { workId: "work:one", title: "Original", mainAgentId: "agent:worker" },
    creationOrigin: { originType: "session", creatorSessionId: "session:source" },
    sourceSessionId: "session:source",
    providerId: "provider:test",
    idempotencyKey: "conflict-key"
  };
  await createTaskAndSession(base);

  await assert.rejects(
    () => createTaskAndSession({ ...base, taskInput: { ...base.taskInput, title: "Changed" } }),
    { code: "ENTITY_CREATION_CONFLICT", statusCode: 409 }
  );
  assert.deepEqual(f.counts(), { persistCount: 1, startCount: 1 });
});
