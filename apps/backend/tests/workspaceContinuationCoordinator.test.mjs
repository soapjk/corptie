import assert from "node:assert/strict";
import test from "node:test";
import {
  continuationTaskId,
  WorkspaceContinuationCoordinator
} from "../src/application/workspaceContinuationCoordinator.mjs";

test("a committed transition queues one hidden continuation with a stable idempotency key", () => {
  const fixture = coordinatorFixture();
  const first = fixture.coordinator.enqueueForTransition("transition:one");
  const second = fixture.coordinator.enqueueForTransition("transition:one");

  assert.equal(first.taskId, continuationTaskId("transition:one"));
  assert.equal(second.taskId, first.taskId);
  assert.equal(fixture.work.size, 1);
  assert.equal(first.localVisibility, "status_only");
  assert.equal(first.source.type, "workspace-continuation");
  assert.equal(first.sessionId, "session:one");
  assert.equal(first.source.productSessionId, "session:one");
  assert.equal(first.source.taskId, "task:one");
  assert.equal(first.source.bindingId, "binding:next");
  assert.equal(first.source.providerSessionId, "provider:next");
  assert.equal(fixture.transition.continuationState, "queued");
  assert.equal(fixture.coordinator.assertWorkTarget(first).logical.activeThreadId, "route:next");
});

test("restart recovery completes an intent whose durable work item already finished", () => {
  const fixture = coordinatorFixture();
  fixture.coordinator.enqueueForTransition("transition:one");
  fixture.work.get(continuationTaskId("transition:one")).status = "completed";

  fixture.coordinator.recover();

  assert.equal(fixture.transition.continuationState, "completed");
});

test("restart recovery requeues a failed continuation for a bounded new delivery attempt", () => {
  const fixture = coordinatorFixture();
  fixture.coordinator.enqueueForTransition("transition:one");
  const task = fixture.work.get(continuationTaskId("transition:one"));
  task.status = "failed";
  fixture.transition.continuationState = "failed";

  fixture.coordinator.recover();

  assert.equal(task.status, "queued");
  assert.equal(fixture.transition.continuationState, "queued");
});

test("restart recovery enriches legacy queued continuation work with the committed target binding", () => {
  const fixture = coordinatorFixture();
  const id = continuationTaskId("transition:one");
  fixture.work.set(id, {
    taskId: id,
    agentId: "agent:one",
    sessionId: "session:one",
    status: "queued",
    source: {
      type: "workspace-continuation",
      transitionId: "transition:one",
      logicalSessionId: "logical:one",
      routingVersion: 2
    }
  });

  fixture.coordinator.recover();

  assert.equal(fixture.work.get(id).source.bindingId, "binding:next");
  assert.equal(fixture.work.get(id).source.productSessionId, "session:one");
  assert.equal(fixture.coordinator.assertWorkTarget(fixture.work.get(id)).logical.activeThreadId, "route:next");
});

test("restart recovery retires a continuation superseded by a newer route", () => {
  const fixture = coordinatorFixture();
  const id = continuationTaskId("transition:one");
  fixture.coordinator.enqueueForTransition("transition:one");
  fixture.logical.routingVersion = 3;
  fixture.logical.activeThreadId = "route:newer";

  fixture.coordinator.recover();

  assert.equal(fixture.work.get(id).status, "failed");
  assert.equal(fixture.transition.continuationState, "failed");
  assert.match(fixture.transition.continuationError, /does not match its continuation checkpoint/);
});

test("requeued interrupted continuation returns its durable transition to queued", () => {
  const fixture = coordinatorFixture();
  const task = fixture.coordinator.enqueueForTransition("transition:one");
  task.status = "queued";
  task.targetTurnId = null;
  task.lastError = "Provider restarted.";
  fixture.transition.continuationState = "running";

  fixture.coordinator.recordWorkRequeued(task);

  assert.equal(fixture.transition.continuationState, "queued");
  assert.equal(fixture.transition.continuationTurnId, null);
  assert.equal(fixture.transition.continuationError, "Provider restarted.");
});

test("continuation delivery fails closed when the logical route no longer matches", () => {
  const fixture = coordinatorFixture();
  fixture.logical.routingVersion = 3;
  assert.throws(
    () => fixture.coordinator.enqueueForTransition("transition:one"),
    /does not match its continuation checkpoint/
  );
  assert.equal(fixture.work.size, 0);
});

test("continuation delivery fails closed when the Task points to another Work Session", () => {
  const fixture = coordinatorFixture();
  const task = fixture.coordinator.enqueueForTransition("transition:one");
  fixture.ownership.taskId = "task:replacement";
  assert.throws(
    () => fixture.coordinator.assertWorkTarget(task),
    /target changed before dispatch/
  );
});

function coordinatorFixture() {
  const transition = {
    transitionId: "transition:one",
    logicalSessionId: "logical:one",
    sourceRoutingVersion: 1,
    newThreadId: "route:next",
    phase: "committed",
    continuationPrompt: "Continue remaining work.",
    continuationState: "pending",
    updatedAt: "2026-08-08T00:00:00.000Z"
  };
  const logical = {
    logicalSessionId: "logical:one",
    legacySessionId: "session:one",
    activeThreadId: "route:next",
    routingVersion: 2,
    activeBinding: {
      bindingId: "binding:next",
      providerThreadId: "route:next",
      providerSessionId: "provider:next"
    }
  };
  const ownership = {
    logicalSessionId: "logical:one",
    sessionId: "session:one",
    taskId: "task:one",
    workId: "work:one",
    agentId: "agent:one"
  };
  const work = new Map();
  const store = {
    getWorkspaceTransition: () => transition,
    getLogicalSession: () => logical,
    assertLogicalWorkSessionBinding: () => ownership,
    getAgentTask: (id) => work.get(id) ?? null,
    listWorkspaceTransitionsAwaitingContinuation: () => [transition],
    updateWorkspaceTransitionContinuation(_id, update) {
      transition.continuationState = update.state;
      transition.continuationTurnId = update.turnId;
      transition.continuationError = update.error;
      return transition;
    },
    updateAgentTask(id, update) {
      Object.assign(work.get(id), update);
      return work.get(id);
    }
  };
  const coordinator = new WorkspaceContinuationCoordinator({
    store,
    resolveAgent: () => ({ agentId: "agent:one" }),
    enqueueWork(item) {
      if (!work.has(item.taskId)) work.set(item.taskId, { ...item, status: "queued" });
      return work.get(item.taskId);
    },
    scheduleDrain() {}
  });
  return { coordinator, logical, ownership, store, transition, work };
}
