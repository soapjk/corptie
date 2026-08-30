import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { inspectGitWorkspace } from "../../src/utils/gitWorktreeInventory.mjs";
import { signReceipt } from "../../src/project-code/projectCodeContracts.mjs";

const execFileAsync = promisify(execFile);

export async function createProjectCodeFixture(options = {}) {
  const directory = await mkdtemp(join(options.parent ?? tmpdir(), "corptie-project-code-"));
  await git(directory, ["init", "-q"]);
  await git(directory, ["config", "user.email", "tests@corptie.local"]);
  await git(directory, ["config", "user.name", "Corptie Tests"]);
  const files = options.files ?? {
    "Sources/App.swift": "struct SearchFixture {\n  func exactNeedle() {}\n}\n",
    "Sources/tool.ts": "export function layeredSymbol() { return 'needle'; }\n",
    ".gitignore": "ignored/\n.build/\n"
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-qm", "fixture"]);
  const identity = await inspectGitWorkspace(directory);
  const [commitOid, treeOid] = await Promise.all([
    git(directory, ["rev-parse", "HEAD"]), git(directory, ["rev-parse", "HEAD^{tree}"])
  ]);
  const sessionContext = {
    objectiveId: "objective:test", workItemId: "work_item:test", logicalSessionId: "logical:test"
  };
  const binding = {
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    canonicalWorktreePath: identity.canonicalPath,
    providerBindingId: "provider_binding:test",
    bindingGeneration: 1,
    repositoryInventoryVersion: "inventory:test",
    workspaceResourceVersion: 1,
    resourceVersion: 1
  };
  const startupReceipt = startupReceiptFor({ identity, commitOid, treeOid, sessionContext, binding });
  return { directory, identity, commitOid, treeOid, sessionContext, binding, startupReceipt };
}

export function startupReceiptFor({ identity, commitOid, treeOid, sessionContext, binding }) {
  const now = "2026-08-30T00:00:00.000Z";
  return signReceipt({
    schemaVersion: 2,
    status: "ready",
    startupOperationId: "startup:test",
    ...sessionContext,
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    canonicalWorktreePath: identity.canonicalPath,
    headIdentity: { kind: "branch", branch: "master" },
    providerBindingId: binding.providerBindingId,
    bindingGeneration: binding.bindingGeneration,
    sourceCommitOid: commitOid,
    sourceTreeOid: treeOid,
    baseRef: "HEAD",
    repositoryInventoryVersion: binding.repositoryInventoryVersion,
    workspaceResourceVersion: binding.workspaceResourceVersion,
    resourceVersion: binding.resourceVersion,
    providerContextHash: "a".repeat(64),
    phaseTimestamps: { allocatedAt: now, worktreePreparedAt: now, sessionBoundAt: now, providerBoundAt: now, readyAt: now },
    compensation: { attempted: false, result: "not_required", completedSteps: [], failedStep: null },
    error: null
  });
}

export async function git(directory, args) {
  const { stdout } = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return stdout.trim();
}
