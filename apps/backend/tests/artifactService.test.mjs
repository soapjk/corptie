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
  const peer = store.createAgent({ name: "Peer Worker", provider: "codex-app-server" });
  const outsider = store.createAgent({ name: "Outsider", provider: "openclacky" });
  store.createObjective({ id: "objective:one", name: "One", contributorAgentIds: [manager.agentId, worker.agentId, peer.agentId] });
  store.createObjective({ id: "objective:two", name: "Two", contributorAgentIds: [outsider.agentId] });
  store.createTask({ id: "task:one", objectiveId: "objective:one", title: "One", mainAgentId: worker.agentId });
  store.createTask({ id: "task:peer", objectiveId: "objective:one", title: "Peer", mainAgentId: peer.agentId });
  store.createTask({ id: "task:two", objectiveId: "objective:two", title: "Two", mainAgentId: outsider.agentId });
  store.upsertSession({ id: "session:manager", title: "Manager", provider: "codex-app-server", status: "running", sessionKind: "objectiveChat", agentId: manager.agentId, objectiveId: "objective:one" });
  store.upsertSession({ id: "session:worker", title: "Worker", provider: "claude-sdk", status: "running", sessionKind: "worker", agentId: worker.agentId, objectiveId: "objective:one", taskId: "task:one" });
  store.upsertSession({ id: "session:peer", title: "Peer", provider: "codex-app-server", status: "running", sessionKind: "worker", agentId: peer.agentId, objectiveId: "objective:one", taskId: "task:peer" });
  store.upsertSession({ id: "session:outsider", title: "Outsider", provider: "openclacky", status: "running", sessionKind: "worker", agentId: outsider.agentId, objectiveId: "objective:two", taskId: "task:two" });
  store.bindSessionToObjective("session:manager", "objective:one");
  store.bindSessionToTask("session:worker", "task:one", "objective:one");
  store.bindSessionToTask("session:peer", "task:peer", "objective:one");
  store.bindSessionToTask("session:outsider", "task:two", "objective:two");
  core.bindSession({ agentId: manager.agentId, sessionId: "session:manager" });
  core.bindSession({ agentId: worker.agentId, sessionId: "session:worker" });
  core.bindSession({ agentId: peer.agentId, sessionId: "session:peer" });
  core.bindSession({ agentId: outsider.agentId, sessionId: "session:outsider" });
  let id = 0;
  const service = new ArtifactService({ store, contentRoot: join(directory, "data", "artifacts"), idFactory: () => `id-${++id}`, clock: () => "2026-08-23T12:00:00.000Z" });
  await service.initialize();
  return { directory, store, service, core, manager, worker, peer, outsider };
}

const managerContext = (f) => ({ actorId: f.manager.agentId, sessionId: "session:manager", objectiveId: "objective:one" });
const workerContext = (f) => ({ actorId: f.worker.agentId, sessionId: "session:worker", objectiveId: "objective:one", taskId: "task:one" });
const peerContext = (f) => ({ actorId: f.peer.agentId, sessionId: "session:peer", objectiveId: "objective:one", taskId: "task:peer" });
const outsiderContext = (f) => ({ actorId: f.outsider.agentId, sessionId: "session:outsider", objectiveId: "objective:two", taskId: "task:two" });
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

