import assert from "node:assert/strict";
import test from "node:test";
import {
  automationTimelineItems,
  collaborationEnvelopeFailure
} from "../src/utils/sessionEventPresentation.mjs";

test("Automation creation projects a user-facing card without internal event or run metadata", () => {
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
      trigger: { type: "processExit", process: { pollIntervalSeconds: 5 } },
      scheduleType: "process",
      expiresAt: "2026-08-25T00:56:04.649Z",
      message: { type: "automation_event", text: "Inspect the stopped process." }
    } }
  }]);

  assert.equal(item.type, "automationEvent");
  assert.equal(item.presentationRole, "automation");
  assert.equal(item.automationId, "scheduled_task:b2");
  assert.equal(item.automationName, "Shadow exit monitor");
  assert.equal(item.automationTriggerType, "processExit");
  assert.equal(item.automationEventType, "ScheduledSessionTaskCreated");
  assert.equal(item.automationEventOccurredAt, "2026-08-24T00:56:04.649Z");
  assert.equal(item.automationProcessPollIntervalSeconds, 5);
  assert.equal(item.automationExpiresAt, "2026-08-25T00:56:04.649Z");
  assert.equal(item.automationRunId, undefined);
  assert.equal(item.automationEventSource, undefined);
  assert.equal(item.createdAt, "2026-08-24T00:56:04.649Z");
  assert.equal(JSON.stringify(item).includes("81987e95-5beb-4740-9326-6d072362b182"), false);
});

test("Automation queued cards retain authoritative queue time without exposing run identity", () => {
  const [item] = automationTimelineItems([{
    eventId: "event:run",
    sequence: 22,
    type: "ScheduledSessionRunQueued",
    createdAt: "2026-08-24T01:56:05.000Z",
    source: { type: "scheduled_session_task", taskId: "scheduled_task:3662" },
    payload: {
      task: {
        taskId: "scheduled_task:3662", name: "One-hour review", trigger: { type: "after", delaySeconds: 3600 },
        scheduleType: "once", runAt: "2026-08-24T01:56:04.000Z", expiresAt: "2026-08-25T01:56:04.000Z"
      },
      run: { runId: "scheduled_run:one", triggerKind: "scheduled", status: "queued", queuedAt: "2026-08-24T01:56:04.500Z" }
    }
  }]);

  assert.equal(item.sourceType, "automation");
  assert.equal(item.automationRunId, undefined);
  assert.equal(item.automationTriggerType, "after");
  assert.equal(item.automationEventOccurredAt, "2026-08-24T01:56:04.500Z");
  assert.notEqual(item.presentationRole, "collaboration");
});

test("Automation timeline projection only admits created, due, and queued events", () => {
  const eventTypes = [
    "ScheduledSessionTaskCreated", "ScheduledSessionTaskDue", "ScheduledSessionRunQueued",
    "ScheduledSessionRunStarted", "ScheduledSessionRunCompleted", "ScheduledSessionRunFailed",
    "ScheduledSessionTaskCancelled", "ScheduledSessionTaskExpired", "ScheduledSessionRunMissed"
  ];
  const items = automationTimelineItems(eventTypes.map((type, index) => ({
    eventId: `event:${index}`, type, createdAt: "2026-08-24T00:00:00.000Z",
    payload: { task: { taskId: "scheduled_task:one", name: "One", message: { text: "Run it" } } }
  })));
  assert.deepEqual(items.map((item) => item.automationEventType), [
    "ScheduledSessionTaskCreated", "ScheduledSessionTaskDue", "ScheduledSessionRunQueued"
  ]);
});

test("collaboration cards require a queryable task and complete envelope", () => {
  const task = { kind: "collaboration", source: { taskId: "task:valid" } };
  const collaborationTask = { taskId: "task:valid" };
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
  assert.equal(collaborationEnvelopeFailure({ task, collaborationTask, envelope }), null);
  assert.equal(collaborationEnvelopeFailure({ task, collaborationTask: null, envelope }), "task_not_found");
  assert.equal(collaborationEnvelopeFailure({ task, collaborationTask, envelope: { ...envelope, message: { ...envelope.message, body: "" } } }), "missing_message_body");
  assert.equal(collaborationEnvelopeFailure({ task: { ...task, source: {} }, collaborationTask, envelope }), "missing_task_id");
});
