import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { withSessionActions } from "../src/agent-provider/sessionActions.mjs";

function providerSession(store) {
  store.upsertSession({
    id: "codex:provider-switch",
    title: "Provider switch",
    agent: "Codex",
    provider: "codex-app-server",
    status: "complete"
  });
  store.createLogicalSessionRoute({
    logicalSessionId: "logical:provider-switch",
    legacySessionId: "codex:provider-switch",
    providerThreadId: "thread:codex-a",
    providerSessionId: "thread:codex-a",
    providerId: "codex-app-server",
    boundCwd: "/repo/main",
    title: "Provider switch"
  });
  return store.getLogicalSession("logical:provider-switch");
}

test("workspace_transitions gains transition_kind during migration without rewriting rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-kind-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const initialStore = new CorptieStore({ dbPath, configPath });
  try {
    await initialStore.initialize();
    await initialStore.close();

    const legacy = new DatabaseSync(dbPath);
    // Simulate a pre-existing database created before the transition_kind column
    // existed. SQLite lacks ALTER TABLE DROP COLUMN support before 3.35, so we
    // rebuild the table without the column, preserving its data shape.
    legacy.exec(`
      ALTER TABLE workspace_transitions RENAME TO workspace_transitions_old;
      CREATE TABLE workspace_transitions (
        transition_id TEXT PRIMARY KEY,
        logical_session_id TEXT NOT NULL,
        source_thread_id TEXT NOT NULL,
        target_worktree_id TEXT,
        target_cwd TEXT NOT NULL,
        source_routing_version INTEGER NOT NULL,
        last_completed_turn_id TEXT,
        resume_goal_after_transition INTEGER NOT NULL DEFAULT 0,
        continuation_prompt TEXT,
        continuation_state TEXT NOT NULL DEFAULT 'none',
        phase TEXT NOT NULL,
        strategy TEXT NOT NULL DEFAULT 'fork',
        new_thread_id TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO workspace_transitions SELECT
        transition_id, logical_session_id, source_thread_id, target_worktree_id,
        target_cwd, source_routing_version, last_completed_turn_id,
        resume_goal_after_transition, continuation_prompt, continuation_state,
        phase, strategy, new_thread_id, error_json, created_at, updated_at
      FROM workspace_transitions_old;
      DROP TABLE workspace_transitions_old;
    `);
    legacy.close();

    const migrated = new CorptieStore({ dbPath, configPath });
    await migrated.initialize();
    const migratedColumns = migrated.selectAll("PRAGMA table_info(workspace_transitions)");
    assert.equal(migratedColumns.some((c) => c.name === "transition_kind"), true);
    await migrated.close();
  } finally {
    await initialStore.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider switch forks the binding, preserves workspace identity, and bumps routing_version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const before = providerSession(store);
    assert.equal(before.activeBinding.providerId, "codex-app-server");
    assert.equal(before.routingVersion, 1);

    store.beginWorkspaceTransition({
      transitionId: "transition:provider-switch",
      logicalSessionId: "logical:provider-switch",
      transitionKind: "provider",
      targetCwd: "/repo/main",
      sourceRoutingVersion: before.routingVersion,
      phase: "waitingForTurn",
      strategy: "fork"
    });

    const pending = store.getPendingWorkspaceTransition("logical:provider-switch");
    assert.equal(pending.transitionKind, "provider");
    assert.equal(pending.phase, "waitingForTurn");

    store.commitWorkspaceTransition("transition:provider-switch", {
      providerThreadId: "thread:claude-b",
      providerSessionId: "thread:claude-b",
      providerId: "claude-sdk",
      boundCwd: "/repo/main",
      instructionSources: [
        { kind: "sessionTitle", title: "Provider switch" },
        { kind: "instructionSummary", summary: "continue the work" }
      ]
    });

    const after = store.getLogicalSession("logical:provider-switch");
    assert.equal(after.activeBinding.providerId, "claude-sdk");
    assert.equal(after.activeThreadId, "thread:claude-b");
    assert.equal(after.routingVersion, 2);
    // Workspace identity is preserved across a Provider switch (no worktree move).
    assert.equal(after.activeWorkspaceId, before.activeWorkspaceId);
    assert.equal(after.repositoryId, before.repositoryId);

    const bindings = store.listProviderThreadBindings("logical:provider-switch");
    const source = bindings.find((b) => b.providerThreadId === "thread:codex-a");
    const target = bindings.find((b) => b.providerThreadId === "thread:claude-b");
    assert.equal(source.state, "superseded");
    assert.equal(target.state, "active");
    assert.equal(target.routingVersion, 2);
    assert.equal(target.parentThreadId, "thread:codex-a");
    assert.equal(target.worktreeId, before.activeBinding.worktreeId);

    // Message ownership: the active binding now routes to the new Provider.
    assert.equal(store.getLogicalSessionByProviderSessionId("claude-sdk", "thread:claude-b").logicalSessionId, "logical:provider-switch");
    assert.equal(store.getLogicalSessionByProviderSessionId("codex-app-server", "thread:codex-a"), null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("beginWorkspaceTransition rejects a concurrent unfinished provider transition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-mutex-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const before = providerSession(store);
    store.beginWorkspaceTransition({
      transitionId: "transition:first",
      logicalSessionId: "logical:provider-switch",
      transitionKind: "provider",
      sourceRoutingVersion: before.routingVersion,
      phase: "waitingForTurn"
    });
    assert.throws(
      () => store.beginWorkspaceTransition({
        transitionId: "transition:second",
        logicalSessionId: "logical:provider-switch",
        transitionKind: "provider",
        sourceRoutingVersion: before.routingVersion,
        phase: "waitingForTurn"
      }),
      /already has transition/
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("switchProvider action is unavailable while a provider switch is in flight", () => {
  const session = {
    id: "codex:provider-switch",
    external: { provider: "codex-app-server", providerSwitchInFlight: true }
  };
  const actions = withSessionActions(session, { id: "codex-app-server" }).actions;
  assert.equal(actions.switchProvider.available, false);
  assert.equal(actions.switchProvider.reason, "PROVIDER_SWITCH_IN_FLIGHT");

  const idle = withSessionActions(
    { id: "codex:provider-switch", external: { provider: "codex-app-server" } },
    { id: "codex-app-server" }
  ).actions;
  assert.equal(idle.switchProvider.available, true);
});
