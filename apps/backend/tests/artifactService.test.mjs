import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactService } from "../src/application/artifactService.mjs";
import { artifactDynamicTools } from "../src/application/artifactDynamicTools.mjs";
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
  return { directory, store, service, manager, worker, outsider };
}

const managerContext = (f) => ({ actorId: f.manager.agentId, sessionId: "session:manager", objectiveId: "objective:one" });
const workerContext = (f) => ({ actorId: f.worker.agentId, sessionId: "session:worker", objectiveId: "objective:one", workItemId: "work_item:one" });
const outsiderContext = (f) => ({ actorId: f.outsider.agentId, sessionId: "session:outsider", objectiveId: "objective:two", workItemId: "work_item:two" });

test("Objective private content is hashed, atomically stored outside repositories, paged, and usage-audited", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), { title: "Implementation", summary: "Private design", visibility: "objective_private", content: "secret specification" });
    assert.equal(artifact.currentVersion, 1);
    assert.equal(artifact.versions[0].contentHash.length, 64);
    assert.match(artifact.versions[0].storageKey, /^objects\//);
    const stored = await readFile(join(f.directory, "data", "artifacts", artifact.versions[0].storageKey), "utf8");
    assert.equal(stored, "secret specification");
    const page = await f.service.get(managerContext(f), artifact.artifactId, { limit: 6 });
    assert.equal(page.content, "secret");
    assert.equal(page.nextOffset, 6);
    assert.equal(f.store.selectOne("SELECT operation, content_hash FROM artifact_usage_events").content_hash, artifact.versions[0].contentHash);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("Worker permissions require an explicit same-Objective reference and reject cross-Objective access and writes", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), { title: "Security", visibility: "objective_private", content: "security requirement" });
    await assert.rejects(() => f.service.get(workerContext(f), artifact.artifactId), { code: "ARTIFACT_READ_FORBIDDEN" });
    assert.throws(() => f.service.createReference(managerContext(f), artifact.artifactId, { workItemId: "work_item:two", relation: "security_requirement" }), { code: "ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN" });
    f.service.createReference(managerContext(f), artifact.artifactId, { workItemId: "work_item:one", relation: "security_requirement", required: true, versionPolicy: "fixed" });
    assert.equal((await f.service.get(workerContext(f), artifact.artifactId)).content, "security requirement");

    const workItemPrivate = await f.service.create(managerContext(f), {
      title: "WorkItem private", visibility: "work_item_private", boundWorkItemId: "work_item:one", content: "work item only"
    });
    await assert.rejects(() => f.service.get(workerContext(f), workItemPrivate.artifactId), { code: "ARTIFACT_READ_FORBIDDEN" });
    f.service.createReference(managerContext(f), workItemPrivate.artifactId, { workItemId: "work_item:one", relation: "implementation_spec" });
    assert.equal((await f.service.get(workerContext(f), workItemPrivate.artifactId)).content, "work item only");

    const sessionPrivate = await f.service.create(managerContext(f), {
      title: "Session private", visibility: "session_private", boundSessionId: "session:manager", content: "manager only"
    });
    await assert.rejects(() => f.service.get(workerContext(f), sessionPrivate.artifactId), { code: "ARTIFACT_READ_FORBIDDEN" });
    f.service.createReference(managerContext(f), sessionPrivate.artifactId, { sessionId: "session:worker", relation: "research_evidence" });
    assert.equal((await f.service.get(workerContext(f), sessionPrivate.artifactId)).content, "manager only");

    const repositoryTracked = await f.service.create(managerContext(f), {
      title: "Tracked", visibility: "repository_tracked", repositoryLocator: "docs/tracked.md", confirmedRepositoryTracked: true
    });
    f.service.createReference(managerContext(f), repositoryTracked.artifactId, { workItemId: "work_item:one", relation: "research_evidence" });
    assert.equal((await f.service.get(workerContext(f), repositoryTracked.artifactId)).content, null);

    assert.throws(() => f.service.changeVisibility(managerContext(f), artifact.artifactId, "work_item_private", { confirmed: true }), { code: "ARTIFACT_WORK_ITEM_REQUIRED" });
    assert.throws(() => f.service.changeVisibility(managerContext(f), artifact.artifactId, "repository_tracked", { confirmed: true }), { code: "ARTIFACT_VISIBILITY_TRANSITION_FORBIDDEN" });
    await assert.rejects(() => f.service.get(outsiderContext(f), artifact.artifactId), { code: "ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN" });
    await assert.rejects(() => f.service.create(workerContext(f), { title: "escape", visibility: "objective_private", content: "no" }), { code: "ARTIFACT_WRITE_FORBIDDEN" });
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
    assert.equal((await f.service.get(workerContext(f), artifact.artifactId)).content, "version one");
    assert.deepEqual(published.affected.map((item) => item.action), ["approval_required"]);
    f.service.acknowledgePendingReference(managerContext(f), reference.referenceId);
    assert.equal((await f.service.get(workerContext(f), artifact.artifactId)).content, "version two");
    assert.ok(f.store.listArtifactAudit("objective:one", artifact.artifactId).some((event) => event.action === "artifact.reference_update_acknowledged"));
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("revocation is stable, audited, and removes Worker access without deleting content", async () => {
  const f = await fixture();
  try {
    const artifact = await f.service.create(managerContext(f), { title: "Handoff", visibility: "objective_private", content: "handoff" });
    const reference = f.service.createReference(managerContext(f), artifact.artifactId, { workItemId: "work_item:one", relation: "handoff", versionPolicy: "fixed" });
    f.service.revokeReference(managerContext(f), reference.referenceId, "No longer needed");
    await assert.rejects(() => f.service.get(workerContext(f), artifact.artifactId), { code: "ARTIFACT_READ_FORBIDDEN" });
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
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("repository-tracked registration requires confirmation and never creates private content", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.service.create(managerContext(f), { title: "Git doc", visibility: "repository_tracked", repositoryLocator: "docs/spec.md" }), { code: "ARTIFACT_CONFIRMATION_REQUIRED" });
    const artifact = await f.service.create(managerContext(f), { title: "Git doc", visibility: "repository_tracked", repositoryLocator: "docs/spec.md", confirmedRepositoryTracked: true });
    assert.equal(artifact.versions[0].storageKey, null);
    assert.equal(artifact.repositoryLocator, "docs/spec.md");
    const detail = await f.service.get(managerContext(f), artifact.artifactId);
    assert.equal(detail.version.version, 1);
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
