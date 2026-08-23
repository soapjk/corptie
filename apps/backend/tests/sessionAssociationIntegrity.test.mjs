import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { persistProviderSessionProjection } from "../src/application/providerSessionProjection.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-association-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  const agent = store.createAgent({ id: "agent:worker", name: "Worker", role: "independentContributor" });
  const objective = store.createObjective({
    id: "objective:one",
    name: "Objective",
    contributorAgentIds: [agent.agentId]
  });
  const workItem = store.createWorkItem({
    id: "work_item:one",
    objectiveId: objective.id,
    title: "Work",
    mainAgentId: agent.agentId
  });
  return { directory, store, agent, objective, workItem };
}

async function cleanup(f) {
  await f.store.close();
  await rm(f.directory, { recursive: true, force: true });
}

test("Provider projection persists the complete Worker association and preserves it on refresh", async () => {
  const f = await fixture();
  try {
    const providerSession = {
      id: "provider:worker",
      title: "Work",
      status: "running",
      external: { provider: "codex-app-server", cwd: f.directory }
    };
    persistProviderSessionProjection(f.store, providerSession, {
      providerId: "codex-app-server",
      agentId: f.agent.agentId,
      sessionKind: "worker",
      objectiveId: f.objective.id,
      workItemId: f.workItem.id
    });
    persistProviderSessionProjection(f.store, { ...providerSession, status: "complete" }, {
      providerId: "codex-app-server",
      agentId: f.agent.agentId,
      sessionKind: "worker"
    });
    const stored = f.store.getSession(providerSession.id);
    assert.equal(stored.objectiveId, f.objective.id);
    assert.equal(stored.workItemId, f.workItem.id);
    assert.equal(stored.status, "complete");
    assert.deepEqual(f.store.sessionAssociationIssues(), []);
  } finally {
    await cleanup(f);
  }
});

test("business validation and SQLite guards reject orphaned or cross-Objective Worker Sessions", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.store.upsertSession({
      id: "provider:missing",
      title: "Missing",
      agent: "Worker",
      provider: "codex-app-server",
      status: "running",
      sessionKind: "worker"
    }), { code: "WORKER_SESSION_ASSOCIATION_REQUIRED" });

    const other = f.store.createObjective({ id: "objective:other", name: "Other" });
    assert.throws(() => f.store.upsertSession({
      id: "provider:mismatch",
      title: "Mismatch",
      agent: "Worker",
      provider: "codex-app-server",
      status: "running",
      sessionKind: "worker",
      objectiveId: other.id,
      workItemId: f.workItem.id
    }), { code: "SESSION_WORK_ITEM_OBJECTIVE_MISMATCH" });

    assert.throws(() => f.store.db.run(
      `INSERT INTO sessions (id,title,agent,provider,status,progress,summary,accent,created_at,updated_at,raw_json,session_kind)
       VALUES ('provider:raw','Raw','Worker','codex-app-server','running',0,'','cyan',datetime('now'),datetime('now'),'{}','worker')`
    ), /WORKER_SESSION_ASSOCIATION_REQUIRED/);
  } finally {
    await cleanup(f);
  }
});

test("historical orphan repair uses the unique start operation and records an audit trail", async () => {
  const f = await fixture();
  try {
    f.store.upsertSession({
      id: "provider:historical",
      title: "Historical",
      agent: "Worker",
      agentId: f.agent.agentId,
      provider: "codex-app-server",
      status: "running"
    });
    new CollaborationCore(f.store).bindSession({ agentId: f.agent.agentId, sessionId: "provider:historical" });
    f.store.db.run("DROP TRIGGER sessions_worker_association_insert_guard");
    f.store.db.run("DROP TRIGGER sessions_worker_association_update_guard");
    f.store.db.run("UPDATE sessions SET session_kind='worker' WHERE id='provider:historical'");
    f.store.migrate();

    f.store.createLogicalSessionRoute({
      logicalSessionId: "logical:historical",
      legacySessionId: "provider:historical",
      providerThreadId: "thread:historical",
      providerSessionId: "historical",
      providerId: "codex-app-server",
      boundCwd: f.directory,
      sessionName: "Historical"
    });
    f.store.db.run(
      `INSERT INTO work_item_start_operations (
         operation_id, work_item_id, objective_id, agent_id, provider_id,
         idempotency_key, input_fingerprint, source, status, stage, failure_stage,
         error_code, error_summary, worktree_path, session_id, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, 'codex-app-server', 'start:historical', 'fingerprint', 'test',
         'failed', 'failed', 'binding', 'WORK_ITEM_START_INVARIANT_VIOLATION',
         'incomplete graph', ?, 'provider:historical', ?, ?, ?)`,
      ["operation:historical", f.workItem.id, f.objective.id, f.agent.agentId,
        f.directory, "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:01.000Z", "2026-08-23T00:00:01.000Z"]
    );

    assert.deepEqual(
      new Set(f.store.sessionAssociationIssues().map((issue) => issue.code)),
      new Set(["worker_objective_missing", "worker_work_item_missing"])
    );
    const result = f.store.repairOrphanedWorkSessions({ repairedBy: "test", reason: "fixture repair" });
    assert.equal(result.repaired.length, 1);
    assert.deepEqual(result.unresolved, []);
    assert.deepEqual(result.remainingIssues, []);
    const stored = f.store.getSession("provider:historical");
    assert.equal(stored.objectiveId, f.objective.id);
    assert.equal(stored.workItemId, f.workItem.id);
    assert.equal(f.store.getWorkItem(f.workItem.id).current_session_id, stored.id);
    assert.equal(f.store.selectOne(
      "SELECT COUNT(*) AS count FROM session_association_repair_audit WHERE session_id=?",
      [stored.id]
    ).count, 1);
    assert.equal(f.store.selectOne(
      "SELECT status FROM work_item_start_operations WHERE operation_id='operation:historical'"
    ).status, "succeeded");
  } finally {
    await cleanup(f);
  }
});
