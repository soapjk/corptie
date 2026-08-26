import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import {
  activeStoredSessionProjections,
  canonicalSessionIdFromEventPayload,
  persistProviderSessionProjection,
  visibleStoredSessionProjections
} from "../src/application/providerSessionProjection.mjs";

test("resident Session projection excludes archives and restored rows rejoin", () => {
  let archived = true;
  const active = { id: "active", sessionKind: "worker" };
  const restored = { id: "restored", sessionKind: "assistantChat" };
  const store = {
    listSessions(options) {
      assert.deepEqual(options, { archived: false });
      return archived ? [active] : [active, restored];
    }
  };

  assert.deepEqual(activeStoredSessionProjections(store).map((value) => value.id), ["active"]);
  archived = false;
  assert.deepEqual(
    activeStoredSessionProjections(store).map((value) => value.id),
    ["active", "restored"]
  );
});

test("a newly created Provider Session persists provider-neutral entity ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-created-provider-projection-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const agent = store.createAgent({ id: "agent:worker", name: "Worker" });
    const objective = store.createObjective({
      id: "objective:one",
      name: "Objective",
      contributorAgentIds: [agent.agentId]
    });
    const workItem = store.createWorkItem({
      id: "work-item:one",
      objectiveId: objective.id,
      title: "Work Item",
      mainAgentId: agent.agentId
    });
    persistProviderSessionProjection(store, {
      id: "codex:created",
      title: "Created Worker",
      status: "complete",
      external: { provider: "codex-app-server", cwd: directory }
    }, {
      providerId: "codex-app-server",
      agentId: agent.agentId,
      sessionKind: "worker",
      objectiveId: objective.id,
      workItemId: workItem.id
    });

    const stored = store.getSession("codex:created");
    assert.equal(stored.agentId, agent.agentId);
    assert.equal(stored.sessionKind, "worker");
    assert.equal(stored.objectiveId, objective.id);
    assert.equal(stored.workItemId, workItem.id);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Provider Session without a product classification is rejected at the write boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-unclassified-projection-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const providerSession = {
      id: "codex:unowned",
      title: "Provider-local thread",
      status: "complete",
      external: { provider: "codex-app-server", threadId: "unowned", sessionId: "unowned" }
    };
    assert.throws(
      () => persistProviderSessionProjection(store, providerSession),
      { code: "SESSION_CLASSIFICATION_REQUIRED" }
    );
    assert.throws(
      () => persistProviderSessionProjection(store, { ...providerSession, sessionKind: " " }),
      { code: "SESSION_KIND_INVALID" }
    );
    assert.equal(store.getSession(providerSession.id), null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session visibility is a pure local projection with no per-row Binding lookups", () => {
  const forbiddenStore = new Proxy({}, {
    get() {
      throw new Error("Session list projection must not query the Store");
    }
  });
  const sessions = [
    { id: "assistant", sessionKind: "assistantChat" },
    { id: "objective", sessionKind: "objectiveChat" },
    { id: "worker", sessionKind: "worker" },
    { id: "provider-transport", sessionKind: "legacy" }
  ];

  assert.deepEqual(
    visibleStoredSessionProjections(forbiddenStore, sessions).map((session) => session.id),
    ["assistant", "objective", "worker"]
  );
});

test("a switched Provider event keeps the stable namespaced Session id", () => {
  const id = canonicalSessionIdFromEventPayload({
    session: {
      id: "openclacky:stable",
      external: {
        provider: "codex-app-server",
        sessionId: "codex-target",
        threadId: "codex-target"
      }
    }
  }, {
    resolveStableSessionId: ({ providerId, providerSessionId }) => (
      providerId === "codex-app-server" && providerSessionId === "codex-target"
        ? "openclacky:stable"
        : null
    )
  });

  assert.equal(id, "openclacky:stable");
});

test("an unresolved namespaced Session id is never prefixed twice", () => {
  assert.equal(canonicalSessionIdFromEventPayload({
    session: {
      id: "openclacky:stable",
      external: { provider: "codex-app-server" }
    }
  }), "openclacky:stable");
  assert.equal(canonicalSessionIdFromEventPayload({
    session: {
      id: "plain-codex-thread",
      external: { provider: "codex-app-server" }
    }
  }), "codex:plain-codex-thread");
});
