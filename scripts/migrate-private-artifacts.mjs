#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { ArtifactService } from "../apps/backend/src/application/artifactService.mjs";
import { CorptieStore } from "../apps/backend/src/store/corptieStore.mjs";

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const objectiveId = required(args["objective-id"], "--objective-id");
const workItemId = args["work-item-id"] ?? null;
const sourceRoot = resolve(required(args["source-root"], "--source-root"));
const files = required(args.files, "--files").split(",").map((entry) => resolve(sourceRoot, entry.trim()));
const apply = args.apply === true;
const store = new CorptieStore({ dbPath: process.env.CORPTIE_DB_PATH || undefined });
await store.initialize();
const service = new ArtifactService({ store });
await service.initialize();

try {
  const objective = store.getObjective(objectiveId);
  if (!objective) throw new Error(`Objective not found: ${objectiveId}`);
  const workItem = workItemId ? store.getWorkItem(workItemId) : null;
  if (workItemId && (!workItem || workItem.objective_id !== objectiveId)) throw new Error("WorkItem must exist in the migration Objective.");
  const preflight = [];
  for (const path of files) {
    await assertGitUntracked(sourceRoot, path);
    const content = await readFile(path);
    preflight.push({ path, title: basename(path), byteLength: content.byteLength, contentHash: sha256(content) });
  }
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", objectiveId, workItemId, sourcePreserved: true, remoteWrite: false, files: preflight }, null, 2));
    process.exitCode = 2;
  } else {
    const migrated = [];
    for (const source of preflight) {
      const artifactId = `artifact:${createHash("sha256").update(`${objectiveId}\0${source.path}`).digest("hex").slice(0, 32)}`;
      let artifact = store.getArtifact(artifactId);
      if (!artifact) {
        const imported = await service.importLocalFile({ kind: "local_user", actorId: "migration-tool", objectiveId }, {
          artifactId, path: source.path, title: source.title,
          summary: `Safely migrated local design document; source retained at ${source.path}`,
          visibility: "objective_private", approvalStatus: "approved"
        });
        artifact = imported.artifact;
      }
      const version = store.getArtifactVersion(artifactId, 1);
      if (!version || version.contentHash !== source.contentHash || version.byteLength !== source.byteLength) {
        throw new Error(`Registered Artifact integrity mismatch: ${source.path}`);
      }
      if (workItemId && !store.listArtifactReferences({ artifactId }).some((reference) => reference.workItemId === workItemId && !reference.revokedAt)) {
        service.createReference({ kind: "local_user", actorId: "migration-tool", objectiveId }, artifactId, {
          workItemId, relation: relationFor(source.title), required: false, versionPolicy: "fixed", version: 1
        });
      }
      const after = await readFile(source.path);
      if (sha256(after) !== source.contentHash || after.byteLength !== source.byteLength) throw new Error(`Source changed during migration: ${source.path}`);
      await assertGitUntracked(sourceRoot, source.path);
      const integrity = await service.verifyIntegrity(artifactId);
      if (!integrity.ok) throw new Error(`Post-registration integrity failed: ${source.path}`);
      migrated.push({ ...source, artifactId, version: 1, versionPolicy: "fixed", sourcePreserved: true, gitTracked: false, remoteWrite: false });
    }
    const receipt = {
      receiptId: `artifact-migration:${Date.now()}`, objectiveId, workItemId,
      sourceRoot, createdAt: new Date().toISOString(), sourcePreserved: true,
      gitTracked: false, remoteWrite: false, files: migrated
    };
    if (args.receipt) await writeFile(resolve(args.receipt), JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
    store.appendArtifactAudit({
      auditId: receipt.receiptId, artifactId: null, objectiveId, action: "artifact.migration_completed",
      actorId: "migration-tool", workItemId, details: receipt, createdAt: receipt.createdAt
    });
    console.log(JSON.stringify(receipt, null, 2));
  }
} finally {
  await store.close();
}

async function assertGitUntracked(root, path) {
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  try {
    await execFileAsync("git", ["-C", root, "ls-files", "--error-unmatch", "--", relative]);
  } catch (error) {
    if (error.code === 1 || error.code === 128) return;
    throw error;
  }
  throw new Error(`Migration source is Git-tracked and must not be imported as private content: ${path}`);
}
function relationFor(name) {
  if (name.includes("security")) return "security_requirement";
  if (name.includes("test") || name.includes("rollback")) return "test_plan";
  if (name.includes("architecture") || name.includes("design")) return "implementation_spec";
  return "research_evidence";
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function required(value, flag) { if (!value) throw new Error(`${flag} is required.`); return value; }
function parseArgs(values) { const result = {}; for (let index = 0; index < values.length; index += 1) { const key = values[index].replace(/^--/, ""); if (["apply"].includes(key)) result[key] = true; else result[key] = values[++index]; } return result; }
