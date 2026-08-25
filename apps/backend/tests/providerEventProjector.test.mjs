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
    projector.project({
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

    const item = store.getSessionItem("session:one", "item:final");
    assert.equal(item.presentationRole, "final_answer");
    assert.equal(item.turnStatus, "completed");
    assert.equal(store.getSessionTurn("session:one", binding.bindingId, "turn:one").execution_status, "completed");
    assert.equal(store.getSession("session:one").status, "complete");
    assert.equal(store.getSession("session:one").executionStatus, "completed");
    assert.equal(store.getSession("session:one").external.activeTurnId, null);
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
