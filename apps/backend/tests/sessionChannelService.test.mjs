import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { SessionChannelService } from "../src/collaboration/sessionChannelService.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
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
  const work = store.createWork({
    id: "work:channel", name: "Channel", contributorAgentIds: ["agent:a", "agent:b"]
  });
  for (const endpoint of [
    { provider: "provider:a", logical: "session:a", agent: "agent:a", item: "task:a" },
    { provider: "provider:b", logical: "session:b", agent: "agent:b", item: "task:b" }
  ]) {
    store.createTask({
      id: endpoint.item, workId: work.id, title: endpoint.item.replaceAll(":","_"), mainAgentId: endpoint.agent
    }, { originType: "direct_user" });
    store.createSession({
      id: endpoint.provider, title: endpoint.provider, agentId: endpoint.agent,
      sessionKind: "worker", workId: work.id, taskId: endpoint.item, cwd: directory
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

test("current parent to direct child auto-authorizes one durable channel; siblings, stale bindings and revocation do not",async()=>{
  const f=await fixture();
  try {
    f.store.createTask({id:"task:child",workId:"work:channel",title:"Child",parentTaskId:"task:a"},{},
      {expectedParentResourceVersion:f.store.getTask("task:a").resource_version});
    f.store.createSession({id:"provider:child",title:"Child",agentId:"agent:b",sessionKind:"worker",workId:"work:channel",taskId:"task:child",cwd:f.directory});
    f.store.createLogicalSessionRoute({logicalSessionId:"session:child",legacySessionId:"provider:child",providerThreadId:"provider:child",
      providerSessionId:"provider:child",providerId:"another-provider",boundCwd:f.directory,sessionName:"Child"});
    f.store.db.run("UPDATE tasks SET current_session_id=? WHERE id=?",["provider:a","task:a"]);
    f.store.db.run("UPDATE tasks SET current_session_id=? WHERE id=?",["provider:child","task:child"]);
    const input={requestingSessionId:"session:a",recipientSessionId:"session:child",body:"test only",idempotencyKey:"parent-child-first"};
    const first=f.service.requestChannel(input);
    assert.equal(first.status,"sent"); assert.equal(first.routeAuthorization,"parent_child_policy");
    assert.equal(f.service.pendingRequestForSession("session:a"),null);
    assert.equal(f.service.requestChannel(input).message.messageId,first.message.messageId);
    assert.equal(f.service.listMessages(first.channel.channelId,"session:a").length,1);
    const reply=f.service.sendMessage({channelId:first.channel.channelId,senderSessionId:"session:child",body:"received",idempotencyKey:"child-reply"});
    assert.equal(reply.message.recipientSessionId,"session:a");
    assert.equal(f.service.requestChannel({...input,recipientSessionId:"session:b",idempotencyKey:"unrelated"}).status,"pending");
    f.service.revokeChannel(first.channel.channelId,"session:a","stop");
    assert.equal(f.service.requestChannel({...input,idempotencyKey:"after-revoke"}).status,"pending");
    f.store.db.run("UPDATE tasks SET current_session_id=NULL WHERE id='task:a'");
    assert.equal(f.service.resolveParentChildAuthorization("session:a","session:child"),null);
  } finally {await f.store.close(); await rm(f.directory,{recursive:true,force:true});}
});

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

test("a Session Channel delivery uses its own Agent queue foreign key", async () => {
  const value = await fixture();
  try {
    const pending = value.service.requestChannel({
      requestingSessionId: "session:a",
      recipientSessionId: "session:b",
      body: "Deliver through the Session Channel queue.",
      idempotencyKey: "open:channel-queue"
    });
    const confirmed = value.service.confirmRequest(pending.requestId, {
      recipientSessionId: "session:b"
    }, { type: "direct_user" });
    const delivery = value.service.getDeliveryByMessage(confirmed.firstMessageId);

    const queued = value.store.enqueueAgentTask({
      taskId: `delivery:${delivery.deliveryId}`,
      agentId: "agent:b",
      sessionId: "provider:b",
      kind: "collaboration",
      priority: 50,
      text: "Trusted Channel envelope",
      source: { type: "session_channel", deliveryId: delivery.deliveryId },
      localVisibility: "status_only",
      channelDeliveryId: delivery.deliveryId,
      createdAt: delivery.createdAt
    });

    assert.equal(queued.deliveryId, delivery.deliveryId);
    assert.equal(value.store.getAgentTaskForDelivery(delivery.deliveryId)?.taskId, queued.taskId);
    const stored = value.store.selectOne(
      "SELECT delivery_id, channel_delivery_id FROM agent_operations WHERE task_id=?",
      [queued.taskId]
    );
    assert.equal(stored.delivery_id, null);
    assert.equal(stored.channel_delivery_id, delivery.deliveryId);
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
      workId: "work:channel",
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
    const workService = new WorkApplicationService({ store: value.store });
    const launches = [];
    const provisioning = new SessionCollaborationService({
      store: value.store,
      workService,
      collaborationCore: value.service.collaborationCore,
      defaultProviderId: "test-provider",
      workSessionStartApplicationService: { start: async (command) => {
        const task = value.store.getTask(command.taskId);
        const agent = value.store.getAgent(command.assigneeAgentId);
        launches.push({ taskId: task.id, agentId: agent.agentId });
        value.store.createSession({
          id: "provider:created", title: "Created peer", agentId: agent.agentId,
          sessionKind: "worker", workId: task.work_id, taskId: task.id,
          cwd: value.directory
        });
        value.store.createLogicalSessionRoute({
          logicalSessionId: "session:created", legacySessionId: "provider:created",
          providerThreadId: "provider:created", providerSessionId: "provider:created",
          providerId: "test-provider", boundCwd: value.directory, sessionName: "Created peer"
        });
        value.service.collaborationCore.bindSession({ agentId: agent.agentId, sessionId: "provider:created" });
        value.store.bindSessionToTask("provider:created", task.id, task.work_id);
        return { session: value.store.getSession("provider:created") };
      } }
    });
    const pending = value.service.requestChannel({
      requestingSessionId: "session:a",
      targetWorkId: "work:channel",
      sessionAgentId: "agent:b",
      title: "Long-lived_peer",
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

// Exercise the real SQLite store, shared queue and Provider-neutral dispatch.
async function mailboxFixture(options = {}) {
  const f = await fixture();
  const { SessionChannelMailboxService } = await import("../src/collaboration/sessionChannelMailboxService.mjs");
  const pending = f.service.requestChannel({ requestingSessionId: "session:a", recipientSessionId: "session:b",
    body: "first", idempotencyKey: "batch:first" });
  const confirmed = f.service.confirmRequest(pending.requestId, { recipientSessionId: "session:b" }, { type: "direct_user" });
  const first = f.service.listMessages(confirmed.channelId, "session:a")[0];
  const head = f.service.getDeliveryByMessage(first.messageId);
  let timestamp = Date.parse("2026-08-31T12:00:00.000Z");
  const mailbox = new SessionChannelMailboxService({ store: f.store, sessionChannelService: f.service,
    clock: () => timestamp, ...options });
  let ordinal = 0;
  const send = (body, extra = {}) => f.service.sendMessage({ channelId: confirmed.channelId,
    senderSessionId: "session:a", body, idempotencyKey: `batch:extra:${++ordinal}`, ...extra });
  const enqueue = (delivery = head, createdAt = delivery.createdAt) => f.store.enqueueAgentTask({
    taskId: `delivery:${delivery.deliveryId}`, agentId: "agent:b", sessionId: "provider:b", kind: "collaboration",
    priority: 50, text: "first", channelDeliveryId: delivery.deliveryId, createdAt,
    source: { type: "session_channel", channelId: confirmed.channelId, deliveryId: delivery.deliveryId,
      senderSessionId: "session:a", recipientSessionId: "session:b" }
  });
  const close = async () => { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); };
  return { ...f, mailbox, channelId: confirmed.channelId, head, send, enqueue, close,
    advance: ms => { timestamp += ms; } };
}

test("mailbox folds five pending messages into one immutable batch and cancels legacy queued followers", async () => {
  const f = await mailboxFixture();
  try {
    const headWork = f.enqueue();
    const followers = Array.from({ length: 4 }, (_, i) => f.send(`part ${i + 2}`).delivery);
    followers.forEach(delivery => f.enqueue(delivery));
    assert.equal(f.mailbox.waitMs(f.head.deliveryId, headWork.taskId), 2000);
    f.advance(6000);
    assert.equal(f.mailbox.waitMs(f.head.deliveryId, headWork.taskId), 0);
    f.store.claimAgentTask(headWork.taskId);
    const batch = f.mailbox.prepareBatch(f.head.deliveryId, headWork.taskId);
    assert.equal(f.mailbox.getItems(batch.batch_id).length, 5);
    assert.equal(f.store.listQueuedAgentTasksForSession("provider:b").length, 0);
    assert.equal(f.store.getAgentTask(`delivery:${followers[0].deliveryId}`).source.batchedInto, batch.batch_id);
    assert.equal(f.store.getAgentTaskForDelivery(followers[0].deliveryId).taskId, headWork.taskId);
    f.send("late arrival");
    assert.equal(f.mailbox.getItems(batch.batch_id).length, 5);
    assert.equal(f.mailbox.prepareBatch(f.head.deliveryId, headWork.taskId).batch_id, batch.batch_id);
    f.mailbox.mark(batch.batch_id, "accepted", { turnId: "turn:batch" });
    for (const delivery of [f.head, ...followers]) {
      const receipt = f.service.getDelivery(delivery.deliveryId);
      assert.equal(receipt.status, "delivered");
      assert.equal(receipt.targetTurnId, "turn:batch");
      assert.equal(receipt.messageCount, 5);
    }
  } finally { await f.close(); }
});

test("shared queue creates one wake operation for a burst and ignores silent notifications", async () => {
  const f = await mailboxFixture();
  try {
    const { createCollaborationDeliveryQueue } = await import("../src/collaboration/collaborationDeliveryQueue.mjs");
    f.send("second"); f.send("third");
    const silent = f.send("FYI", { deliveryIntent: "notification" });
    let wakes = 0;
    const queue = createCollaborationDeliveryQueue({ store: f.store, sessionChannelService: f.service,
      channelMailbox: f.mailbox, collaborationCore: f.service.collaborationCore,
      collaborationDispatcher: { maxAttempts: 3 }, registerRuntimeQueuedWork() {}, moveRuntimeQueuedWork() {},
      scheduleAgentWorkDrain() { wakes++; }, emitEvent() {} });
    await queue.syncSessionChannelDeliveriesIntoAgentWorkQueue();
    assert.equal(f.store.listQueuedAgentTasksForSession("provider:b").length, 1);
    assert.equal(wakes, 1);
    assert.equal(f.mailbox.shouldWake(silent.delivery.deliveryId), false);
    const work = f.store.listQueuedAgentTasksForSession("provider:b")[0];
    f.store.claimAgentTask(work.taskId);
    const batch = f.mailbox.prepareBatch(f.head.deliveryId, work.taskId);
    assert.equal(f.mailbox.getItems(batch.batch_id).length, 4);
    f.mailbox.mark(batch.batch_id, "accepted", { turnId: "turn:one" });
    f.store.updateAgentTask(work.taskId, { status: "completed" });
    f.send("receipt only", { deliveryIntent: "acknowledgement" });
    await queue.syncSessionChannelDeliveriesIntoAgentWorkQueue();
    assert.equal(f.store.listQueuedAgentTasksForSession("provider:b").length, 0);
  } finally { await f.close(); }
});

test("latest history and cursor pages preserve insertion order even at identical timestamps", async () => {
  const f = await mailboxFixture();
  try {
    for (let i = 0; i < 112; i++) f.send(`message ${i}`);
    const page = f.service.listMessagePage(f.channelId, "session:b", { limit: 100 });
    assert.equal(page.messages.length, 100);
    assert.equal(page.messages[0].body, "message 12");
    assert.equal(page.messages.at(-1).body, "message 111");
    assert.equal(page.hasMore, true);
    const previous = f.service.listMessagePage(f.channelId, "session:a", { beforeCursor: page.beforeCursor, limit: 100 });
    assert.equal(previous.messages.length, 13);
    assert.equal(previous.messages[0].body, "first");
    assert.equal(previous.hasMore, false);
    const next = f.service.listMessagePage(f.channelId, "session:a", { afterCursor: previous.afterCursor, limit: 100 });
    assert.deepEqual(next.messages.map(m => m.messageId), page.messages.map(m => m.messageId));
    assert.equal(f.service.getDelivery(f.head.deliveryId).status, "pending");
    assert.throws(() => f.service.listMessagePage(f.channelId, "session:a", { beforeCursor: "bad" }), { code: "INVALID_CHANNEL_CURSOR" });
    assert.throws(() => f.service.sendMessage({ channelId: f.channelId, senderSessionId: "session:a", body: "first",
      idempotencyKey: "batch:first", deliveryIntent: "notification" }), { code: "CHANNEL_IDEMPOTENCY_CONFLICT" });
  } finally { await f.close(); }
});

test("batch boundaries honor user queue barriers, byte budgets and recipient binding changes", async () => {
  const f = await mailboxFixture({ maxBytes: 5000 });
  try {
    const work = f.enqueue();
    f.service.clock = () => "2026-08-31T12:00:02.000Z";
    f.store.enqueueAgentTask({ taskId: "user:barrier", agentId: "agent:b", sessionId: "provider:b",
      kind: "user", priority: 0, text: "user", createdAt: "2026-08-31T12:00:01.000Z" });
    f.send("after user");
    const batch = f.mailbox.prepareBatch(f.head.deliveryId, work.taskId);
    assert.equal(f.mailbox.getItems(batch.batch_id).length, 1);
    f.mailbox.mark(batch.batch_id, "accepted", { turnId: "turn:first" });
    f.store.updateAgentTask("user:barrier", { status: "completed" });
    const second = f.mailbox.listWakeDeliveries(100, 3)[0];
    const secondWork = f.enqueue(second);
    f.send("large ".repeat(2000));
    const secondBatch = f.mailbox.prepareBatch(second.deliveryId, secondWork.taskId);
    assert.equal(f.mailbox.getItems(secondBatch.batch_id).length, 1);
  } finally { await f.close(); }
  const g = await mailboxFixture();
  try {
    const work = g.enqueue();
    g.send("new binding", { resourceContext: { recipient: { routingVersion: 999 } } });
    const batch = g.mailbox.prepareBatch(g.head.deliveryId, work.taskId);
    assert.equal(g.mailbox.getItems(batch.batch_id).length, 1);
  } finally { await g.close(); }
});

test("Provider-neutral batch dispatch shares one turn, retains provenance and blocks uncertain replay", async () => {
  const f = await mailboxFixture();
  try {
    const { createSessionChannelDeliveryOperation } = await import("../src/application/sessionChannelDeliveryOperation.mjs");
    const second = f.send("补充：采用新接口");
    const work = f.enqueue(); f.store.claimAgentTask(work.taskId);
    let calls = 0;
    const operation = createSessionChannelDeliveryOperation({ store: f.store, sessionChannelService: f.service,
      channelMailbox: f.mailbox, now: f.service.clock, resumeSession: async () => {},
      sendMessage: async (sessionId, text, source) => {
        calls++;
        assert.equal(sessionId, "provider:b");
        assert.match(text, /来源 Session：session:a/);
        assert.ok(text.includes(second.message.messageId));
        assert.equal(source.messageIds.length, 2);
        return { result: { turn: { id: "provider:turn" } } };
      } });
    const delivered = await operation.dispatchSessionChannelDelivery(f.head.deliveryId);
    assert.equal(delivered.targetTurnId, "provider:turn");
    assert.equal(f.service.getDelivery(second.delivery.deliveryId).targetTurnId, "provider:turn");
    assert.equal(calls, 1);
  } finally { await f.close(); }
  const g = await mailboxFixture();
  try {
    const { createSessionChannelDeliveryOperation } = await import("../src/application/sessionChannelDeliveryOperation.mjs");
    const work = g.enqueue(); g.store.claimAgentTask(work.taskId);
    let calls = 0;
    const operation = createSessionChannelDeliveryOperation({ store: g.store, sessionChannelService: g.service,
      channelMailbox: g.mailbox, now: g.service.clock, resumeSession: async () => {},
      sendMessage: async () => { calls++; throw new Error("connection lost after submission"); } });
    assert.equal((await operation.dispatchSessionChannelDelivery(g.head.deliveryId)).status, "failed");
    assert.equal(g.mailbox.getBatchForDelivery(g.head.deliveryId).status, "unknown");
    assert.equal(g.mailbox.listWakeDeliveries(100, 3).length, 0);
    await operation.dispatchSessionChannelDelivery(g.head.deliveryId);
    assert.equal(calls, 1);
  } finally { await g.close(); }
});

test("restart recovery never resends a batch without a Provider receipt", async () => {
  const f = await mailboxFixture();
  try {
    const work = f.enqueue(); f.store.claimAgentTask(work.taskId);
    const batch = f.mailbox.prepareBatch(f.head.deliveryId, work.taskId);
    f.mailbox.mark(batch.batch_id, "dispatching");
    f.mailbox.recoverInterruptedBatches();
    assert.equal(f.mailbox.getBatchForDelivery(f.head.deliveryId).status, "unknown");
    assert.equal(f.store.getAgentTask(work.taskId).status, "failed");
    assert.equal(f.mailbox.listWakeDeliveries(100, 3).length, 0);
  } finally { await f.close(); }
});

test("quiet window has a durable maximum wait and a busy recipient does not freeze membership", async () => {
  const f = await mailboxFixture();
  try {
    const work = f.enqueue();
    for (let second = 1; second <= 4; second++) {
      f.advance(1000);
      f.service.clock = () => new Date(Date.parse("2026-08-31T12:00:00Z") + second * 1000).toISOString();
      f.send(`update ${second}`);
    }
    assert.equal(f.mailbox.waitMs(f.head.deliveryId, work.taskId), 1000);
    f.advance(1000);
    assert.equal(f.mailbox.waitMs(f.head.deliveryId, work.taskId), 0);
    const { createSessionChannelDeliveryOperation } = await import("../src/application/sessionChannelDeliveryOperation.mjs");
    f.store.listUnsettledSessionTurns = () => [{ id: "running" }];
    const operation = createSessionChannelDeliveryOperation({ store: f.store, sessionChannelService: f.service,
      channelMailbox: f.mailbox, now: f.service.clock, sendMessage: async () => { throw new Error("must not send"); } });
    assert.equal((await operation.dispatchSessionChannelDelivery(f.head.deliveryId)).status, "queued");
    assert.equal(f.mailbox.getBatchForDelivery(f.head.deliveryId), null);
  } finally { await f.close(); }
});

test("revocation is rechecked for a frozen batch and restart reconciles an accepted turn receipt", async () => {
  const f = await mailboxFixture();
  try {
    const work = f.enqueue(); f.store.claimAgentTask(work.taskId);
    const batch = f.mailbox.prepareBatch(f.head.deliveryId, work.taskId);
    f.mailbox.mark(batch.batch_id, "dispatching");
    f.store.updateAgentTask(work.taskId, { targetTurnId: "turn:accepted" });
    f.mailbox.recoverInterruptedBatches();
    assert.equal(f.service.getDelivery(f.head.deliveryId).targetTurnId, "turn:accepted");
    assert.equal(f.mailbox.getBatchForDelivery(f.head.deliveryId).status, "accepted");
    f.service.revokeChannel(f.channelId, "session:a", "stop");
    assert.throws(() => f.service.resolveDeliveryRoute(f.head.deliveryId), { code: "CHANNEL_NOT_ACTIVE" });
  } finally { await f.close(); }
});

test("a late Provider receipt reconciles an uncertain batch without submitting again", async () => {
  const f = await mailboxFixture();
  try {
    const work = f.enqueue(); f.store.claimAgentTask(work.taskId);
    const batch = f.mailbox.prepareBatch(f.head.deliveryId, work.taskId);
    f.mailbox.mark(batch.batch_id, "unknown", { error: "lost receipt" });
    f.store.updateAgentTask(work.taskId, { status: "failed", lastError: "lost receipt" });
    f.mailbox.reconcileUncertainBatches();
    assert.equal(f.mailbox.getBatchForDelivery(f.head.deliveryId).status, "unknown");
    f.store.getMessageDelivery = () => ({ providerTurnId: "late:turn", sessionId: "provider:b", bindingId: "binding" });
    f.store.getSessionTurn = () => ({ status: "completed" });
    f.mailbox.reconcileUncertainBatches();
    assert.equal(f.mailbox.getBatchForDelivery(f.head.deliveryId).status, "accepted");
    assert.equal(f.store.getAgentTask(work.taskId).status, "completed");
    assert.equal(f.service.getDelivery(f.head.deliveryId).targetTurnId, "late:turn");
    assert.equal(f.service.listMessagePage(f.channelId, "session:a").pendingCount, 0);
  } finally { await f.close(); }
});

test("restart requeues a prepared batch that was never submitted, with frozen membership", async () => {
  const f = await mailboxFixture();
  try {
    const work = f.enqueue(); f.store.claimAgentTask(work.taskId);
    const batch = f.mailbox.prepareBatch(f.head.deliveryId, work.taskId);
    f.send("next batch");
    f.mailbox.recoverInterruptedBatches();
    assert.equal(f.store.getAgentTask(work.taskId).status, "queued");
    assert.equal(f.mailbox.getBatchForDelivery(f.head.deliveryId).status, "prepared");
    assert.equal(f.mailbox.prepareBatch(f.head.deliveryId, work.taskId).batch_id, batch.batch_id);
    assert.equal(f.mailbox.getItems(batch.batch_id).length, 1);
  } finally { await f.close(); }
});

test("a large Channel backlog cannot hide another mailbox or monopolize its recipient", async () => {
  const f = await mailboxFixture();
  try {
    for (let i = 0; i < 505; i++) f.send(`backlog ${i}`);
    const core = f.service.collaborationCore;
    f.store.createSession({ id: "provider:c", title: "Session_c", agentId: "agent:a", sessionKind: "worker",
      workId: "work:channel", taskId: "task:a", cwd: f.directory });
    f.store.createLogicalSessionRoute({ logicalSessionId: "session:c", legacySessionId: "provider:c",
      providerThreadId: "provider:c", providerSessionId: "provider:c", providerId: "another-provider",
      boundCwd: f.directory, sessionName: "Session_c" });
    core.bindSession({ agentId: "agent:a", sessionId: "provider:c" });
    const request = f.service.requestChannel({ requestingSessionId: "session:c", recipientSessionId: "session:b",
      body: "other mailbox", idempotencyKey: "other:mailbox" });
    const confirmed = f.service.confirmRequest(request.requestId, { recipientSessionId: "session:b" }, { type: "direct_user" });
    assert.equal(f.mailbox.listWakeDeliveries(2, 3).length, 2);
    const work = f.enqueue();
    f.advance(6000);
    f.store.claimAgentTask(work.taskId);
    const batch = f.mailbox.prepareBatch(f.head.deliveryId, work.taskId);
    f.mailbox.mark(batch.batch_id, "accepted", { turnId: "first:batch" });
    f.store.updateAgentTask(work.taskId, { status: "completed" });
    const { createCollaborationDeliveryQueue } = await import("../src/collaboration/collaborationDeliveryQueue.mjs");
    const queue = createCollaborationDeliveryQueue({ store: f.store, sessionChannelService: f.service,
      channelMailbox: f.mailbox, collaborationCore: core, collaborationDispatcher: { maxAttempts: 3 },
      registerRuntimeQueuedWork() {}, moveRuntimeQueuedWork() {}, scheduleAgentWorkDrain() {}, emitEvent() {} });
    await queue.syncSessionChannelDeliveriesIntoAgentWorkQueue();
    const queued = f.store.listQueuedAgentTasksForSession("provider:b");
    assert.equal(queued.length, 2);
    assert.equal(queued[0].source.channelId, confirmed.channelId);
  } finally { await f.close(); }
});

async function unifiedMailboxFixture() {
  const f = await mailboxFixture();
  const { SessionMailboxService } = await import("../src/application/sessionMailboxService.mjs");
  const wakes = [], changes = [], events = [];
  const unified = new SessionMailboxService({ store: f.store, channelService: f.service, channelMailbox: f.mailbox,
    wake: (...args) => wakes.push(args), changed: id => changes.push(id), workEvent: (...args) => events.push(args),
    validateExternal: (row, auth) => {
      if (row.source_type !== "automation" && (auth.ownerLogicalSessionId !== row.recipient_session_id || auth.sourceId !== row.source_id)) {
        throw Object.assign(new Error("scope"), { code: "MAILBOX_EVENT_SCOPE_REQUIRED" });
      }
    },
    clock: f.service.clock });
  f.mailbox.sessionMailbox = unified;
  const activeTurn = () => {
    const route = f.store.getLogicalSession("session:b");
    f.store.upsertSessionTurn({ sessionId: "provider:b", bindingId: route.activeBinding.bindingId,
      routingVersion: route.routingVersion, turnId: "active:turn", executionStatus: "running" });
    return route.activeBinding.bindingId;
  };
  return { ...f, unified, wakes, changes, events, activeTurn,
    mailboxId: `mailbox:${f.service.listMessages(f.channelId, "session:a")[0].messageId}` };
}

test("unified inbox indexes originals, separates read from delivery and protects recipient scope", async () => {
  const f = await unifiedMailboxFixture();
  try {
    const page = f.unified.rows("provider:b");
    assert.equal(page.pendingCount, 1); assert.equal(page.unreadCount, 1);
    assert.equal(page.messages[0].body, undefined);
    assert.equal(f.unified.get("session:b", f.mailboxId).body, "first");
    assert.throws(() => f.unified.get("session:a", f.mailboxId), { code: "MAILBOX_MESSAGE_NOT_FOUND" });
    f.unified.mutate("session:b", f.mailboxId, "read");
    assert.equal(f.unified.summary("session:b").unreadCount, 0);
    assert.equal(f.unified.summary("session:b").pendingCount, 1);
    assert.equal(f.service.getDelivery(f.head.deliveryId).status, "pending");
    f.unified.mutate("session:b", f.mailboxId, "ignore");
    assert.equal(f.unified.summary("session:b").pendingCount, 0);
    assert.equal(f.mailbox.listWakeDeliveries(100, 3).length, 0);
  } finally { await f.close(); }
});

test("paused mailbox allows one explicitly selected later message without claiming earlier mail", async () => {
  const f = await unifiedMailboxFixture();
  try {
    const work = f.enqueue();
    const later = f.send("later request");
    f.unified.setPaused("session:b", true);
    assert.equal(f.unified.canDispatchOperation(work), false);
    f.activeTurn();
    assert.throws(() => f.unified.adopt("session:b", [f.mailboxId]), { code: "MAILBOX_PAUSED" });
    f.unified.mutate("session:b", `mailbox:${later.message.messageId}`, "process");
    const heads = f.mailbox.listWakeDeliveries(100, 3);
    assert.equal(heads[0].deliveryId, later.delivery.deliveryId);
    assert.equal(f.mailbox.findQueuedHead(f.service.getDeliveryEnvelope(later.delivery.deliveryId), "provider:b"), null);
    const selected = f.enqueue(later.delivery);
    assert.equal(f.unified.canDispatchOperation(selected), true);
    const batch = f.mailbox.prepareBatch(later.delivery.deliveryId, selected.taskId);
    assert.equal(f.mailbox.getItems(batch.batch_id).length, 1);
    assert.equal(f.service.getDelivery(f.head.deliveryId).status, "pending");
    assert.throws(() => f.unified.mutate("session:b", `mailbox:${later.message.messageId}`, "ignore"), { code: "MAILBOX_MESSAGE_ALREADY_CLAIMED" });
  } finally { await f.close(); }
});

test("adoption is atomic, idempotent within the active turn and never creates another execution", async () => {
  const f = await unifiedMailboxFixture();
  try {
    assert.throws(() => f.unified.adopt("session:b", [f.mailboxId]), { code: "MAILBOX_ACTIVE_TURN_REQUIRED" });
    const work = f.enqueue(); f.activeTurn();
    const result = f.unified.adopt("session:b", [f.mailboxId]);
    assert.equal(result.turnId, "active:turn"); assert.match(result.messages[0].trustedContent, /来源 Session：session:a/);
    assert.equal(f.store.getAgentTask(work.taskId).status, "cancelled");
    assert.equal(f.service.getDelivery(f.head.deliveryId).targetTurnId, "active:turn");
    assert.equal(f.mailbox.listWakeDeliveries(100, 3).length, 0);
    assert.equal(f.unified.adopt("session:b", [f.mailboxId]).turnId, "active:turn");
    const second = f.send("still pending");
    assert.throws(() => f.unified.adopt("session:b", [`mailbox:${second.message.messageId}`, "missing"]));
    assert.equal(f.service.getDelivery(second.delivery.deliveryId).status, "pending");
    assert.equal(f.unified.get("session:b", `mailbox:${second.message.messageId}`).state, "pending");
  } finally { await f.close(); }
});

test("mailbox tools revalidate exact Session actor and active Provider binding", async () => {
  const f = await unifiedMailboxFixture();
  try {
    const { callSessionMailboxTool } = await import("../src/application/sessionMailboxDynamicTools.mjs");
    const binding = f.store.getLogicalSession("session:b").activeBinding.bindingId;
    const input = { actorId: "agent:b", metadata: { sessionId: "provider:b", providerBindingId: binding },
      tool: "corptie_mailbox_list", arguments: {} };
    assert.equal(callSessionMailboxTool(f.unified, input).pendingCount, 1);
    assert.throws(() => callSessionMailboxTool(f.unified, { ...input, actorId: "agent:a" }), { code: "MAILBOX_SCOPE_REQUIRED" });
    assert.throws(() => callSessionMailboxTool(f.unified, { ...input, metadata: { ...input.metadata, providerBindingId: "stale" } }), { code: "MAILBOX_SCOPE_REQUIRED" });
    assert.throws(() => callSessionMailboxTool(f.unified, { ...input, tool: "corptie_mailbox_get", arguments: { messageId: "missing" } }), { code: "MAILBOX_MESSAGE_NOT_FOUND" });
  } finally { await f.close(); }
});

test("external notifications persist without waking and manual processing uses the existing queue", async () => {
  const f = await unifiedMailboxFixture();
  try {
    const input = { recipientSessionId: "session:b", sourceType: "background", sourceId: "background:one",
      body: "Result available", authorization: { ownerLogicalSessionId: "session:b", sourceId: "background:one" }, idempotencyKey: "done" };
    const message = f.unified.receiveEvent(input);
    assert.equal(f.wakes.length, 0); assert.equal(message.intent, "notification");
    assert.equal(f.unified.receiveEvent(input).messageId, message.messageId);
    assert.throws(() => f.unified.receiveEvent({ ...input, recipientSessionId: "session:a" }), { code: "MAILBOX_EVENT_SCOPE_REQUIRED" });
    f.unified.setPaused("session:b", true);
    f.unified.mutate("session:b", message.messageId, "process");
    const registered = [];
    f.unified.syncQueuedOperations((...args) => registered.push(args));
    const operation = f.store.getAgentTask(registered[0][1]);
    assert.equal(operation.priority, 90);
    assert.equal(operation.source.mailboxMessageId, message.messageId);
    assert.equal(f.unified.canDispatchOperation(operation), true);
    assert.equal(f.unified.summary("session:b").pendingCount, 2);
  } finally { await f.close(); }
});

test("automation index retains execution ownership and adoption does not steal turn settlement", async () => {
  const f = await unifiedMailboxFixture();
  try {
    const input = { taskId: "scheduled:one", sessionId: "provider:b", agentId: "agent:b", kind: "user", priority: 75,
      text: "automation request", source: { type: "scheduled_session_task", scheduledTaskId: "automation:one", scheduledRunId: "run:one" }, createdAt: f.service.clock() };
    const first = f.unified.enqueueExternalOperation(input);
    assert.equal(f.unified.enqueueExternalOperation(input).inserted, false);
    assert.equal(f.unified.rows("session:b", { sourceType: "automation" }).messages.length, 1);
    f.activeTurn();
    f.unified.adopt("session:b", [`mailbox:${input.taskId}`]);
    assert.equal(f.store.getAgentTask(first.task.taskId).targetTurnId, null);
    assert.equal(f.events[0][0], "AgentWorkStarted");
    f.unified.settleAdopted("session:b", "active:turn", "completed");
    assert.equal(f.events[1][0], "AgentWorkCompleted");
    const binding = f.store.getLogicalSession("session:b").activeBinding.bindingId;
    f.store.upsertSessionTurn({ sessionId: "provider:b", bindingId: binding, routingVersion: 1,
      turnId: "active:turn", executionStatus: "completed" });
    assert.equal(f.unified.get("session:b", `mailbox:${input.taskId}`).executionStatus, "completed");
    f.store.upsertTimelineItemProjection("provider:b", { id: "processed:tool", turnId: "active:turn",
      bindingId: binding, type: "commandExecution", text: "read verification log", status: "completed" });
    const detail = f.unified.get("session:b", `mailbox:${input.taskId}`);
    assert.equal(detail.processingSessionId, "provider:b");
    assert.equal(detail.processingItemId, "processed:tool");
    assert.equal(f.unified.rows("session:b", { filter: "all", sourceType: "automation" }).messages[0].processingItemId, undefined);
  } finally { await f.close(); }
});

test("mailbox rechecks revoked sources at adoption and before execution", async () => {
  const f = await unifiedMailboxFixture();
  try {
    f.activeTurn();
    f.service.revokeChannel(f.channelId, "session:a", "stop");
    assert.throws(() => f.unified.adopt("session:b", [f.mailboxId]), { code: "CHANNEL_NOT_ACTIVE" });
    const { task } = f.unified.enqueueExternalOperation({ taskId: "external:revoked", sessionId: "provider:b", agentId: "agent:b",
      kind: "user", priority: 50, text: "action", source: { type: "scheduled_session_task" } });
    f.unified.validateExternal = () => { throw Object.assign(new Error("revoked"), { code: "AUTHORIZATION_REVOKED" }); };
    assert.throws(() => f.unified.validateOperation(task), { code: "AUTHORIZATION_REVOKED" });
  } finally { await f.close(); }
});

test("mailbox HTTP isolates local-user management from Session tool callers", async () => {
  const f = await unifiedMailboxFixture();
  try {
    const { handleSessionMailboxHttp } = await import("../src/application/sessionMailboxHttpApi.mjs");
    const invoke = (path, { method = "GET", headers = {}, input = {}, preview = false } = {}) => new Promise(resolve => {
      assert.equal(handleSessionMailboxHttp({ request: { method, headers, socket: { remoteAddress: "127.0.0.1" } }, response: {},
        url: new URL(path, "http://localhost"), service: f.unified, preview,
        sendJson: (_, status, body) => resolve({ status, body }), readJson: async () => input }), true);
    });
    assert.equal((await invoke("/sessions/provider%3Ab/mailbox")).body.pendingCount, 1);
    assert.equal((await invoke("/sessions/provider%3Ab/mailbox", { headers: { origin: "https://untrusted" } })).status, 403);
    assert.equal((await invoke("/sessions/provider%3Ab/mailbox/settings", { method: "POST", input: { paused: true }, preview: true })).status, 403);
    assert.equal((await invoke("/sessions/provider%3Ab/mailbox/settings", { method: "POST", input: { paused: true } })).body.paused, true);
  } finally { await f.close(); }
});

test("mailbox summaries keep Emoji valid and show uncertain external dispatch without replay", async () => {
  const f = await unifiedMailboxFixture();
  try {
    const result = f.unified.enqueueExternalOperation({ taskId: "mailbox:unicode", sessionId: "provider:b", agentId: "agent:b",
      kind: "user", priority: 50, text: "a".repeat(239) + "🐈" + "tail", source: { type: "scheduled_session_task" } });
    const messageId = result.task.source.mailboxMessageId;
    assert.equal(f.unified.get("session:b", messageId).preview.isWellFormed(), true);
    f.store.updateAgentTask(result.task.taskId, { status: "failed", source: { ...result.task.source, mailboxDispatchAttempted: true } });
    const message = f.unified.get("session:b", messageId);
    assert.equal(message.state, "unknown"); assert.equal(message.canHandle, false);
    assert.equal(f.unified.rows("session:b", { filter: "abnormal" }).messages.length, 1);
  } finally { await f.close(); }
});
