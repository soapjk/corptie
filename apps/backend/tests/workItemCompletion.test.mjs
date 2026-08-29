import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { presentWorkItemAcceptance } from "../src/application/workItemAcceptance.mjs";
import { WorkItemCompletionService } from "../src/application/workItemCompletionService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-work-item-completion-"));
  const dbPath = join(directory, "db.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath });
  await store.initialize();
  const entities = new ObjectiveApplicationService({ store });
  const objective = entities.createObjective({ id: "objective:completion", name: "Completion" });
  const workItem = entities.createWorkItem({
    id: "work_item:completion", objectiveId: objective.id,
    title: "Ship completion authorization", status: "in_progress"
  });
  return { directory, dbPath, configPath, store, entities, objective, workItem };
}

function uiIntentInput(workItem, suffix = "one") {
  return {
    requestId: `intent-request:${suffix}`,
    interactionId: `interaction:${suffix}`,
    uiSurface: "work_item_completion_confirmation",
    displayedWorkItemId: workItem.id,
    displayedWorkItemTitle: workItem.title,
    displayedAcceptanceStatus: "passed"
  };
}

test("macOS direct intent is target-bound, one-time, audited, and idempotently retryable", async () => {
  const f = await fixture();
  try {
    const service = new WorkItemCompletionService({ store: f.store });
    const receipt = service.issueMacOSIntent(
      f.workItem.id, uiIntentInput(f.workItem), { type: "user", id: "user:local-macos" }
    );
    const request = {
      intentToken: receipt.intentToken,
      requestId: "intent-request:one",
      idempotencyKey: "complete:one"
    };
    const first = service.completeFromMacOS(f.workItem.id, request);
    const replay = service.completeFromMacOS(f.workItem.id, request);
    assert.equal(first.workItem.status, "done");
    assert.equal(first.operation.sourceType, "direct_macos_ui_action");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.operation.operationId, first.operation.operationId);
    assert.equal(f.store.listWorkItemCompletionOperations(f.workItem.id).length, 1);
    assert.throws(
      () => f.store.db.run("UPDATE work_item_completion_operations SET result='rejected' WHERE operation_id=?", [first.operation.operationId]),
      /WORK_ITEM_COMPLETION_AUDIT_IMMUTABLE/
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("confirmed=true, ordinary PATCH semantics, and direct Store updates cannot complete", async () => {
  const f = await fixture();
  try {
    assert.throws(
      () => f.entities.confirmWorkItemCompletion(f.workItem.id, { confirmed: true }),
      (error) => error.code === "WORK_ITEM_COMPLETION_INTENT_REQUIRED"
    );
    assert.throws(
      () => f.entities.updateWorkItem(f.workItem.id, { status: "done" }),
      (error) => error.code === "WORK_ITEM_COMPLETION_INTENT_REQUIRED"
    );
    assert.throws(
      () => f.store.updateWorkItem(f.workItem.id, { status: "done" }),
      (error) => error.code === "WORK_ITEM_COMPLETION_INTENT_REQUIRED"
    );
    assert.throws(
      () => new WorkItemCompletionService({ store: f.store }).completeFromMacOS(f.workItem.id, {
        requestId: "missing-token-request", idempotencyKey: "missing-token-idempotency"
      }),
      (error) => error.code === "COMPLETION_INTENT_REQUIRED"
    );
    assert.equal(f.store.getWorkItem(f.workItem.id).status, "in_progress");
    const rejected = f.store.listWorkItemCompletionOperations(f.workItem.id);
    assert.equal(rejected.length, 4);
    assert.ok(rejected.every((entry) => entry.result === "rejected"));
    assert.deepEqual(
      new Set(rejected.map((entry) => entry.callSurface)),
      new Set(["legacy_confirm_completion", "store.updateWorkItem", "macos_completion_http"])
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("stale UI snapshots, cross-target receipts, expiration, and nonce replay fail closed with audit", async () => {
  const f = await fixture();
  try {
    const other = f.entities.createWorkItem({
      id: "work_item:other", objectiveId: f.objective.id, title: "Other target", status: "in_progress"
    });
    const service = new WorkItemCompletionService({ store: f.store });
    assert.throws(
      () => service.issueMacOSIntent(f.workItem.id, {
        ...uiIntentInput(f.workItem, "stale"), displayedWorkItemTitle: "Stale title"
      }, { type: "user", id: "user:local-macos" }),
      (error) => error.code === "UI_TARGET_SNAPSHOT_MISMATCH"
    );
    const receipt = service.issueMacOSIntent(
      f.workItem.id, uiIntentInput(f.workItem, "cross"), { type: "user", id: "user:local-macos" }
    );
    assert.throws(
      () => service.completeFromMacOS(other.id, {
        intentToken: receipt.intentToken, requestId: "intent-request:cross", idempotencyKey: "cross-target"
      }),
      (error) => error.code === "COMPLETION_INTENT_TARGET_MISMATCH"
    );
    const expiring = new WorkItemCompletionService({
      store: f.store, uiTtlMs: 1, now: () => new Date("2026-08-29T00:00:00.000Z")
    });
    const expired = expiring.issueMacOSIntent(
      f.workItem.id, uiIntentInput(f.workItem, "expired"), { type: "user", id: "user:local-macos" }
    );
    const later = new WorkItemCompletionService({ store: f.store, now: () => new Date("2026-08-29T00:00:01.000Z") });
    assert.throws(
      () => later.completeFromMacOS(f.workItem.id, {
        intentToken: expired.intentToken, requestId: "intent-request:expired", idempotencyKey: "expired"
      }),
      (error) => error.code === "COMPLETION_INTENT_EXPIRED"
    );
    const errors = [
      ...f.store.listWorkItemCompletionOperations(f.workItem.id),
      ...f.store.listWorkItemCompletionOperations(other.id)
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
    const receipt = new WorkItemCompletionService({ store }).issueMacOSIntent(
      f.workItem.id, uiIntentInput(f.workItem, "restart"), { type: "user", id: "user:local-macos" }
    );
    await store.close();
    store = new CorptieStore({ dbPath: f.dbPath, configPath: f.configPath });
    await store.initialize();
    const service = new WorkItemCompletionService({ store });
    const attempts = ["race:a", "race:b"].map((idempotencyKey) => {
      try {
        return service.completeFromMacOS(f.workItem.id, {
          intentToken: receipt.intentToken, requestId: "intent-request:restart", idempotencyKey
        }).operation.result;
      } catch (error) {
        return error.code;
      }
    });
    assert.equal(attempts.filter((value) => value === "succeeded").length, 1);
    assert.equal(store.getWorkItem(f.workItem.id).status, "done");
  } finally {
    await store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("completion transaction rolls back receipt consumption and status when audit persistence fails", async () => {
  const f = await fixture();
  try {
    const service = new WorkItemCompletionService({ store: f.store });
    const receipt = service.issueMacOSIntent(
      f.workItem.id, uiIntentInput(f.workItem, "rollback"), { type: "user", id: "user:local-macos" }
    );
    f.store.db.run(`CREATE TEMP TRIGGER reject_completion_audit
      BEFORE INSERT ON work_item_completion_operations
      BEGIN SELECT RAISE(ABORT, 'simulated audit persistence failure'); END`);
    assert.throws(() => service.completeFromMacOS(f.workItem.id, {
      intentToken: receipt.intentToken,
      requestId: "intent-request:rollback",
      idempotencyKey: "complete:rollback"
    }), /simulated audit persistence failure/);
    assert.equal(f.store.getWorkItem(f.workItem.id).status, "in_progress");
    assert.equal(f.store.getWorkItemCompletionIntent(receipt.receiptId).consumedOperationId, null);
    f.store.db.run("DROP TRIGGER reject_completion_audit");
    const recovered = service.completeFromMacOS(f.workItem.id, {
      intentToken: receipt.intentToken,
      requestId: "intent-request:rollback",
      idempotencyKey: "complete:rollback"
    });
    assert.equal(recovered.workItem.status, "done");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("completion audit is queryable by WorkItem and operation while old completed rows remain legacy/unattributed", async () => {
  const f = await fixture();
  try {
    const service = new WorkItemCompletionService({ store: f.store });
    const receipt = service.issueMacOSIntent(
      f.workItem.id, uiIntentInput(f.workItem, "query"), { type: "user", id: "user:local-macos" }
    );
    const result = service.completeFromMacOS(f.workItem.id, {
      intentToken: receipt.intentToken,
      requestId: "intent-request:query",
      idempotencyKey: "complete:query"
    });
    assert.equal(service.listAudit(f.workItem.id)[0].operationId, result.operation.operationId);
    assert.equal(service.getAuditOperation(result.operation.operationId).workItemId, f.workItem.id);

    const legacy = f.entities.createWorkItem({
      id: "work_item:legacy", objectiveId: f.objective.id, title: "Historical completion", status: "in_progress"
    });
    f.store.db.run(
      `INSERT INTO work_item_completion_authorizations
       (operation_id, work_item_id, objective_id, source_type, nonce, validated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["legacy-fixture", legacy.id, f.objective.id, "direct_macos_ui_action", "fixture", new Date().toISOString()]
    );
    f.store.db.run(
      "UPDATE work_items SET status='done', completion_operation_id='legacy-fixture', completion_source_type='direct_macos_ui_action' WHERE id=?",
      [legacy.id]
    );
    f.store.db.run(
      "UPDATE work_items SET completion_operation_id=NULL, completion_source_type=NULL WHERE id=?",
      [legacy.id]
    );
    const presented = presentWorkItemAcceptance(f.entities.getWorkItem(legacy.id));
    assert.equal(presented.completionSource.sourceType, "legacy/unattributed");
    assert.equal(f.store.listWorkItemCompletionOperations(legacy.id).length, 0);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

async function sessionFixture(source = { type: "desktop" }, text = "请将 WorkItem work_item:completion 标记完成") {
  const f = await fixture();
  f.store.createAgent({ id: "agent:completion", name: "Completion Agent", role: "independentContributor" });
  f.store.upsertSession({
    id: "provider-session:completion", title: "Worker", agent: "Completion Agent",
    agentId: "agent:completion", provider: "provider:test", status: "running", sessionKind: "worker",
    objectiveId: f.objective.id, workItemId: f.workItem.id
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
    targetWorkItemId: f.workItem.id,
    objectiveId: f.objective.id,
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
    const service = new WorkItemCompletionService({ store: f.store });
    const result = service.completeFromSession(sessionCompletionInput(f), {
      sessionId: "provider-session:completion", logicalSessionId: "session:logical-completion"
    });
    assert.equal(result.workItem.status, "done");
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
      const service = new WorkItemCompletionService({ store: f.store });
      assert.throws(
        () => service.completeFromSession(sessionCompletionInput(f), {
          sessionId: "provider-session:completion", logicalSessionId: "session:logical-completion"
        }),
        (error) => error.code === expected
      );
      assert.equal(f.store.getWorkItem(f.workItem.id).status, "in_progress");
      const audit = f.store.listWorkItemCompletionOperations(f.workItem.id)[0];
      assert.equal(audit.result, "rejected");
      assert.equal(audit.details.category, category);
    } finally {
      await f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}

test("assistant judgment, wrong turn, missing intent, ambiguous target, Provider id, and cross Objective all reject", async () => {
  const cases = [
    { text: "I think the task is done", overrides: {}, code: "USER_MESSAGE_COMPLETION_INTENT_MISSING" },
    { text: "请不要将 WorkItem work_item:completion 标记完成", overrides: {}, code: "USER_MESSAGE_COMPLETION_INTENT_MISSING" },
    { text: "请查看 work_item:completion", overrides: {}, code: "USER_MESSAGE_COMPLETION_INTENT_MISSING" },
    { text: "请完成另一个 WorkItem", overrides: {}, code: "USER_MESSAGE_TARGET_AMBIGUOUS" },
    { overrides: { turnId: "turn:wrong" }, code: "USER_MESSAGE_TURN_MISMATCH" },
    { overrides: { logicalSessionId: "provider-session:completion" }, code: "LOGICAL_SESSION_MISMATCH" },
    { overrides: { objectiveId: "objective:other" }, code: "WORK_ITEM_OBJECTIVE_MISMATCH" }
  ];
  for (const [index, item] of cases.entries()) {
    const f = await sessionFixture({ type: "desktop" }, item.text);
    try {
      const input = sessionCompletionInput(f, {
        requestId: `session-request:${index}`, idempotencyKey: `session-completion:${index}`,
        ...item.overrides
      });
      assert.throws(
        () => new WorkItemCompletionService({ store: f.store }).completeFromSession(input, {
          sessionId: "provider-session:completion", logicalSessionId: "session:logical-completion"
        }),
        (error) => error.code === item.code
      );
      assert.equal(f.store.getWorkItem(f.workItem.id).status, "in_progress");
    } finally {
      await f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});
