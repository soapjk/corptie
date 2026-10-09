import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";
import { ClientInspectorAPI } from "../src/application/clientInspectorAPI.mjs";

const identity = { deviceId: "test-device" };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "corptie-inspector-"));
  const store = new CorptieStore({ dbPath: join(dir, "db.sqlite"), configPath: join(dir, "config.json") });
  await store.initialize();
  store.createAgent({ id: "agent:test", name: "Test" });
  store.createWork({ id: "work:test", name: "Test", contributorAgentIds: ["agent:test"] });
  store.createSession({ id: "s", workId: "work:test", title: "Test" });
  const calls = [];
  const inspector = new ClientInspectorAPI({ store, resolveSession: sessionId => ({ sessionId, logicalSessionId: sessionId }),
    references: { list: () => [], create: async (id, fields) => { calls.push([id, fields]); return { id: "ref" }; } },
    artifacts: { list: () => [], get: async (...args) => args },
    schedules: { list: () => [] }, providers: () => [], observability: { latestSummary: () => null, summary: () => null } });
  const api = new ClientSessionAPI({ store, inspector });
  return { store, inspector, api, calls, close: async () => { await store.close(); await rm(dir, { recursive: true, force: true }); } };
}
test("section failures are not projected as empty successful results", async () => {
  const f = await fixture();
  try {
    f.inspector.references.list = () => { throw Object.assign(new Error(), { code: "REFERENCE_FAILED" }); };
    const snapshot = await f.inspector.snapshot(identity, "s");
    assert.equal(snapshot.errors.references, "REFERENCE_FAILED");
    assert.equal(Object.hasOwn(snapshot.sections, "references"), false);
    assert.deepEqual(snapshot.sections.providers, []);
    await assert.rejects(() => f.inspector.snapshot(identity, "missing"), { code: "SESSION_NOT_FOUND" });
  } finally { await f.close(); }
});
test("paired-device Detail reads active schedules with the scheduler actor and reports denied reads", async () => {
  const f = await fixture();
  try {
    f.inspector.schedules.list = (options, actor) => {
      assert.deepEqual(options, { logicalSessionId: "s", status: "active" });
      assert.deepEqual(actor, { type: "user", id: "user:paired-device:test-device" });
      return [{ taskId: "scheduled:one", status: "active", name: "Next check" }];
    };
    const active = await f.inspector.snapshot(identity, "s");
    assert.equal(active.sections.schedules[0].taskId, "scheduled:one");
    assert.equal(f.inspector.scope("s", identity).actor.id, "client-device:test-device");
    f.inspector.schedules.list = () => { throw Object.assign(new Error("denied"), { code: "AUTHORIZATION_REVOKED" }); };
    const denied = await f.inspector.snapshot(identity, "s");
    assert.equal(denied.errors.schedules, "AUTHORIZATION_REVOKED");
    assert.equal(Object.hasOwn(denied.sections, "schedules"), false);
  } finally { await f.close(); }
});
test("task Detail snapshot carries the same definition fields as desktop", async () => {
  const f = await fixture();
  try {
    const task = f.store.createTask({ workId: "work:test", title: "Task", description: "Scope",
      acceptanceCriteria: "Accepted", verificationCriteria: "Verified", mainAgentId: "agent:test" });
    f.store.createSession({ id: "s:task", title: "Worker", workId: "work:test", taskId: task.id, agentId: "agent:test" });
    const snapshot = await f.inspector.snapshot(identity, "s:task");
    assert.equal(snapshot.taskId, task.id);
    assert.equal(snapshot.taskDefinition.description, "Scope");
    assert.equal(snapshot.taskDefinition.acceptanceCriteria, "Accepted");
    assert.equal(snapshot.taskDefinition.verificationCriteria, "Verified");
    assert.equal(snapshot.taskDefinition.revision, task.revision);
    const workSnapshot = await f.inspector.snapshot(identity, "s");
    assert.equal(workSnapshot.sections.focusTasks[0].id, task.id);
    assert.equal(workSnapshot.sections.focusTasks[0].taskRevision, task.revision);
  } finally { await f.close(); }
});
test("mobile Detail recall snapshot includes the selected memory content", async () => {
  const f = await fixture();
  try {
    const memory = f.store.createMemory({ ownerType: "work", ownerId: "work:test", kind: "fact",
      content: "Original recall context", sourceType: "user", trustLevel: "trusted", promotionStatus: "active" });
    f.store.createMemoryRecallAudit({ sessionId: "s", phase: "turn", mode: "lightweight",
      reason: "routine_context", candidateIds: [memory.id], selectedIds: [memory.id],
      diagnostics: { selectedEntries: [{ id: memory.id, kind: "fact", content: "Original recall context",
        ownerType: "work", ownerId: "work:test", snapshotAtRecall: true }] } });
    f.store.updateMemory(memory.id, { content: "Changed later" });
    const snapshot = await f.inspector.snapshot(identity, "s");
    assert.equal(snapshot.sections.recalls[0].selectedEntries[0].content, "Original recall context");
    assert.equal(snapshot.sections.recalls[0].selectedEntries[0].snapshotAtRecall, true);
  } finally { await f.close(); }
});
test("commands share durable receipts, reject field injection and never replay side effects", async () => {
  const f = await fixture();
  try {
    const input = { requestId: "reference-create-123", action: "reference.create", fields: { targetType: "work", targetId: "work:test" } };
    const result = await f.inspector.command(f.api, identity, "s", input);
    assert.equal(result.status, "completed"); assert.equal(result.kind, "inspector:reference.create");
    await f.inspector.command(f.api, identity, "s", input); assert.equal(f.calls.length, 1);
    await assert.rejects(async () => f.inspector.command(f.api, identity, "s", { ...input, fields: { ...input.fields, targetId: "elsewhere" } }), { code: "IDEMPOTENCY_CONFLICT" });
    assert.throws(() => f.inspector.command(f.api, identity, "s", { ...input, fields: { actorId: "session:other" } }), { code: "INVALID_INSPECTOR_COMMAND" });
    f.inspector.references.create = async () => { f.calls.push("uncertain"); throw new Error("lost response"); };
    const unknown = { ...input, requestId: "reference-unknown-123" };
    assert.equal((await f.inspector.command(f.api, identity, "s", unknown)).status, "unknown");
    await f.inspector.command(f.api, identity, "s", unknown); assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});
test("reads validate ownership and keep one immutable per-document paging identity", async () => {
  const f = await fixture();
  try {
    f.store.getArtifact = id => ({ artifactId: id, workId: id === "own" ? "work:test" : "other" });
    await assert.rejects(() => f.inspector.read(identity, "s", "artifact", { id: "outside" }), { code: "ARTIFACT_NOT_FOUND" });
    await assert.rejects(() => f.inspector.read(identity, "s", "artifact", { id: "own" }), { code: "INVALID_READ_ID" });
    const args = await f.inspector.read(identity, "s", "artifact", { id: "own", readId: "document-12345", version: 3, contentHash: "abc", offset: 10 });
    assert.equal(args[2].turnExecutionId, "device-inspector:test-device:document-12345");
    assert.equal(args[2].version, 3); assert.equal(args[2].offset, 10);
    await assert.rejects(() => f.inspector.read(identity, "s", "trace", { id: "outside" }), { code: "TURN_NOT_CURRENT" });
    await assert.rejects(() => f.inspector.read(identity, "s", "url", { url: "http://localhost/private" }), { code: "ROUTE_NOT_AVAILABLE" });
  } finally { await f.close(); }
});

test("header read exposes only authorized presentation metadata", async () => {
  const f = await fixture();
  try {
    const task = f.store.createTask({ workId: "work:test", title: "Header task", mainAgentId: "agent:test" });
    f.store.createSession({ id: "s:header", workId: "work:test", taskId: task.id, title: "Header",
      provider: "claude-sdk", cwd: "/project/fallback",
      raw: { secret: "private", workspace: { path: "/project/active", branchName: "feature/ui",
        continuationState: "failed", transitionStrategy: "handoff" } } });
    assert.deepEqual(await f.inspector.read(identity, "s:header", "header"), {
      schemaVersion: 1,
      provider: "claude-sdk", cwd: "/project/active", branchName: "feature/ui",
      continuationState: "failed", transitionStrategy: "handoff"
    });
    await assert.rejects(() => f.inspector.read(identity, "missing", "header"), { code: "SESSION_NOT_FOUND" });
  } finally { await f.close(); }
});

test("memory operations use shared user provenance, version checks and audited rollback", async () => {
  const f = await fixture();
  try {
    const scope = f.inspector.scope("s", identity);
    const memory = await f.inspector.perform(scope, "memory.create", { kind: "fact", content: "Original", tags: "one,two" });
    assert.equal(memory.sourceType, "user"); assert.equal(memory.trustLevel, "trusted");
    const updated = await f.inspector.perform(scope, "memory.update", { id: memory.id, expectedVersion: memory.version, content: "Changed", tags: [] });
    await assert.rejects(() => f.inspector.perform(scope, "memory.update", { id: memory.id, expectedVersion: memory.version, content: "Stale" }), { code: "MEMORY_VERSION_CHANGED" });
    const audit = f.store.listMemoryAudit({ memoryId: memory.id }).find(item => item.action === "update");
    const restored = await f.inspector.perform(scope, "memory.rollback", { id: memory.id, auditId: audit.id, confirmed: true, expectedVersion: updated.version });
    assert.equal(restored.content, "Original"); assert.equal(restored.version, updated.version + 1);
    assert.ok(f.store.listMemoryAudit({ memoryId: memory.id }).some(item => item.action === "rollback"));
    const other = f.store.createMemory({ ownerType: "agent", ownerId: "agent:test", content: "Private", kind: "fact" });
    await assert.rejects(() => f.inspector.read(identity, "s", "memory-audit", { id: other.id }), { code: "MEMORY_NOT_FOUND" });
  } finally { await f.close(); }
});
