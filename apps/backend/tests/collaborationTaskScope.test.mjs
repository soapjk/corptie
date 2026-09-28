import test from "node:test";
import assert from "node:assert/strict";
import { CollaborationTaskScope } from "../src/collaboration/collaborationTaskScope.mjs";

test("participant validation rejects two aliases of the same Session", () => {
  const scope = new CollaborationTaskScope({ store: {}, stableSessionIdentity: () => "logical" });
  assert.throws(() => scope.assertSessionParticipants(
    { initiatorSessionId: "logical", recipientSessionId: "provider-session" }, {}, {}, { requireRecipient: true }
  ), { code: "DISTINCT_SESSIONS_REQUIRED" });
});

test("scope derives Work and Binding from Sessions and rejects spoofed ownership", () => {
  const scope = new CollaborationTaskScope({ store: {
    getLogicalSession: (id) => ({ legacySessionId: id, routingVersion: 4, activeBinding: { bindingId: `binding:${id}`, state: "active" } }),
    getSession: (id) => ({ workId: `work:${id}`, taskId: `task:${id}` })
  } });
  const input = { initiatorSessionId: "source", recipientSessionId: "target" };
  const value = scope.resolveTaskScope(input, {}, {});
  assert.equal(value.sourceWorkId, "work:source");
  assert.equal(value.targetWorkId, "work:target");
  assert.equal(value.recipientBindingId, "binding:target");
  assert.equal(value.targetTaskId, "task:target");
  assert.equal(value.routingVersion, 4);
  assert.throws(() => scope.resolveTaskScope({ ...input, sourceWorkId: "other" }, {}, {}), { code: "SOURCE_WORK_SPOOFED" });
});

test("requested Task must remain in the selected Work and assigned to the recipient", () => {
  const task = { id: "task", work_id: "work", main_agent_id: "agent", lifecycle_state: "todo" };
  const scope = new CollaborationTaskScope({ store: { getTask: () => task } });
  assert.equal(scope.validateRequestedTask("task", "work", "agent"), task);
  assert.throws(() => scope.validateRequestedTask("task", "other", "agent"), { code: "TASK_WORK_MISMATCH" });
  assert.throws(() => scope.validateRequestedTask("task", "work", "other"), { code: "TASK_AGENT_MISMATCH" });
  task.lifecycle_state = "done";
  assert.throws(() => scope.validateRequestedTask("task", "work", "agent"), { code: "TASK_TERMINAL" });
});
