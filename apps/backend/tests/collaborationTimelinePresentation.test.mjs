import test from "node:test";
import assert from "node:assert/strict";
import { createCollaborationTimelinePresentation } from "../src/collaboration/collaborationTimelinePresentation.mjs";

function fixture() {
  const logical = new Map([
    ["sender", { legacySessionId: "legacy-sender", sessionName: "Sender logical" }],
    ["recipient", { legacySessionId: "legacy-recipient", sessionName: "Recipient logical" }]
  ]);
  const sessions = new Map([
    ["legacy-sender", { title: "Sender", agentId: "agent-s", workId: "work-s", taskId: "task-s", sessionKind: "task" }],
    ["legacy-recipient", { title: "Recipient", agentId: "agent-r", workId: "work-r", taskId: "task-r", sessionKind: "work_chat" }]
  ]);
  const deliveries = new Map();
  const store = {
    getLogicalSession: id => logical.get(id),
    getLogicalSessionByLegacySessionId: id => [...logical.values()].find(row => row.legacySessionId === id),
    getSession: id => sessions.get(id),
    getAgent: id => ({ name: id }),
    getTask: id => ({ id, collaboration_relation: "delegated" }),
    getWork: id => ({ name: id })
  };
  const api = createCollaborationTimelinePresentation({
    store,
    collaborationCore: {
      hasTask: id => id === "request",
      getDeliveryEnvelope: id => deliveries.get(id),
      getAgent: id => ({ name: id })
    },
    sessionChannelService: { getDeliveryEnvelope: id => deliveries.get(id) }
  });
  return { api, deliveries, logical };
}

test("user work preserves canonical message identity, queue and error metadata", () => {
  const { api } = fixture();
  assert.equal(api.agentWorkTimelineItem(null, "recipient"), null);
  const item = api.agentWorkTimelineItem({
    taskId: "work", kind: "user", status: "failed", text: "hello", lastError: "offline",
    source: { type: "feishu", messageId: "message", messageContent: { images: ["image"] } }
  }, "recipient", "2");
  assert.equal(item.id, "message");
  assert.equal(item.turnId, "work:work");
  assert.equal(item.title, "IMgateway");
  assert.equal(item.userMessageStatus, "failed");
  assert.equal(item.queuePosition, 2);
  assert.equal(item.feishuVisibility, "hidden");
  assert.equal(item.processingError, "offline");
  assert.deepEqual(item.images, ["image"]);
});

test("unverified collaboration and channel deliveries remain diagnostic system events", () => {
  const { api } = fixture();
  const base = { taskId: "work", kind: "collaboration", status: "queued", text: "untrusted" };
  const channel = api.agentWorkTimelineItem({ ...base, source: { type: "session_channel" } }, "recipient");
  assert.equal(channel.title, "System Event");
  assert.equal(channel.sourceType, "system");
  assert.equal(channel.systemEventReason, "CHANNEL_DELIVERY_ENVELOPE_MISSING");
  const legacy = api.agentWorkTimelineItem({ ...base, source: { type: "collaboration" } }, "recipient");
  assert.equal(legacy.systemEventReason, "missing_task_id");
  assert.equal(JSON.parse(legacy.rawEventEnvelope).eventType, "AgentTask");
});

test("channel inbound presentation uses verified envelope and current logical titles", () => {
  const { api, deliveries, logical } = fixture();
  deliveries.set("delivery", {
    channel: { channelId: "channel" },
    message: {
      senderSessionId: "sender", recipientSessionId: "recipient", body: "verified",
      resourceContext: { sender: { workId: "work-s", taskId: "task-s" }, recipient: { workId: "work-r" } }
    }
  });
  logical.get("sender").sessionName = "Updated";
  const item = api.agentWorkTimelineItem({
    taskId: "work", kind: "collaboration", status: "running", deliveryId: "delivery",
    source: { type: "session_channel" }
  }, "recipient");
  assert.equal(item.id, "work:work");
  assert.equal(item.collaborationDirection, "inbound");
  assert.equal(item.presentationText, "verified");
  assert.equal(item.collaborationInitiatorSessionTitle, "Updated");
  assert.equal(item.collaborationSourceWorkName, "work-s");
  assert.equal(item.collaborationSourceTaskId, "task-s");
  assert.equal(item.userMessageStatus, "processing");
  assert.equal(item.collaborationChannelId, "channel");
});

