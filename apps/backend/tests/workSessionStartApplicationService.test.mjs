import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkSessionStartApplicationService } from "../src/application/workSessionStartApplicationService.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";

const REQUIRED = new Set([
  AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
  AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND,
  AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND
]);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-start-application-"));
  const store = new CorptieStore({
    dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json")
  });
  await store.initialize();
  const workService = new WorkApplicationService({ store });
  const worker = store.createAgent({
    id: "agent:worker", name: "Worker", role: "independentContributor"
  });
  const now = new Date().toISOString();
  store.createWorkspace({ workspaceId: "workspace:one", kind: "linkedLocal", ownership: "userManaged", rootPath: directory });
  store.db.run(
    "INSERT INTO git_repositories (repository_id, workspace_id, common_git_dir, discovered_at, last_validated_at) VALUES (?, ?, ?, ?, ?)",
    ["repository:one", "workspace:one", join(directory, ".git"), now, now]
  );
  const work = workService.createWork({
    id: "work:one", name: "One", contributorAgentIds: [worker.agentId],
    workspaceId: "workspace:one"
  });
  const task = workService.createTask({
    id: "task:one", workId: work.id, title: "Task"
  });
  store.createSession({
    id: "provider:source", title: "Source", provider: "codex-app-server",
    agentId: worker.agentId, sessionKind: "workChat", workId: work.id, cwd: directory
  });
  store.createLogicalSessionRoute({
    logicalSessionId: "session:source", legacySessionId: "provider:source",
    providerThreadId: "thread:source", providerSessionId: "provider:source",
    providerId: "codex-app-server", boundCwd: directory, sessionName: "Source"
  });
  const calls = [];
  const coordinator = {
    async start(command) { calls.push(command); return { status: "ready" }; },
  };
  const providerRegistry = { supports: (_providerId, capability) => REQUIRED.has(capability) };
  const service = new WorkSessionStartApplicationService({
    store, coordinator, providerRegistry, resolveProviderId: (value) => value
  });
  return { directory, store, workService, work, task, worker, service, calls };
}

function command(patch = {}) {
  return {
    taskId: "task:one",
    assigneeAgentId: "agent:worker",
    expectedTaskVersion: 1,
    providerId: "codex-app-server",
    idempotencyKey: "start:one",
    sourceSessionId: "session:source",
    ...patch
  };
}

async function cleanup(f) {
  await f.store.close();
  await rm(f.directory, { recursive: true, force: true });
}

test("strict WorkSessionStartCommand reaches the coordinator without aliases or resource objects", async () => {
  const f = await fixture();
  try {
    await f.service.start(command());
    assert.deepEqual(f.calls, [command()]);
    assert.equal(Object.hasOwn(f.calls[0], "agentId"), false);
    assert.equal(Object.hasOwn(f.calls[0], "requestedAgentId"), false);
    assert.equal(Object.hasOwn(f.calls[0], "agent"), false);
  } finally { await cleanup(f); }
});

test("missing assignee and unknown legacy fields fail before coordinator allocation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.service.start(command({ assigneeAgentId: undefined })), {
      code: "START_ASSIGNEE_REQUIRED"
    });
    await assert.rejects(() => f.service.start({ ...command(), requestedAgentId: "agent:worker" }), {
      code: "UNKNOWN_START_FIELD"
    });
    assert.equal(f.calls.length, 0);
  } finally { await cleanup(f); }
});

test("Task version conflict and Work authorization failures create no startup operation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.service.start(command({ expectedTaskVersion: 2 })), {
      code: "TASK_VERSION_CONFLICT"
    });
    const other = f.workService.createWork({
      id: "work:other", name: "Other", contributorAgentIds: [f.worker.agentId]
    });
    f.store.db.run("UPDATE sessions SET work_id=? WHERE id=?", [other.id, "provider:source"]);
    await assert.rejects(() => f.service.start(command()), { code: "TASK_OUTSIDE_WORK" });
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM work_session_startup_operations").count, 0);
  } finally { await cleanup(f); }
});

test("non-contributor and non-Independent Contributor assignees are rejected explicitly", async () => {
  const f = await fixture();
  try {
    const outside = f.store.createAgent({
      id: "agent:outside", name: "Outside", role: "independentContributor"
    });
    await assert.rejects(() => f.service.start(command({ assigneeAgentId: outside.agentId })), {
      code: "AGENT_OUTSIDE_WORK"
    });
    const assistant = f.store.createAgent({ id: "agent:assistant", name: "Assistant", role: "assistant" });
    // Simulate a legacy/corrupt contributor reference so startup still fails
    // closed even if an invalid role escaped the ordinary Work writer.
    f.store.db.run(
      "INSERT INTO work_contributors (work_id, agent_id, role, is_primary, created_at) VALUES (?, ?, 'contributor', 0, ?)",
      [f.work.id, assistant.agentId, new Date().toISOString()]
    );
    await assert.rejects(() => f.service.start(command({ assigneeAgentId: assistant.agentId })), {
      code: "AGENT_NOT_INDEPENDENT_CONTRIBUTOR"
    });
  } finally { await cleanup(f); }
});

test("Provider capability absence is a stable provider-neutral business error", async () => {
  const f = await fixture();
  try {
    f.service.providerRegistry.supports = (_providerId, capability) => (
      capability !== AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND
    );
    await assert.rejects(() => f.service.start(command()), {
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      stage: "provider_validation"
    });
  } finally { await cleanup(f); }
});