test("Artifact and Reference writes participate in the durable State invalidation stream", async () => {
  const f = await fixture();
  try {
    let dirtyNotifications = 0;
    f.store.setStateDirtyListener(() => { dirtyNotifications += 1; });
    const before = f.store.stateRevision();
    const artifact = await f.service.create(managerContext(f), {
      title: "Live cache spec", visibility: "objective_private", content: "v1"
    });
    f.service.createReference(managerContext(f), artifact.artifactId, {
      taskId: "task:one", relation: "implementation_spec", versionPolicy: "fixed"
    });

    const invalidations = f.store.stateChangesAfter(before).filter((change) => (
      change.entityType === "artifact" && change.entityId === artifact.artifactId
    ));
    assert.ok(invalidations.length >= 3, "Artifact row, version, and Reference must all invalidate clients");
    assert.ok(invalidations.every((change) => change.operation === "upsert"));
    assert.equal(dirtyNotifications, 2, "create and Reference commits must each wake State SSE delivery");
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Benchmark pinned evidence performs one complete authority read with fixed Reference provenance", async () => {
  const f = await fixture();
  try {
    const content = "完整 fixed implementation specification 🧪";
    const artifact = await f.service.create(managerContext(f), { title: "Fixed spec", visibility: "objective_private", content, approvalStatus: "approved" });
    f.service.createReference(managerContext(f), artifact.artifactId, { taskId: "task:one", relation: "implementation_spec", required: true, versionPolicy: "fixed", version: 1 });
    const evidence = await f.service.readPinnedEvidence(workerContext(f), artifact.artifactId, { version: 1 });
    assert.equal(evidence.content, content);
    assert.equal(evidence.byteLength, Buffer.byteLength(content));
    assert.equal(evidence.contentHash, artifact.versions[0].contentHash);
    assert.equal(evidence.approvalStatus, "approved");
    assert.equal(evidence.relation, "implementation_spec");
    assert.equal(evidence.versionPolicy, "fixed");
    assert.match(evidence.readReceiptId, /^artifact_usage:/);
    assert.deepEqual(f.store.selectOne("SELECT byte_offset, byte_length, operation FROM artifact_usage_events WHERE usage_id=?", [evidence.readReceiptId]), { byte_offset: 0, byte_length: Buffer.byteLength(content), operation: "get" });
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
      taskId: "task:one", relation: "implementation_spec", versionPolicy: "fixed", version: 1
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
      taskId: "task:one", relation: "implementation_spec", versionPolicy: "fixed", version: 1
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

test("Work Sessions read same-Objective Artifacts without References while cross-Objective access remains forbidden", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), { title: "Security", visibility: "objective_private", content: "security requirement" });
    assert.equal((await f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact))).content, "security requirement");
    assert.throws(() => f.service.createReference(managerContext(f), artifact.artifactId, { taskId: "task:two", relation: "security_requirement" }), { code: "ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN" });
    const securityReference = f.service.createReference(managerContext(f), artifact.artifactId, { taskId: "task:one", relation: "security_requirement", required: true, versionPolicy: "fixed" });
    assert.equal((await f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, securityReference))).content, "security requirement");
    const unrelated = await f.service.create(managerContext(f), { title: "Unrelated", visibility: "objective_private", content: "other" });
    const unrelatedReference = f.service.createReference(managerContext(f), unrelated.artifactId, { taskId: "task:one", relation: "research_evidence" });
    await assert.rejects(() => f.service.get(workerContext(f), artifact.artifactId, pinnedReadOptions(artifact, securityReference, {
      referenceId: unrelatedReference.referenceId
    })), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN", statusCode: 404 });

    const taskPrivate = await f.service.create(managerContext(f), {
      title: "Task private", visibility: "task_private", boundTaskId: "task:one", content: "work item only"
    });
    assert.equal((await f.service.get(peerContext(f), taskPrivate.artifactId, pinnedReadOptions(taskPrivate))).content, "work item only");
    const taskReference = f.service.createReference(managerContext(f), taskPrivate.artifactId, { taskId: "task:one", relation: "implementation_spec" });
    assert.equal((await f.service.get(workerContext(f), taskPrivate.artifactId, pinnedReadOptions(taskPrivate, taskReference))).content, "work item only");

    const sessionPrivate = await f.service.create(managerContext(f), {
      title: "Session private", visibility: "session_private", boundSessionId: "session:manager", content: "manager only"
    });
    await assert.rejects(() => f.service.get(workerContext(f), sessionPrivate.artifactId, pinnedReadOptions(sessionPrivate)), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
    const sessionReference = f.service.createReference(managerContext(f), sessionPrivate.artifactId, { sessionId: "session:worker", relation: "research_evidence" });
    assert.equal((await f.service.get(workerContext(f), sessionPrivate.artifactId, pinnedReadOptions(sessionPrivate, sessionReference))).content, "manager only");

    const repositoryTracked = await f.service.create(managerContext(f), {
      title: "Tracked", visibility: "repository_tracked", repositoryLocator: "docs/tracked.md", confirmedRepositoryTracked: true
    });
    const trackedReference = f.service.createReference(managerContext(f), repositoryTracked.artifactId, { taskId: "task:one", relation: "research_evidence" });
    assert.equal((await f.service.get(workerContext(f), repositoryTracked.artifactId, pinnedReadOptions(repositoryTracked, trackedReference))).content, null);

    assert.throws(() => f.service.changeVisibility(managerContext(f), artifact.artifactId, "task_private", { confirmed: true }), { code: "ARTIFACT_TASK_REQUIRED" });
    assert.throws(() => f.service.changeVisibility(managerContext(f), artifact.artifactId, "repository_tracked", { confirmed: true }), { code: "ARTIFACT_VISIBILITY_TRANSITION_FORBIDDEN" });
    await assert.rejects(() => f.service.get(outsiderContext(f), artifact.artifactId, pinnedReadOptions(artifact)), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
    const sharedByWorker = await f.service.create(workerContext(f), {
      title: "Shared by Worker", visibility: "objective_private", scope: "objective",
      content: "shared", idempotencyKey: "shared-by-worker"
    });
    assert.equal(sharedByWorker.scope, "objective");
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Objective Artifacts are collaboratively writable while another Task's Artifact stays read-only", async () => {
  const f = await fixture();
  try {
    const shared = await f.service.create(workerContext(f), {
      title: "Provider startup design",
      summary: "Shared readiness contract",
      content: "Provider initialization must not block the frontend.",
      scope: "objective",
      kind: "architecture",
      categoryPath: "architecture/provider/startup",
      tags: ["provider", "readiness"],
      aliases: ["Provider启动方案"],
      keywords: ["not ready", "bootstrap"],
      idempotencyKey: "shared-provider-startup"
    });
    assert.equal(shared.scope, "objective");
    assert.equal(shared.createdByActorId, "session:worker");
    const edited = f.service.updateMetadata(peerContext(f), shared.artifactId, {
      summary: "Shared Provider readiness and startup contract",
      tags: ["provider", "readiness", "frontend"]
    });
    assert.equal(edited.access.write, true);
    const published = await f.service.publishVersion(peerContext(f), shared.artifactId, {
      content: "Provider initializes in the background after the frontend connects."
    });
    assert.equal(published.version.version, 2);
    f.service.revokeArtifact(workerContext(f), shared.artifactId, "replace shared draft");
    const deleted = f.service.list(peerContext(f), { includeRevoked: true })
      .find((candidate) => candidate.artifactId === shared.artifactId);
    assert.equal(deleted.status, "revoked");
    assert.equal(deleted.access.write, true);
    assert.equal(f.service.restoreArtifact(peerContext(f), shared.artifactId).status, "active");

    const privateArtifact = await f.service.create(workerContext(f), {
      title: "Private implementation notes",
      content: "Owned by work item one",
      scope: "task",
      idempotencyKey: "private-implementation-notes"
    });
    const privateVersion = privateArtifact.versions[0];
    assert.equal((await f.service.get(peerContext(f), privateArtifact.artifactId, {
      version: privateVersion.version,
      contentHash: privateVersion.contentHash,
      turnExecutionId: `test-turn:${++artifactReadTurn}`
    })).content, "Owned by work item one");
    assert.throws(
      () => f.service.updateMetadata(peerContext(f), privateArtifact.artifactId, { summary: "unauthorized" }),
      { code: "ARTIFACT_READ_ONLY" }
    );
    await assert.rejects(
      () => f.service.publishVersion(peerContext(f), privateArtifact.artifactId, { content: "unauthorized" }),
      { code: "ARTIFACT_PRIVATE_PUBLISH_FORBIDDEN" }
    );
    assert.throws(
      () => f.service.revokeArtifact(peerContext(f), privateArtifact.artifactId, "unauthorized"),
      { code: "ARTIFACT_READ_ONLY" }
    );
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Worker private publish appends an immutable version and atomically repins its fixed Task Reference", async () => {
  const f = await fixture();
  try {
    const created = await f.service.create(workerContext(f), {
      title: "Private evolving design", content: "version one",
      idempotencyKey: "private-evolving-design", versionPolicy: "fixed",
      approvalStatus: "draft", relation: "implementation_spec", required: false
    });
    const originalVersion = created.versions[0];
    const originalReference = created.references[0];
    const listedDraft = f.service.listForTask(workerContext(f), "task:one")
      .find((artifact) => artifact.artifactId === created.artifactId);
    assert.equal(listedDraft.versions[0].approvalStatus, "draft");
    assert.equal(listedDraft.references[0].required, false);
    assert.equal(listedDraft.references[0].relation, "implementation_spec");
    const input = {
      content: "version two", summary: "Updated design", mimeType: "text/markdown",
      expectedResourceVersion: created.resourceVersion,
      expectedPinnedVersion: originalReference.pinnedVersion,
      expectedPinnedHash: originalReference.pinnedHash,
      referenceId: originalReference.referenceId,
      idempotencyKey: "publish-private-v2"
    };
    const published = await f.service.publishVersion(workerContext(f), created.artifactId, input);
    assert.equal(published.version.version, 2);
    assert.equal(published.reference.pinnedVersion, 2);
    assert.equal(published.reference.pinnedHash, published.version.contentHash);
    assert.equal(published.operationStatus, "completed");
    assert.equal(published.idempotentReplay, false);
    assert.equal(published.version.createdByActorId, "session:worker");
    assert.equal(f.store.getArtifactVersion(created.artifactId, 1).contentHash, originalVersion.contentHash);
    assert.equal((await f.service.get(workerContext(f), created.artifactId, {
      version: 1, contentHash: originalVersion.contentHash,
      turnExecutionId: `test-turn:${++artifactReadTurn}`
    })).content, "version one");

    const replay = await f.service.publishVersion(workerContext(f), created.artifactId, input);
    assert.equal(replay.version.version, 2);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(f.store.listArtifactVersions(created.artifactId).length, 2);
    await assert.rejects(() => f.service.publishVersion(workerContext(f), created.artifactId, {
      ...input, content: "conflicting retry"
    }), { code: "ARTIFACT_IDEMPOTENCY_CONFLICT" });
    await assert.rejects(() => f.service.publishVersion(workerContext(f), created.artifactId, {
      ...input, idempotencyKey: "stale-publish"
    }), { code: "ARTIFACT_RESOURCE_VERSION_CONFLICT" });
    assert.equal(f.store.listArtifactVersions(created.artifactId).length, 2);
    await assert.rejects(() => f.service.publishVersion(peerContext(f), created.artifactId, {
      ...input, idempotencyKey: "peer-publish"
    }), { code: "ARTIFACT_PRIVATE_PUBLISH_FORBIDDEN" });
    const actions = f.service.listForTask(workerContext(f), "task:one")[0].availableActions;
    assert.ok(actions.includes("publish_and_repin"));
    assert.equal(f.store.listArtifactAudit("objective:one", created.artifactId)
      .some((event) => event.action === "artifact.reference_repinned"
        && event.actorId === "session:worker"), true);
    f.service.revokeReference(workerContext(f), published.reference.referenceId, "test revoked pin");
    await assert.rejects(() => f.service.publishVersion(workerContext(f), created.artifactId, {
      content: "version three", expectedResourceVersion: published.artifact.resourceVersion,
      expectedPinnedVersion: 2, expectedPinnedHash: published.version.contentHash,
      idempotencyKey: "publish-without-active-reference"
    }), { code: "ARTIFACT_REFERENCE_PIN_CONFLICT" });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Worker private publish rolls back version and repin together when the Reference update fails", async () => {
  const f = await fixture();
  try {
    const created = await f.service.create(workerContext(f), {
      title: "Atomic private design", content: "v1", idempotencyKey: "atomic-private-design"
    });
    const reference = created.references[0];
    const originalUpdate = f.store.updateArtifactReference.bind(f.store);
    f.store.updateArtifactReference = () => {
      const error = new Error("injected reference failure");
      error.code = "INJECTED_REFERENCE_FAILURE";
      throw error;
    };
    await assert.rejects(() => f.service.publishVersion(workerContext(f), created.artifactId, {
      content: "v2", expectedResourceVersion: created.resourceVersion,
      expectedPinnedVersion: reference.pinnedVersion, expectedPinnedHash: reference.pinnedHash,
      idempotencyKey: "atomic-private-v2"
    }), { code: "INJECTED_REFERENCE_FAILURE" });
    f.store.updateArtifactReference = originalUpdate;
    assert.equal(f.store.listArtifactVersions(created.artifactId).length, 1);
    assert.equal(f.store.getArtifact(created.artifactId).currentVersion, 1);
    assert.equal(f.store.getArtifactReference(reference.referenceId).pinnedVersion, 1);
    assert.equal(f.store.getArtifactWorkerPublishOperation("session:worker", "atomic-private-v2"), null);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Artifact full-text and taxonomy search finds Objective documents by body, aliases, categories, and tags", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), {
      title: "Runtime readiness architecture",
      summary: "Frontend connection boundary",
      content: "The Python Provider bootstrap continues after the application becomes usable.",
      scope: "objective",
      kind: "architecture",
      categoryPath: "architecture/provider/startup",
      tags: ["provider", "readiness"],
      aliases: ["启动解耦文档"],
      keywords: ["not ready", "background initialization"]
    });

    for (const query of ["Python Provider bootstrap", "启动解耦文档", "background initialization"]) {
      const result = await f.service.search(peerContext(f), query);
      assert.equal(result.results[0].artifact.artifactId, artifact.artifactId);
      assert.equal(result.results[0].artifact.access.write, true);
    }
    const filtered = await f.service.search(peerContext(f), "Provider", {
      kinds: ["architecture"], categoryPrefix: "architecture/provider", tags: ["readiness"]
    });
    assert.equal(filtered.count, 1);
    assert.equal(filtered.results[0].artifact.categoryPath, "architecture/provider/startup");
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Task Artifact summary loading batches 1,000 referenced Artifacts without N+1 queries", async () => {
  const f = await fixture();
  try {
    f.store.runInTransaction(() => {
      for (let index = 0; index < 1_000; index += 1) {
        const artifactId = `artifact:bulk-${index}`;
        const hash = index.toString(16).padStart(64, "0");
        f.store.createArtifactMetadata({
          artifactId, objectiveId: "objective:one", title: `Bulk ${index}`, summary: "draft",
          visibility: "task_private", scope: "task", kind: "other", categoryPath: "",
          tags: [], aliases: [], keywords: [], boundTaskId: "task:one", boundSessionId: null,
          actorId: "session:worker", createdAt: "2026-09-01T00:00:00.000Z"
        });
        f.store.createArtifactVersion({
          artifactId, version: 1, contentHash: hash, byteLength: 0, mimeType: "text/markdown",
          storageKey: null, sourceSessionId: "session:worker", supersedesVersion: null,
          approvalStatus: "draft", actorId: "session:worker", createdAt: "2026-09-01T00:00:00.000Z"
        });
        f.store.updateArtifact(artifactId, { currentVersion: 1, approvedVersion: null });
        f.store.createArtifactReference({
          referenceId: `artifact_reference:bulk-${index}`, artifactId, objectiveId: "objective:one",
          taskId: "task:one", relation: "implementation_spec", required: false,
          versionPolicy: "fixed", pinnedVersion: 1, pinnedHash: hash,
          actorId: "session:worker", authorizedAt: "2026-09-01T00:00:00.000Z"
        });
      }
    });
    const pageStarted = performance.now();
    const page = f.service.listForTask(managerContext(f), "task:one", { limit: 100, offset: 0 });
    const pageElapsed = performance.now() - pageStarted;
    assert.equal(page.length, 100);
    assert.ok(pageElapsed < 250, `paged Task Artifact list took ${pageElapsed.toFixed(2)}ms`);
    const started = performance.now();
    const artifacts = f.service.listForTask(managerContext(f), "task:one");
    const elapsed = performance.now() - started;
    assert.equal(artifacts.length, 1_000);
    assert.equal(artifacts.every((artifact) => artifact.references[0].required === false
      && artifact.versions[0].approvalStatus === "draft"), true);
    assert.ok(elapsed < 1_000, `batched Task Artifact list took ${elapsed.toFixed(2)}ms`);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Worker creates one current-Task Artifact and explicit pinned Reference atomically with Session as actor", async () => {
  const f = await fixture();
  try {
    const created = await callArtifactDynamicTool(f.service, {
      tool: "corptie_artifact_create",
      actorId: f.worker.agentId,
      metadata: {
        sessionId: "session:worker", objectiveId: "objective:one",
        taskId: "task:one", sessionKind: "worker"
      },
      arguments: {
        title: "Worker evidence", summary: "Completed verification", content: "evidence body",
        idempotency_key: "worker-evidence-1"
      }
    });
    assert.equal(created.visibility, "task_private");
    assert.equal(created.boundTaskId, "task:one");
    assert.equal(created.boundSessionId, null);
    assert.equal(created.sourceSessionId, "session:worker");
    assert.equal(created.createdByActorId, "session:worker");
    assert.equal(created.currentVersion, 1);
    assert.equal(created.idempotentReplay, false);
    assert.equal(created.references.length, 1);
    const reference = created.references[0];
    assert.equal(reference.objectiveId, "objective:one");
    assert.equal(reference.taskId, "task:one");
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
      event.actorId === "session:worker" && event.sessionId === "session:worker" && event.taskId === "task:one"
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
      ...input, idempotencyKey: "cross-task", boundTaskId: "task:two"
    }), { code: "ARTIFACT_TASK_FORBIDDEN" });
    await assert.rejects(() => f.service.create(workerContext(f), {
      ...input, idempotencyKey: "session-scope", boundSessionId: "session:worker"
    }), { code: "ARTIFACT_WORKER_SCOPE_FORBIDDEN" });
    await assert.rejects(() => f.service.create({ ...workerContext(f), objectiveId: "objective:two" }, {
      ...input, idempotencyKey: "cross-objective"
    }), { code: "ARTIFACT_OBJECTIVE_FORBIDDEN" });
    await assert.rejects(() => f.service.create({ ...workerContext(f), taskId: "task:two" }, {
      ...input, idempotencyKey: "claimed-task"
    }), { code: "ARTIFACT_TASK_FORBIDDEN" });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("parallel Worker Sessions owned by one Agent create Artifacts within their authoritative Tasks", async () => {
  const f = await fixture();
  try {
    f.store.createTask({
      id: "task:parallel",
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
      taskId: "task:parallel"
    });
    f.store.bindSessionToTask("session:parallel", "task:parallel", "objective:one");
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
      taskId: "task:parallel"
    }, {
      title: "Parallel Worker output",
      content: "parallel",
      idempotencyKey: "parallel-agent-second-worker"
    });

    assert.equal(original.objectiveId, "objective:one");
    assert.equal(original.boundTaskId, "task:one");
    assert.equal(original.references[0].taskId, "task:one");
    assert.equal(parallel.objectiveId, "objective:one");
    assert.equal(parallel.boundTaskId, "task:parallel");
    assert.equal(parallel.references[0].taskId, "task:parallel");
    const parallelContext = {
      actorId: f.worker.agentId,
      sessionId: "session:parallel",
      objectiveId: "objective:one",
      taskId: "task:parallel"
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
      taskId: "task:one", relation: "test_plan", versionPolicy: "latest_approved"
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
      taskId: "task:one", relation: "test_plan", versionPolicy: "fixed", version: 1
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
      taskId: "task:one", relation: "test_plan", versionPolicy: "fixed", version: 1
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
      taskId: "task:one", relation: "test_plan", versionPolicy: "fixed", version: 1
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
    f.store.db.run("UPDATE tasks SET current_session_id=NULL WHERE id=?", ["task:one"]);
    await assert.rejects(() => f.service.create(workerContext(f), {
      title: "Stale", content: "content", idempotencyKey: "stale"
    }), { code: "ARTIFACT_SESSION_BINDING_INVALID" });
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifacts").count, 0);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Artifact binding is rejected once Task deletion has started", async () => {
  const f = await fixture();
  try {
    f.store.markTaskDeletion("task:one", "deleting");
    await assert.rejects(
      () => f.service.create(managerContext(f), {
        title: "Too late",
        visibility: "task_private",
        boundTaskId: "task:one",
        content: "must not race deletion"
      }),
      { code: "TASK_DELETION_IN_PROGRESS", statusCode: 409 }
    );
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifacts").count, 0);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("started Tasks pin latest-approved references until an explicit audited acknowledgement", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), { title: "Spec", visibility: "objective_private", content: "version one" });
    const reference = f.service.createReference(managerContext(f), artifact.artifactId, { taskId: "task:one", relation: "implementation_spec", required: true, versionPolicy: "latest_approved" });
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

test("Reference revocation remains stable and audited without removing inherent Work Session read access", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), { title: "Handoff", visibility: "objective_private", content: "handoff" });
    const reference = f.service.createReference(managerContext(f), artifact.artifactId, { taskId: "task:one", relation: "handoff", versionPolicy: "fixed" });
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
    f.service.createReference(managerContext(f), artifact.artifactId, { taskId: "task:one", relation: "research_evidence", required: true, versionPolicy: "fixed" });
    const index = f.service.indexForSession(f.store.getSession("session:worker"));
    assert.equal(index.items[0].contentHash, artifact.versions[0].contentHash);
    assert.equal(index.items[0].required, true);
    assert.doesNotMatch(JSON.stringify(index), /body must not be injected/);
    assert.deepEqual(artifactDynamicTools.slice(0, 3).map((tool) => tool.name), ["corptie_artifact_list", "corptie_artifact_get", "corptie_artifact_search"]);
    for (const tool of artifactDynamicTools) assert.equal(tool.inputSchema.additionalProperties, false);
    const getSchema = artifactDynamicTools.find((tool) => tool.name === "corptie_artifact_get").inputSchema;
    assert.deepEqual(getSchema.required, ["artifact_id", "version", "content_hash"]);
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
