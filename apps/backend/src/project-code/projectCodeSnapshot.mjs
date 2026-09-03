import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { inspectGitWorkspace } from "../utils/gitWorktreeInventory.mjs";
import {
  STARTUP_BINDING_ARTIFACT,
  contractError,
  createReceiptId,
  hashCanonical,
  sha256Hex,
  signReceipt,
  snapshotArtifactRef,
  startupBindingRef,
  validateProjectCodeReceipt,
  verifyReceiptHash
} from "./projectCodeContracts.mjs";
import {
  PROJECT_CODE_EXCLUSION_REVISION,
  defaultExclusionReason,
  isDescendant,
  normalizeRelativePath,
  rejectedPathFact
} from "./projectCodePaths.mjs";

const execFileAsync = promisify(execFile);
const startupFields = new Set([
  "schemaVersion", "status", "startupOperationId", "workId", "taskId", "logicalSessionId",
  "repositoryId", "worktreeId", "canonicalWorktreePath", "headIdentity", "providerBindingId",
  "bindingGeneration", "sourceCommitOid", "sourceTreeOid", "baseRef", "repositoryInventoryVersion",
  "workspaceResourceVersion", "resourceVersion", "providerContextHash", "toolContractHash",
  "instructionSourcesHash", "phaseTimestamps",
  "compensation", "error", "receiptHash"
]);

export class StartupBindingReceiptConsumer {
  constructor(options = {}) {
    this.inspectWorkspace = options.inspectWorkspace ?? inspectGitWorkspace;
    this.runGit = options.runGit ?? runGit;
  }

  async verify(receipt, binding, sessionContext, options = {}) {
    assertStartupAuthority(receipt, binding, sessionContext);
    const checked = await this.inspectWorkspace(receipt.canonicalWorktreePath, options);
    assertWorkspaceIdentity(receipt, checked);
    const [commitOid, treeOid] = parseSourceIdentity(await this.runGit(
      receipt.canonicalWorktreePath, ["rev-parse", "HEAD", "HEAD^{tree}"], options
    ));
    if (commitOid !== receipt.sourceCommitOid || treeOid !== receipt.sourceTreeOid) {
      throw contractError("STARTUP_SOURCE_CHANGED", "The authoritative Worktree HEAD changed after StartupBindingReceipt was issued.");
    }
    return Object.freeze({ receipt, workspace: checked, commitOid, treeOid });
  }

  async verifyCurrent(receipt, binding, sessionContext, workspace, options = {}) {
    assertStartupAuthority(receipt, binding, sessionContext);
    await assertKnownWorkspaceIdentity(receipt, workspace);
    const [commitOid, treeOid] = parseSourceIdentity(await this.runGit(
      receipt.canonicalWorktreePath, ["rev-parse", "HEAD", "HEAD^{tree}"], options
    ));
    if (commitOid !== receipt.sourceCommitOid || treeOid !== receipt.sourceTreeOid) {
      throw contractError("STARTUP_SOURCE_CHANGED", "The authoritative Worktree HEAD changed after StartupBindingReceipt was issued.");
    }
    return true;
  }
}

export class RepositorySourceSnapshotBuilder {
  constructor(options = {}) {
    this.startupConsumer = options.startupConsumer ?? new StartupBindingReceiptConsumer(options);
    this.runGit = options.runGit ?? runGit;
    this.now = options.now ?? (() => new Date().toISOString());
    this.receiptId = options.receiptId ?? (() => createReceiptId("snapshot"));
  }

