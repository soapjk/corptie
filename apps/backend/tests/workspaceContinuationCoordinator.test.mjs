import assert from "node:assert/strict";
import test from "node:test";
import {
  continuationWorkItemId,
  WorkspaceContinuationCoordinator
} from "../src/application/workspaceContinuationCoordinator.mjs";

test("a committed transition queues one hidden continuation with a stable idempotency key", () => {
  const fixture = coordinatorFixture();
  const first = fixture.coordinator.enqueueForTransition("transition:one");
  const second = fixture.coordinator.enqueueForTransition("transition:one");

  assert.equal(first.workItemId, continuationWorkItemId("transition:one"));
  assert.equal(second.workItemId, first.workItemId);
  assert.equal(fixture.work.size, 1);
  assert.equal(first.localVisibility, "status_only");
  assert.equal(first.source.type, "workspace-continuation");
  assert.equal(fixture.transition.continuationState, "queued");
});

test("restart recovery completes an intent whose durable work item already finished", () => {
  const fixture = coordinatorFixture();
  fixture.coordinator.enqueueForTransition("transition:one");
  fixture.work.get(continuationWorkItemId("transition:one")).status = "completed";

  fixture.coordinator.recover();

  assert.equal(fixture.transition.continuationState, "completed");
});

test("restart recovery requeues a failed continuation for a bounded new delivery attempt", () => {
  const fixture = coordinatorFixture();
  fixture.coordinator.enqueueForTransition("transition:one");
  const workItem = fixture.work.get(continuationWorkItemId("transition:one"));
  workItem.status = "failed";
  fixture.transition.continuationState = "failed";

  fixture.coordinator.recover();

  assert.equal(workItem.status, "queued");
  assert.equal(fixture.transition.continuationState, "queued");
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
    activeBinding: { providerThreadId: "route:next" }
  };
  const work = new Map();
  const store = {
    getWorkspaceTransition: () => transition,
    getLogicalSession: () => logical,
    getAgentWorkItem: (id) => work.get(id) ?? null,
    listWorkspaceTransitionsAwaitingContinuation: () => [transition],
    updateWorkspaceTransitionContinuation(_id, update) {
      transition.continuationState = update.state;
      transition.continuationTurnId = update.turnId;
      transition.continuationError = update.error;
      return transition;
    },
    updateAgentWorkItem(id, update) {
      Object.assign(work.get(id), update);
      return work.get(id);
    }
  };
  const coordinator = new WorkspaceContinuationCoordinator({
    store,
    resolveAgent: () => ({ agentId: "agent:one" }),
    enqueueWork(item) {
      if (!work.has(item.workItemId)) work.set(item.workItemId, { ...item, status: "queued" });
      return work.get(item.workItemId);
    },
    scheduleDrain() {}
  });
  return { coordinator, logical, store, transition, work };
}
