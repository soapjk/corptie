import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { SessionChannelService } from "../src/collaboration/sessionChannelService.mjs";
import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { SessionCollaborationService } from "../src/application/sessionCollaborationService.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-channel-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  const core = new CollaborationCore(store);
  core.registerAgent({ agentId: "agent:a", name: "Agent A" });
  core.registerAgent({ agentId: "agent:b", name: "Agent B" });
  const objective = store.createObjective({
    id: "objective:channel", name: "Channel", contributorAgentIds: ["agent:a", "agent:b"]
  });
  for (const endpoint of [
    { provider: "provider:a", logical: "session:a", agent: "agent:a", item: "task:a" },
    { provider: "provider:b", logical: "session:b", agent: "agent:b", item: "task:b" }
  ]) {
    store.createTask({
      id: endpoint.item, objectiveId: objective.id, title: endpoint.item, mainAgentId: endpoint.agent
    }, { originType: "direct_user" });
    store.createSession({
      id: endpoint.provider, title: endpoint.provider, agentId: endpoint.agent,
      sessionKind: "worker", objectiveId: objective.id, taskId: endpoint.item, cwd: directory
    });
    store.createLogicalSessionRoute({
      logicalSessionId: endpoint.logical,
      legacySessionId: endpoint.provider,
      providerThreadId: endpoint.provider,
      providerSessionId: endpoint.provider,
      providerId: "test-provider",
      boundCwd: directory,
      sessionName: endpoint.logical
    });
    core.bindSession({ agentId: endpoint.agent, sessionId: endpoint.provider });
  }
  let ordinal = 0;
  const service = new SessionChannelService({
    store,
    collaborationCore: core,
    idFactory: () => `id-${++ordinal}`,
    clock: () => "2026-08-31T12:00:00.000Z"
  });
  return { directory, store, service };
}

