import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AUTOMATIC_WORK_ITEM_SESSION_REPAIRS,
  evaluateWorkItemSessionRepair
} from "../src/application/workItemSessionRepairPolicy.mjs";

function input(overrides = {}) {
  return {
    workItem: { id: "work_item:one", status: "in_progress", current_session_id: "session:old" },
    session: { id: "session:old", sessionKind: "worker" },
    failedWork: { targetTurnId: null },
    error: { code: "PROVIDER_SESSION_UNAVAILABLE", safeToRetry: true },
    turnCount: 0,
    uncertainDeliveries: [],
    repairCount: 0,
    providerId: "provider-neutral",
    agent: { agentId: "agent:one" },
    ...overrides
  };
}

test("an incomplete WorkItem with a definitively missing unused Provider Session can self-repair", () => {
  assert.deepEqual(evaluateWorkItemSessionRepair(input()), {
    eligible: true,
    reason: "provider-session-unavailable"
  });
});

test("self-repair fails closed after any observed or ambiguous Provider execution", () => {
  assert.equal(evaluateWorkItemSessionRepair(input({ turnCount: 1 })).reason, "PROVIDER_EXECUTION_OBSERVED");
  assert.equal(evaluateWorkItemSessionRepair(input({
    uncertainDeliveries: [{ status: "delivery_unknown", last_error: "socket closed" }]
  })).reason, "DELIVERY_OUTCOME_AMBIGUOUS");
  assert.equal(evaluateWorkItemSessionRepair(input({
    uncertainDeliveries: [{
      status: "delivery_unknown",
      last_error: '{"message":"no rollout found for thread id legacy-thread"}'
    }]
  })).eligible, true, "legacy releases misclassified this explicit pre-execution failure");
  assert.equal(evaluateWorkItemSessionRepair(input({
    uncertainDeliveries: [{
      status: "delivery_unknown",
      last_error: "WorkItem work_item:one points to no Session, not active Worker Session session:old."
    }, {
      status: "delivery_unknown",
      last_error: '{"message":"no rollout found for thread id legacy-thread"}'
    }]
  })).eligible, true, "the legacy binding race and missing rollout both happened before Provider execution");
  assert.equal(evaluateWorkItemSessionRepair(input({
    uncertainDeliveries: [{
      status: "delivery_unknown",
      last_error: "WorkItem work_item:one points to no Session, not active Worker Session session:old."
    }, {
      status: "delivery_unknown",
      last_error: "connection reset after dispatch"
    }]
  })).reason, "DELIVERY_OUTCOME_AMBIGUOUS", "an unrelated ambiguous delivery must still fail closed");
});

test("terminal, stale, and repeatedly failing WorkItems cannot be replaced", () => {
  assert.equal(evaluateWorkItemSessionRepair(input({
    workItem: { id: "work_item:one", status: "done", current_session_id: "session:old" }
  })).reason, "WORK_ITEM_TERMINAL");
  assert.equal(evaluateWorkItemSessionRepair(input({
    workItem: { id: "work_item:one", status: "in_progress", current_session_id: "session:new" }
  })).reason, "SESSION_NOT_CURRENT_WORKER");
  assert.equal(evaluateWorkItemSessionRepair(input({
    repairCount: MAX_AUTOMATIC_WORK_ITEM_SESSION_REPAIRS
  })).reason, "REPAIR_LIMIT_REACHED");
});
