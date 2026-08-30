import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";

import { ArtifactService, readVerifiedArtifactPage } from "../src/application/artifactService.mjs";
import { ArtifactReadCoordinator } from "../src/application/artifactReadCoordinator.mjs";
import { artifactDynamicTools, callArtifactDynamicTool } from "../src/application/artifactDynamicTools.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-artifacts-"));
  const store = new CorptieStore({ dbPath: join(directory, "data", "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const core = new CollaborationCore(store);
  const manager = store.createAgent({ name: "Manager", provider: "codex-app-server" });
  const worker = store.createAgent({ name: "Worker", provider: "claude-sdk" });
  const outsider = store.createAgent({ name: "Outsider", provider: "openclacky" });
  store.createObjective({ id: "objective:one", name: "One", contributorAgentIds: [manager.agentId, worker.agentId] });
  store.createObjective({ id: "objective:two", name: "Two", contributorAgentIds: [outsider.agentId] });
  store.createWorkItem({ id: "work_item:one", objectiveId: "objective:one", title: "One", mainAgentId: worker.agentId });
  store.createWorkItem({ id: "work_item:two", objectiveId: "objective:two", title: "Two", mainAgentId: outsider.agentId });
  store.upsertSession({ id: "session:manager", title: "Manager", provider: "codex-app-server", status: "running", sessionKind: "objectiveChat", agentId: manager.agentId, objectiveId: "objective:one" });
  store.upsertSession({ id: "session:worker", title: "Worker", provider: "claude-sdk", status: "running", sessionKind: "worker", agentId: worker.agentId, objectiveId: "objective:one", workItemId: "work_item:one" });
  store.upsertSession({ id: "session:outsider", title: "Outsider", provider: "openclacky", status: "running", sessionKind: "worker", agentId: outsider.agentId, objectiveId: "objective:two", workItemId: "work_item:two" });
  store.bindSessionToObjective("session:manager", "objective:one");
  store.bindSessionToWorkItem("session:worker", "work_item:one", "objective:one");
  store.bindSessionToWorkItem("session:outsider", "work_item:two", "objective:two");
  core.bindSession({ agentId: manager.agentId, sessionId: "session:manager" });
  core.bindSession({ agentId: worker.agentId, sessionId: "session:worker" });
  core.bindSession({ agentId: outsider.agentId, sessionId: "session:outsider" });
  let id = 0;
  const service = new ArtifactService({ store, contentRoot: join(directory, "data", "artifacts"), idFactory: () => `id-${++id}`, clock: () => "2026-08-23T12:00:00.000Z" });
  await service.initialize();
  return { directory, store, service, core, manager, worker, outsider };
}

const managerContext = (f) => ({ actorId: f.manager.agentId, sessionId: "session:manager", objectiveId: "objective:one" });
const workerContext = (f) => ({ actorId: f.worker.agentId, sessionId: "session:worker", objectiveId: "objective:one", workItemId: "work_item:one" });
const outsiderContext = (f) => ({ actorId: f.outsider.agentId, sessionId: "session:outsider", objectiveId: "objective:two", workItemId: "work_item:two" });
let artifactReadTurn = 0;
function pinnedReadOptions(artifact, reference = null, options = {}) {
  const selectedReference = reference ?? artifact.references?.find((candidate) => !candidate.revokedAt);
  const version = artifact.versions.find((candidate) => candidate.version === (selectedReference?.pinnedVersion ?? 1));
  return {
    version: version.version,
    contentHash: selectedReference?.pinnedHash ?? version.contentHash,
    referenceId: options.referenceId ?? selectedReference?.referenceId,
    turnExecutionId: options.turnExecutionId ?? `test-turn:${++artifactReadTurn}`,
    ...options
  };
}

test("Objective private content is hashed, atomically stored outside repositories, paged, and usage-audited", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), { title: "Implementation", summary: "Private design", visibility: "objective_private", content: "secret specification" });
    assert.equal(artifact.currentVersion, 1);
    assert.equal(artifact.versions[0].contentHash.length, 64);
    assert.match(artifact.versions[0].storageKey, /^objects\//);
    const stored = await readFile(join(f.directory, "data", "artifacts", artifact.versions[0].storageKey), "utf8");
    assert.equal(stored, "secret specification");
    const reference = f.service.createReference(managerContext(f), artifact.artifactId, {
      sessionId: "session:manager", relation: "implementation_spec"
    });
    const page = await f.service.get(managerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, {
      referenceId: reference.referenceId, limit: 6
    }));
    assert.equal(page.content, "secret");
    assert.equal(page.range.nextOffset, 6);
    assert.equal(f.store.selectOne("SELECT operation, content_hash FROM artifact_usage_events").content_hash, artifact.versions[0].contentHash);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("local file lookup reuses the stored Artifact object without reading or materializing another file", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), {
      title: "Implementation Notes",
      visibility: "objective_private",
      content: "# Existing content",
      mimeType: "text/markdown"
    });
    await assert.rejects(
      () => f.service.localFile(managerContext(f), artifact.artifactId, {
        version: 1, contentHash: artifact.versions[0].contentHash
      }),
      { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" }
    );
    const reference = f.service.createReference(managerContext(f), artifact.artifactId, {
      workItemId: "work_item:one", relation: "implementation_spec", versionPolicy: "fixed", version: 1
    });
    const localOptions = {
      version: 1, contentHash: artifact.versions[0].contentHash, referenceId: reference.referenceId
    };
    const objectsDirectory = join(f.directory, "data", "artifacts", "objects", artifact.versions[0].contentHash.slice(0, 2));
    const before = await readdir(objectsDirectory);

    const receipt = await f.service.localFile(managerContext(f), artifact.artifactId, localOptions);
    const after = await readdir(objectsDirectory);

    assert.equal(receipt.path, join(f.directory, "data", "artifacts", artifact.versions[0].storageKey));
    assert.equal(receipt.suggestedFilename, "Implementation Notes.md");
    assert.equal(receipt.mimeType, "text/markdown");
    assert.deepEqual(after, before);

    await chmod(receipt.path, 0o000);
    await assert.rejects(
      () => f.service.localFile(managerContext(f), artifact.artifactId, localOptions),
      { code: "ARTIFACT_LOCAL_FILE_PERMISSION_DENIED" }
    );
    await chmod(receipt.path, 0o600);
    await unlink(receipt.path);
    await assert.rejects(
      () => f.service.localFile(managerContext(f), artifact.artifactId, localOptions),
      { code: "ARTIFACT_LOCAL_FILE_NOT_FOUND" }
    );

    const trackedDirectory = await f.service.create(managerContext(f), {
      title: "Invalid tracked path",
      visibility: "repository_tracked",
      repositoryLocator: f.directory,
      confirmedRepositoryTracked: true
    });
    const trackedReference = f.service.createReference(managerContext(f), trackedDirectory.artifactId, {
      workItemId: "work_item:one", relation: "implementation_spec", versionPolicy: "fixed", version: 1
    });
    await assert.rejects(
      () => f.service.localFile(managerContext(f), trackedDirectory.artifactId, {
        version: 1,
        contentHash: trackedDirectory.versions[0].contentHash,
        referenceId: trackedReference.referenceId
      }),
      { code: "ARTIFACT_LOCAL_FILE_NOT_FILE" }
    );
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Worker permissions require an explicit same-Objective reference and reject cross-Objective access and writes", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), { title: "Security", visibility: "objective_private", content: "security requirement" });
    await assert.rejects(() => f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact)), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
    assert.throws(() => f.service.createReference(managerContext(f), artifact.artifactId, { workItemId: "work_item:two", relation: "security_requirement" }), { code: "ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN" });
    const securityReference = f.service.createReference(managerContext(f), artifact.artifactId, { workItemId: "work_item:one", relation: "security_requirement", required: true, versionPolicy: "fixed" });
    assert.equal((await f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, securityReference))).content, "security requirement");
    const unrelated = await f.service.create(managerContext(f), { title: "Unrelated", visibility: "objective_private", content: "other" });
    const unrelatedReference = f.service.createReference(managerContext(f), unrelated.artifactId, { workItemId: "work_item:one", relation: "research_evidence" });
    await assert.rejects(() => f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, securityReference, {
      referenceId: unrelatedReference.referenceId
    })), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN", statusCode: 404 });

    const workItemPrivate = await f.service.create(managerContext(f), {
      title: "WorkItem private", visibility: "work_item_private", boundWorkItemId: "work_item:one", content: "work item only"
    });
    await assert.rejects(() => f.service.get(workerContext(f), workItemPrivate.artifactId, pinnedReadOptions(workItemPrivate)), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
    const workItemReference = f.service.createReference(managerContext(f), workItemPrivate.artifactId, { workItemId: "work_item:one", relation: "implementation_spec" });
    assert.equal((await f.service.get(workerContext(f), workItemPrivate.artifactId, pinnedReadOptions(workItemPrivate, workItemReference))).content, "work item only");

    const sessionPrivate = await f.service.create(managerContext(f), {
      title: "Session private", visibility: "session_private", boundSessionId: "session:manager", content: "manager only"
    });
    await assert.rejects(() => f.service.get(workerContext(f), sessionPrivate.artifactId, pinnedReadOptions(sessionPrivate)), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
    const sessionReference = f.service.createReference(managerContext(f), sessionPrivate.artifactId, { sessionId: "session:worker", relation: "research_evidence" });
    assert.equal((await f.service.get(workerContext(f), sessionPrivate.artifactId, pinnedReadOptions(sessionPrivate, sessionReference))).content, "manager only");

    const repositoryTracked = await f.service.create(managerContext(f), {
      title: "Tracked", visibility: "repository_tracked", repositoryLocator: "docs/tracked.md", confirmedRepositoryTracked: true
    });
    const trackedReference = f.service.createReference(managerContext(f), repositoryTracked.artifactId, { workItemId: "work_item:one", relation: "research_evidence" });
    assert.equal((await f.service.get(workerContext(f), repositoryTracked.artifactId, pinnedReadOptions(repositoryTracked, trackedReference))).content, null);

    assert.throws(() => f.service.changeVisibility(managerContext(f), artifact.artifactId, "work_item_private", { confirmed: true }), { code: "ARTIFACT_WORK_ITEM_REQUIRED" });
    assert.throws(() => f.service.changeVisibility(managerContext(f), artifact.artifactId, "repository_tracked", { confirmed: true }), { code: "ARTIFACT_VISIBILITY_TRANSITION_FORBIDDEN" });
    await assert.rejects(() => f.service.get(outsiderContext(f), artifact.artifactId, pinnedReadOptions(artifact)), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
    await assert.rejects(() => f.service.create(workerContext(f), {
      title: "escape", visibility: "objective_private", content: "no", idempotencyKey: "escape"
    }), { code: "ARTIFACT_WORKER_SCOPE_FORBIDDEN" });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Worker creates one current-WorkItem Artifact and explicit pinned Reference atomically with Session as actor", async () => {
  const f = await fixture();
  try {
    const created = await callArtifactDynamicTool(f.service, {
      tool: "corptie_artifact_create",
      actorId: f.worker.agentId,
      metadata: {
        sessionId: "session:worker", objectiveId: "objective:one",
        workItemId: "work_item:one", sessionKind: "worker"
      },
      arguments: {
        title: "Worker evidence", summary: "Completed verification", content: "evidence body",
        idempotency_key: "worker-evidence-1"
      }
    });
    assert.equal(created.visibility, "work_item_private");
    assert.equal(created.boundWorkItemId, "work_item:one");
    assert.equal(created.boundSessionId, null);
    assert.equal(created.sourceSessionId, "session:worker");
    assert.equal(created.createdByActorId, "session:worker");
    assert.equal(created.currentVersion, 1);
    assert.equal(created.idempotentReplay, false);
    assert.equal(created.references.length, 1);
    const reference = created.references[0];
    assert.equal(reference.objectiveId, "objective:one");
    assert.equal(reference.workItemId, "work_item:one");
    assert.equal(reference.sessionId, null);
    assert.equal(reference.relation, "acceptance_evidence");
    assert.equal(reference.required, false);
    assert.equal(reference.versionPolicy, "fixed");
    assert.equal(reference.pinnedVersion, 1);
    assert.equal(reference.pinnedHash, created.versions[0].contentHash);
    assert.equal(reference.authorizedByActorId, "session:worker");
    assert.deepEqual(
      new Set(f.store.listArtifactAudit("objective:one", created.artifactId).map((event) => event.action)),
      new Set(["artifact.created", "artifact.reference_created", "artifact.worker_created_and_referenced"])
    );
    assert.ok(f.store.listArtifactAudit("objective:one", created.artifactId).every((event) =>
      event.actorId === "session:worker" && event.sessionId === "session:worker" && event.workItemId === "work_item:one"
    ));
    assert.equal((await f.service.get(workerContext(f), created.artifactId, pinnedReadOptions(created, reference))).content, "evidence body");
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Worker Artifact creation is Session-scoped idempotent and rejects conflicting or model-expanded scope", async () => {
  const f = await fixture();
  try {
    const input = {
      title: "Stable output", content: "same content", idempotencyKey: "stable-key",
      relation: "handoff", required: true, versionPolicy: "latest_approved"
    };
    const first = await f.service.create(workerContext(f), input);
    const replay = await f.service.create(workerContext(f), input);
    assert.equal(replay.artifactId, first.artifactId);
    assert.equal(replay.references[0].referenceId, first.references[0].referenceId);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifacts").count, 1);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifact_references").count, 1);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifact_worker_create_operations").count, 1);
    await assert.rejects(() => f.service.create(workerContext(f), { ...input, content: "changed" }), {
      code: "ARTIFACT_IDEMPOTENCY_CONFLICT", statusCode: 409
    });
    await assert.rejects(() => f.service.create(workerContext(f), {
      ...input, idempotencyKey: "cross-work-item", boundWorkItemId: "work_item:two"
    }), { code: "ARTIFACT_WORK_ITEM_FORBIDDEN" });
    await assert.rejects(() => f.service.create(workerContext(f), {
      ...input, idempotencyKey: "session-scope", boundSessionId: "session:worker"
    }), { code: "ARTIFACT_WORKER_SCOPE_FORBIDDEN" });
    await assert.rejects(() => f.service.create({ ...workerContext(f), objectiveId: "objective:two" }, {
      ...input, idempotencyKey: "cross-objective"
    }), { code: "ARTIFACT_OBJECTIVE_FORBIDDEN" });
    await assert.rejects(() => f.service.create({ ...workerContext(f), workItemId: "work_item:two" }, {
      ...input, idempotencyKey: "claimed-work-item"
    }), { code: "ARTIFACT_WORK_ITEM_FORBIDDEN" });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("parallel Worker Sessions owned by one Agent create Artifacts within their authoritative WorkItems", async () => {
  const f = await fixture();
  try {
    f.store.createWorkItem({
      id: "work_item:parallel",
      objectiveId: "objective:one",
      title: "Parallel",
      mainAgentId: f.worker.agentId
    });
    f.store.upsertSession({
      id: "session:parallel",
      title: "Parallel Worker",
      provider: "codex-app-server",
      status: "running",
      sessionKind: "worker",
      agentId: f.worker.agentId,
      objectiveId: "objective:one",
      workItemId: "work_item:parallel"
    });
    f.store.bindSessionToWorkItem("session:parallel", "work_item:parallel", "objective:one");
    f.core.bindSession({ agentId: f.worker.agentId, sessionId: "session:parallel" });
    assert.equal(f.store.getAgent(f.worker.agentId).currentSessionId, "session:parallel");

    const original = await f.service.create(workerContext(f), {
      title: "Original Worker output",
      content: "original",
      idempotencyKey: "parallel-agent-original-worker"
    });
    const parallel = await f.service.create({
      actorId: f.worker.agentId,
      sessionId: "session:parallel",
      objectiveId: "objective:one",
      workItemId: "work_item:parallel"
    }, {
      title: "Parallel Worker output",
      content: "parallel",
      idempotencyKey: "parallel-agent-second-worker"
    });

    assert.equal(original.objectiveId, "objective:one");
    assert.equal(original.boundWorkItemId, "work_item:one");
    assert.equal(original.references[0].workItemId, "work_item:one");
    assert.equal(parallel.objectiveId, "objective:one");
    assert.equal(parallel.boundWorkItemId, "work_item:parallel");
    assert.equal(parallel.references[0].workItemId, "work_item:parallel");
    const parallelContext = {
      actorId: f.worker.agentId,
      sessionId: "session:parallel",
      objectiveId: "objective:one",
      workItemId: "work_item:parallel"
    };
    const [originalPage, parallelPage] = await Promise.all([
      f.service.get(workerContext(f), original.artifactId, pinnedReadOptions(original)),
      f.service.get(parallelContext, parallel.artifactId, pinnedReadOptions(parallel))
    ]);
    assert.equal(originalPage.content, "original");
    assert.equal(parallelPage.content, "parallel");
    await assert.rejects(
      f.service.get(workerContext(f), parallel.artifactId, pinnedReadOptions(parallel)),
      { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" }
    );
    await assert.rejects(
      f.service.get(parallelContext, original.artifactId, pinnedReadOptions(original)),
      { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" }
    );
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Artifact authorization rejects a stale Provider binding for the exact logical Session route", async () => {
  const f = await fixture();
  try {
    const logical = f.store.createLogicalSessionRoute({
      logicalSessionId: "logical:artifact-worker",
      legacySessionId: "session:worker",
      providerThreadId: "thread:artifact-worker",
      providerSessionId: "provider-session:artifact-worker",
      providerId: "claude-sdk",
      boundCwd: f.directory,
      sessionName: "Artifact Worker"
    });
    const exactContext = {
      ...workerContext(f),
      logicalSessionId: logical.logicalSessionId,
      providerBindingId: logical.activeBinding.bindingId
    };
    assert.deepEqual(f.service.list(exactContext), []);
    assert.throws(() => f.service.list({
      ...exactContext,
      providerBindingId: "binding:stale"
    }), { code: "ARTIFACT_SESSION_BINDING_INVALID", statusCode: 409 });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("fixed-triple pages preserve UTF-8 boundaries, raw base64 offsets, hashes, pending pins, and revocation", async () => {
  const f = await fixture();
  try {
    const content = "A😀中B\0C";
    const artifact = await f.service.create(managerContext(f), {
      title: "Encoding", visibility: "objective_private", content, mimeType: "text/plain"
    });
    const reference = f.service.createReference(managerContext(f), artifact.artifactId, {
      workItemId: "work_item:one", relation: "test_plan", versionPolicy: "latest_approved"
    });
    const turnExecutionId = "turn:utf8-fixed";
    const first = await f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, {
      limit: 6, format: "text", turnExecutionId
    }));
    assert.equal(first.content, "A😀");
    assert.equal(first.range.byteLength, 5);
    const second = await f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, {
      offset: first.range.nextOffset, limit: 6, format: "text", turnExecutionId
    }));
    assert.equal(`${first.content}${second.content}`, content);
    const eof = await f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, {
      offset: Buffer.byteLength(content), limit: 6, format: "text", turnExecutionId
    }));
    assert.equal(eof.content, "");
    assert.equal(eof.range.byteLength, 0);
    assert.equal(eof.complete, true);
    await assert.rejects(f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, {
      offset: 2, limit: 6, format: "text", turnExecutionId: "turn:unaligned-text"
    })), { code: "ARTIFACT_RANGE_INVALID" });
    const replay = await f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, {
      limit: 6, format: "text", turnExecutionId
    }));
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.readReceiptId, first.readReceiptId);

    const binary = await f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, {
      offset: 2, limit: 4, format: "base64", turnExecutionId: "turn:base64"
    }));
    assert.deepEqual(Buffer.from(binary.content, "base64"), Buffer.from(content).subarray(2, 6));
    await assert.rejects(f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, {
      contentHash: "f".repeat(64)
    })), { code: "ARTIFACT_VERSION_HASH_MISMATCH" });

    const published = await f.service.publishVersion(managerContext(f), artifact.artifactId, {
      content: "new body", mimeType: "text/plain", approvalStatus: "approved"
    });
    const pending = f.store.getArtifactReference(reference.referenceId);
    assert.equal(pending.pinnedVersion, 1);
    assert.equal(pending.pendingVersion, 2);
    const oldPage = await f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference));
    assert.equal(oldPage.pendingUpdate.contentHash, published.version.contentHash);
    f.service.revokeReference(managerContext(f), reference.referenceId, "no longer authorized");
    await assert.rejects(f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, {
      limit: 6, format: "text", turnExecutionId
    })), {
      code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN"
    });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("durable page replay is charged once and fails closed when fixed content changes", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), {
      title: "Durable replay", visibility: "objective_private", content: "immutable page", mimeType: "text/plain"
    });
    const reference = f.service.createReference(managerContext(f), artifact.artifactId, {
      workItemId: "work_item:one", relation: "test_plan", versionPolicy: "fixed", version: 1
    });
    const options = pinnedReadOptions(artifact, reference, {
      turnExecutionId: "turn:durable-service", format: "base64", limit: 8
    });
    const first = await f.service.get(workerContext(f), artifact.artifactId, options);
    const usageBefore = f.store.getArtifactTurnReadUsage(
      "session:worker", "product-session:session:worker", options.turnExecutionId
    );
    f.service.readCoordinator = new ArtifactReadCoordinator({ store: f.store });
    const replay = await f.service.get(workerContext(f), artifact.artifactId, options);
    assert.equal(replay.readReceiptId, first.readReceiptId);
    assert.equal(replay.deduplicated, true);
    assert.deepEqual(
      f.store.getArtifactTurnReadUsage("session:worker", "product-session:session:worker", options.turnExecutionId),
      usageBefore
    );
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifact_read_receipts").count, 1);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifact_usage_events WHERE operation='get'").count, 1);

    const storedPath = join(f.directory, "data", "artifacts", artifact.versions[0].storageKey);
    await writeFile(storedPath, "mutated page!!");
    f.service.readCoordinator = new ArtifactReadCoordinator({ store: f.store });
    await assert.rejects(
      f.service.get(workerContext(f), artifact.artifactId, options),
      { code: "ARTIFACT_CONTENT_INTEGRITY_FAILED" }
    );
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("streamed fixed pages meet latency and bounded-memory envelopes without whole-body caching", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), {
      title: "Performance body",
      visibility: "objective_private",
      content: "x".repeat(128 * 1_024),
      mimeType: "application/octet-stream"
    });
    const reference = f.service.createReference(managerContext(f), artifact.artifactId, {
      workItemId: "work_item:one", relation: "test_plan", versionPolicy: "fixed", version: 1
    });
    const version = artifact.versions[0];
    const path = join(f.directory, "data", "artifacts", version.storageKey);
    const measure = async (limit, count) => {
      const samples = [];
      for (let index = 0; index < count; index += 1) {
        const started = performance.now();
        await readVerifiedArtifactPage({ path, version, offset: 0, limit, format: "base64" });
        samples.push(performance.now() - started);
      }
      samples.sort((left, right) => left - right);
      return samples[Math.ceil(samples.length * 0.95) - 1];
    };
    const rssBefore = process.memoryUsage().rss;
    // A wider sample prevents one external-volume fsync outlier from being
    // mislabeled as p95 while still exercising durable receipts on every read.
    const p95Page16KiB = await measure(16 * 1_024, 60);
    const p95Page64KiB = await measure(64 * 1_024, 60);
    const replayTurn = "turn:perf:replay";
    await f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, {
      limit: 16 * 1_024, format: "base64", turnExecutionId: replayTurn
    }));
    const replay = await f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, {
      limit: 16 * 1_024, format: "base64", turnExecutionId: replayTurn
    }));
    const cache = f.service.readCoordinator.snapshot();
    assert.equal(replay.deduplicated, true);
    assert.ok(p95Page16KiB < 20, `16 KiB page p95=${p95Page16KiB}ms`);
    assert.ok(p95Page64KiB < 30, `64 KiB page p95=${p95Page64KiB}ms`);
    assert.ok(cache.cachedPages <= 256);
    assert.ok(cache.cachedBytes <= 16 * 1_024 * 1_024);
    assert.ok(process.memoryUsage().rss - rssBefore < 64 * 1_024 * 1_024);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("read receipt and usage commit atomically and a failed audit releases the Turn reservation", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), {
      title: "Atomic read", visibility: "objective_private", content: "atomic body"
    });
    const reference = f.service.createReference(managerContext(f), artifact.artifactId, {
      workItemId: "work_item:one", relation: "test_plan", versionPolicy: "fixed", version: 1
    });
    const original = f.store.recordArtifactUsage.bind(f.store);
    f.store.recordArtifactUsage = () => {
      throw Object.assign(new Error("injected usage failure"), { code: "INJECTED_USAGE_FAILURE" });
    };
    const turnExecutionId = "turn:atomic-read-failure";
    await assert.rejects(
      f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, { turnExecutionId })),
      { code: "INJECTED_USAGE_FAILURE" }
    );
    f.store.recordArtifactUsage = original;
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifact_read_receipts").count, 0);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifact_usage_events").count, 0);
    const usage = f.store.getArtifactTurnReadUsage("session:worker", "product-session:session:worker", turnExecutionId);
    assert.deepEqual({ bytes: usage.uniqueBytes, pages: usage.uniquePages }, { bytes: 0, pages: 0 });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Worker Artifact Reference failure rolls back metadata, version, audit, idempotency, and unreferenced content", async () => {
  const f = await fixture();
  try {
    const original = f.store.createArtifactReference.bind(f.store);
    f.store.createArtifactReference = () => {
      const error = new Error("injected reference failure");
      error.code = "INJECTED_REFERENCE_FAILURE";
      throw error;
    };
    await assert.rejects(() => f.service.create(workerContext(f), {
      title: "Atomic failure", content: "must fully roll back", idempotencyKey: "retry-after-failure"
    }), { code: "INJECTED_REFERENCE_FAILURE" });
    f.store.createArtifactReference = original;
    for (const table of ["artifacts", "artifact_versions", "artifact_references", "artifact_audit_events", "artifact_worker_create_operations"]) {
      assert.equal(f.store.selectOne(`SELECT COUNT(*) AS count FROM ${table}`).count, 0, table);
    }
    const objects = await readdir(join(f.directory, "data", "artifacts", "objects"), { recursive: true });
    assert.equal(objects.filter((entry) => /^[a-f0-9]{64}$/.test(entry)).length, 0);
    assert.equal(f.store.selectOne("SELECT status FROM artifact_content_operations").status, "rolled_back");
    const retried = await f.service.create(workerContext(f), {
      title: "Atomic failure", content: "must fully roll back", idempotencyKey: "retry-after-failure"
    });
    assert.equal(retried.references.length, 1);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Worker Artifact creation rejects missing or stale authoritative Session bindings", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.service.create(workerContext(f), {
      title: "No key", content: "content"
    }), { code: "ARTIFACT_INVALID_INPUT" });
    f.store.db.run("UPDATE work_items SET current_session_id=NULL WHERE id=?", ["work_item:one"]);
    await assert.rejects(() => f.service.create(workerContext(f), {
      title: "Stale", content: "content", idempotencyKey: "stale"
    }), { code: "ARTIFACT_SESSION_BINDING_INVALID" });
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifacts").count, 0);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Artifact binding is rejected once WorkItem deletion has started", async () => {
  const f = await fixture();
  try {
    f.store.markWorkItemDeletion("work_item:one", "deleting");
    await assert.rejects(
      () => f.service.create(managerContext(f), {
        title: "Too late",
        visibility: "work_item_private",
        boundWorkItemId: "work_item:one",
        content: "must not race deletion"
      }),
      { code: "WORK_ITEM_DELETION_IN_PROGRESS", statusCode: 409 }
    );
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifacts").count, 0);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("started WorkItems pin latest-approved references until an explicit audited acknowledgement", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), { title: "Spec", visibility: "objective_private", content: "version one" });
    const reference = f.service.createReference(managerContext(f), artifact.artifactId, { workItemId: "work_item:one", relation: "implementation_spec", required: true, versionPolicy: "latest_approved" });
    const published = await f.service.publishVersion(managerContext(f), artifact.artifactId, { content: "version two" });
    const pending = f.store.getArtifactReference(reference.referenceId);
    assert.equal(pending.pinnedVersion, 1);
    assert.equal(pending.pendingVersion, 2);
    assert.equal((await f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, pending))).content, "version one");
    assert.deepEqual(published.affected.map((item) => item.action), ["approval_required"]);
    const acknowledged = f.service.acknowledgePendingReference(managerContext(f), reference.referenceId);
    assert.equal((await f.service.get(workerContext(f), published.artifact.artifactId, pinnedReadOptions(published.artifact, acknowledged))).content, "version two");
    assert.ok(f.store.listArtifactAudit("objective:one", artifact.artifactId).some((event) => event.action === "artifact.reference_update_acknowledged"));
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("revocation is stable, audited, and removes Worker access without deleting content", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), { title: "Handoff", visibility: "objective_private", content: "handoff" });
    const reference = f.service.createReference(managerContext(f), artifact.artifactId, { workItemId: "work_item:one", relation: "handoff", versionPolicy: "fixed" });
    f.service.revokeReference(managerContext(f), reference.referenceId, "No longer needed");
    await assert.rejects(() => f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference)), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
    assert.equal(await readFile(join(f.directory, "data", "artifacts", artifact.versions[0].storageKey), "utf8"), "handoff");
    assert.equal(f.store.getArtifactReference(reference.referenceId).revocationReason, "No longer needed");
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("metadata failure rolls back an unreferenced content object and records a recoverable operation", async () => {
  const f = await fixture();
  try {
    const original = f.store.createArtifactVersion.bind(f.store);
    f.store.createArtifactVersion = () => { const error = new Error("injected database failure"); error.code = "INJECTED_DB_FAILURE"; throw error; };
    await assert.rejects(() => f.service.create(managerContext(f), { title: "Failure", visibility: "objective_private", content: "must roll back" }), { code: "INJECTED_DB_FAILURE" });
    f.store.createArtifactVersion = original;
    const objects = await readdir(join(f.directory, "data", "artifacts", "objects"), { recursive: true });
    assert.equal(objects.filter((entry) => /^[a-f0-9]{64}$/.test(entry)).length, 0);
    assert.equal(f.store.selectOne("SELECT status FROM artifact_content_operations").status, "rolled_back");
    assert.equal(f.store.listArtifactsByObjective("objective:one", { includeRevoked: true }).length, 0);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("crash recovery removes prepared orphan files but preserves committed version content", async () => {
  const f = await fixture();
  try {
    const orphan = join(f.directory, "data", "artifacts", "tmp", "orphan.tmp");
    await writeFile(orphan, "orphan");
    f.store.createArtifactContentOperation({ operationId: "op:orphan", artifactId: "artifact:missing", version: 1, contentHash: "a".repeat(64), tempPath: orphan, finalPath: join(f.directory, "data", "artifacts", "objects", "aa", "a".repeat(64)), createdAt: "2026-08-23T00:00:00Z" });
    const recovered = await f.service.recoverContentOperations();
    assert.deepEqual(recovered, [{ operationId: "op:orphan", action: "rolled_back_orphan" }]);
    assert.equal(f.store.selectOne("SELECT status FROM artifact_content_operations WHERE operation_id='op:orphan'").status, "rolled_back");
    const orphanHash = "b".repeat(64);
    const orphanObject = join(f.directory, "data", "artifacts", "objects", "bb", orphanHash);
    await mkdir(join(f.directory, "data", "artifacts", "objects", "bb"), { recursive: true });
    await writeFile(orphanObject, "detached object", { flag: "wx" });
    const orphaned = await f.service.auditOrphanedContent();
    assert.equal(orphaned[0].storageKey, join("objects", "bb", orphanHash));
    assert.equal(f.store.listArtifactStorageAudit()[0].details.retained, true);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Session context is metadata-only and provider-neutral tools expose identical list/get/search contracts", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), { title: "Research", summary: "bounded summary", visibility: "objective_private", content: "body must not be injected" });
    f.service.createReference(managerContext(f), artifact.artifactId, { workItemId: "work_item:one", relation: "research_evidence", required: true, versionPolicy: "fixed" });
    const index = f.service.indexForSession(f.store.getSession("session:worker"));
    assert.equal(index.items[0].contentHash, artifact.versions[0].contentHash);
    assert.equal(index.items[0].required, true);
    assert.doesNotMatch(JSON.stringify(index), /body must not be injected/);
    assert.deepEqual(artifactDynamicTools.slice(0, 3).map((tool) => tool.name), ["corptie_artifact_list", "corptie_artifact_get", "corptie_artifact_search"]);
    for (const tool of artifactDynamicTools) assert.equal(tool.inputSchema.additionalProperties, false);
    const getSchema = artifactDynamicTools.find((tool) => tool.name === "corptie_artifact_get").inputSchema;
    assert.deepEqual(getSchema.required, ["artifact_id", "version", "content_hash", "reference_id"]);
    assert.equal(getSchema.properties.limit.maximum, 65_536);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("repository-tracked registration requires confirmation and never creates private content", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.service.create(managerContext(f), { title: "Git doc", visibility: "repository_tracked", repositoryLocator: "docs/spec.md" }), { code: "ARTIFACT_CONFIRMATION_REQUIRED" });
    const artifact = await f.service.create(managerContext(f), { title: "Git doc", visibility: "repository_tracked", repositoryLocator: "docs/spec.md", confirmedRepositoryTracked: true });
    assert.equal(artifact.versions[0].storageKey, null);
    assert.equal(artifact.repositoryLocator, "docs/spec.md");
    const reference = f.service.createReference(managerContext(f), artifact.artifactId, {
      sessionId: "session:manager", relation: "implementation_spec"
    });
    const detail = await f.service.get(managerContext(f), artifact.artifactId, pinnedReadOptions(artifact, reference, {
      referenceId: reference.referenceId
    }));
    assert.equal(detail.version, 1);
    assert.equal(detail.content, null);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("verified backup restores corrupted content and rejects cross-Objective restore", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), { title: "Backup", visibility: "objective_private", content: "verified backup content" });
    const backupPath = join(f.directory, "backup-bundle");
    const receipt = await f.service.backupObjective(managerContext(f), { destinationPath: backupPath, confirmed: true });
    assert.equal(receipt.artifactCount, 1);
    const storedPath = join(f.directory, "data", "artifacts", artifact.versions[0].storageKey);
    await writeFile(storedPath, "corrupted");
    assert.equal((await f.service.verifyIntegrity(artifact.artifactId)).ok, false);
    const restored = await f.service.restoreObjective(managerContext(f), { sourcePath: backupPath, confirmed: true });
    assert.equal(restored.verifiedContentObjects, 1);
    assert.equal(await readFile(storedPath, "utf8"), "verified backup content");
    await assert.rejects(() => f.service.restoreObjective({ kind: "local_user", actorId: "local", objectiveId: "objective:two" }, { sourcePath: backupPath, confirmed: true }), { code: "ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN" });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});
