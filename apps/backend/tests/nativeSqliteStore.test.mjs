import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";

test("native SQLite persists committed writes immediately in WAL mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-native-sqlite-"));
  const dbPath = join(directory, "corptie.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });

  try {
    await store.initialize();
    store.upsertSession({
      id: "native-session",
      title: "Native SQLite",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete",
      updatedAt: "2026-07-20T00:00:00.000Z"
    });

    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(reader.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      assert.equal(
        reader.prepare("SELECT title FROM sessions WHERE id = ?").get("native-session").title,
        "Native SQLite"
      );
    } finally {
      reader.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session kind persists explicitly and WorkItem binding classifies worker sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-kind-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({
      id: "assistant-session",
      title: "Assistant",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete",
      sessionKind: "assistantChat"
    });
    store.setSessionKind("assistant-session", "assistantChat", "assistant");
    assert.equal(store.getSession("assistant-session").sessionKind, "assistantChat");
    assert.equal(store.getSession("assistant-session").agentId, "assistant");

    store.upsertSession({
      id: "worker-session",
      title: "Worker",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    store.bindSessionToWorkItem("worker-session", "work-item:1", "objective:1");
    const worker = store.getSession("worker-session");
    assert.equal(worker.sessionKind, "worker");
    assert.equal(worker.workItemId, "work-item:1");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Assistant agents receive distinct workspaces and reject explicit reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-assistant-workspaces-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const first = store.createAgent({ id: "assistant:first", name: "First", role: "assistant" });
    const second = store.createAgent({ id: "assistant:second", name: "Second", role: "assistant" });

    assert.notEqual(first.workDir, second.workDir);
    assert.match(first.workDir, /assistants\/assistant%3Afirst\/workspace$/);
    assert.throws(
      () => store.updateAgent(second.agentId, { workDir: first.workDir }),
      (error) => error.code === "ASSISTANT_WORKSPACE_CONFLICT"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy shared Assistant workspaces are split during store migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-assistant-workspace-migration-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const sharedWorkspace = join(directory, "legacy-shared-workspace");
  const firstStore = new CorptieStore({ dbPath, configPath });

  try {
    await firstStore.initialize();
    firstStore.createAgent({ id: "assistant:first", name: "First", role: "assistant" });
    firstStore.createAgent({ id: "assistant:second", name: "Second", role: "assistant" });
    firstStore.db.run("DROP INDEX idx_agents_assistant_work_dir");
    firstStore.db.run(
      "UPDATE agents SET work_dir = ? WHERE agent_id IN (?, ?)",
      [sharedWorkspace, "assistant:first", "assistant:second"]
    );
    await firstStore.close();

    const migratedStore = new CorptieStore({ dbPath, configPath });
    try {
      await migratedStore.initialize();
      const first = migratedStore.getAgent("assistant:first");
      const second = migratedStore.getAgent("assistant:second");
      assert.notEqual(first.workDir.toLowerCase(), second.workDir.toLowerCase());
      assert.equal([first.workDir, second.workDir].includes(sharedWorkspace), true);
    } finally {
      await migratedStore.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy Session-derived inactive status is repaired once without overriding future explicit inactivity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-agent-status-migration-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const first = new CorptieStore({ dbPath, configPath });

  try {
    await first.initialize();
    first.createAgent({ id: "agent:legacy-inactive", name: "Legacy", role: "assistant" });
    first.upsertSession({
      id: "codex:deleted-session",
      title: "Deleted",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    const core = new CollaborationCore(first);
    core.bindSession({ agentId: "agent:legacy-inactive", sessionId: "codex:deleted-session" });
    core.detachSession("codex:deleted-session");
    first.db.run("UPDATE agents SET status = 'inactive' WHERE agent_id = ?", ["agent:legacy-inactive"]);
    first.db.run(
      "DELETE FROM data_migrations WHERE migration_id = ?",
      ["decouple-agent-status-from-session-v1"]
    );
    await first.close();

    const migrated = new CorptieStore({ dbPath, configPath });
    await migrated.initialize();
    assert.equal(migrated.getAgent("agent:legacy-inactive").status, "available");
    migrated.updateAgent("agent:legacy-inactive", { status: "inactive" });
    await migrated.close();

    const restarted = new CorptieStore({ dbPath, configPath });
    await restarted.initialize();
    assert.equal(restarted.getAgent("agent:legacy-inactive").status, "inactive");
    await restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("logical Session owns the canonical unique name and preserves renamed aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-identity-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.createAgent({ id: "agent:stable-name", name: "Stable Agent", role: "assistant" });
    store.upsertSession({
      id: "codex:provider-thread",
      title: "original_agent",
      agent: "Codex",
      provider: "codex-app-server",
      cwd: directory,
      status: "complete"
    });
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:stable-session",
      legacySessionId: "codex:provider-thread",
      providerThreadId: "provider-thread",
      providerId: "codex-app-server",
      boundCwd: directory,
      title: "original_agent"
    });
    new CollaborationCore(store).bindSession({
      agentId: "agent:stable-name",
      sessionId: "codex:provider-thread"
    });

    store.renameSession("logical:stable-session", "renamed_agent");

    assert.equal(store.getAgent("agent:stable-name").name, "Stable Agent");
    assert.equal(store.getLogicalSession("logical:stable-session").sessionName, "renamed_agent");
    assert.equal(store.getSession("codex:provider-thread").title, "renamed_agent");
    assert.equal(store.getLogicalSessionByName("renamed_agent").logicalSessionId, "logical:stable-session");
    assert.equal(store.getLogicalSessionByName("original_agent").logicalSessionId, "logical:stable-session");

    store.updateAgent("agent:stable-name", { name: "Renamed Agent" });
    assert.equal(store.getSession("codex:provider-thread").title, "renamed_agent");
    assert.equal(store.getLogicalSession("logical:stable-session").sessionName, "renamed_agent");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("active Provider Session ids are scoped by Provider and survive store restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-ownership-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const first = new CorptieStore({ dbPath, configPath });

  try {
    await first.initialize();
    first.createLogicalSessionRoute({
      logicalSessionId: "logical:openclacky-owned",
      legacySessionId: "openclacky:owned-native",
      providerThreadId: "owned-native",
      providerId: "openclacky",
      providerSessionId: "owned-native",
      boundCwd: directory,
      title: "Owned OpenClacky Session"
    });
    first.createLogicalSessionRoute({
      logicalSessionId: "logical:other-provider",
      legacySessionId: "other:foreign-native",
      providerThreadId: "foreign-native",
      providerId: "other-provider",
      providerSessionId: "foreign-native",
      boundCwd: directory,
      title: "Other Provider Session"
    });
    await first.close();

    const restarted = new CorptieStore({ dbPath, configPath });
    try {
      await restarted.initialize();
      assert.deepEqual(restarted.listActiveProviderSessionIds("openclacky"), ["owned-native"]);
      assert.deepEqual(restarted.listActiveProviderSessionIds("other-provider"), ["foreign-native"]);
    } finally {
      await restarted.close();
    }
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy workspace transition tables migrate to support regular directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-directory-transition-migration-"));
  const dbPath = join(directory, "corptie.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE workspace_transitions (
      transition_id TEXT PRIMARY KEY,
      logical_session_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      target_worktree_id TEXT NOT NULL,
      source_routing_version INTEGER NOT NULL,
      last_completed_turn_id TEXT,
      new_thread_id TEXT,
      phase TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT 'fork',
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy.close();
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });

  try {
    await store.initialize();
    const columns = store.selectAll("PRAGMA table_info(workspace_transitions)");
    assert.equal(columns.find((column) => column.name === "target_worktree_id")?.notnull, 0);
    assert.equal(columns.find((column) => column.name === "target_cwd")?.notnull, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("initialization refuses a corrupt database instead of replacing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-corrupt-sqlite-"));
  const dbPath = join(directory, "corptie.sqlite");
  const corruptBytes = Buffer.from("not a sqlite database");

  try {
    await writeFile(dbPath, corruptBytes);
    const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await assert.rejects(store.initialize(), /database|malformed|encrypted/i);
    assert.deepEqual(await readFile(dbPath), corruptBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Git workspace snapshots persist stable repository and worktree identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-git-registry-"));
  const dbPath = join(directory, "corptie.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
  const snapshot = {
    repository: {
      id: "repository:abc",
      commonGitDirCanonicalPath: "/repo/.git",
      discoveredAt: "2026-07-28T00:00:00.000Z",
      lastValidatedAt: "2026-07-28T00:00:00.000Z"
    },
    inventoryVersion: "inventory-v1",
    observedAt: "2026-07-28T00:00:00.000Z",
    worktrees: [{
      worktreeId: "worktree:main",
      path: "/repo",
      canonicalPath: "/repo",
      gitDirCanonicalPath: "/repo/.git",
      isMain: true,
      availability: "available",
      headOid: "abc123",
      branchRef: "refs/heads/main",
      branchName: "main",
      isDetached: false,
      isLocked: false,
      lockReason: null,
      isPrunable: false,
      pruneReason: null
    }]
  };

  try {
    await store.initialize();
    const persisted = store.upsertGitWorkspaceSnapshot(snapshot);
    assert.deepEqual(store.getGitRepository("repository:abc"), snapshot.repository);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].worktreeId, "worktree:main");
    assert.equal(persisted[0].branchName, "main");

    const nextSnapshot = {
      ...snapshot,
      inventoryVersion: "inventory-v2",
      observedAt: "2026-07-28T00:01:00.000Z",
      repository: {
        ...snapshot.repository,
        lastValidatedAt: "2026-07-28T00:01:00.000Z"
      },
      worktrees: []
    };
    const missing = store.upsertGitWorkspaceSnapshot(nextSnapshot);
    assert.equal(missing[0].availability, "missing");
    assert.equal(missing[0].inventoryVersion, "inventory-v2");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("logical session route commits switch the active thread and workspace atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-logical-session-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertGitWorkspaceSnapshot(workspaceSnapshot());
    store.upsertSession({
      id: "codex:thread-source",
      title: "Stable UI session",
      agent: "Codex",
      provider: "codex-app-server",
      cwd: "/repo/main",
      status: "complete",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z"
    });

    const created = store.createLogicalSessionRoute({
      logicalSessionId: "logical:one",
      legacySessionId: "codex:thread-source",
      providerThreadId: "thread-source",
      repositoryId: "repository:one",
      worktreeId: "worktree:main",
      boundCwd: "/repo/main",
      instructionSources: ["/repo/main/AGENTS.md"],
      permissionSnapshot: { sandbox: "workspaceWrite", writableRoots: ["/repo/main"] },
      title: "Stable UI session",
      createdAt: "2026-07-28T00:00:00.000Z"
    });
    assert.equal(created.activeThreadId, "thread-source");
    assert.equal(created.activeWorkspaceId, "worktree:main");
    assert.equal(created.routingVersion, 1);
    assert.match(created.activeBinding.bindingId, /^binding:/);
    assert.equal(created.activeBinding.providerId, "codex-app-server");
    assert.equal(created.activeBinding.providerSessionId, "thread-source");
    assert.deepEqual(created.activeBinding.providerMetadata, {});
    assert.deepEqual(
      store.getAgentSessionBindingByProviderSession("codex-app-server", "thread-source"),
      created.activeBinding
    );
    assert.equal(store.assertLogicalSessionRoute("logical:one"), true);

    store.beginWorkspaceTransition({
      transitionId: "transition:one",
      logicalSessionId: "logical:one",
      targetWorktreeId: "worktree:feature",
      sourceRoutingVersion: 1,
      lastCompletedTurnId: "turn-7",
      strategy: "fork",
      phase: "forking",
      createdAt: "2026-07-28T00:01:00.000Z"
    });
    store.updateWorkspaceTransition("transition:one", {
      phase: "validatingInstructions",
      newThreadId: "thread-feature",
      updatedAt: "2026-07-28T00:02:00.000Z"
    });
    const switched = store.commitWorkspaceTransition("transition:one", {
      providerThreadId: "thread-feature",
      boundCwd: "/repo/feature worktree",
      instructionSources: ["/repo/feature worktree/AGENTS.md"],
      permissionSnapshot: {
        sandbox: "workspaceWrite",
        writableRoots: ["/repo/feature worktree"]
      },
      createdAt: "2026-07-28T00:03:00.000Z"
    });

    assert.equal(switched.logicalSessionId, "logical:one");
    assert.equal(switched.activeThreadId, "thread-feature");
    assert.equal(switched.activeWorkspaceId, "worktree:feature");
    assert.equal(switched.routingVersion, 2);
    assert.equal(switched.transitionState, null);
    assert.equal(store.assertLogicalSessionRoute("logical:one"), true);
    assert.equal(store.getSession("codex:thread-source").external.cwd, "/repo/feature worktree");

    const bindings = store.listProviderThreadBindings("logical:one");
    assert.deepEqual(bindings.map((binding) => binding.state), ["superseded", "active"]);
    assert.notEqual(bindings[0].bindingId, bindings[1].bindingId);
    assert.equal(bindings[1].providerId, "codex-app-server");
    assert.equal(bindings[1].providerSessionId, "thread-feature");
    assert.equal(bindings[1].parentBindingId, bindings[0].bindingId);
    assert.equal(bindings[1].parentThreadId, "thread-source");
    assert.equal(bindings[1].forkedAtTurnId, "turn-7");
    assert.deepEqual(bindings[1].instructionSources, ["/repo/feature worktree/AGENTS.md"]);
    assert.deepEqual(bindings[1].permissionSnapshot.writableRoots, ["/repo/feature worktree"]);
    assert.equal(store.getWorkspaceTransition("transition:one").phase, "committed");

    const retried = store.commitWorkspaceTransition("transition:one", {
      providerThreadId: "thread-feature",
      boundCwd: "/repo/feature worktree"
    });
    assert.equal(retried.routingVersion, 2);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("logical session transitions reject stale routing versions without changing the active route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-logical-session-stale-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertGitWorkspaceSnapshot(workspaceSnapshot());
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:stale",
      providerThreadId: "thread-source",
      repositoryId: "repository:one",
      worktreeId: "worktree:main",
      boundCwd: "/repo/main"
    });

    assert.throws(
      () => store.beginWorkspaceTransition({
        transitionId: "transition:stale",
        logicalSessionId: "logical:stale",
        targetWorktreeId: "worktree:feature",
        sourceRoutingVersion: 0
      }),
      /routing version changed/
    );
    const logical = store.getLogicalSession("logical:stale");
    assert.equal(logical.activeThreadId, "thread-source");
    assert.equal(logical.activeWorkspaceId, "worktree:main");
    assert.equal(logical.routingVersion, 1);
    assert.equal(logical.transitionState, null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agent Provider binding migration backfills legacy thread identities idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-binding-migration-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const first = new CorptieStore({ dbPath, configPath });
  try {
    await first.initialize();
    first.upsertSession({
      id: "codex:legacy-thread",
      title: "Legacy Provider Binding",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    first.createLogicalSessionRoute({
      logicalSessionId: "logical:legacy-provider",
      legacySessionId: "codex:legacy-thread",
      providerThreadId: "legacy-thread",
      boundCwd: "/repo/legacy"
    });
    first.db.run(
      `UPDATE provider_thread_bindings
       SET binding_id = NULL, provider_id = NULL, provider_session_id = NULL
       WHERE provider_thread_id = 'legacy-thread'`
    );
  } finally {
    await first.close();
  }

  const second = new CorptieStore({ dbPath, configPath });
  try {
    await second.initialize();
    const migrated = second.getProviderThreadBinding("legacy-thread");
    assert.match(migrated.bindingId, /^binding:/);
    assert.equal(migrated.providerId, "codex-app-server");
    assert.equal(migrated.providerSessionId, "legacy-thread");
    assert.deepEqual(migrated.providerMetadata, {});
    const stableBindingId = migrated.bindingId;
    await second.close();

    const third = new CorptieStore({ dbPath, configPath });
    await third.initialize();
    try {
      assert.equal(third.getProviderThreadBinding("legacy-thread").bindingId, stableBindingId);
    } finally {
      await third.close();
    }
  } finally {
    if (second.db) await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stable Codex session id can route to a different active provider thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-stable-session-provider-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({
      id: "codex:stable-ui-id",
      title: "Stable UI",
      agent: "Codex",
      provider: "codex-app-server",
      cwd: "/repo/feature",
      status: "complete",
      external: {
        provider: "codex-app-server",
        threadId: "provider-thread-after-fork",
        cwd: "/repo/feature",
        logicalSessionId: "logical:stable",
        workspace: {
          id: "worktree:feature",
          repositoryId: "repository:one",
          path: "/repo/feature"
        },
        routingVersion: 3
      }
    });

    const restored = store.getSession("codex:stable-ui-id");
    assert.equal(restored.id, "codex:stable-ui-id");
    assert.equal(restored.external.threadId, "provider-thread-after-fork");
    assert.equal(restored.external.logicalSessionId, "logical:stable");
    assert.equal(restored.external.workspace.id, "worktree:feature");
    assert.equal(restored.external.routingVersion, 3);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function workspaceSnapshot() {
  return {
    repository: {
      id: "repository:one",
      commonGitDirCanonicalPath: "/repo/main/.git",
      discoveredAt: "2026-07-28T00:00:00.000Z",
      lastValidatedAt: "2026-07-28T00:00:00.000Z"
    },
    inventoryVersion: "inventory:one",
    observedAt: "2026-07-28T00:00:00.000Z",
    worktrees: [
      {
        worktreeId: "worktree:main",
        path: "/repo/main",
        canonicalPath: "/repo/main",
        gitDirCanonicalPath: "/repo/main/.git",
        isMain: true,
        availability: "available",
        headOid: "abc123",
        branchRef: "refs/heads/main",
        branchName: "main",
        isDetached: false,
        isLocked: false,
        lockReason: null,
        isPrunable: false,
        pruneReason: null
      },
      {
        worktreeId: "worktree:feature",
        path: "/repo/feature worktree",
        canonicalPath: "/repo/feature worktree",
        gitDirCanonicalPath: "/repo/main/.git/worktrees/feature",
        isMain: false,
        availability: "available",
        headOid: "def456",
        branchRef: "refs/heads/feature/workspace",
        branchName: "feature/workspace",
        isDetached: false,
        isLocked: false,
        lockReason: null,
        isPrunable: false,
        pruneReason: null
      }
    ]
  };
}
