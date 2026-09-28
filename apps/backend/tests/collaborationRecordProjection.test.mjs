import test from "node:test";
import assert from "node:assert/strict";
import { agentFromRow, taskFromRow, taskConfirmationFromRow, deliveryFromRow, parseJson } from "../src/collaboration/collaborationRecordProjection.mjs";

function store() {
  return {
    getLogicalSession: (id) => id === "logical" ? { logicalSessionId: id, legacySessionId: "provider-session", sessionName: "Current title" } : null,
    getLogicalSessionByLegacySessionId: () => null,
    getSession: (id) => id === "provider-session" ? { id, title: "Provider title", workId: "work", taskId: "task" } : null,
    listWorks: () => [{ id: "work", contributorAgentIds: ["agent"] }],
    getWork: () => null,
    getTask: () => null
  };
}

test("Agent projection keeps selected logical Session separate from provider identity", () => {
  const value = agentFromRow({ agent_id: "agent", current_session_id: "provider-session", capabilities_json: "[]" }, store(), "logical");
  assert.equal(value.sessionId, "logical");
  assert.equal(value.providerSessionId, "provider-session");
  assert.equal(value.sessionName, "Current title");
  assert.equal(value.currentTaskId, "task");
  assert.deepEqual(value.workIds, ["work"]);
});

test("Task projection resolves current names without replacing stored participant identities", () => {
  const value = taskFromRow({ initiator_session_id: "logical", initiator_name_at_send: "Old title",
    recipient_session_id: "missing", recipient_name_at_send: "Retained title", acceptance_criteria_json: "invalid" }, store());
  assert.equal(value.initiatorSessionId, "logical");
  assert.equal(value.initiatorNameAtSend, "Current title");
  assert.equal(value.recipientNameAtSend, "Retained title");
  assert.deepEqual(value.acceptanceCriteria, []);
});

test("unresolved confirmation does not infer a recipient Session from its Agent", () => {
  const value = taskConfirmationFromRow({ request_json: JSON.stringify({ routingIntent: "new-task" }) }, {
    store: store(), getAgent: () => ({ sessionId: "logical", name: "Agent" })
  });
  assert.equal(value.recipientSessionId, null);
  assert.equal(value.initiatorSessionId, "logical");
});

test("delivery projection retains legacy recipient fallback and safe JSON defaults", () => {
  const value = deliveryFromRow({ message_recipient_session_id: "logical", attempt_count: "2" });
  assert.equal(value.recipientSessionId, "logical");
  assert.equal(value.attemptCount, 2);
  assert.deepEqual(parseJson("broken", []), []);
});