  async build(input) {
    const verified = await this.startupConsumer.verify(
      input.startupReceipt, input.binding, input.sessionContext, { signal: input.signal }
    );
    throwIfAborted(input.signal);
    const root = verified.workspace.canonicalPath;
    const declarations = normalizeDeclarations(input.sourceDeclarations ?? []);
    const [overlay, ignoreConfig, scope] = await Promise.all([
      collectDirtyOverlay(root, { runGit: this.runGit, signal: input.signal, declarations }),
      collectIgnoreConfigRevision(root, { runGit: this.runGit, signal: input.signal, declarations }),
      resolveCandidateCatalog(root, { runGit: this.runGit, signal: input.signal, declarations })
    ]);
    throwIfAborted(input.signal);
    const fingerprintPayload = {
      schemaVersion: "source-fingerprint/v2",
      repositoryId: input.startupReceipt.repositoryId,
      worktreeId: input.startupReceipt.worktreeId,
      commitOid: input.startupReceipt.sourceCommitOid,
      treeOid: input.startupReceipt.sourceTreeOid,
      overlayManifest: overlay.entries,
      ignoreConfigRevision: ignoreConfig.payload
    };
    const sourceFingerprint = hashCanonical(fingerprintPayload);
    const fields = {
      receiptId: this.receiptId(),
      schemaVersion: 1,
      resourceVersion: 1,
      artifactRef: snapshotArtifactRef(),
      startupBindingRef: startupBindingRef(input.startupReceipt),
      workId: input.startupReceipt.workId,
      taskId: input.startupReceipt.taskId,
      logicalSessionId: input.startupReceipt.logicalSessionId,
      repositoryId: input.startupReceipt.repositoryId,
      worktreeId: input.startupReceipt.worktreeId,
      sourceCommitOid: input.startupReceipt.sourceCommitOid,
      sourceTreeOid: input.startupReceipt.sourceTreeOid,
      dirtyOverlayRef: {
        schemaVersion: 1,
        manifestHash: hashCanonical(overlay.entries),
        entryCount: overlay.entries.length,
        tombstoneCount: overlay.entries.filter((entry) => entry.state === "tombstone").length,
        opaqueLocalLocatorHash: hashCanonical({ repositoryId: input.startupReceipt.repositoryId, worktreeId: input.startupReceipt.worktreeId, kind: "overlay" })
      },
      ignoreConfigRevisionRef: {
        schemaVersion: 1,
        revisionHash: hashCanonical(ignoreConfig.payload),
        sourceCount: ignoreConfig.sources.length,
        opaqueLocalLocatorHash: hashCanonical({ repositoryId: input.startupReceipt.repositoryId, worktreeId: input.startupReceipt.worktreeId, kind: "ignore" })
      },
      scopeRootHash: sha256Hex(Buffer.from(root.normalize("NFC"), "utf8")),
      sourceFingerprint,
      createdAt: this.now()
    };
    const receipt = signReceipt(fields);
    await validateProjectCodeReceipt(receipt, "RepositorySourceSnapshotReceipt");
    return Object.freeze({
      receipt,
      candidates: scope.candidates,
      rejectedPaths: [...scope.rejectedPaths, ...overlay.rejectedPaths],
      overlayEntries: overlay.entries,
      fingerprintPayload,
      canonicalWorktreePath: root,
      declarations,
      workspaceIdentity: Object.freeze({ ...verified.workspace }),
      ignoreConfigSources: ignoreConfig.localSources,
      startupReceipt: input.startupReceipt,
      binding: input.binding,
      sessionContext: input.sessionContext
    });
  }

  async assertCurrent(snapshot, options = {}) {
    const [, overlay, ignoreConfig] = await Promise.all([
      this.startupConsumer.verifyCurrent(
        snapshot.startupReceipt, snapshot.binding, snapshot.sessionContext, snapshot.workspaceIdentity, { signal: options.signal }
      ).then(() => null),
      collectDirtyOverlay(snapshot.canonicalWorktreePath, { runGit: this.runGit, signal: options.signal, declarations: snapshot.declarations }),
      collectCurrentIgnoreConfigRevision(snapshot.ignoreConfigSources, snapshot.declarations)
    ]);
    if (hashCanonical(overlay.entries) !== snapshot.receipt.dirtyOverlayRef.manifestHash
      || overlay.ignoreConfigChanges.some((path) => !snapshot.ignoreConfigSources.some((source) => source.relativePath === path))
      || hashCanonical(ignoreConfig.payload) !== snapshot.receipt.ignoreConfigRevisionRef.revisionHash) {
      throw contractError("SOURCE_SNAPSHOT_STALE", "Worktree overlay or project-code configuration changed after Snapshot preflight.");
    }
    return true;
  }
}

export async function resolveCandidateCatalog(root, options = {}) {
  const raw = await options.runGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], options);
  const paths = raw.split("\0").filter(Boolean).sort(compareUtf8);
  const candidates = [];
  const rejectedPaths = [];
  for (const value of paths) {
    throwIfAborted(options.signal);
    let path;
    try {
      path = normalizeRelativePath(value);
    } catch (error) {
      rejectedPaths.push(error.rejectedPath ?? rejectedPathFact(value, "PATH_INVALID"));
      continue;
    }
    const declaration = declarationFor(path, options.declarations);
    if (options.declarations.length > 0 && !declaration) continue;
    const exclusion = defaultExclusionReason(path, { generatedAllowed: declaration?.generatedAllowed });
    if (exclusion) {
      rejectedPaths.push(rejectedPathFact(path, exclusion, { revealRelative: true }));
      continue;
    }
    const absolutePath = join(root, path);
    try {
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        rejectedPaths.push(rejectedPathFact(path, "SYMLINK_FORBIDDEN", { revealRelative: true }));
      } else if (info.isFile()) {
        candidates.push(Object.freeze({ path, absolutePath, byteLength: info.size, language: declaration?.language ?? inferLanguage(path) }));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") rejectedPaths.push(rejectedPathFact(path, "PATH_UNAVAILABLE", { revealRelative: true }));
    }
  }
  return { candidates: Object.freeze(candidates), rejectedPaths: Object.freeze(rejectedPaths) };
}

