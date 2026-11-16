import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { ArtifactService } from "../src/application/artifactService.mjs";
import { CoordinationReadService } from "../src/application/coordinationReadService.mjs";

async function fixture(t, provider = "codex-app-server") {
  const dir = await mkdtemp(join(tmpdir(), "coordination-document-"));
  const store = new CorptieStore({ dataRoot: dir, dbPath: ":memory:", configPath: join(dir, "config.json"), manageProcessEnvironment: false });
  await store.initialize({ resolveDataPath: false });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const agent = store.createAgent({ name: "Reader", provider });
  const work = store.createWork({ name: "Documents", contributorAgentIds: [agent.agentId] });
  const task = store.createTask({ workId: work.id, title: "Parent", mainAgentId: agent.agentId });
  const core = new CollaborationCore(store);
  function open(name) {
    const sessionId = `session:${name}`;
    store.createSession({ id: sessionId, agentId: agent.agentId, provider, title: name, sessionKind: "worker", workId: work.id, taskId: task.id });
    store.createLogicalSessionRoute({ logicalSessionId: `logical:${name}`, legacySessionId: sessionId,
      providerId: provider, providerThreadId: name, providerSessionId: name, boundCwd: dir, sessionName: name });
    core.bindSession({ sessionId, agentId: agent.agentId });
    const route = store.getLogicalSessionByLegacySessionId(sessionId);
    return { sessionId, logicalSessionId: route.logicalSessionId, bindingId: route.activeBinding.bindingId };
  }
  const main = open("main");
  const artifacts = new ArtifactService({ store, contentRoot: join(dir, "artifacts") });
  await artifacts.initialize({ performMaintenance: false });
  const read = new CoordinationReadService({ store, artifacts });
  const context = { sessionId: main.sessionId, logicalSessionId: main.logicalSessionId, providerBindingId: main.bindingId };
  const create = content => artifacts.create(context, { title: "Technical design", scope: "work", content, idempotencyKey: `create:${Math.random()}` });
  const body = (targetId, reference = main, options = {}) => read.execute(reference, task.id,
    { tool: "read_resource", targetType: "artifact", targetId, section: "body", cursor: options.cursor },
    { turnExecutionId: "turn:document", ...options });
  return { store, artifacts, read, main, task, work, open, context, create, body };
}

test("program reads a 77 KB UTF-8 document in pinned pages, even if a new version appears", async t => {
  const f = await fixture(t), content = "公式😀正文\n".repeat(4560), artifact = await f.create(content);
  const get = f.artifacts.get.bind(f.artifacts); let calls = 0;
  f.artifacts.get = async (...args) => {
    const page = await get(...args);
    if (++calls === 1) await f.artifacts.publishVersion({ kind: "local_user", workId: f.work.id }, artifact.artifactId, { content: "new version" });
    return page;
  };
  const result = await f.body(artifact.artifactId);
  assert.equal(result.content, content); assert.equal(result.version, 1);
  assert.equal(result.complete, true); assert.equal(result.truncated, false);
  assert.equal(calls, 2); assert.equal(result.readReceiptIds.length, 2);
  assert.equal(result.range.byteLength, Buffer.byteLength(content)); assert.equal(result.nextCursor, null);
});

