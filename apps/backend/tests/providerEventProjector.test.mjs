import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";
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

test("a model change notice cannot create an unsettled Turn before the first message", async () => {
  const { directory, store, projector } = await fixture();
  try {
    projector.project({ binding, event: event("tool.started", {
      payload: { item: { id: "model-change", turnId: "turn:one", type: "system",
        title: "Model", text: "Switched model", turnStatus: "complete" } }
    }) });
    assert.equal(store.listUnsettledSessionTurns(binding.sessionId).length, 0);
    assert.equal(store.getSession(binding.sessionId).status, "complete");
    assert.ok(store.getItems(binding.sessionId).some(item => item.id === "model-change"));
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("streamed chart reply retains one stable item and exact fenced text through the mobile message API", async () => {
  const { directory, store, projector } = await fixture();
  const itemId = "agent:chart-reply";
  const prefix = "Before\n\n```corptie-chart\n";
  const fullText = `${prefix}{"version":1,"type":"bar","title":"Compare","data":[{"label":"A","value":2}]}\n\`\`\`\n\nAfter`;
  const item = (text, status) => ({ id: itemId, turnId: "turn:one", type: "agentMessage",
    title: "Assistant", text, status, turnStatus: status === "completed" ? "completed" : "inProgress" });
  try {
    projector.project({ event: event("turn.started"), binding });
    projector.project({ event: event("assistant.message.delta", {
      providerEventId: "event:chart-delta", itemId, payload: { item: item(prefix, "streaming") }
    }), binding });
    const api = new ClientSessionAPI({ store,
      readWindow: async () => ({ revision: 1, hasEarlier: false, items: store.getItems(binding.sessionId) }) });
    const identity = { deviceId: "device:test" };
    const during = await api.messages(identity, binding.sessionId, new URLSearchParams());
    assert.equal(during.items.find((candidate) => candidate.id === itemId)?.text, prefix);

    projector.project({ event: event("assistant.message.completed", {
      providerEventId: "event:chart-final", itemId, payload: { item: item(fullText, "completed") }
    }), binding });
    projector.project({ event: event("turn.completed", { providerEventId: "event:chart-turn-complete" }), binding });
    const after = await api.messages(identity, binding.sessionId, new URLSearchParams());
    assert.deepEqual(after.items.filter((candidate) => candidate.type === "agentMessage").map((candidate) => candidate.id), [itemId]);
    assert.equal(after.items.find((candidate) => candidate.id === itemId)?.text, fullText);
    assert.equal((after.items.find((candidate) => candidate.id === itemId)?.text.match(/```corptie-chart/g) ?? []).length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
    const { task } = store.enqueueAgentTaskWithResult({
      taskId: "agent-work:one",
      agentId: "agent:one",
      sessionId: binding.sessionId,
      kind: "collaboration",
      priority: 100,
      text: "Handle this collaboration once",
      source: { type: "collaboration", taskId: "task:one" },
      localVisibility: "status_only"
    });
    const running = store.claimAgentTask(task.taskId);
    store.upsertTimelineItemProjection(binding.sessionId, {
      id: `work:${task.taskId}`,
      turnId: `work:${task.taskId}`,
      type: "userMessage",
      title: "Agent Collaboration",
      text: task.text,
      status: "running",
      presentationRole: "collaboration",
      rawMetadataJSON: JSON.stringify({ taskId: task.taskId, presentationRole: "collaboration" })
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
    assert.deepEqual(userItems.map((item) => item.id), [`work:${task.taskId}`]);
    assert.equal(userItems[0].turnId, "turn:one");
    assert.equal(userItems[0].title, "Agent Collaboration");
    assert.equal(userItems[0].presentationRole, "collaboration");
    assert.equal(userItems[0].taskId, task.taskId);
    assert.equal(store.getAgentTask(task.taskId).targetTurnId, "turn:one");
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

test("a structured input request persists as one pending interaction and blocks only its turn", async () => {
  const { directory, store, projector } = await fixture();
  try {
    projector.project({ binding, event: event("turn.started") });
    const item = {
      id: "thread:current:app-server-user-input:request:one",
      turnId: "turn:one", turnStatus: "blocked", type: "userInput",
      title: "需要输入", text: "Which route?", status: "pending",
      rawMetadataJSON: JSON.stringify({ userInput: {
        schemaVersion: 1, isBlocking: true, questions: [{ id: "route", question: "Which route?" }]
      } })
    };
    projector.project({ binding, event: event("interaction.requested", {
      itemId: item.id, payload: { item }
    }) });
    assert.equal(store.getSession(binding.sessionId).status, "blocked");
    assert.equal(store.getSession(binding.sessionId).activityStatus, "Waiting for input");
    const projected = store.getSessionItem(binding.sessionId, item.id);
    assert.equal(projected.status, "pending");
    assert.equal(projected.userInput.questions[0].id, "route");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a nonblocking structured question leaves its turn running", async () => {
  const { directory, store, projector } = await fixture();
  try {
    projector.project({ binding, event: event("turn.started") });
    projector.project({ binding, event: event("interaction.requested", {
      itemId: "input:nonblocking",
      payload: { item: {
        id: "input:nonblocking", turnId: "turn:one", type: "userInput",
        status: "pending", text: "Optional question",
        rawMetadataJSON: JSON.stringify({ userInput: {
          schemaVersion: 1, isBlocking: false, questions: [{ id: "optional", question: "Optional question" }]
        } })
      } }
    }) });
    assert.equal(store.getSession(binding.sessionId).status, "running");
    assert.equal(store.getSessionItem(binding.sessionId, "input:nonblocking").status, "pending");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("input submission and native resolution update one item without reviving a settled turn", async () => {
  const { directory, store, projector } = await fixture();
  try {
    const item = { id: "input:one", turnId: "turn:one", turnStatus: "blocked",
      type: "userInput", text: "Choose route", status: "pending",
      rawMetadataJSON: JSON.stringify({ userInput: {
        schemaVersion: 1, isBlocking: true, questions: [{ id: "route", question: "Choose route" }]
      } }) };
    projector.project({ binding, event: event("turn.started") });
    projector.project({ binding, event: event("interaction.requested", { itemId: item.id,
      payload: { item } }) });
    projector.project({ binding, event: event("interaction.submitted", { itemId: item.id,
      payload: { item: { ...item, status: "submitted" } } }) });
    assert.equal(store.getSession(binding.sessionId).status, "blocked");
    assert.equal(store.getSessionItem(binding.sessionId, item.id).status, "submitted");
    projector.project({ binding, event: event("interaction.resolved", { itemId: item.id,
      payload: { item: { ...item, status: "submitted", turnStatus: "inProgress" } } }) });
    assert.equal(store.getSession(binding.sessionId).status, "running");
    assert.equal(store.getItems(binding.sessionId).filter((candidate) => candidate.id === item.id).length, 1);
    projector.project({ binding, event: event("turn.completed") });
    assert.equal(store.getSessionItem(binding.sessionId, item.id).turnStatus, "completed");
    projector.project({ binding, event: event("interaction.resolved", { itemId: item.id,
      payload: { item: { ...item, status: "submitted", turnStatus: "inProgress" } } }) });
    assert.equal(store.getSessionTurn(binding.sessionId, binding.bindingId, "turn:one").execution_status, "completed");
    assert.equal(store.getSessionItem(binding.sessionId, item.id).turnStatus, "completed");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("turn completion expires a still-pending question without inventing an answer", async () => {
  const { directory, store, projector } = await fixture();
  try {
    const item = { id: "input:unanswered", turnId: "turn:one", turnStatus: "blocked",
      type: "userInput", text: "Choose route", status: "pending",
      rawMetadataJSON: JSON.stringify({ userInput: {
        schemaVersion: 1, isBlocking: true, questions: [{ id: "route", question: "Choose route" }]
      } }) };
    projector.project({ binding, event: event("turn.started") });
    projector.project({ binding, event: event("interaction.requested", { itemId: item.id,
      payload: { item } }) });
    projector.project({ binding, event: event("turn.completed") });
    assert.equal(store.getSessionItem(binding.sessionId, item.id).status, "expired");
    assert.equal(store.getSessionItem(binding.sessionId, item.id).turnStatus, "completed");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("async questions survive turn completion and cannot resurrect after a submitted reply", async () => {
  const { directory, store, projector } = await fixture();
  try {
    const item = { id: "async:question", type: "userInput", status: "pending", turnId: "turn:one",
      text: "Choose", rawMetadataJSON: JSON.stringify({ userInput: {
        schemaVersion: 1, responseMode: "message", isBlocking: false,
        questions: [{ id: "q", question: "Choose", isOther: true, options: null }]
      } }) };
    projector.project({ binding, event: event("turn.started") });
    projector.project({ binding, event: event("interaction.requested", { payload: { item } }) });
    projector.project({ binding, event: event("turn.completed") });
    assert.equal(store.getSessionItem(binding.sessionId, item.id).status, "pending");
    assert.equal(store.getSession(binding.sessionId).status, "complete");
    store.upsertTimelineItemProjection(binding.sessionId, { ...store.getSessionItem(binding.sessionId, item.id), status: "submitted" });
    projector.project({ binding, event: event("interaction.requested", { payload: { item } }) });
    assert.equal(store.getSessionItem(binding.sessionId, item.id).status, "submitted");
    projector.project({ binding, event: event("execution.notice", { payload: { item: {
      id: "compact", type: "contextCompaction", text: "Compressed", status: "completed"
    } } }) });
    assert.equal(store.listUnsettledSessionTurns(binding.sessionId).length, 0);
    assert.equal(store.getSessionItem(binding.sessionId, "compact").type, "contextCompaction");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("plan snapshots update one stable timeline item and preserve step identities", async () => {
  const { directory, store, projector } = await fixture();
  try {
    projector.project({ binding, event: event("turn.started") });
    projector.project({ binding, event: event("plan.updated", { payload: { plan: {
      operation: "replace", explanation: null,
      steps: [{ text: "Inspect", status: "inProgress" }, { text: "Fix", status: "pending" }]
    } } }) });
    const first = store.getItems(binding.sessionId).find((item) => item.type === "executionPlan");
    assert.equal(first.executionPlan.revision, 1);
    assert.equal(first.executionPlan.steps[0].stepId, "step:1");
    projector.project({ binding, event: event("plan.updated", { payload: { plan: {
      operation: "replace", explanation: null,
      steps: [{ text: "Inspect", status: "completed" }, { text: "Fix", status: "inProgress" }]
    } } }) });
    const plans = store.getItems(binding.sessionId).filter((item) => item.type === "executionPlan");
    assert.equal(plans.length, 1);
    assert.equal(plans[0].id, first.id);
    assert.equal(plans[0].executionPlan.revision, 2);
    assert.equal(plans[0].executionPlan.steps[0].stepId, "step:1");
    assert.equal(plans[0].executionPlan.steps[0].status, "completed");
    projector.project({ binding, event: event("turn.completed") });
    assert.equal(store.getSessionItem(binding.sessionId, first.id).executionPlan.lifecycle, "completed");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a historical plan remains readable after the Session changes Provider Binding", async () => {
  const { directory, store, projector } = await fixture();
  const nextBinding = {
    ...binding,
    bindingId: "binding:claude",
    providerId: "claude-sdk",
    providerSessionId: "claude:next",
    routingVersion: binding.routingVersion + 1
  };
  try {
    projector.project({ binding, event: event("turn.started") });
    projector.project({ binding, event: event("plan.updated", { payload: { plan: {
      operation: "replace", explanation: null,
      steps: [{ text: "Inspect", status: "completed" }]
    } } }) });
    projector.project({ binding, event: event("turn.completed") });
    const historical = store.getItems(binding.sessionId).find((item) => item.type === "executionPlan");
    assert.equal(historical.executionPlan.lifecycle, "completed");

    projector.project({ binding: nextBinding, event: event("turn.started", {
      providerId: nextBinding.providerId,
      providerSessionId: nextBinding.providerSessionId,
      bindingId: nextBinding.bindingId,
      routingVersion: nextBinding.routingVersion,
      turnId: "turn:next"
    }) });
    const afterSwitch = store.getSessionItem(binding.sessionId, historical.id);
    assert.equal(afterSwitch.executionPlan.planId, historical.executionPlan.planId);
    assert.deepEqual(afterSwitch.executionPlan.steps, historical.executionPlan.steps);
    assert.equal(afterSwitch.executionPlan.lifecycle, "completed");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("late plan updates retain the settled Turn state while revising its existing checklist", async () => {
  const { directory, store, projector } = await fixture();
  try {
    projector.project({ binding, event: event("turn.started") });
    projector.project({ binding, event: event("plan.updated", { payload: { plan: {
      operation: "replace", explanation: null,
      steps: [{ text: "Inspect", status: "inProgress" }]
    } } }) });
    projector.project({ binding, event: event("turn.completed") });
    const before = store.getItems(binding.sessionId).find((item) => item.type === "executionPlan");
    assert.equal(before.executionPlan.lifecycle, "completed");

    projector.project({ binding, event: event("plan.updated", { payload: { plan: {
      operation: "replace", explanation: null,
      steps: [{ text: "Inspect", status: "completed" }]
    } } }) });
    const plans = store.getItems(binding.sessionId).filter((item) => item.type === "executionPlan");
    assert.equal(plans.length, 1);
    assert.equal(plans[0].id, before.id);
    assert.equal(plans[0].executionPlan.revision, before.executionPlan.revision + 1);
    assert.equal(plans[0].executionPlan.lifecycle, "completed");
    assert.equal(plans[0].executionPlan.steps[0].status, "completed");
    assert.equal(plans[0].status, "completed");
    assert.equal(store.getSessionTurn(binding.sessionId, binding.bindingId, "turn:one").execution_status, "completed");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed Turn and its late plan updates never revive a running checklist step", async () => {
  const { directory, store, projector } = await fixture();
  const snapshot = { operation: "replace", explanation: null,
    steps: [{ text: "Inspect", status: "completed" }, { text: "Fix", status: "inProgress" }] };
  try {
    projector.project({ binding, event: event("turn.started") });
    projector.project({ binding, event: event("plan.updated", { payload: { plan: snapshot } }) });
    projector.project({ binding, event: event("turn.failed") });
    const first = store.getItems(binding.sessionId).find((item) => item.type === "executionPlan");
    assert.equal(first.executionPlan.lifecycle, "failed");
    assert.deepEqual(first.executionPlan.steps.map((step) => step.status), ["completed", "unknown"]);

    projector.project({ binding, event: event("plan.updated", { payload: { plan: snapshot } }) });
    const late = store.getSessionItem(binding.sessionId, first.id);
    assert.equal(late.executionPlan.lifecycle, "failed");
    assert.deepEqual(late.executionPlan.steps.map((step) => step.status), ["completed", "unknown"]);
    assert.equal(late.executionPlan.revision, first.executionPlan.revision,
      "a redundant late snapshot must not publish a new revision");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsupported plan snapshot keeps a visible uncertain state instead of disappearing", async () => {
  const { directory, store, projector } = await fixture();
  try {
    projector.project({ binding, event: event("plan.updated", { payload: { plan: null } }) });
    const item = store.getItems(binding.sessionId).find((candidate) => candidate.type === "executionPlan");
    assert.equal(item.text, "Plan update unavailable");
    assert.equal(item.executionPlan.lifecycle, "unknown");
    projector.project({ binding, event: event("plan.updated", { payload: { plan: {
      operation: "replace", explanation: null, steps: [{ text: "Recover", status: "pending" }]
    } } }) });
    const recovered = store.getSessionItem(binding.sessionId, item.id);
    assert.equal(recovered.executionPlan.lifecycle, "active");
    assert.equal(recovered.executionPlan.steps[0].text, "Recover");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed plan updates mark prior steps uncertain while valid no-ops keep their revision", async () => {
  const { directory, store, projector } = await fixture();
  try {
    const valid = { operation: "replace", explanation: null,
      steps: [{ text: "Inspect", status: "pending" }] };
    projector.project({ binding, event: event("plan.updated", { payload: { plan: valid } }) });
    const initial = store.getItems(binding.sessionId).find((item) => item.type === "executionPlan");
    projector.project({ binding, event: event("plan.updated", { payload: { plan: valid } }) });
    assert.equal(store.getSessionItem(binding.sessionId, initial.id).executionPlan.revision, 1);

    projector.project({ binding, event: event("plan.updated", { payload: { plan: {
      operation: "replace", explanation: null,
      steps: [{ text: "Inspect", status: "not-a-status" }]
    } } }) });
    const uncertain = store.getSessionItem(binding.sessionId, initial.id);
    assert.equal(uncertain.executionPlan.lifecycle, "unknown");
    assert.equal(uncertain.executionPlan.revision, 2);
    assert.equal(uncertain.executionPlan.steps[0].text, "Inspect");
    assert.equal(uncertain.text, "Plan update unavailable");

    projector.project({ binding, event: event("plan.updated", { payload: { plan: valid } }) });
    const recovered = store.getSessionItem(binding.sessionId, initial.id);
    assert.equal(recovered.executionPlan.lifecycle, "active");
    assert.equal(recovered.executionPlan.revision, 3);
    assert.equal(store.getItems(binding.sessionId).filter((item) => item.type === "executionPlan").length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude task create and update patches use stable task IDs", async () => {
  const { directory, store, projector } = await fixture();
  try {
    projector.project({ binding, event: event("plan.updated", { payload: { plan: {
      operation: "upsert", planKey: "claude-tasks",
      step: { stepId: "task:7", text: "Build UI", status: "pending" }
    } } }) });
    projector.project({ binding, event: event("plan.updated", { payload: { plan: {
      operation: "upsert", planKey: "claude-tasks",
      step: { stepId: "task:7", status: "inProgress" }
    } } }) });
    const item = store.getItems(binding.sessionId).find((candidate) => candidate.type === "executionPlan");
    assert.equal(item.executionPlan.steps.length, 1);
    assert.equal(item.executionPlan.steps[0].text, "Build UI");
    assert.equal(item.executionPlan.steps[0].status, "inProgress");
    assert.equal(item.executionPlan.revision, 2);
    projector.project({ binding, event: event("turn.completed") });
    const settled = store.getSessionItem(binding.sessionId, item.id);
    assert.equal(settled.turnStatus, "completed");
    assert.equal(store.getExecutionPlanState(binding.sessionId, binding.bindingId, "claude-tasks").lifecycle,
      "completed", "the cross-turn seed must settle with the visible checklist");
    projector.project({ binding, event: event("plan.updated", { turnId: "turn:two", payload: { plan: {
      operation: "upsert", planKey: "claude-tasks", step: { stepId: "task:7", status: "completed" }
    } } }) });
    const updated = store.getItemsForTurn(binding.sessionId, "turn:two").find((candidate) => candidate.type === "executionPlan");
    assert.ok(updated);
    assert.notEqual(updated.id, item.id);
    assert.equal(updated.turnId, "turn:two");
    assert.equal(updated.executionPlan.steps[0].text, "Build UI");
    assert.equal(updated.executionPlan.steps[0].status, "completed");
    assert.equal(store.getSessionItem(binding.sessionId, item.id).executionPlan.steps[0].status, "unknown",
      "the prior turn remains historical without implying its unfinished step is still running");
    projector.project({ binding, event: event("plan.updated", { turnId: "turn:two", payload: { plan: {
      operation: "remove", planKey: "claude-tasks", step: { stepId: "task:7" }
    } } }) });
    assert.deepEqual(store.getSessionItem(binding.sessionId, updated.id).executionPlan.steps, []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude task state stays terminal after failure and late updates, then reopens in a new Turn", async () => {
  const { directory, store, projector } = await fixture();
  try {
    const planUpdate = (turnId, stepId, text, status) => event("plan.updated", { turnId, payload: { plan: {
      operation: "upsert", planKey: "claude-tasks",
      step: { stepId, text, status }
    } } });
    projector.project({ binding, event: planUpdate("turn:one", "task:7", "Build UI", "inProgress") });
    const first = store.getItemsForTurn(binding.sessionId, "turn:one")
      .find((item) => item.type === "executionPlan");
    const staleSeed = store.getExecutionPlanState(binding.sessionId, binding.bindingId, "claude-tasks");
    projector.project({ binding, event: event("turn.failed") });
    assert.equal(store.getSessionItem(binding.sessionId, first.id).executionPlan.lifecycle, "failed");
    assert.equal(store.getExecutionPlanState(binding.sessionId, binding.bindingId, "claude-tasks").lifecycle,
      "failed");

    projector.project({ binding, event: planUpdate("turn:one", "task:7", "Build UI", "completed") });
    assert.equal(store.getSessionItem(binding.sessionId, first.id).executionPlan.lifecycle, "failed");
    assert.equal(store.getExecutionPlanState(binding.sessionId, binding.bindingId, "claude-tasks").lifecycle,
      "failed", "a late update must not reopen the failed Turn in the materialized seed");

    // Simulate a database produced by the older projector: the timeline was
    // settled at a newer revision, but the materialized seed stayed active.
    store.upsertExecutionPlanState(binding.sessionId, binding.bindingId, "claude-tasks", staleSeed);
    projector.project({ binding, event: planUpdate("turn:two", "task:8", "Review", "pending") });
    const second = store.getItemsForTurn(binding.sessionId, "turn:two")
      .find((item) => item.type === "executionPlan");
    assert.equal(second.executionPlan.lifecycle, "active");
    assert.equal(second.executionPlan.steps.find((step) => step.stepId === "task:7")?.status,
      "completed", "the new Turn must inherit the newer settled item, not stale active state");
    assert.equal(store.getExecutionPlanState(binding.sessionId, binding.bindingId, "claude-tasks").lifecycle,
      "active");
    assert.equal(store.getSessionItem(binding.sessionId, first.id).executionPlan.lifecycle, "failed");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("a completed Provider turn preserves completion despite a failed tool and empty final reply", async () => {
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
    assert.equal(projected.terminalStatus, "completed");
    assert.equal(projected.terminalFailure, null);
    assert.equal(turn.execution_status, "completed");
    assert.equal(turn.final_item_id, null);
    assert.equal(delivery.status, "completed");
    assert.equal(delivery.lastError, null);
    assert.equal(projected.session.status, "complete");
    assert.equal(store.getItems(binding.sessionId).find((item) => item.id === "tool:failed").status, "failed");
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
    const failureItem = store.getItems(binding.sessionId).find(item =>
      item.id === `turn-failure:${binding.bindingId}:turn:one`
    );
    assert.equal(failureItem.type, "system");
    assert.equal(failureItem.turnStatus, "failed");
    assert.match(failureItem.text, /模型服务/);
    assert.equal(settled.timelineChanged, true);
    assert.equal(
      store.getSessionTurn(binding.sessionId, binding.bindingId, "turn:one").execution_status,
      "failed"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed Turn publishes one sanitized actionable timeline item on replay", async () => {
  const { directory, store, projector } = await fixture();
  try {
    const failed = event("turn.failed", {
      payload: { error: {
        code: "UPSTREAM_ACCOUNT_UNAVAILABLE",
        message: "no eligible upstream account is currently available; token=secret-value"
      } }
    });
    projector.project({ event: failed, binding });
    projector.project({ event: failed, binding });
    const items = store.getItems(binding.sessionId).filter(item => item.type === "system");
    assert.equal(items.length, 1);
    assert.match(items[0].text, /没有可用的上游账号/);
    assert.equal(items[0].text.includes("secret-value"), false);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a delayed first response replaces generic Working with an honest waiting state", async () => {
  const { directory, store, projector } = await fixture();
  try {
    projector.project({ event: event("turn.started"), binding });
    const message = "模型服务暂未返回任何执行信息，仍在等待；如果持续无响应，本次执行会自动结束。";
    const projected = projector.project({
      event: event("provider.error", {
        providerEventId: "watchdog:delayed",
        payload: {
          error: { code: "PROVIDER_RESPONSE_DELAYED", message, retryable: true },
          failureScope: "turn",
          willRetry: true
        }
      }),
      binding
    });

    assert.equal(projected.session.status, "running");
    assert.equal(projected.session.activityStatus, "Waiting for model response");
    assert.equal(projected.session.summary, message);
    assert.equal(projected.session.capabilities.canInterrupt, true);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a response timeout remains failed when the Provider later reports cancellation", async () => {
  const { directory, store, projector } = await fixture();
  try {
    projector.project({ event: event("turn.started"), binding });
    const message = "模型服务长时间未返回任何执行信息。本次执行已自动结束；您可以重试或切换模型。";
    const failed = projector.project({
      event: event("turn.failed", {
        providerEventId: "watchdog:timeout",
        payload: {
          error: { code: "PROVIDER_RESPONSE_TIMEOUT", message, retryable: true },
          items: [{
            id: "timeout:one", turnId: "turn:one", type: "system",
            title: "模型响应超时", text: message, status: "failed"
          }]
        }
      }),
      binding
    });
    const late = projector.project({
      event: event("turn.cancelled", { providerEventId: "provider:late-cancel" }),
      binding
    });

    const turn = store.getSessionTurn("session:one", binding.bindingId, "turn:one");
    assert.equal(failed.terminalStatus, "failed");
    assert.equal(late.terminalStatus, "failed");
    assert.equal(turn.execution_status, "failed");
    assert.equal(JSON.parse(turn.failure_json).code, "PROVIDER_RESPONSE_TIMEOUT");
    assert.equal(late.session.status, "failed");
    assert.equal(late.session.summary, message);
    assert.equal(late.session.capabilities.canInterrupt, false);
    assert.equal(store.getSessionItem("session:one", "timeout:one").text, message);
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
