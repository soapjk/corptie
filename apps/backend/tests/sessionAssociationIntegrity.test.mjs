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
  const work = store.createWork({
    id: "work:one",
    name: "Work",
    contributorAgentIds: [agent.agentId]
  });
  const task = store.createTask({
    id: "task:one",
    workId: work.id,
    title: "Work",
    mainAgentId: agent.agentId
  });
  return { directory, store, agent, work, task };
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
      workId: f.work.id,
      taskId: f.task.id
    });
    persistProviderSessionProjection(f.store, { ...providerSession, status: "complete" }, {
      providerId: "codex-app-server",
      agentId: f.agent.agentId,
      sessionKind: "worker"
    });
    const stored = f.store.getSession(providerSession.id);
    assert.equal(stored.workId, f.work.id);
    assert.equal(stored.taskId, f.task.id);
    assert.equal(stored.status, "complete");
    assert.deepEqual(f.store.sessionAssociationIssues(), []);
  } finally {
    await cleanup(f);
  }
});

test("business validation and SQLite guards reject orphaned or cross-Work Worker Sessions", async () => {
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

    const other = f.store.createWork({
      id: "work:other", name: "Other", contributorAgentIds: [f.agent.agentId]
    });
    assert.throws(() => f.store.upsertSession({
      id: "provider:mismatch",
      title: "Mismatch",
      agent: "Worker",
      provider: "codex-app-server",
      status: "running",
      sessionKind: "worker",
      workId: other.id,
      taskId: f.task.id
    }), { code: "SESSION_TASK_WORK_MISMATCH" });

    assert.throws(() => f.store.db.run(
      `INSERT INTO sessions (id,title,agent,provider,status,progress,summary,accent,created_at,updated_at,raw_json,session_kind)
       VALUES ('provider:raw','Raw','Worker','codex-app-server','running',0,'','cyan',datetime('now'),datetime('now'),'{}','worker')`
    ), /WORKER_SESSION_ASSOCIATION_REQUIRED/);
  } finally {
    await cleanup(f);
  }
});
