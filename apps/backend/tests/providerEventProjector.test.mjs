import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderEventProjector } from "../src/application/providerEventProjector.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-projector-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  store.createAgent({ id: "agent:one", name: "Agent", role: "independentContributor" });
  store.upsertSession({
    id: "session:one",
    title: "Projection",
    agent: "Agent",
    provider: "provider:test",
    status: "complete",
    summary: "before"
  });
  return { directory, store, projector: new ProviderEventProjector({ store }) };
}

test("a Provider user item arriving before send returns updates the durable product message instead of inserting an alias", async () => {
  const { directory, store, projector } = await fixture();
  try {
    store.createUserMessageDelivery({
      deliveryId: "delivery:one",
      messageId: "message:one",
      sessionId: binding.sessionId,
      binding,
      agentId: "agent:one",
      text: "sent once"
    });
    store.updateMessageDelivery("delivery:one", {
      status: "dispatching",
      attemptCount: 1,
      lastAttemptAt: "2026-08-26T10:00:00.000Z"
    });

    projector.project({ event: event("turn.started"), binding });
    projector.project({
      event: event("user.message.accepted", {
        itemId: "provider-item:one",
        payload: { item: {
          id: "provider-item:one",
          turnId: "turn:one",
          turnStatus: "inProgress",
          type: "userMessage",
          title: "User",
          text: "sent once",
          status: "inProgress"
        } }
      }),
      binding
    });

    const userItems = store.getItems(binding.sessionId).filter((item) => item.type === "userMessage");
    assert.deepEqual(userItems.map((item) => item.id), ["message:one"]);
    assert.equal(userItems[0].turnId, "turn:one");
    assert.equal(store.getMessageDelivery("delivery:one").providerTurnId, "turn:one");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a collaboration prompt is claimed by its Provider turn and remains one canonical Timeline item", async () => {
  const { directory, store, projector } = await fixture();
  try {
    const { workItem } = store.enqueueAgentWorkItemWithResult({
      workItemId: "agent-work:one",
      agentId: "agent:one",
      sessionId: binding.sessionId,
      kind: "collaboration",
      priority: 100,
      text: "Handle this collaboration once",
      source: { type: "collaboration", taskId: "task:one" },
      localVisibility: "status_only"
    });
    const running = store.claimAgentWorkItem(workItem.workItemId);
    store.upsertTimelineItemProjection(binding.sessionId, {
      id: `work:${workItem.workItemId}`,
      turnId: `work:${workItem.workItemId}`,
      type: "userMessage",
      title: "Agent Collaboration",
      text: workItem.text,
      status: "running",
      presentationRole: "collaboration",
      rawMetadataJSON: JSON.stringify({ workItemId: workItem.workItemId, presentationRole: "collaboration" })
    });

    projector.project({ event: event("turn.started"), binding });
    projector.project({
      event: event("user.message.accepted", {
        itemId: "provider-item:collaboration",
        payload: { item: {
          id: "provider-item:collaboration",
          turnId: "turn:one",
          turnStatus: "inProgress",
          type: "userMessage",
          title: "User",
          text: running.text,
          status: "inProgress",
          rawMetadataJSON: JSON.stringify({ providerEvent: true })
        } }
      }),
      binding
    });

    const userItems = store.getItems(binding.sessionId).filter((item) => item.type === "userMessage");
    assert.deepEqual(userItems.map((item) => item.id), [`work:${workItem.workItemId}`]);
    assert.equal(userItems[0].turnId, "turn:one");
    assert.equal(userItems[0].title, "Agent Collaboration");
    assert.equal(userItems[0].presentationRole, "collaboration");
    assert.equal(userItems[0].workItemId, workItem.workItemId);
    assert.equal(store.getAgentWorkItem(workItem.workItemId).targetTurnId, "turn:one");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const binding = {
  sessionId: "session:one",
  bindingId: "binding:current",
  providerId: "provider:test",
  providerSessionId: "thread:current",
  logicalSessionId: "logical:one",
  routingVersion: 2,
  isCurrentRoute: true
};

function event(type, overrides = {}) {
  return {
    providerId: binding.providerId,
    providerSessionId: binding.providerSessionId,
    bindingId: binding.bindingId,
    logicalSessionId: binding.logicalSessionId,
    routingVersion: binding.routingVersion,
    providerEventId: `event:${type}`,
    providerSequence: null,
    turnId: "turn:one",
    itemId: null,
    type,
    occurredAt: "2026-08-26T10:00:00.000Z",
    receivedAt: "2026-08-26T10:00:00.010Z",
    payload: {},
    ...overrides
  };
}

test("turn completion settles only its run and preserves the final reply as a separate presentation item", async () => {
  const { directory, store, projector } = await fixture();
  try {
    projector.project({ event: event("turn.started"), binding });
    projector.project({
      event: event("assistant.message.completed", {
        itemId: "item:final",
        payload: { item: {
          id: "item:final",
          turnId: "turn:one",
          turnStatus: "inProgress",
          type: "agentMessage",
          title: "Agent",
          text: "final answer",
          presentationRole: "final_answer",
          status: "completed"
        } }
      }),
      binding
    });
    const completion = projector.project({
      event: event("turn.completed", { payload: { items: [{
        id: "item:final",
        turnId: "turn:one",
        turnStatus: "completed",
        type: "agentMessage",
        title: "Agent",
        text: "final answer",
        presentationRole: "final_answer",
        status: "completed"
      }] } }),
      binding
    });
    assert.equal(completion.hasAgentMessage, true);
    projector.project({
      event: event("tool.completed", {
        itemId: "item:late-tool",
        receivedAt: "2026-08-26T10:06:00.000Z",
        payload: { item: {
          id: "item:late-tool",
          turnId: "turn:one",
          turnStatus: "inProgress",
          type: "toolCall",
          title: "Late tool update",
          text: "arrived after turn completion",
          status: "completed"
        } }
      }),
      binding
    });

    const item = store.getSessionItem("session:one", "item:final");
    assert.equal(item.presentationRole, "final_answer");
    assert.equal(item.turnStatus, "completed");
    assert.equal(store.getSessionItem("session:one", "item:late-tool").status, "completed");
    assert.equal(store.getSessionTurn("session:one", binding.bindingId, "turn:one").execution_status, "completed");
    assert.equal(store.getSession("session:one").status, "complete");
    assert.equal(store.getSession("session:one").executionStatus, "completed");
    assert.equal(store.getSession("session:one").external.activeTurnId, null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed Provider turn with a failed tool and no non-empty final reply is projected as failed", async () => {
  const { directory, store, projector } = await fixture();
  try {
    store.createUserMessageDelivery({
      deliveryId: "delivery:failed-tool",
      messageId: "message:failed-tool",
      sessionId: binding.sessionId,
      binding,
      agentId: "agent:one",
      text: "Perform the instruction"
    });
    store.updateMessageDelivery("delivery:failed-tool", {
      status: "dispatching",
      attemptCount: 1,
      lastAttemptAt: "2026-08-26T10:00:00.000Z",
      providerTurnId: "turn:one"
    });
    projector.project({ event: event("turn.started"), binding });
    projector.project({
      event: event("tool.failed", { payload: { item: {
        id: "tool:failed",
        turnId: "turn:one",
        type: "dynamicToolCall",
        title: "Collaboration request",
        text: "{}",
        status: "failed"
      } } }),
      binding
    });

    const projected = projector.project({
      event: event("turn.completed", { payload: { items: [{
        id: "agent:empty-final",
        turnId: "turn:one",
        type: "agentMessage",
        title: "Agent",
        text: "  ",
        presentationRole: "final_answer",
        status: "completed"
      }] } }),
      binding
    });

    const turn = store.getSessionTurn("session:one", binding.bindingId, "turn:one");
    const delivery = store.getMessageDelivery("delivery:failed-tool");
    assert.equal(projected.terminalStatus, "failed");
    assert.equal(projected.terminalFailure.code, "PROVIDER_TOOL_FAILED_WITHOUT_FINAL_RESPONSE");
    assert.equal(turn.execution_status, "failed");
    assert.equal(turn.final_item_id, null);
    assert.equal(delivery.status, "failed");
    assert.match(delivery.lastError, /Collaboration request failed/);
    assert.equal(projected.session.status, "failed");
    assert.equal(projected.surface, false);
    assert.equal(projected.hasAgentMessage, false);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a non-retryable Provider error persists an actionable send failure", async () => {
  const { directory, store, projector } = await fixture();
  try {
    const projected = projector.project({
      event: event("provider.error", {
        turnId: null,
        payload: {
          error: "Operation not permitted @ rb_sysopen - /repo/AGENTS.md",
          willRetry: false
        }
      }),
      binding
    });

    assert.equal(projected.session.status, "failed");
    assert.equal(projected.session.capabilities.canSend, false);
    assert.equal(projected.session.summary, "Operation not permitted @ rb_sysopen - /repo/AGENTS.md");
    assert.equal(projected.session.sendUnavailableReason, "Operation not permitted @ rb_sysopen - /repo/AGENTS.md");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a turn-scoped Provider error fails only the Turn and keeps the Session retryable", async () => {
  const { directory, store, projector } = await fixture();
  try {
    projector.project({ event: event("turn.started"), binding });
    const providerError = projector.project({
      event: event("provider.error", {
        payload: {
          error: {
            message: "Selected model is at capacity. Please try a different model.",
            code: "serverOverloaded"
          },
          failureScope: "turn",
          willRetry: false
        }
      }),
      binding
    });
    const settled = projector.project({
      event: event("turn.failed", {
        payload: {
          error: {
            message: "Selected model is at capacity. Please try a different model.",
            code: "serverOverloaded"
          }
        }
      }),
      binding
    });

    assert.equal(providerError.session.status, "running");
    assert.equal(providerError.session.capabilities.canSend, true);
    assert.equal(providerError.session.sendUnavailableReason, null);
    assert.equal(settled.session.status, "failed");
    assert.equal(settled.session.capabilities.canSend, true);
    assert.equal(settled.session.sendUnavailableReason, null);
    assert.equal(
      store.getSessionTurn(binding.sessionId, binding.bindingId, "turn:one").execution_status,
      "failed"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a new Turn clears a stale Session-level send failure from an earlier Provider error", async () => {
  const { directory, store, projector } = await fixture();
  try {
    const failed = projector.project({
      event: event("provider.error", {
        turnId: null,
        payload: {
          error: "Selected model is at capacity. Please try a different model.",
          willRetry: false
        }
      }),
      binding
    });
    assert.equal(failed.session.capabilities.canSend, false);
    assert.match(failed.session.sendUnavailableReason, /capacity/);

    const recovered = projector.project({ event: event("turn.started"), binding });

    assert.equal(recovered.session.status, "running");
    assert.equal(recovered.session.capabilities.canSend, true);
    assert.equal(recovered.session.sendUnavailableReason, null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pending collaboration confirmation is a successful turn handoff even after an earlier tool failure", async () => {
  const { directory, store, projector } = await fixture();
  try {
    store.createUserMessageDelivery({
      deliveryId: "delivery:confirmation-handoff",
      messageId: "message:confirmation-handoff",
      sessionId: binding.sessionId,
      binding,
      agentId: "agent:one",
      text: "Stage a collaboration request"
    });
    store.updateMessageDelivery("delivery:confirmation-handoff", {
      status: "dispatching",
      attemptCount: 1,
      lastAttemptAt: "2026-08-26T10:00:00.000Z",
      providerTurnId: "turn:one"
    });
    projector.project({ event: event("turn.started"), binding });
    projector.project({
      event: event("tool.failed", { payload: { item: {
        id: "tool:artifact-failed",
        turnId: "turn:one",
        type: "dynamicToolCall",
        title: "Artifact lookup",
        text: "{}",
        status: "failed"
      } } }),
      binding
    });
    store.upsertTimelineItemProjection(binding.sessionId, {
      id: "collaboration-confirmation:one",
      turnId: "turn:one",
      turnStatus: "waiting_approval",
      type: "collaborationConfirmation",
      title: "Confirm Agent Collaboration",
      text: "",
      status: "pending",
      presentationRole: "collaboration_confirmation"
    });

    const projected = projector.project({
      event: event("turn.completed", { payload: { items: [{
        id: "agent:empty-final",
        turnId: "turn:one",
        type: "agentMessage",
        title: "Agent",
        text: "",
        presentationRole: "final_answer",
        status: "completed"
      }] } }),
      binding
    });

    const turn = store.getSessionTurn("session:one", binding.bindingId, "turn:one");
    const delivery = store.getMessageDelivery("delivery:confirmation-handoff");
    assert.equal(projected.terminalStatus, "completed");
    assert.equal(projected.terminalFailure, null);
    assert.equal(turn.execution_status, "completed");
    assert.equal(turn.failure_json, null);
    assert.equal(delivery.status, "completed");
    assert.equal(delivery.lastError, null);
    assert.equal(projected.session.status, "complete");
    assert.equal(store.getSessionItem("session:one", "tool:artifact-failed").status, "failed");
    assert.equal(store.getSessionItem("session:one", "collaboration-confirmation:one").status, "pending");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a definitive unavailable-Provider interruption settles the persisted run as cancelled", async () => {
  const { directory, store, projector } = await fixture();
  try {
    projector.project({ event: event("turn.started"), binding });
    const projected = projector.project({
      event: event("turn.cancelled", {
        providerEventId: "corptie:interrupt-unavailable:turn:one",
        payload: {
          error: {
            code: "PROVIDER_SESSION_UNAVAILABLE",
            message: "Provider Session no longer exists."
          }
        }
      }),
      binding
    });

    assert.equal(store.getSessionTurn("session:one", binding.bindingId, "turn:one").execution_status, "cancelled");
    assert.equal(projected.session.status, "cancelled");
    assert.equal(projected.session.external.activeTurnId, null);
    assert.equal(projected.session.capabilities.canInterrupt, false);
    assert.deepEqual(store.listUnsettledSessionTurns("session:one"), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a superseded Binding completion cannot terminate the current Binding run", async () => {
  const { directory, store, projector } = await fixture();
  const oldBinding = {
    ...binding,
    bindingId: "binding:old",
    providerSessionId: "thread:old",
    routingVersion: 1,
    isCurrentRoute: false
  };
  try {
    projector.project({ event: event("turn.started", { turnId: "turn:new" }), binding });
    projector.project({
      event: {
        ...event("turn.completed", { turnId: "turn:old" }),
        bindingId: oldBinding.bindingId,
        providerSessionId: oldBinding.providerSessionId,
        routingVersion: oldBinding.routingVersion
      },
      binding: oldBinding
    });
    assert.equal(store.getSessionTurn("session:one", oldBinding.bindingId, "turn:old").execution_status, "completed");
    assert.equal(store.getSessionTurn("session:one", binding.bindingId, "turn:new").execution_status, "running");
    assert.equal(store.getSession("session:one").status, "running");
    assert.equal(store.getSession("session:one").external.activeTurnId, "turn:new");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("usage events persist a provider-neutral local snapshot without changing execution state", async () => {
  const { directory, store, projector } = await fixture();
  try {
    const result = projector.project({
      event: event("usage.updated", {
        turnId: null,
        payload: {
          tokenUsage: {
            total: { totalTokens: 250 },
            modelContextWindow: 1_000
          }
        }
      }),
      binding
    });

    assert.deepEqual(store.getSessionUsageSnapshot("session:one").context, {
      usedTokens: 250,
      contextWindow: 1_000,
      remainingTokens: 750,
      usedPercent: 25
    });
    assert.equal(result.session.status, "complete");
    assert.equal(result.timelineChanged, false);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