test("legacy collaboration preserves send-time names and resource route", () => {
  const { api, deliveries } = fixture();
  deliveries.set("delivery", {
    task: {
      taskId: "request", sourceWorkId: "work-s", targetWorkId: "work-r",
      initiatorSessionId: "sender", initiatorNameAtSend: "At send", sourceTaskId: "task-s"
    },
    message: {
      senderSessionId: "sender", recipientSessionId: "recipient", body: "verified",
      envelope: {
        sender: { sessionId: "sender" }, recipient: { sessionId: "recipient" },
        resources: { sourceWorkId: "work-s", targetWorkId: "work-r", sourceAgentId: "agent-s" }
      }
    }
  });
  const item = api.agentWorkTimelineItem({
    taskId: "work", kind: "collaboration", status: "completed", deliveryId: "delivery",
    source: { taskId: "request" }
  }, "recipient");
  assert.equal(item.presentationRole, "collaboration");
  assert.equal(item.collaborationInitiatorSessionTitle, "At send");
  assert.equal(item.collaborationRecipientSessionTitle, "Recipient logical");
  assert.equal(item.collaborationTargetTaskId, "request");
  assert.equal(item.collaborationRelation, "delegated");
  assert.equal(item.collaborationSenderName, "agent-s");
});

test("outbound channel projection keeps sender identity and resource context precedence", () => {
  const { api } = fixture();
  assert.equal(api.sessionChannelMessageTimelineItem({}, "sender"), null);
  const item = api.sessionChannelMessageTimelineItem({
    channel: { channelId: "channel" },
    message: {
      messageId: "message", senderSessionId: "sender", recipientSessionId: "recipient", body: "hello",
      resourceContext: { sender: { workId: "recorded-work", taskId: "recorded-task" } }
    }
  }, "sender");
  assert.equal(item.id, "session-channel-message:message:outbound");
  assert.equal(item.collaborationDirection, "outbound");
  assert.equal(item.collaborationSourceWorkId, "recorded-work");
  assert.equal(item.collaborationSourceTaskId, "recorded-task");
  assert.equal(item.collaborationSenderAgentId, "agent-s");
  assert.equal(item.productSessionId, "sender");
});

test("confirmation projections retain distinct authorization contracts and fallback titles", () => {
  const { api } = fixture();
  assert.equal(api.collaborationConfirmationTimelineItem({}, "sender"), null);
  assert.equal(api.sessionChannelAuthorizationTimelineItem({}, "sender"), null);
  const legacy = api.collaborationConfirmationTimelineItem({
    confirmationId: "confirm", status: "pending", initiatorSessionId: "legacy-sender",
    recipientSessionId: "recipient", request: { taskId: "request", summary: "Approve" }
  }, "sender");
  assert.equal(legacy.turnStatus, "waiting_approval");
  assert.equal(legacy.collaborationInitiatorSessionTitle, "Sender logical");
  assert.equal(legacy.collaborationRecipientSessionTitle, "Recipient");
  assert.equal(legacy.collaborationRelation, "delegated");
  const channel = api.sessionChannelAuthorizationTimelineItem({
    requestId: "request", requestingSessionId: "sender", requestedRecipientSessionId: "recipient",
    status: "approved", request: { summary: "Approve" }
  }, "sender");
  assert.equal(channel.turnStatus, "completed");
  assert.equal(channel.collaborationAuthorizationKind, "session_channel");
  assert.equal(channel.collaborationRecipientSessionTitle, "Recipient logical");
  assert.equal(channel.collaborationSourceWorkName, "work-s");
  assert.equal(channel.collaborationTargetTaskId, "task-r");
});
