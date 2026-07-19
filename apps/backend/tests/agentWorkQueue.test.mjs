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

async function fixture() {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-work-queue-test-"));
  const dbPath = join(directory, "corptie.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
  await store.initialize();
  const core = new CollaborationCore(store);
  core.registerAgent({ agentId: "agent-b", name: "Agent B" });
  core.bindSession({ agentId: "agent-b", sessionId: "codex:thread-b" });
  return { directory, dbPath, store };
}

function enqueue(store, overrides) {
  return store.enqueueAgentWorkItem({
    workItemId: overrides.workItemId,
    agentId: "agent-b",
    sessionId: "codex:thread-b",
    kind: overrides.kind,
    priority: overrides.priority,
    text: overrides.text ?? overrides.workItemId,
    source: { type: overrides.kind },
    localVisibility: overrides.kind === "collaboration" ? "status_only" : "normal",
    createdAt: overrides.createdAt
  });
}

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

test("an Agent can claim only one work item at a time", async () => {
  const { directory, store } = await fixture();
  try {
    enqueue(store, { workItemId: "user-1", kind: "user", priority: 100 });
    enqueue(store, { workItemId: "user-2", kind: "user", priority: 100 });

    assert.equal(store.claimAgentWorkItem("user-1")?.status, "running");
    assert.equal(store.claimAgentWorkItem("user-2"), null);
    store.updateAgentWorkItem("user-1", { status: "completed" });
    assert.equal(store.claimAgentWorkItem("user-2")?.status, "running");
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
