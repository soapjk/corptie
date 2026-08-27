import assert from "node:assert/strict";
import test from "node:test";
import {
  automationTimelineItems,
  collaborationEnvelopeFailure
} from "../src/utils/sessionEventPresentation.mjs";

test("Automation creation projects a typed card with stable identity, trigger, source, event type, and timestamp", () => {
  const [item] = automationTimelineItems([{
    eventId: "event:create",
    sequence: 21,
    type: "ScheduledSessionTaskCreated",
    createdAt: "2026-08-24T00:56:04.649Z",
    source: { type: "scheduled_session_task", taskId: "scheduled_task:b2" },
    payload: { task: {
      taskId: "scheduled_task:b2",
      automationId: "scheduled_task:b2",
      name: "Shadow exit monitor",
      status: "active",
      lastRunId: null,
      lastRunStatus: null,
      trigger: { type: "processExit" },
      message: { type: "automation_event", text: "Inspect the stopped process." }
    } }
  }]);

  assert.equal(item.type, "automationEvent");
  assert.equal(item.presentationRole, "automation");
  assert.equal(item.automationId, "scheduled_task:b2");
  assert.equal(item.automationName, "Shadow exit monitor");
  assert.equal(item.automationTriggerType, "processExit");
  assert.equal(item.automationEventSource, "scheduled_session_task");
  assert.equal(item.automationEventType, "ScheduledSessionTaskCreated");
  assert.equal(item.createdAt, "2026-08-24T00:56:04.649Z");
  assert.equal(JSON.stringify(item).includes("81987e95-5beb-4740-9326-6d072362b182"), false);
});

test("Automation run events retain run trigger and never claim collaboration semantics", () => {
  const [item] = automationTimelineItems([{
    eventId: "event:run",
    sequence: 22,
    type: "ScheduledSessionRunQueued",
    createdAt: "2026-08-24T01:56:05.000Z",
    source: { type: "scheduled_session_task", taskId: "scheduled_task:3662" },
    payload: {
      task: { taskId: "scheduled_task:3662", name: "One-hour review", trigger: { type: "after" } },
      run: { runId: "scheduled_run:one", triggerKind: "scheduled", status: "queued" }
    }
  }]);

  assert.equal(item.sourceType, "automation");
  assert.equal(item.automationRunId, "scheduled_run:one");
  assert.equal(item.automationTriggerType, "scheduled");
  assert.notEqual(item.presentationRole, "collaboration");
});

test("collaboration cards require a queryable task and complete envelope", () => {
  const workItem = { kind: "collaboration", source: { taskId: "task:valid" } };
  const task = { taskId: "task:valid" };
  const envelope = {
    task: { taskId: "task:valid", sourceObjectiveId: "objective:source", targetObjectiveId: "objective:target" },
    message: {
      senderSessionId: "session:source",
      recipientSessionId: "session:target",
      body: "Review this.",
      envelope: {
        sender: { sessionId: "session:source" },
        recipient: { sessionId: "session:target" }
      }
    }
  };
  assert.equal(collaborationEnvelopeFailure({ workItem, task, envelope }), null);
  assert.equal(collaborationEnvelopeFailure({ workItem, task: null, envelope }), "task_not_found");
  assert.equal(collaborationEnvelopeFailure({ workItem, task, envelope: { ...envelope, message: { ...envelope.message, body: "" } } }), "missing_message_body");
  assert.equal(collaborationEnvelopeFailure({ workItem: { ...workItem, source: {} }, task, envelope }), "missing_task_id");
});