test("canonical ID, missing artifact prefix, Reference and immutable link resolve without guessing", async t => {
  const f = await fixture(t), artifact = await f.create("exact body"), version = f.store.getArtifactVersion(artifact.artifactId, 1);
  const ref = f.store.listArtifactReferences({ artifactId: artifact.artifactId })[0];
  for (const target of [artifact.artifactId, artifact.artifactId.slice(9), ref.referenceId,
    `${artifact.artifactId}?version=1&hash=${version.contentHash}`]) {
    assert.equal((await f.body(target)).content, "exact body");
  }
  await assert.rejects(f.body(`${artifact.artifactId}?version=1&hash=${"0".repeat(64)}`), { code: "ARTIFACT_VERSION_HASH_MISMATCH" });
  await assert.rejects(f.body("artifact_reference:missing"), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
  await assert.rejects(f.body("worker-work:missing"), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
});

for (const provider of ["codex-app-server", "claude-sdk", "openclacky"]) {
  test(`main and authorized request/summary shadows read with their own identity (${provider})`, async t => {
    const f = await fixture(t, provider), artifact = await f.create("shared evidence");
    const request = f.open("request"), summary = f.open("summary");
    f.store.bindSessionToTask(f.main.sessionId, f.task.id, f.work.id);
    const now = new Date().toISOString();
    f.store.db.run(`INSERT INTO coordination_requests(request_id,main_session_id,parent_task_id,message_id,shadow_session_id,status,created_at,updated_at)
      VALUES ('request:test',?,?, 'message:input',?,'running',?,?)`, [f.main.logicalSessionId, f.task.id, request.logicalSessionId, now, now]);
    f.store.db.run(`INSERT INTO coordination_shadow_sessions(main_session_id,parent_task_id,shadow_session_id,state,scope_json,created_at,updated_at)
      VALUES (?,?,?,'ready','{}',?,?)`, [f.main.logicalSessionId, f.task.id, summary.logicalSessionId, now, now]);
    for (const reference of [f.main, request, summary]) {
      const result = await f.body(artifact.artifactId, reference);
      assert.equal(result.content, "shared evidence");
      const receipt = f.store.getArtifactReadReceipt(result.readReceiptIds[0]);
      assert.equal(receipt.logicalSessionId, reference.logicalSessionId);
      assert.equal(receipt.providerBindingId, reference.bindingId);
    }
    // The delegated read grant must not become Artifact write authority.
    await assert.rejects(f.artifacts.publishVersion({ sessionId: summary.sessionId, coordinationRead: true }, artifact.artifactId, { content: "forbidden" }), { code: "ARTIFACT_SESSION_BINDING_INVALID" });
    f.store.db.run("UPDATE coordination_requests SET status='completed' WHERE request_id='request:test'");
    assert.throws(() => f.body(artifact.artifactId, request), { code: "COORDINATION_READ_SCOPE_INVALID" });
    f.store.db.run("UPDATE coordination_shadow_sessions SET state='failed'");
    assert.throws(() => f.body(artifact.artifactId, summary), { code: "COORDINATION_READ_SCOPE_INVALID" });
  });
}

test("large document respects the existing read budget and resumes from an audited boundary in a new Turn", async t => {
  const f = await fixture(t), content = "正文😀".repeat(18000), artifact = await f.create(content);
  const first = await f.body(artifact.artifactId);
  assert.equal(first.complete, false); assert.equal(first.truncated, true);
  assert.equal(first.readBlocked.code, "ARTIFACT_TURN_READ_BUDGET_EXCEEDED");
  const rest = await f.body(artifact.artifactId, f.main, { cursor: first.nextCursor, turnExecutionId: "turn:next" });
  assert.equal(rest.complete, true); assert.equal(first.content + rest.content, content);
  const forged = JSON.parse(first.nextCursor); forged.offset++;
  await assert.rejects(f.body(artifact.artifactId, f.main, { cursor: JSON.stringify(forged), turnExecutionId: "turn:forged" }), { code: "ARTIFACT_RANGE_INVALID" });
});

test("revocation, stale binding, unsupported binary and cancellation produce real read errors", async t => {
  const f = await fixture(t), artifact = await f.create("protected");
  const binary = await f.artifacts.create(f.context, { title: "binary", content: "bytes", mimeType: "application/octet-stream", scope: "work", idempotencyKey: "binary" });
  await assert.rejects(f.body(binary.artifactId), { code: "ARTIFACT_TEXT_ENCODING_INVALID" });
  assert.throws(() => f.body(artifact.artifactId, { ...f.main, bindingId: "stale" }), { code: "COORDINATION_READ_SCOPE_INVALID" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.body(artifact.artifactId, f.main, { signal: controller.signal }), { name: "AbortError" });
  f.artifacts.revokeArtifact(f.context, artifact.artifactId, "test revocation");
  await assert.rejects(f.body(artifact.artifactId), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
});

test("Reference revocation between pages cannot return a fabricated complete body", async t => {
  const f = await fixture(t), artifact = await f.create("页😀".repeat(12000));
  const reference = f.store.listArtifactReferences({ artifactId: artifact.artifactId })[0];
  const get = f.artifacts.get.bind(f.artifacts); let calls = 0;
  f.artifacts.get = async (...args) => {
    const page = await get(...args);
    if (++calls === 1) f.artifacts.revokeReference(f.context, reference.referenceId, "revoked while reading");
    return page;
  };
  await assert.rejects(f.body(reference.referenceId), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
});
