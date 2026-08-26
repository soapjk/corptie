import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import {
  reconcileAuthoritativeRunState,
  sessionHasActiveRun
} from "../src/utils/sessionPresentation.mjs";
import {
  assertAgentWorkSessionReference,
  interruptedAgentWorkRecoveryPatch,
  shouldReportAgentWorkQueued,
  userMessageStatusForAgentWork
} from "../src/utils/agentWorkQueue.mjs";

async function fixture() {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-work-queue-test-"));
  const dbPath = join(directory, "corptie.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
  await store.initialize();
  const core = new CollaborationCore(store);
  core.registerAgent({ agentId: "agent-b", name: "Agent B" });
  core.bindSession({ agentId: "agent-b", sessionId: "codex:thread-b" });
  core.bindSession({ agentId: "agent-b", sessionId: "codex:thread-c" });
  return { directory, dbPath, store };
}

function enqueue(store, overrides) {
  return store.enqueueAgentWorkItem({
    workItemId: overrides.workItemId,
    agentId: "agent-b",
    sessionId: overrides.sessionId ?? "codex:thread-b",
    kind: overrides.kind,
    priority: overrides.priority,
    text: overrides.text ?? overrides.workItemId,
    source: { type: overrides.kind },
    localVisibility: overrides.kind === "collaboration" ? "status_only" : "normal",
    createdAt: overrides.createdAt
  });
}

test("an idle Agent's first message starts without a queue notice", () => {
  assert.equal(shouldReportAgentWorkQueued({}), false);
});

test("a message reports queued when an Agent is busy or work is ahead", () => {
  assert.equal(shouldReportAgentWorkQueued({ sessionHasActiveRun: true }), true);
  assert.equal(shouldReportAgentWorkQueued({ hasRunningWorkItem: true }), true);
  assert.equal(shouldReportAgentWorkQueued({ queuedWorkItemsAhead: 1 }), true);
});

test("orphaned dispatched work is cancelled while pre-dispatch work is requeued", () => {
  assert.deepEqual(interruptedAgentWorkRecoveryPatch({
    status: "running",
    targetTurnId: "turn-interrupted"
  }), {
    status: "cancelled",
    lastError: "Provider stopped after dispatch; message was not resent."
  });
  assert.deepEqual(interruptedAgentWorkRecoveryPatch({
    status: "running",
    targetTurnId: null
  }), {
    status: "queued",
    startedAt: null,
    targetTurnId: null,
    lastError: "Provider stopped before dispatch; work was requeued."
  });
  assert.deepEqual(interruptedAgentWorkRecoveryPatch({
    status: "running",
    targetTurnId: "turn-interrupted",
    source: { type: "workspace-continuation" }
  }), {
    status: "queued",
    startedAt: null,
    targetTurnId: null,
    lastError: "Provider stopped before the workspace continuation settled; it was requeued."
  });
});

test("queued work remains routed to its own Session when the Agent current Session changes", () => {
  const workItem = {
    sessionId: "codex:work-item-session",
    source: { type: "desktop" }
  };
  const reference = {
    sessionId: "codex:work-item-session",
    providerSessionId: "provider:work-item"
  };

  assert.equal(assertAgentWorkSessionReference(workItem, reference), reference);
  assert.throws(
    () => assertAgentWorkSessionReference(workItem, {
      sessionId: "codex:agent-current-session",
      providerSessionId: "provider:other"
    }),
    (error) => error.code === "AGENT_WORK_ROUTE_MISMATCH"
  );
});

test("workspace continuation is locked to the committed Provider binding and routing version", () => {
  const workItem = {
    sessionId: "codex:stable-work-session",
    source: {
      type: "workspace-continuation",
      productSessionId: "codex:stable-work-session",
      logicalSessionId: "logical:work-session",
      bindingId: "binding:new-worktree",
      providerSessionId: "provider:new-worktree",
      routingVersion: 2
    }
  };
  const reference = {
    sessionId: "codex:stable-work-session",
    logicalSessionId: "logical:work-session",
    bindingId: "binding:new-worktree",
    providerSessionId: "provider:new-worktree",
    routingVersion: 2
  };

  assert.equal(assertAgentWorkSessionReference(workItem, reference), reference);
  assert.throws(
    () => assertAgentWorkSessionReference(workItem, { ...reference, routingVersion: 3 }),
    (error) => error.code === "STALE_WORKSPACE_CONTINUATION"
  );
});

test("durable work lifecycle maps to provider-neutral user message status", () => {
  assert.equal(userMessageStatusForAgentWork("queued"), "queued");
  assert.equal(userMessageStatusForAgentWork("running"), "processing");
  assert.equal(userMessageStatusForAgentWork("completed"), "consumed");
  assert.equal(userMessageStatusForAgentWork("failed"), "failed");
  assert.equal(userMessageStatusForAgentWork("cancelled"), "cancelled");
  assert.equal(userMessageStatusForAgentWork("future-state"), null);

});

test("user instructions are selected before older collaboration work", async () => {
  const { directory, store } = await fixture();
  try {
    enqueue(store, {
      workItemId: "collaboration-1",
      kind: "collaboration",
      priority: 50,
      createdAt: "2026-07-17T00:00:00.000Z"
    });
    enqueue(store, {
      workItemId: "user-1",
      kind: "user",
      priority: 100,
      createdAt: "2026-07-17T00:00:01.000Z"
    });

    assert.deepEqual(
      store.listQueuedAgentWorkItems("agent-b").map((item) => item.workItemId),
      ["user-1", "collaboration-1"]
    );
  } finally {
    if (store.saveTimer) clearTimeout(store.saveTimer);
    await rm(directory, { recursive: true, force: true });
  }
});

test("one Session stays serial while two Sessions sharing an Agent run concurrently", async () => {
  const { directory, store } = await fixture();
  try {
    enqueue(store, { workItemId: "user-1", kind: "user", priority: 100 });
    enqueue(store, { workItemId: "user-2", kind: "user", priority: 100 });
    enqueue(store, {
      workItemId: "user-3",
      kind: "user",
      priority: 100,
      sessionId: "codex:thread-c"
    });

    assert.equal(store.claimAgentWorkItem("user-1")?.status, "running");
    assert.equal(store.claimAgentWorkItem("user-2"), null);
    store.db.run(`CREATE UNIQUE INDEX idx_agent_work_items_one_running
      ON agent_work_items(agent_id) WHERE status = 'running'`);
    assert.equal(store.claimAgentWorkItem("user-3")?.status, "running");
    assert.equal(store.selectOne(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_work_items_one_running'"
    ), null);
    assert.equal(store.getRunningAgentWorkItemForSession("codex:thread-b")?.workItemId, "user-1");
    assert.equal(store.getRunningAgentWorkItemForSession("codex:thread-c")?.workItemId, "user-3");
    store.updateAgentWorkItem("user-1", { status: "completed" });
    assert.equal(store.claimAgentWorkItem("user-2")?.status, "running");
  } finally {
    if (store.saveTimer) clearTimeout(store.saveTimer);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lone running work item remains discoverable for restart recovery", async () => {
  const { directory, store } = await fixture();
  try {
    enqueue(store, {
      workItemId: "only-running",
      kind: "user",
      priority: 100,
      createdAt: "2026-07-17T00:00:00.000Z"
    });
    store.claimAgentWorkItem("only-running");

    assert.deepEqual(store.listAgentIdsWithQueuedWork(), []);
    assert.deepEqual(store.listAgentIdsWithUnsettledWork(), ["agent-b"]);
    assert.deepEqual(store.listSessionIdsWithUnsettledAgentWork(), ["codex:thread-b"]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup migrates the legacy Agent-wide running index to a Session-wide index", async () => {
  const { directory, dbPath, store } = await fixture();
  let reopened = null;
  try {
    store.db.run("DROP INDEX IF EXISTS idx_agent_work_items_one_running_per_session");
    store.db.run(`CREATE UNIQUE INDEX idx_agent_work_items_one_running
      ON agent_work_items(agent_id) WHERE status = 'running'`);
    await store.close();

    reopened = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await reopened.initialize();

    assert.equal(reopened.selectOne(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_work_items_one_running'"
    ), null);
    assert.equal(reopened.selectOne(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_work_items_one_running_per_session'"
    )?.name, "idx_agent_work_items_one_running_per_session");
  } finally {
    if (reopened?.saveTimer) clearTimeout(reopened.saveTimer);
    await rm(directory, { recursive: true, force: true });
  }
});

test("clearing or deleting a Session cancels every unsettled queued message", async () => {
  const { directory, store } = await fixture();
  try {
    store.upsertSession({
      id: "codex:thread-b",
      title: "Agent B",
      status: "complete",
      progress: 1,
      summary: "Ready",
      updatedAt: "2026-07-17T00:00:00.000Z",
      accent: "cyan"
    });
    enqueue(store, { workItemId: "queued-before-clear", kind: "user", priority: 100 });

    store.deleteSession("codex:thread-b");

    const cancelled = store.getAgentWorkItem("queued-before-clear");
    assert.equal(cancelled.status, "cancelled");
    assert.match(cancelled.lastError, /cleared or deleted/);
  } finally {
    if (store.saveTimer) clearTimeout(store.saveTimer);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a running work item is recovered to queued after restart", async () => {
  const { directory, dbPath, store } = await fixture();
  let reopened = null;
  try {
    enqueue(store, { workItemId: "user-1", kind: "user", priority: 100 });
    store.claimAgentWorkItem("user-1");
    if (store.saveTimer) {
      clearTimeout(store.saveTimer);
      store.saveTimer = null;
    }
    await store.save();

    reopened = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await reopened.initialize();
    const recovered = reopened.getAgentWorkItem("user-1");
    assert.equal(recovered.status, "queued");
    assert.match(recovered.lastError, /restart/);
  } finally {
    if (store.saveTimer) clearTimeout(store.saveTimer);
    if (reopened?.saveTimer) clearTimeout(reopened.saveTimer);
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart recovery does not requeue dispatched collaboration work", async () => {
  const { directory, dbPath, store } = await fixture();
  let reopened = null;
  try {
    enqueue(store, {
      workItemId: "collaboration-dispatched",
      kind: "collaboration",
      priority: 50
    });
    store.claimAgentWorkItem("collaboration-dispatched");
    store.updateAgentWorkItem("collaboration-dispatched", { targetTurnId: "turn-interrupted" });
    if (store.saveTimer) {
      clearTimeout(store.saveTimer);
      store.saveTimer = null;
    }
    await store.save();

    reopened = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await reopened.initialize();

    const recovered = reopened.getAgentWorkItem("collaboration-dispatched");
    assert.equal(recovered.status, "cancelled");
    assert.match(recovered.lastError, /not resent/);
  } finally {
    if (store.saveTimer) clearTimeout(store.saveTimer);
    if (reopened?.saveTimer) clearTimeout(reopened.saveTimer);
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart recovery does not resend user work that reached a Codex turn", async () => {
  const { directory, dbPath, store } = await fixture();
  let reopened = null;
  try {
    store.upsertSession({
      id: "codex:thread-b",
      title: "Agent B",
      agent: "Codex",
      status: "running",
      progress: 0.5,
      summary: "Installing browser",
      updatedAt: "2026-07-18T05:35:59.000Z",
      external: {
        provider: "codex-app-server",
        threadId: "thread-b",
        sessionId: "thread-b",
        activeTurnId: "interrupted-turn"
      }
    });
    enqueue(store, { workItemId: "install-browser", kind: "user", priority: 100 });
    store.claimAgentWorkItem("install-browser");
    store.updateAgentWorkItem("install-browser", { targetTurnId: "interrupted-turn" });
    if (store.saveTimer) {
      clearTimeout(store.saveTimer);
      store.saveTimer = null;
    }
    await store.save();

    reopened = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await reopened.initialize();

    const recoveredWork = reopened.getAgentWorkItem("install-browser");
    const staleSession = reopened.getSession("codex:thread-b");
    assert.equal(recoveredWork.status, "cancelled");
    assert.match(recoveredWork.lastError, /not resent/);
    assert.equal(sessionHasActiveRun(staleSession), true);

    const reconciledSession = reconcileAuthoritativeRunState(
      { ...staleSession, status: "complete" },
      "complete"
    );
    assert.equal(sessionHasActiveRun(reconciledSession), false);
    assert.equal(reopened.claimAgentWorkItem(recoveredWork.workItemId), null);
  } finally {
    if (store.saveTimer) clearTimeout(store.saveTimer);
    if (reopened?.saveTimer) clearTimeout(reopened.saveTimer);
    await rm(directory, { recursive: true, force: true });
  }
});
