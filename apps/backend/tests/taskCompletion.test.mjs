import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { presentTaskAcceptance } from "../src/application/taskAcceptance.mjs";
import { TaskCompletionService } from "../src/application/taskCompletionService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-task-completion-"));
  const dbPath = join(directory, "db.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath });
  await store.initialize();
  const entities = new WorkApplicationService({ store });
  const work = entities.createWork({ id: "work:completion", name: "Completion" });
  const task = entities.createTask({
    id: "task:completion", workId: work.id,
    title: "Ship completion authorization", lifecycleState: "in_progress"
  });
  return { directory, dbPath, configPath, store, entities, work, task };
}

function uiIntentInput(task, suffix = "one") {
  return {
    requestId: `intent-request:${suffix}`,
    interactionId: `interaction:${suffix}`,
    uiSurface: "task_completion_confirmation",
    displayedTaskId: task.id,
    displayedTaskTitle: task.title,
    displayedAcceptanceStatus: "passed"
  };
}

test("macOS direct intent is target-bound, one-time, audited, and idempotently retryable", async () => {
  const f = await fixture();
  try {
    const service = new TaskCompletionService({ store: f.store });
    const receipt = service.issueMacOSIntent(
      f.task.id, uiIntentInput(f.task), { type: "user", id: "user:local-macos" }
    );
    const request = {
      intentToken: receipt.intentToken,
      requestId: "intent-request:one",
      idempotencyKey: "complete:one"
    };
    const first = service.completeFromMacOS(f.task.id, request);
    const replay = service.completeFromMacOS(f.task.id, request);
    assert.equal(first.task.lifecycle_state, "done");
    assert.equal(first.operation.sourceType, "direct_macos_ui_action");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.operation.operationId, first.operation.operationId);
    assert.equal(f.store.listTaskCompletionOperations(f.task.id).length, 1);
    assert.throws(
      () => f.store.db.run("UPDATE task_completion_operations SET result='rejected' WHERE operation_id=?", [first.operation.operationId]),
      /TASK_COMPLETION_AUDIT_IMMUTABLE/
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("ordinary PATCH semantics and direct Store updates cannot complete", async () => {
  const f = await fixture();
  try {
    assert.throws(
      () => f.entities.updateTask(f.task.id, { lifecycleState: "done" }),
      (error) => error.code === "TASK_COMPLETION_INTENT_REQUIRED"
    );
    assert.throws(
      () => f.store.updateTask(f.task.id, { lifecycleState: "done" }),
      (error) => error.code === "TASK_COMPLETION_INTENT_REQUIRED"
    );
    assert.throws(
      () => new TaskCompletionService({ store: f.store }).completeFromMacOS(f.task.id, {
        requestId: "missing-token-request", idempotencyKey: "missing-token-idempotency"
      }),
      (error) => error.code === "COMPLETION_INTENT_REQUIRED"
    );
    assert.equal(f.store.getTask(f.task.id).lifecycle_state, "in_progress");
    const rejected = f.store.listTaskCompletionOperations(f.task.id);
    assert.equal(rejected.length, 3);
    assert.ok(rejected.every((entry) => entry.result === "rejected"));
    assert.deepEqual(
      new Set(rejected.map((entry) => entry.callSurface)),
      new Set(["store.updateTask", "macos_completion_http"])
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("stale UI snapshots, cross-target receipts, expiration, and nonce replay fail closed with audit", async () => {
  const f = await fixture();
  try {
    const other = f.entities.createTask({
      id: "task:other", workId: f.work.id, title: "Other target", lifecycleState: "in_progress"
    });
    const service = new TaskCompletionService({ store: f.store });
    assert.throws(
      () => service.issueMacOSIntent(f.task.id, {
        ...uiIntentInput(f.task, "stale"), displayedTaskTitle: "Stale title"
      }, { type: "user", id: "user:local-macos" }),
      (error) => error.code === "UI_TARGET_SNAPSHOT_MISMATCH"
    );
    const receipt = service.issueMacOSIntent(
      f.task.id, uiIntentInput(f.task, "cross"), { type: "user", id: "user:local-macos" }
    );
    assert.throws(
      () => service.completeFromMacOS(other.id, {
        intentToken: receipt.intentToken, requestId: "intent-request:cross", idempotencyKey: "cross-target"
      }),
      (error) => error.code === "COMPLETION_INTENT_TARGET_MISMATCH"
    );
    const expiring = new TaskCompletionService({
      store: f.store, uiTtlMs: 1, now: () => new Date("2026-08-29T00:00:00.000Z")
    });
    const expired = expiring.issueMacOSIntent(
      f.task.id, uiIntentInput(f.task, "expired"), { type: "user", id: "user:local-macos" }
    );
    const later = new TaskCompletionService({ store: f.store, now: () => new Date("2026-08-29T00:00:01.000Z") });
    assert.throws(
      () => later.completeFromMacOS(f.task.id, {
        intentToken: expired.intentToken, requestId: "intent-request:expired", idempotencyKey: "expired"
      }),
      (error) => error.code === "COMPLETION_INTENT_EXPIRED"
    );
    const errors = [
      ...f.store.listTaskCompletionOperations(f.task.id),
      ...f.store.listTaskCompletionOperations(other.id)
    ]
      .filter((entry) => entry.result === "rejected").map((entry) => entry.errorCode);
    assert.deepEqual(new Set(errors), new Set(["COMPLETION_INTENT_TARGET_MISMATCH", "COMPLETION_INTENT_EXPIRED"]));
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("UI receipt survives restart and concurrent distinct operations produce at most one success", async () => {
  const f = await fixture();
  let store = f.store;
  try {
    const receipt = new TaskCompletionService({ store }).issueMacOSIntent(
      f.task.id, uiIntentInput(f.task, "restart"), { type: "user", id: "user:local-macos" }
    );
    await store.close();
    store = new CorptieStore({ dbPath: f.dbPath, configPath: f.configPath });
    await store.initialize();
    const service = new TaskCompletionService({ store });
    const attempts = ["race:a", "race:b"].map((idempotencyKey) => {
      try {
        return service.completeFromMacOS(f.task.id, {
          intentToken: receipt.intentToken, requestId: "intent-request:restart", idempotencyKey
        }).operation.result;
      } catch (error) {
        return error.code;
      }
    });
    assert.equal(attempts.filter((value) => value === "succeeded").length, 1);
    assert.equal(store.getTask(f.task.id).lifecycle_state, "done");
  } finally {
    await store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("completion transaction rolls back receipt consumption and status when audit persistence fails", async () => {
  const f = await fixture();
  try {
    const service = new TaskCompletionService({ store: f.store });
    const receipt = service.issueMacOSIntent(
      f.task.id, uiIntentInput(f.task, "rollback"), { type: "user", id: "user:local-macos" }
    );
    f.store.db.run(`CREATE TEMP TRIGGER reject_completion_audit
      BEFORE INSERT ON task_completion_operations
      BEGIN SELECT RAISE(ABORT, 'simulated audit persistence failure'); END`);
    assert.throws(() => service.completeFromMacOS(f.task.id, {
      intentToken: receipt.intentToken,
      requestId: "intent-request:rollback",
      idempotencyKey: "complete:rollback"
    }), /simulated audit persistence failure/);
    assert.equal(f.store.getTask(f.task.id).lifecycle_state, "in_progress");
    assert.equal(f.store.getTaskCompletionIntent(receipt.receiptId).consumedOperationId, null);
    f.store.db.run("DROP TRIGGER reject_completion_audit");
    const recovered = service.completeFromMacOS(f.task.id, {
      intentToken: receipt.intentToken,
      requestId: "intent-request:rollback",
      idempotencyKey: "complete:rollback"
    });
    assert.equal(recovered.task.lifecycle_state, "done");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("completion audit is queryable and completion metadata is omitted without authorization", async () => {
  const f = await fixture();
  try {
    const service = new TaskCompletionService({ store: f.store });
    const receipt = service.issueMacOSIntent(
      f.task.id, uiIntentInput(f.task, "query"), { type: "user", id: "user:local-macos" }
    );
    const result = service.completeFromMacOS(f.task.id, {
      intentToken: receipt.intentToken,
      requestId: "intent-request:query",
      idempotencyKey: "complete:query"
    });
    assert.equal(service.listAudit(f.task.id)[0].operationId, result.operation.operationId);
    assert.equal(service.getAuditOperation(result.operation.operationId).taskId, f.task.id);

    const legacy = f.entities.createTask({
      id: "task:legacy", workId: f.work.id, title: "Historical completion", lifecycleState: "in_progress"
    });
    f.store.db.run(
      `INSERT INTO task_completion_authorizations
       (operation_id, task_id, work_id, source_type, nonce, validated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["legacy-fixture", legacy.id, f.work.id, "direct_macos_ui_action", "fixture", new Date().toISOString()]
    );
    f.store.db.run(
      "UPDATE tasks SET lifecycle_state='done', completion_operation_id='legacy-fixture', completion_source_type='direct_macos_ui_action' WHERE id=?",
      [legacy.id]
    );
    f.store.db.run(
      "UPDATE tasks SET completion_operation_id=NULL, completion_source_type=NULL WHERE id=?",
      [legacy.id]
    );
    const presented = presentTaskAcceptance(f.entities.getTask(legacy.id));
    assert.equal(presented.completionSource, undefined);
    assert.equal(f.store.listTaskCompletionOperations(legacy.id).length, 0);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

async function sessionFixture(source = { type: "desktop" }, text = "请将 Task task:completion 标记完成") {
  const f = await fixture();
  f.store.createAgent({ id: "agent:completion", name: "Completion Agent", role: "independentContributor" });
  f.store.upsertSession({
    id: "provider-session:completion", title: "Worker", agent: "Completion Agent",
    agentId: "agent:completion", provider: "provider:test", status: "running", sessionKind: "worker",
    workId: f.work.id, taskId: f.task.id
  });
  const logical = f.store.createLogicalSessionRoute({
    logicalSessionId: "session:logical-completion", legacySessionId: "provider-session:completion",
    providerThreadId: "thread:completion", providerSessionId: "provider-native:completion",
    providerId: "provider:test", boundCwd: f.directory, sessionName: "Completion worker"
  });
  const message = f.store.createUserMessageDelivery({
    deliveryId: "delivery:completion", messageId: "message:completion",
    sessionId: "provider-session:completion", binding: logical.activeBinding,
    agentId: "agent:completion", text, source
  });
  f.store.updateMessageDelivery(message.delivery.deliveryId, {
    status: "accepted", providerTurnId: "turn:completion", providerAcknowledgedAt: new Date().toISOString()
  });
  const event = f.store.getSessionEvent("user-message:message:completion");
  return { ...f, logical, event };
}

function sessionCompletionInput(f, overrides = {}) {
  return {
    targetTaskId: f.task.id,
    workId: f.work.id,
    logicalSessionId: f.logical.logicalSessionId,
    userMessageEventId: f.event.eventId,
    userMessageSequence: f.event.sequence,
    turnId: "turn:completion",
    requestId: "session-request:one",
    idempotencyKey: "session-completion:one",
    ...overrides
  };
}

test("provider-neutral Session completion accepts only the authoritative direct user event and current turn", async () => {
  const f = await sessionFixture();
  try {
    const service = new TaskCompletionService({ store: f.store });
    const result = service.completeFromSession(sessionCompletionInput(f), {
      sessionId: "provider-session:completion", logicalSessionId: "session:logical-completion"
    });
    assert.equal(result.task.lifecycle_state, "done");
    assert.equal(result.operation.logicalSessionId, "session:logical-completion");
    assert.equal(result.operation.userMessageEventId, f.event.eventId);
    assert.equal(result.operation.turnId, "turn:completion");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

for (const [label, source, expected, category] of [
  ["collaboration", { type: "collaboration", taskId: "task:one" }, "COLLABORATION_MESSAGE_NOT_AUTHORIZED", "collaboration_message"],
  ["Automation", { type: "scheduled_session_task", automationId: "automation:one" }, "AUTOMATION_MESSAGE_NOT_AUTHORIZED", "system_or_automation"]
]) {
  test(`${label} messages cannot authorize completion`, async () => {
    const f = await sessionFixture(source);
    try {
      const service = new TaskCompletionService({ store: f.store });
      assert.throws(
        () => service.completeFromSession(sessionCompletionInput(f), {
          sessionId: "provider-session:completion", logicalSessionId: "session:logical-completion"
        }),
        (error) => error.code === expected
      );
      assert.equal(f.store.getTask(f.task.id).lifecycle_state, "in_progress");
      const audit = f.store.listTaskCompletionOperations(f.task.id)[0];
      assert.equal(audit.result, "rejected");
      assert.equal(audit.details.category, category);
    } finally {
      await f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}

test("assistant judgment, wrong turn, missing intent, ambiguous target, Provider id, and cross Work all reject", async () => {
  const cases = [
    { text: "I think the task is done", overrides: {}, code: "USER_MESSAGE_COMPLETION_INTENT_MISSING" },
    { text: "请不要将 Task task:completion 标记完成", overrides: {}, code: "USER_MESSAGE_COMPLETION_INTENT_MISSING" },
    { text: "请查看 task:completion", overrides: {}, code: "USER_MESSAGE_COMPLETION_INTENT_MISSING" },
    { text: "请完成另一个 Task", overrides: {}, code: "USER_MESSAGE_TARGET_AMBIGUOUS" },
    { overrides: { turnId: "turn:wrong" }, code: "USER_MESSAGE_TURN_MISMATCH" },
    { overrides: { logicalSessionId: "provider-session:completion" }, code: "LOGICAL_SESSION_MISMATCH" },
    { overrides: { workId: "work:other" }, code: "TASK_WORK_MISMATCH" }
  ];
  for (const [index, item] of cases.entries()) {
    const f = await sessionFixture({ type: "desktop" }, item.text);
    try {
      const input = sessionCompletionInput(f, {
        requestId: `session-request:${index}`, idempotencyKey: `session-completion:${index}`,
        ...item.overrides
      });
      assert.throws(
        () => new TaskCompletionService({ store: f.store }).completeFromSession(input, {
          sessionId: "provider-session:completion", logicalSessionId: "session:logical-completion"
        }),
        (error) => error.code === item.code
      );
      assert.equal(f.store.getTask(f.task.id).lifecycle_state, "in_progress");
    } finally {
      await f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});