test("Channel authorization creates one durable equal Session pair and supports both directions", async () => {
  const value = await fixture();
  try {
    assert.throws(() => value.service.requestChannel({
      requestingSessionId: "session:a",
      recipientSessionId: "session:b",
      body: "Invalid pre-channel reply",
      inReplyToMessageId: "channel_message:missing",
      idempotencyKey: "open:invalid-reply"
    }), { code: "CHANNEL_REPLY_REQUIRES_ACTIVE_CHANNEL" });

    const pending = value.service.requestChannel({
      requestingSessionId: "session:a",
      recipientSessionId: "session:b",
      body: "Can you help?",
      messageKind: "question",
      idempotencyKey: "open:1"
    });
    assert.equal(pending.status, "pending");
    assert.equal(value.service.listChannels("session:a").length, 0);

    const confirmed = value.service.confirmRequest(pending.requestId, {
      recipientSessionId: "session:b"
    }, { type: "direct_user" });
    assert.equal(confirmed.status, "confirmed");
    const channel = value.service.getChannel(confirmed.channelId);
    assert.deepEqual([channel.sessionAId, channel.sessionBId], ["session:a", "session:b"]);
    assert.equal(channel.status, "active");

    const firstMessages = value.service.listMessages(channel.channelId, "session:a");
    assert.equal(firstMessages[0].body, "Can you help?");
    assert.equal(firstMessages[0].senderSessionId, "session:a");
    assert.equal(firstMessages[0].recipientSessionId, "session:b");

    const reply = value.service.sendMessage({
      channelId: channel.channelId,
      senderSessionId: "session:b",
      body: "Yes.",
      inReplyToMessageId: firstMessages[0].messageId,
      idempotencyKey: "reply:1"
    });
    assert.equal(reply.message.senderSessionId, "session:b");
    assert.equal(reply.message.recipientSessionId, "session:a");
    assert.equal(value.service.listMessages(channel.channelId, "session:b").length, 2);
    assert.throws(() => value.service.sendMessage({
      channelId: channel.channelId,
      senderSessionId: "session:b",
      body: "Different payload",
      idempotencyKey: "reply:1"
    }), { code: "CHANNEL_IDEMPOTENCY_CONFLICT" });
    assert.throws(() => value.service.sendMessage({
      channelId: channel.channelId,
      senderSessionId: "session:b",
      body: "Reply to missing",
      inReplyToMessageId: "channel_message:missing",
      idempotencyKey: "reply:missing"
    }), { code: "CHANNEL_REPLY_MESSAGE_NOT_FOUND" });
    assert.throws(() => value.service.requestChannel({
      requestingSessionId: "session:a",
      recipientSessionId: "session:b",
      body: "Changed initial payload",
      messageKind: "question",
      idempotencyKey: "open:1"
    }), { code: "CHANNEL_IDEMPOTENCY_CONFLICT" });

    const reused = value.service.requestChannel({
      requestingSessionId: "session:a",
      recipientSessionId: "session:b",
      body: "Another topic",
      idempotencyKey: "open:2"
    });
    assert.equal(reused.status, "sent");
    assert.equal(reused.channel.channelId, channel.channelId);
    assert.equal(value.store.selectAll("SELECT * FROM session_collaboration_channels").length, 1);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Task creation origin is immutable provenance and does not create hierarchy", async () => {
  const value = await fixture();
  try {
    const item = value.store.createTask({
      id: "task:independent",
      objectiveId: "objective:channel",
      title: "Independent"
    }, {
      originType: "session",
      creatorSessionId: "session:a",
      creationContextTaskId: "task:a",
      operationId: "create:independent"
    });
    const origin = value.store.getTaskCreationOrigin(item.id);
    assert.equal(origin.originType, "session");
    assert.equal(origin.creatorSessionId, "session:a");
    assert.equal(origin.creationContextTaskId, "task:a");
    const stored = value.store.getTask(item.id);
    assert.equal(stored.source_task_id, null);
    assert.equal(stored.parent_task_id, null);
    assert.equal(stored.collaboration_relation, null);
    assert.deepEqual(value.store.listTaskDependencies(item.id), []);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("one authorization can provision the missing Task and Session before activating the Channel", async () => {
  const value = await fixture();
  try {
    const objectiveService = new ObjectiveApplicationService({ store: value.store });
    const launches = [];
    const provisioning = new SessionCollaborationService({
      store: value.store,
      objectiveService,
      collaborationCore: value.service.collaborationCore,
      startTask: async ({ task, agent }) => {
        launches.push({ taskId: task.id, agentId: agent.agentId });
        value.store.createSession({
          id: "provider:created", title: "Created peer", agentId: agent.agentId,
          sessionKind: "worker", objectiveId: task.objective_id, taskId: task.id,
          cwd: value.directory
        });
        value.store.createLogicalSessionRoute({
          logicalSessionId: "session:created", legacySessionId: "provider:created",
          providerThreadId: "provider:created", providerSessionId: "provider:created",
          providerId: "test-provider", boundCwd: value.directory, sessionName: "Created peer"
        });
        value.service.collaborationCore.bindSession({ agentId: agent.agentId, sessionId: "provider:created" });
        value.store.bindSessionToTask("provider:created", task.id, task.objective_id);
        return { id: "provider:created" };
      }
    });
    const pending = value.service.requestChannel({
      requestingSessionId: "session:a",
      targetObjectiveId: "objective:channel",
      sessionAgentId: "agent:b",
      title: "Long-lived peer",
      body: "Please join this Channel.",
      idempotencyKey: "provision:1"
    });
    assert.equal(pending.requestedRecipientSessionId, null);
    assert.equal(value.store.getTask(`task:channel:${pending.requestId}`), null);

    const target = await provisioning.prepareChannelRequestTarget(pending);
    assert.equal(target.recipientSessionId, "session:created");
    assert.equal(target.created, true);
    assert.equal(launches.length, 1);
    const origin = value.store.getTaskCreationOrigin(target.taskId);
    assert.equal(origin.creatorSessionId, "session:a");
    assert.equal(origin.creationContextTaskId, "task:a");
    const provisioned = value.store.getTask(target.taskId);
    assert.equal(provisioned.parent_task_id, null);
    assert.equal(provisioned.source_task_id, null);

    const confirmed = value.service.confirmRequest(pending.requestId, target, { type: "direct_user" });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(value.service.getChannel(confirmed.channelId).status, "active");
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
