import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactService } from "../src/application/artifactService.mjs";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { PlatformConfirmationService } from "../src/application/platformConfirmationService.mjs";
import { platformDynamicTools, callPlatformDynamicTool } from "../src/application/platformDynamicTools.mjs";
import { PlatformOperationService } from "../src/application/platformOperationService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { resolvePlatformAdminSession } from "../src/utils/platformAssistantIdentity.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-platform-admin-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const workService = new WorkApplicationService({ store });
  const core = new CollaborationCore(store);
  const artifactService = new ArtifactService({ store, contentRoot: join(directory, "artifacts") });
  await artifactService.initialize();
  const confirmationService = new PlatformConfirmationService({ store });
  const started = [];
  const service = new PlatformOperationService({
    store, workService, artifactService, collaborationCore: core, confirmationService,
    sessionService: { listSessions: () => [], sendMessage: () => ({}) },
    listSessions: () => store.listSessions(),
    createSession: async (input) => { started.push(input); return { id: "provider:started", ...input }; }
  });
  return { directory, store, workService, core, artifactService, confirmationService, service, started };
}

function bindSession(f, { id, logicalId, agentId, kind = "assistantChat", workId = null, taskId = null }) {
  f.store.createSession({ id, title: logicalId, agentId, sessionKind: kind, workId, taskId });
  f.store.createLogicalSessionRoute({ logicalSessionId: logicalId, legacySessionId: id, providerThreadId: `thread:${id}`, providerSessionId: id, providerId: "codex-app-server", boundCwd: f.directory, sessionName: logicalId });
  f.core.bindSession({ agentId, sessionId: id });
}

