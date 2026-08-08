import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { PtyAgentManager } from "../src/adapters/ptyAgentManager.mjs";

test("PTY creation persists its Session before the first lifecycle item", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-pty-session-order-"));
  const dbPath = join(directory, "corptie.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });

  try {
    await store.initialize();
    const manager = new PtyAgentManager({ store });
    const session = manager.start({
      title: "PTY persistence ordering",
      command: "/usr/bin/true",
      cwd: directory
    });
    const nativeId = session.external.sessionId;
    assert.equal(store.getSession(nativeId)?.title, "PTY persistence ordering");
    assert.equal(store.getDetail(nativeId).items[0]?.type, "system");
    manager.delete(nativeId);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