export async function collectDirtyOverlay(root, options = {}) {
  const raw = await options.runGit(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--renames"], options);
  const parsed = parsePorcelainV2(raw);
  const ignoreConfigChanges = [...new Set(parsed.flatMap((item) => [item.path, item.oldPath])
    .filter((path) => path && (path === ".gitignore" || path.endsWith("/.gitignore"))))].sort(compareUtf8);
  const entries = [];
  const rejectedPaths = [];
  for (const item of parsed) {
    throwIfAborted(options.signal);
    const declaration = declarationFor(item.path, options.declarations);
    const exclusion = defaultExclusionReason(item.path, { generatedAllowed: declaration?.generatedAllowed });
    if (exclusion || (options.declarations.length > 0 && !declaration)) {
      rejectedPaths.push(rejectedPathFact(item.path, exclusion ?? "SOURCE_DECLARATION_EXCLUDED", { revealRelative: true }));
      continue;
    }
    if (item.state === "rename") {
      const renameGroupId = hashCanonical({ oldPath: item.oldPath, path: item.path });
      entries.push(tombstoneEntry(item.oldPath, item.stageState, renameGroupId));
      const content = await hashVisiblePath(root, item.path);
      entries.push(overlayEntry({ ...item, ...content, oldPath: item.oldPath, renameGroupId }));
    } else if (item.state === "delete") {
      entries.push(tombstoneEntry(item.path, item.stageState, null));
    } else {
      const content = await hashVisiblePath(root, item.path);
      entries.push(overlayEntry({ ...item, ...content, oldPath: null, renameGroupId: null }));
    }
  }
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  return {
    entries: Object.freeze(entries),
    rejectedPaths: Object.freeze(rejectedPaths),
    ignoreConfigChanges: Object.freeze(ignoreConfigChanges)
  };
}

export async function collectIgnoreConfigRevision(root, options = {}) {
  const raw = await options.runGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.gitignore", ".gitignore"], options);
  const names = raw.split("\0").filter(Boolean).sort(compareUtf8);
  const sources = [];
  const localSources = [];
  for (const name of names) {
    const path = join(root, name);
    localSources.push(Object.freeze({ kind: "gitignore", relativePath: name, absolutePath: path }));
    try {
      const content = await readStableFile(path);
      sources.push({ kind: "gitignore", pathHash: sha256Hex(Buffer.from(name.normalize("NFC"))), contentHash: sha256Hex(content) });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const gitDir = await options.runGit(root, ["rev-parse", "--git-path", "info/exclude"], options);
  const path = resolve(root, gitDir);
  localSources.push(Object.freeze({ kind: "repository_exclude", relativePath: "git/info/exclude", absolutePath: path }));
  try {
    const content = await readStableFile(path);
    sources.push({ kind: "repository_exclude", pathHash: sha256Hex(Buffer.from("git/info/exclude")), contentHash: sha256Hex(content) });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const declarationsHash = hashCanonical(options.declarations ?? []);
  const payload = { schemaVersion: PROJECT_CODE_EXCLUSION_REVISION, sources, declarationsHash };
  return { payload, sources, localSources: Object.freeze(localSources) };
}

async function collectCurrentIgnoreConfigRevision(localSources = [], declarations = []) {
  const sources = [];
  for (const source of localSources) {
    try {
      const content = await readStableFile(source.absolutePath);
      sources.push({
        kind: source.kind,
        pathHash: sha256Hex(Buffer.from(source.relativePath.normalize("NFC"))),
        contentHash: sha256Hex(content)
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return {
    payload: { schemaVersion: PROJECT_CODE_EXCLUSION_REVISION, sources, declarationsHash: hashCanonical(declarations) },
    sources
  };
}

export function parsePorcelainV2(raw) {
  const fields = raw.split("\0");
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const line = fields[index];
    if (!line) continue;
    if (line.startsWith("? ")) {
      entries.push({ path: normalizeRelativePath(line.slice(2)), state: "add", stageState: "??" });
    } else if (line.startsWith("1 ")) {
      const match = line.match(/^1 (\S{2}) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.+)$/s);
      if (!match) throw contractError("SOURCE_SNAPSHOT_STALE", "Git returned an invalid porcelain v2 ordinary entry.");
      const xy = match[1];
      const path = normalizeRelativePath(match[8]);
      const state = xy.includes("D") ? "delete" : xy.includes("T") ? "typechange" : xy.includes("A") ? "add" : "modify";
      entries.push({ path, state, stageState: xy });
    } else if (line.startsWith("2 ")) {
      const match = line.match(/^2 (\S{2}) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.+)$/s);
      if (!match || !fields[index + 1]) throw contractError("SOURCE_SNAPSHOT_STALE", "Git returned an invalid porcelain v2 rename entry.");
      entries.push({ path: normalizeRelativePath(match[9]), oldPath: normalizeRelativePath(fields[++index]), state: "rename", stageState: match[1] });
    } else if (line.startsWith("u ")) {
      throw contractError("SOURCE_SNAPSHOT_STALE", "Unmerged source state cannot produce an authoritative Snapshot.");
    }
  }
  return entries;
}

async function hashVisiblePath(root, path) {
  const absolutePath = join(root, normalizeRelativePath(path));
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) {
    const target = await readlink(absolutePath, { encoding: "buffer" });
    return { mode: `120000`, byteLength: target.byteLength, contentHash: sha256Hex(target) };
  }
  if (!info.isFile()) return { mode: info.mode.toString(8), byteLength: 0, contentHash: sha256Hex(Buffer.alloc(0)) };
  const content = await readStableFile(absolutePath);
  return { mode: (info.mode & 0o777777).toString(8), byteLength: content.byteLength, contentHash: sha256Hex(content) };
}

async function readStableFile(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      const content = await handle.readFile();
      const after = await handle.stat();
      if (before.dev === after.dev && before.ino === after.ino && before.size === after.size
        && before.mtimeMs === after.mtimeMs) return content;
    } finally {
      await handle.close();
    }
  }
  throw contractError("SOURCE_SNAPSHOT_STALE", "Source changed while Snapshot content was hashed.");
}

function overlayEntry(item) {
  return Object.freeze({
    path: item.path.normalize("NFC"), state: item.state, oldPath: item.oldPath?.normalize("NFC") ?? null,
    mode: item.mode, byteLength: item.byteLength, contentHash: item.contentHash,
    stageState: item.stageState, renameGroupId: item.renameGroupId
  });
}

function tombstoneEntry(path, stageState, renameGroupId) {
  return Object.freeze({
    path: path.normalize("NFC"), state: "tombstone", oldPath: null, mode: "0", byteLength: 0,
    contentHash: sha256Hex(Buffer.alloc(0)), stageState, renameGroupId
  });
}

function normalizeDeclarations(declarations) {
  return declarations.map((entry) => {
    const path = normalizeRelativePath(entry.path);
    return Object.freeze({ path, language: entry.language ? String(entry.language) : null, generatedAllowed: entry.generatedAllowed === true });
  }).sort((left, right) => compareUtf8(left.path, right.path));
}

function declarationFor(path, declarations = []) {
  return declarations.find((entry) => path === entry.path || path.startsWith(`${entry.path}/`)) ?? null;
}

function inferLanguage(path) {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  return ({ swift: "swift", m: "work-c", mm: "work-cpp", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript", py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", cc: "cpp", json: "json", md: "markdown" })[extension] ?? "text";
}

function assertExactStartupShape(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw contractError("STARTUP_BINDING_MISMATCH", "Startup receipt must be an object.");
  for (const field of startupFields) if (!Object.hasOwn(receipt, field)) throw contractError("STARTUP_BINDING_MISMATCH", `Startup receipt is missing ${field}.`);
  for (const field of Object.keys(receipt)) if (!startupFields.has(field)) throw contractError("STARTUP_BINDING_MISMATCH", `Startup receipt has unknown field ${field}.`);
  if (receipt.compensation?.attempted !== false || receipt.compensation?.result !== "not_required") {
    throw contractError("STARTUP_BINDING_MISMATCH", "A compensated Startup receipt cannot authorize project-code search.");
  }
  if (!Number.isInteger(receipt.bindingGeneration) || receipt.bindingGeneration < 1) throw contractError("STARTUP_BINDING_MISMATCH", "Startup bindingGeneration is invalid.");
  if (!/^[0-9a-f]{64}$/.test(receipt.toolContractHash) || !/^[0-9a-f]{64}$/.test(receipt.instructionSourcesHash)) {
    throw contractError("STARTUP_BINDING_MISMATCH", "Startup activation proof hashes are invalid.");
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(receipt.sourceCommitOid) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(receipt.sourceTreeOid)) {
    throw contractError("STARTUP_BINDING_MISMATCH", "Startup source identity is invalid.");
  }
}

function assertStartupAuthority(receipt, binding, sessionContext) {
  assertExactStartupShape(receipt);
  verifyReceiptHash(receipt, "STARTUP_RECEIPT_HASH_MISMATCH");
  if (receipt.schemaVersion !== 2 || receipt.status !== "ready" || receipt.error !== null) {
    throw contractError("STARTUP_BINDING_MISMATCH", "Startup binding is not an approved ready schemaVersion 2 receipt.");
  }
  for (const field of ["workId", "taskId", "logicalSessionId"]) {
    if (receipt[field] !== sessionContext?.[field]) {
      throw contractError("STARTUP_BINDING_MISMATCH", `Startup ${field} does not match the authenticated Session binding.`);
    }
  }
  for (const field of ["repositoryId", "worktreeId", "providerBindingId", "bindingGeneration",
    "repositoryInventoryVersion", "workspaceResourceVersion", "resourceVersion"]) {
    if (binding && receipt[field] !== binding[field]) {
      throw contractError("STARTUP_BINDING_MISMATCH", `Startup ${field} is stale.`);
    }
  }
  if (binding?.canonicalWorktreePath && resolve(binding.canonicalWorktreePath) !== resolve(receipt.canonicalWorktreePath)) {
    throw contractError("STARTUP_BINDING_MISMATCH", "Startup canonical Worktree path is stale.");
  }
}

function assertWorkspaceIdentity(receipt, workspace) {
  if (!workspace || workspace.repositoryId !== receipt.repositoryId || workspace.worktreeId !== receipt.worktreeId
    || resolve(workspace.canonicalPath) !== resolve(receipt.canonicalWorktreePath)) {
    throw contractError("STARTUP_BINDING_MISMATCH", "Startup Worktree identity no longer matches Git inventory.");
  }
}

async function assertKnownWorkspaceIdentity(receipt, workspace) {
  assertWorkspaceIdentity(receipt, workspace);
  let canonicalPath;
  let gitDirCanonicalPath;
  let commonGitDirCanonicalPath;
  try {
    canonicalPath = await realpath(receipt.canonicalWorktreePath);
    const markerPath = join(canonicalPath, ".git");
    const marker = await lstat(markerPath);
    if (marker.isDirectory()) {
      gitDirCanonicalPath = await realpath(markerPath);
    } else if (marker.isFile()) {
      const content = String(await readFile(markerPath, "utf8"));
      const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
      if (!match?.[1]) throw new Error("invalid .git marker");
      gitDirCanonicalPath = await realpath(resolve(dirname(markerPath), match[1]));
    } else {
      throw new Error("unsupported .git marker");
    }
    try {
      const common = String(await readFile(join(gitDirCanonicalPath, "commondir"), "utf8")).trim();
      if (!common) throw new Error("empty commondir");
      commonGitDirCanonicalPath = await realpath(resolve(gitDirCanonicalPath, common));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      commonGitDirCanonicalPath = gitDirCanonicalPath;
    }
  } catch {
    throw contractError("STARTUP_BINDING_MISMATCH", "Startup Worktree identity is no longer readable from its authoritative Git marker.");
  }
  if (resolve(canonicalPath) !== resolve(workspace.canonicalPath)
    || resolve(gitDirCanonicalPath) !== resolve(workspace.gitDirCanonicalPath)
    || resolve(commonGitDirCanonicalPath) !== resolve(workspace.commonGitDirCanonicalPath)) {
    throw contractError("STARTUP_BINDING_MISMATCH", "Startup Worktree Git identity changed after Snapshot preflight.");
  }
}

function parseSourceIdentity(raw) {
  const values = String(raw).split(/\r?\n/).filter(Boolean);
  if (values.length !== 2 || values.some((value) => !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value))) {
    throw contractError("STARTUP_SOURCE_CHANGED", "Git returned an invalid authoritative HEAD/tree identity.");
  }
  return values;
}

async function runGit(root, args, options = {}) {
  throwIfAborted(options.signal);
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8", maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, signal: options.signal,
    env: minimalGitEnvironment()
  });
  return args.includes("-z") ? stdout : stdout.trim();
}

function minimalGitEnvironment() {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0"
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Project-code operation was cancelled.");
  error.name = "AbortError";
  error.code = "QUERY_CANCELLED";
  throw error;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

export const PROJECT_CODE_STARTUP_CONTRACT = Object.freeze({ ...STARTUP_BINDING_ARTIFACT, schemaVersion: 2 });
