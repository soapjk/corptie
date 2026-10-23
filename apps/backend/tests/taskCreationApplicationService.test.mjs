import assert from "node:assert/strict";
import test from "node:test";
import { createTaskAndSession } from "../src/application/taskCreationApplicationService.mjs";

function fixture() {
  const tasks = new Map();
  const sessions = new Map();
  let persistCount = 0;
  let startCount = 0;
  const startCommands = [];
  const workService = {
    store: {
      getTask: (id) => tasks.get(id) ?? null,
      getSession: (id) => sessions.get(id) ?? null,
      setTaskCreationState: (id, state, code) => {
        const task = tasks.get(id);
        if (task) { task.creation_state = state; task.creation_error_code = code ?? null; }
        return task;
      }
    },
    createTask: (input) => {
      persistCount += 1;
      const task = {
        id: input.id,
        work_id: input.workId,
        title: input.title,
        description: input.description ?? "",
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
    startCommands.push(command);
    const session = { id: `session:${command.taskId}`, taskId: command.taskId, workId: tasks.get(command.taskId).work_id };
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
    startCommands,
    counts: () => ({ persistCount, startCount })
  };
}

test("creation forwards selected model and reasoning to the companion Session", async () => {
  for (const providerId of ["codex-app-server", "claude-sdk", "openclacky"]) {
    const f = fixture();
    await createTaskAndSession({ ...f,
      taskInput: { workId: "work:one", title: "New", mainAgentId: "agent:worker" },
      sourceSessionId: "session:source", providerId, idempotencyKey: "settings",
      model: "model:test", reasoningLevel: "high"
    });
    assert.equal(f.startCommands[0].providerId, providerId);
    assert.equal(f.startCommands[0].model, "model:test");
    assert.equal(f.startCommands[0].reasoningLevel, "high");
  }
});

test("creation starts with the committed post-event version, not the returned snapshot", async () => {
  const f = fixture();
  const create = f.workService.createTask;
  f.workService.createTask = (input) => {
    const task = create(input);
    const snapshot = { ...task };
    task.resource_version = 2;
    return snapshot;
  };
  await createTaskAndSession({
    ...f, taskInput: { workId: "work:one", title: "New", mainAgentId: "agent:worker" },
    sourceSessionId: "session:source", providerId: "provider:test", idempotencyKey: "post-event"
  });
  assert.equal(f.startCommands[0].expectedTaskVersion, 2);
  assert.equal(f.startCommands[0].dispatchInitialTurn, false);
});

test("a failed startup can resume the same persisted Task without a second Task", async () => {
  const f = fixture();
  const input = {
    ...f, taskInput: { workId: "work:one", title: "New", mainAgentId: "agent:worker" },
    sourceSessionId: "session:source", providerId: "provider:test", idempotencyKey: "recover"
  };
  await assert.rejects(createTaskAndSession({ ...input, startWorkSession: async () => {
    throw Object.assign(new Error("Conflict"), { code: "TASK_VERSION_CONFLICT" });
  } }), { code: "TASK_VERSION_CONFLICT" });
  const recovered = await createTaskAndSession(input);
  assert.ok(recovered.session);
  assert.deepEqual(f.counts(), { persistCount: 1, startCount: 1 });
});

test("canonical Task creation persists one deferred companion Session in one operation", async () => {
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
  assert.equal(f.startCommands[0].dispatchInitialTurn, false);
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

test("ready-shaped replies cannot succeed without a persisted two-way Task/Work binding", async () => {
  for (const fault of ["missing", "pointer", "task", "work"]) {
    const f = fixture();
    const options = { ...f, taskInput: { workId: "work:one", title: "New", mainAgentId: "agent:worker" },
      sourceSessionId: "session:source", providerId: "provider:test", idempotencyKey: fault };
    let taskId;
    await assert.rejects(createTaskAndSession({ ...options, startWorkSession: async command => {
      taskId = command.taskId;
      if (fault === "missing") return { status: "ready", session: { id: "phantom" } };
      const value = await f.startWorkSession(command);
      if (fault === "pointer") f.workService.store.getTask(taskId).current_session_id = null;
      if (fault === "task") f.workService.store.getSession(value.session.id).taskId = "task:other";
      if (fault === "work") f.workService.store.getSession(value.session.id).workId = "work:other";
      return value;
    } }), { code: "TASK_SESSION_BINDING_INCOMPLETE" });
    assert.equal(f.workService.store.getTask(taskId).creation_state, "failed");
  }
});

test("parallel identical creates share one startup, while pending startup never reports success", async () => {
  const f = fixture();
  const input = { ...f, taskInput: { workId: "work:one", title: "New", mainAgentId: "agent:worker" },
    sourceSessionId: "session:source", providerId: "provider:test", idempotencyKey: "parallel" };
  const [one, two] = await Promise.all([createTaskAndSession(input), createTaskAndSession(input)]);
  assert.equal(one.session.id, two.session.id);
  assert.deepEqual(f.counts(), { persistCount: 1, startCount: 1 });
  let taskId;
  await assert.rejects(createTaskAndSession({ ...input, idempotencyKey: "pending", startWorkSession: async command => {
    taskId = command.taskId;
    return { status: "pending" };
  } }), error => error.code === "START_NOT_READY" && error.creationRecovery.status === "pending");
  assert.equal(f.workService.store.getTask(taskId).creation_state, "pending");
});

test("a stale existing companion cannot turn an idempotent replay into success", async () => {
  const f = fixture();
  const input = { ...f, taskInput: { workId: "work:one", title: "New", mainAgentId: "agent:worker" },
    sourceSessionId: "session:source", providerId: "provider:test", idempotencyKey: "stale" };
  const created = await createTaskAndSession(input);
  f.workService.store.getSession(created.session.id).workId = "work:wrong";
  await assert.rejects(createTaskAndSession(input), { code: "TASK_SESSION_BINDING_INCOMPLETE" });
});