test("platform admin identity requires the protected Store Agent and exact Assistant Chat Session binding", async () => {
  const f = await fixture();
  try {
    const ordinary = f.store.createAgent({ name: "Ordinary Assistant", role: "assistant" });
    bindSession(f, { id: "provider:platform", logicalId: "session:platform", agentId: "assistant" });
    bindSession(f, { id: "provider:ordinary", logicalId: "session:ordinary", agentId: ordinary.agentId });
    assert.equal(resolvePlatformAdminSession(f.store, { actorId: "assistant", sessionId: "provider:platform" }).actorSessionId, "provider:platform");
    assert.throws(() => resolvePlatformAdminSession(f.store, { actorId: "assistant", sessionId: "provider:ordinary", agentKind: "platformAssistant" }), { code: "PLATFORM_ADMIN_SESSION_REQUIRED" });
    f.store.db.run("UPDATE agents SET agent_kind='platformAssistant' WHERE agent_id=?", [ordinary.agentId]);
    assert.throws(() => resolvePlatformAdminSession(f.store, { actorId: ordinary.agentId, sessionId: "provider:ordinary" }), { code: "PLATFORM_ADMIN_SESSION_REQUIRED" });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("platform Artifact create is explicitly Work-scoped, Session-attributed, atomic, strict, and idempotent", async () => {
  const f = await fixture();
  try {
    bindSession(f, { id: "provider:platform", logicalId: "session:platform", agentId: "assistant" });
    const work = f.workService.createWork({ name: "Artifact Work" });
    const other = f.workService.createWork({ name: "Other Work" });
    const wrongTask = f.workService.createTask({ workId: other.id, title: "Wrong" });
    const input = { actorId: "assistant", sessionId: "provider:platform", tool: "corptie_platform_artifacts_manage", arguments: { action: "create", work_id: work.id, title: "Platform evidence", content: "immutable", visibility: "work_private", idempotency_key: "artifact-create-1" } };
    const created = await f.service.execute(input);
    assert.equal(created.actorSessionId, "provider:platform");
    assert.match(created.auditId, /^platform_operation:/);
    assert.equal(created.target.id, created.result.artifactId);
    assert.equal(created.result.sourceSessionId, "provider:platform");
    assert.equal(f.store.listArtifactAudit(work.id, created.result.artifactId)[0].sessionId, "provider:platform");
    const replay = await f.service.execute(input);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.result.artifactId, created.result.artifactId);
    await assert.rejects(() => f.service.execute({ ...input, arguments: { ...input.arguments, title: "Changed" } }), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(() => f.service.execute({ ...input, arguments: { ...input.arguments, idempotency_key: "bad-ref", visibility: "task_private", bound_task_id: wrongTask.id } }), { code: "ARTIFACT_CROSS_WORK_FORBIDDEN" });
    assert.equal(f.store.listArtifactsByWork(work.id).length, 1);
    await assert.rejects(() => f.service.execute({ ...input, arguments: { ...input.arguments, idempotency_key: "unknown", invented: true } }), { code: "UNKNOWN_FIELD" });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("high-impact Artifact actions consume a Session-and-digest-bound server confirmation exactly once", async () => {
  const f = await fixture();
  try {
    bindSession(f, { id: "provider:platform", logicalId: "session:platform", agentId: "assistant" });
    const work = f.workService.createWork({ name: "Confirmed Work" });
    const created = await f.service.execute({ actorId: "assistant", sessionId: "provider:platform", tool: "corptie_platform_artifacts_manage", arguments: { action: "create", work_id: work.id, title: "Status", content: "v1", idempotency_key: "create-confirmed" } });
    const arguments_ = { action: "supersede", work_id: work.id, artifact_id: created.result.artifactId };
    await assert.rejects(() => f.service.execute({ actorId: "assistant", sessionId: "provider:platform", tool: "corptie_platform_artifacts_manage", arguments: { ...arguments_, confirmed: true } }), { code: "UNKNOWN_FIELD" });
    const staged = f.confirmationService.issue({ actorId: "assistant", sessionId: "provider:platform", tool: "corptie_platform_artifacts_manage", arguments: arguments_ });
    f.confirmationService.resolve(staged.confirmationId, true);
    const superseded = await f.service.execute({ actorId: "assistant", sessionId: "provider:platform", tool: "corptie_platform_artifacts_manage", arguments: { ...arguments_, confirmation_id: staged.confirmationId } });
    assert.equal(superseded.result.status, "superseded");
    await assert.rejects(() => f.service.execute({ actorId: "assistant", sessionId: "provider:platform", tool: "corptie_platform_artifacts_manage", arguments: { ...arguments_, confirmation_id: staged.confirmationId } }), { code: "PLATFORM_CONFIRMATION_REPLAYED" });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("platform collaboration discovers exact Sessions, starts shared-lifecycle Workers, and stages only Session-to-Session tasks", async () => {
  const f = await fixture();
  try {
    const workerAgent = f.store.createAgent({ name: "Worker", role: "independentContributor" });
    const work = f.workService.createWork({ name: "Target", contributorAgentIds: [workerAgent.agentId] });
    const task = f.workService.createTask({ workId: work.id, title: "Target work", mainAgentId: workerAgent.agentId });
    bindSession(f, { id: "provider:platform", logicalId: "session:platform", agentId: "assistant" });
    bindSession(f, { id: "provider:target", logicalId: "session:target", agentId: workerAgent.agentId, kind: "worker", workId: work.id, taskId: task.id });
    const discovered = await f.service.execute({ actorId: "assistant", sessionId: "provider:platform", tool: "corptie_platform_collaboration_manage", arguments: { action: "discover_sessions", work_id: work.id } });
    assert.deepEqual(discovered.result.sessions.map((entry) => entry.sessionId), ["session:target"]);
    await f.service.execute({ actorId: "assistant", sessionId: "provider:platform", tool: "corptie_platform_collaboration_manage", arguments: { action: "start_worker", task_id: task.id, agent_id: workerAgent.agentId, resource_version: task.resource_version, provider_id: "claude-sdk", idempotency_key: "start-worker" } });
    assert.equal(f.started[0].taskId, task.id);
    const proposed = await f.service.execute({ actorId: "assistant", sessionId: "provider:platform", tool: "corptie_platform_collaboration_manage", arguments: { action: "request", session_id: "session:target", title: "Review", summary: "Review the target", type: "question", idempotency_key: "request-target" } });
    assert.equal(proposed.result.confirmation.request.initiatorSessionId, "session:platform");
    assert.equal(proposed.result.confirmation.request.recipientSessionId, "session:target");
    assert.ok(proposed.result.confirmation.request.recipientSessionId);
    assert.equal(f.store.selectAll("SELECT * FROM collaboration_requests").length, 0, "staging never creates a formal Task before user confirmation");
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Tool Host advertises platform tools only to the protected Assistant and execution rechecks Session binding", async () => {
  const f = await fixture();
  try {
    const ordinary = f.store.createAgent({ name: "Ordinary", role: "assistant" });
    bindSession(f, { id: "provider:platform", logicalId: "session:platform", agentId: "assistant" });
    bindSession(f, { id: "provider:ordinary", logicalId: "session:ordinary", agentId: ordinary.agentId });
    const catalog = new HostToolCatalog([{ id: "platform", tools: platformDynamicTools, authorize: ({ actorId }) => actorId === "assistant", execute: (input) => callPlatformDynamicTool(f.service, input) }]);
    assert.ok(catalog.definitions({ actorId: "assistant" }).some((tool) => tool.name === "corptie_platform_artifacts_manage"));
    assert.equal(catalog.definitions({ actorId: ordinary.agentId }).length, 0);
    await assert.rejects(() => catalog.execute({ actorId: ordinary.agentId, tool: "corptie_platform_collaboration_manage", metadata: { sessionId: "provider:ordinary", sessionKind: "assistantChat" }, arguments: { action: "discover_sessions" } }), { code: "SESSION_TOOL_FORBIDDEN" });
    await assert.rejects(() => catalog.execute({ actorId: "assistant", tool: "corptie_platform_collaboration_manage", metadata: { sessionId: "provider:ordinary", sessionKind: "assistantChat" }, arguments: { action: "discover_sessions" } }), { code: "PLATFORM_ADMIN_SESSION_REQUIRED" });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});
