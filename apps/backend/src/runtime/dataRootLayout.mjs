import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  statfs,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export const DATA_ROOT_FIELD = "dataRoot";

export function defaultCorptieDataRoot(options = {}) {
  return resolve(options.homeDir ?? os.homedir(), ".corptie");
}

export function resolveDataRootLayout(dataRoot, environment = "production") {
  const root = resolveRequiredDirectory(dataRoot, "Data root");
  const environmentName = normalizeEnvironment(environment);
  const environmentRoot = environmentName === "development" ? join(root, "development") : root;
  return Object.freeze({
    dataRoot: root,
    environment: environmentName,
    environmentRoot,
    databaseDirectory: join(environmentRoot, "database"),
    databasePath: join(environmentRoot, "database", "corptie.sqlite"),
    configDirectory: join(environmentRoot, "config"),
    configPath: join(environmentRoot, "config", "settings.json"),
    logsDirectory: join(environmentRoot, "logs"),
    artifactsDirectory: join(environmentRoot, "artifacts"),
    runtimeDirectory: join(environmentRoot, "runtimes"),
    backupsDirectory: join(environmentRoot, "backups"),
    stateDirectory: join(environmentRoot, "state")
  });
}

export async function ensureDataRootLayout(layout) {
  for (const directory of [
    layout.dataRoot,
    layout.environmentRoot,
    layout.databaseDirectory,
    layout.configDirectory,
    layout.logsDirectory,
    layout.artifactsDirectory,
    layout.runtimeDirectory,
    layout.backupsDirectory,
    layout.stateDirectory
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

export async function migrateDataRoot({
  sourceLayout,
  targetLayout,
  sourceDatabase,
  keyTables = ["objectives", "work_items", "sessions", "artifact_versions"],
  beforeCommit,
  afterCommit,
  onPhase
}) {
  assertDistinctRoots(sourceLayout.dataRoot, targetLayout.dataRoot);
  await assertTargetEmpty(targetLayout.dataRoot);
  await assertAvailableSpace(sourceLayout.dataRoot, dirname(targetLayout.dataRoot));
  await mkdir(dirname(targetLayout.dataRoot), { recursive: true, mode: 0o700 });
  const stagingRoot = join(
    dirname(targetLayout.dataRoot),
    `.${basename(targetLayout.dataRoot)}.corptie-migration-${randomUUID()}`
  );
  const stagingLayout = resolveDataRootLayout(stagingRoot, targetLayout.environment);
  let committed = false;
  try {
    await onPhase?.("copying");
    await cp(sourceLayout.dataRoot, stagingRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      filter: (source) => !isSQLiteTransientPath(source, sourceLayout.databasePath)
    });
    await ensureDataRootLayout(stagingLayout);
    await mkdir(dirname(stagingLayout.databasePath), { recursive: true, mode: 0o700 });
    await backup(sourceDatabase, stagingLayout.databasePath);
    await syncFile(stagingLayout.databasePath);

    await onPhase?.("verifying");
    const verification = await verifyMigratedDataRoot({
      sourceLayout,
      targetLayout: stagingLayout,
      keyTables
    });
    if (beforeCommit) await beforeCommit({ stagingLayout, verification });
    await onPhase?.("switching");
    if (await pathExists(targetLayout.dataRoot)) await rmdir(targetLayout.dataRoot);
    await rename(stagingRoot, targetLayout.dataRoot);
    committed = true;
    const committedLayout = resolveDataRootLayout(targetLayout.dataRoot, targetLayout.environment);
    if (afterCommit) await afterCommit({ targetLayout: committedLayout, verification });
    return { ...verification, sourceDataRoot: sourceLayout.dataRoot, dataRoot: committedLayout.dataRoot };
  } catch (error) {
    error.migrationStagingRoot = stagingRoot;
    error.migrationCommitted = committed;
    throw error;
  }
}

export async function preflightDataRootMigration({ sourceLayout, targetLayout }) {
  assertDistinctRoots(sourceLayout.dataRoot, targetLayout.dataRoot);
  await assertTargetEmpty(targetLayout.dataRoot);
  await mkdir(dirname(targetLayout.dataRoot), { recursive: true, mode: 0o700 });
  const space = await assertAvailableSpace(sourceLayout.dataRoot, dirname(targetLayout.dataRoot));
  return { sourceBytes: space.sourceBytes, availableBytes: space.availableBytes };
}

export async function verifyMigratedDataRoot({ sourceLayout, targetLayout, keyTables = [] }) {
  const sourceDb = new DatabaseSync(sourceLayout.databasePath, { readOnly: true });
  const targetDb = new DatabaseSync(targetLayout.databasePath, { readOnly: true });
  try {
    assertDatabaseIntegrity(sourceDb, "source");
    assertDatabaseIntegrity(targetDb, "target");
    const keyRecordCounts = {};
    for (const table of keyTables) {
      const sourceCount = tableCount(sourceDb, table);
      const targetCount = tableCount(targetDb, table);
      if (sourceCount !== targetCount) {
        throw migrationError("DATA_ROOT_DATABASE_MISMATCH", `Database record count differs for ${table}: ${sourceCount} != ${targetCount}.`);
      }
      keyRecordCounts[table] = targetCount;
    }
    const artifactResult = await verifyArtifacts(targetDb, targetLayout.artifactsDirectory);
    const fileResult = await verifyCopiedFiles(sourceLayout, targetLayout);
    return {
      databaseIntegrity: "ok",
      keyRecordCounts,
      artifactCount: artifactResult.count,
      artifactBytes: artifactResult.bytes,
      verifiedFileCount: fileResult.count,
      verifiedFileBytes: fileResult.bytes
    };
  } finally {
    sourceDb.close();
    targetDb.close();
  }
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await syncFile(temporaryPath);
  await rename(temporaryPath, path);
}

function resolveRequiredDirectory(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required.`);
  const trimmed = value.trim();
  if (!isAbsolute(trimmed)) throw new TypeError(`${label} must be an absolute path.`);
  return resolve(trimmed);
}

function assertDistinctRoots(source, target) {
  const from = resolve(source);
  const to = resolve(target);
  if (from === to) throw migrationError("DATA_ROOT_UNCHANGED", "The requested data root is already active.");
  if (to.startsWith(`${from}${sep}`) || from.startsWith(`${to}${sep}`)) {
    throw migrationError("DATA_ROOT_NESTED", "The new data root cannot contain, or be contained by, the active data root.");
  }
}

async function assertTargetEmpty(path) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw migrationError("DATA_ROOT_TARGET_INVALID", "The new data root exists and is not a directory.");
    if ((await readdir(path)).length > 0) {
      throw migrationError("DATA_ROOT_TARGET_NOT_EMPTY", "The new data root must be empty so existing files are never overwritten.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function assertAvailableSpace(sourceRoot, targetParent) {
  const [sourceBytes, filesystem] = await Promise.all([
    directoryBytes(sourceRoot),
    statfs(targetParent)
  ]);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  // SQLite backup and copy-on-write files can briefly require more than the
  // exact source size. Keep a bounded 10% margin plus 64 MiB.
  const requiredBytes = Math.ceil(sourceBytes * 1.1) + 64 * 1024 * 1024;
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    const error = migrationError("DATA_ROOT_INSUFFICIENT_SPACE", "The target filesystem does not have enough free space for a verified migration.");
    error.statusCode = 507;
    error.details = { sourceBytes, requiredBytes, availableBytes };
    throw error;
  }
  return { sourceBytes, requiredBytes, availableBytes };
}

async function directoryBytes(root) {
  let bytes = 0;
  for (const path of await listFiles(root)) bytes += Number((await stat(path)).size);
  return bytes;
}

function isSQLiteTransientPath(path, databasePath) {
  const resolved = resolve(path);
  return resolved === resolve(databasePath)
    || resolved === `${resolve(databasePath)}-wal`
    || resolved === `${resolve(databasePath)}-shm`;
}

function assertDatabaseIntegrity(database, label) {
  const result = database.prepare("PRAGMA quick_check").get();
  if (result?.quick_check !== "ok") {
    throw migrationError("DATA_ROOT_DATABASE_INTEGRITY_FAILED", `${label} database failed SQLite quick_check.`);
  }
}

function tableCount(database, table) {
  if (!/^[a-z][a-z0-9_]*$/i.test(table)) throw new TypeError(`Unsafe table name: ${table}`);
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return exists ? Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0) : 0;
}

async function verifyArtifacts(database, artifactsDirectory) {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_versions'").get();
  if (!exists) return { count: 0, bytes: 0 };
  const versions = database.prepare(
    "SELECT storage_key, content_hash, byte_length FROM artifact_versions WHERE storage_key IS NOT NULL"
  ).all();
  let bytes = 0;
  for (const version of versions) {
    const path = safeDescendant(artifactsDirectory, String(version.storage_key));
    const content = await readFile(path);
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== version.content_hash || content.byteLength !== Number(version.byte_length)) {
      throw migrationError("DATA_ROOT_ARTIFACT_INTEGRITY_FAILED", `Artifact content failed hash or length verification: ${version.storage_key}`);
    }
    bytes += content.byteLength;
  }
  return { count: versions.length, bytes };
}

async function verifyCopiedFiles(sourceLayout, targetLayout) {
  const sourceFiles = await listFiles(sourceLayout.dataRoot);
  let count = 0;
  let bytes = 0;
  for (const sourcePath of sourceFiles) {
    if (isSQLiteTransientPath(sourcePath, sourceLayout.databasePath)) continue;
    const relativePath = relative(sourceLayout.dataRoot, sourcePath);
    const targetPath = safeDescendant(targetLayout.dataRoot, relativePath);
    const [sourceHash, targetHash] = await Promise.all([fileHash(sourcePath), fileHash(targetPath)]);
    if (sourceHash.hash !== targetHash.hash || sourceHash.bytes !== targetHash.bytes) {
      throw migrationError("DATA_ROOT_FILE_INTEGRITY_FAILED", `Migrated file failed integrity verification: ${relativePath}`);
    }
    count += 1;
    bytes += targetHash.bytes;
  }
  return { count, bytes };
}

async function listFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  if (await pathExists(root)) await visit(root);
  return result;
}

async function fileHash(path) {
  const content = await readFile(path);
  return { hash: createHash("sha256").update(content).digest("hex"), bytes: content.byteLength };
}

function safeDescendant(root, child) {
  const base = resolve(root);
  const path = resolve(base, child);
  if (path !== base && !path.startsWith(`${base}${sep}`)) {
    throw migrationError("DATA_ROOT_PATH_ESCAPE", `Persistent path escapes the data root: ${child}`);
  }
  return path;
}

async function syncFile(path) {
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function normalizeEnvironment(value = "") {
  const normalized = String(value || "").toLowerCase();
  return normalized === "dev" || normalized === "development" ? "development" : "production";
}
