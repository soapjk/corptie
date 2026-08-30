import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, stat, statfs } from "node:fs/promises";
import os from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { contractError, evidenceHash } from "./receiptContracts.mjs";

const ROOT_MARKER = ".corptie-data-root.json";
const execFile = promisify(execFileCallback);

export class DataRootVerifier {
  constructor({ homeDirectory = os.homedir(), productionRoot = null, volumeInspector = defaultVolumeInspector, clock = () => new Date() } = {}) {
    this.homeDirectory = resolve(homeDirectory);
    this.productionRoot = productionRoot ? resolve(productionRoot) : null;
    this.volumeInspector = volumeInspector;
    this.clock = clock;
  }

  async verify(dataRoot, { reserveBytes = 0, softQuotaBytes = null, hardQuotaBytes = null } = {}) {
    assertLiteralAbsolutePath(dataRoot);
    await assertNoSymlinkSegments(dataRoot);
    const canonicalPath = await realpath(dataRoot);
    const forbidden = [this.homeDirectory, this.productionRoot, "/tmp", "/private/tmp", "/System", "/Library", "/Applications"].filter(Boolean);
    if (forbidden.some((root) => isSameOrDescendant(canonicalPath, root))) {
      throw contractError("DATA_ROOT_NOT_EXTERNAL", "Run isolation dataRoot overlaps a forbidden local or production root.");
    }
    await access(canonicalPath, constants.R_OK | constants.W_OK);
    const [rootInfo, filesystem, volume] = await Promise.all([stat(canonicalPath, { bigint: true }), statfs(canonicalPath, { bigint: true }), this.volumeInspector(canonicalPath)]);
    if (!volume.external || !volume.volumeUUID || !volume.mountPoint) {
      throw contractError("DATA_ROOT_NOT_EXTERNAL", "Run isolation requires a verified external volume.");
    }
    const availableBytes = Number(filesystem.bavail * filesystem.bsize);
    const requiredBytes = Number(reserveBytes);
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0 || availableBytes < requiredBytes) {
      throw contractError("DATA_ROOT_QUOTA_EXCEEDED", "External dataRoot does not have the configured reserve.");
    }
    const identity = {
      canonicalPathHash: sha256(canonicalPath), mountPathHash: sha256(volume.mountPoint), volumeUUID: volume.volumeUUID,
      deviceId: String(rootInfo.dev), rootInode: String(rootInfo.ino), filesystemType: volume.filesystemType,
      softQuotaBytes, hardQuotaBytes
    };
    const markerPath = join(canonicalPath, ROOT_MARKER);
    let marker;
    try { marker = JSON.parse(await readFile(markerPath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") throw contractError("DATA_ROOT_IDENTITY_CHANGED", "dataRoot marker is unreadable.");
      marker = { layoutVersion: 3, bindingId: `data_root_binding:${randomUUID()}`, markerNonce: randomUUID(), ...identity, createdAt: this.clock().toISOString() };
      const handle = await open(markerPath, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(marker)}\n`); await handle.sync(); } finally { await handle.close(); }
    }
    for (const field of ["canonicalPathHash", "mountPathHash", "volumeUUID", "deviceId", "rootInode", "filesystemType"]) {
      if (marker[field] !== identity[field]) throw contractError("DATA_ROOT_IDENTITY_CHANGED", `dataRoot ${field} changed since binding.`);
    }
    return Object.freeze({ ...marker, canonicalPath, verifiedAt: this.clock().toISOString(), availableBytes, evidenceHash: evidenceHash(identity) });
  }
}

export function deriveRunPaths(binding, { repositoryId = null, worktreeId = null, runId, mode }) {
  if (!binding?.canonicalPath || !runId || !["development", "test"].includes(mode)) throw new TypeError("Verified binding, runId and mode are required.");
  const repositorySlug = repositoryId ? slug("repository", repositoryId) : "non-repository";
  const worktreeSlug = worktreeId ? slug("worktree", worktreeId) : "non-worktree";
  const runSlug = slug(mode === "development" ? "development" : "run", runId);
  const worktreeRoot = join(binding.canonicalPath, "repositories", repositorySlug, "worktrees", worktreeSlug);
  const runRoot = mode === "development" ? join(worktreeRoot, "development") : join(worktreeRoot, "test-runs", runSlug);
  return Object.freeze({
    repositorySlug, worktreeSlug, runSlug, worktreeRoot, runRoot,
    markerPath: join(runRoot, ".run-owner.json"), databasePath: join(runRoot, "database", "corptie.sqlite"),
    dataDir: join(runRoot, "data"), cacheDir: join(runRoot, "cache"), indexDir: join(runRoot, "indexes"),
    tmpDir: join(runRoot, "tmp"), logDir: join(runRoot, "logs"), uploadDir: join(runRoot, "uploads"),
    queueDir: join(runRoot, "queues"), runtimeDir: join(runRoot, "runtime")
  });
}

export async function createRunDirectories(paths, marker) {
  for (const path of [dirname(paths.databasePath), paths.dataDir, paths.cacheDir, paths.indexDir, paths.tmpDir,
    paths.logDir, paths.uploadDir, paths.queueDir, paths.runtimeDir]) await mkdir(path, { recursive: true, mode: 0o700 });
  const runInfo=await stat(paths.runRoot,{bigint:true});
  const handle = await open(paths.markerPath, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify({...marker,runDeviceId:String(runInfo.dev),runInode:String(runInfo.ino)})}\n`); await handle.sync(); } finally { await handle.close(); }
}

export async function assertNoSymlinkSegments(path) {
  const absolute = resolve(path); let current = sep;
  for (const component of absolute.split(sep).filter(Boolean)) {
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw contractError("RUN_SYMLINK_FORBIDDEN", "A dataRoot path segment is a symbolic link.");
  }
}

export function assertLiteralAbsolutePath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value !== resolve(value) || /[\0*?{}[\]$]/u.test(value)) {
    throw contractError("RUN_PATH_OUT_OF_BOUNDS", "Path must be canonical, absolute and free of expansion syntax.");
  }
}

export function isSameOrDescendant(candidate, root) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function defaultVolumeInspector(path) {
  const match = resolve(path).match(/^\/Volumes\/([^/]+)(?:\/|$)/u);
  if (!match) return { external: false, volumeUUID: null, mountPoint: null, filesystemType: null };
  try {
    const volumeMountPoint = join("/Volumes", match[1]);
    const { stdout } = await execFile("/usr/sbin/diskutil", ["info", "-plist", volumeMountPoint], { maxBuffer: 1024 * 1024 });
    const value = (key) => stdout.match(new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]+)<\\/string>`))?.[1] ?? null;
    const internal = stdout.match(/<key>Internal<\/key>\s*<(true|false)\/>/)?.[1] === "true";
    const reportedMountPoint = value("MountPoint");
    if (reportedMountPoint !== volumeMountPoint) throw new Error("diskutil returned a different mount point");
    return { external: !internal, volumeUUID: value("VolumeUUID") ?? value("DiskUUID"), mountPoint: reportedMountPoint, filesystemType: value("FilesystemType") ?? value("TypeBundle") };
  } catch {
    throw contractError("DATA_ROOT_UNAVAILABLE", "External volume identity could not be verified with diskutil.");
  }
}

function slug(prefix, identity) { return `${prefix}-${sha256(identity).slice(0, 24)}`; }
function sha256(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
