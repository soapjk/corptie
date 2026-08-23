#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { CorptieStore } from "../apps/backend/src/store/corptieStore.mjs";

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(required(args.receipt, "--receipt"));
const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
const apply = args.apply === true;
const confirmed = args.confirmed === true;
const store = new CorptieStore({ dbPath: process.env.CORPTIE_DB_PATH || undefined });
await store.initialize();
try {
  const checks = [];
  for (const file of receipt.files ?? []) {
    const source = await readFile(file.path);
    const version = store.getArtifactVersion(file.artifactId, file.version);
    const tracked = await isGitTracked(receipt.sourceRoot, file.path);
    const ok = sha256(source) === file.contentHash && source.byteLength === file.byteLength
      && version?.contentHash === file.contentHash && version?.byteLength === file.byteLength && !tracked;
    checks.push({ path: file.path, artifactId: file.artifactId, ok, gitTracked: tracked });
  }
  if (!checks.every((check) => check.ok)) throw new Error("Cleanup refused: migration receipt, source hash, Artifact metadata, or Git status no longer matches.");
  const worktreeStatus = (await execFileAsync("git", ["-C", receipt.sourceRoot, "status", "--short"])).stdout.trim().split("\n").filter(Boolean);
  const nonSourceChanges = worktreeStatus.filter((line) => !receipt.files.some((file) => line.endsWith(file.path.slice(receipt.sourceRoot.length + 1))));
  if (apply && !confirmed) throw new Error("--apply requires --confirmed. This destructive action only removes the verified source documents, never the Worktree itself.");
  if (apply) for (const check of checks) await unlink(check.path);
  const audit = {
    cleanupId: `artifact-cleanup:${Date.now()}`, mode: apply ? "source-files-removed" : "dry-run",
    objectiveId: receipt.objectiveId, migrationReceiptId: receipt.receiptId, checkedAt: new Date().toISOString(),
    remoteWrite: false, checks, sourceFilesRemoved: apply, worktreeRemoved: false,
    remainingWorktreeChanges: nonSourceChanges,
    worktreeRemovalAllowed: nonSourceChanges.length === 0,
    note: "Worktree removal remains a separate Corptie Worktree operation and is never performed by this script."
  };
  if (args.audit) await writeFile(resolve(args.audit), JSON.stringify(audit, null, 2), { mode: 0o600, flag: "wx" });
  store.appendArtifactAudit({
    auditId: audit.cleanupId, artifactId: null, objectiveId: receipt.objectiveId,
    action: apply ? "artifact.migration_sources_removed" : "artifact.migration_cleanup_audited",
    actorId: "cleanup-tool", workItemId: receipt.workItemId, details: audit, createdAt: audit.checkedAt
  });
  console.log(JSON.stringify(audit, null, 2));
} finally { await store.close(); }

async function isGitTracked(root, path) { try { await execFileAsync("git", ["-C", root, "ls-files", "--error-unmatch", "--", path.slice(root.length + 1)]); return true; } catch (error) { if (error.code === 1 || error.code === 128) return false; throw error; } }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function required(value, flag) { if (!value) throw new Error(`${flag} is required.`); return value; }
function parseArgs(values) { const result = {}; for (let index = 0; index < values.length; index += 1) { const key = values[index].replace(/^--/, ""); if (["apply", "confirmed"].includes(key)) result[key] = true; else result[key] = values[++index]; } return result; }
