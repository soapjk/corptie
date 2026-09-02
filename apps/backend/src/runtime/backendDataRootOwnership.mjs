import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";

const LOCK_DIRECTORY_NAME = "backend-owner.lock";
const OWNER_FILE_NAME = "owner.json";
const INCOMPLETE_OWNER_GRACE_MS = 10_000;

export class BackendDataRootOwnershipError extends Error {
  constructor(message, owner = null) {
    super(message);
    this.name = "BackendDataRootOwnershipError";
    this.code = "BACKEND_DATA_ROOT_IN_USE";
    this.statusCode = 409;
    this.retryable = true;
    this.owner = safeOwner(owner);
  }
}

/**
 * Process-scoped, host-local ownership for one Corptie environment root.
 *
 * SQLite WAL permits multiple writers, but Provider runtimes and durable Turn
 * execution are intentionally single-owner resources. The atomic directory
 * claim prevents a second Backend on another port from presenting the same
 * Data Root while the first process still owns its Worker Sessions.
 */
export class BackendDataRootOwnership {
  static async acquire(options = {}) {
    const stateDirectory = resolveRequired(options.stateDirectory, "stateDirectory");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const lockDirectory = join(stateDirectory, LOCK_DIRECTORY_NAME);
    const ownerPath = join(lockDirectory, OWNER_FILE_NAME);
    const owner = Object.freeze({
      schemaVersion: 1,
      ownershipId: `backend-owner:${randomUUID()}`,
      pid: Number(options.pid ?? process.pid),
      hostname: String(options.hostname ?? os.hostname()),
      environment: String(options.environment ?? "production"),
      port: Number(options.port ?? 0),
      acquiredAt: String(options.acquiredAt ?? new Date().toISOString())
    });
    const processAlive = options.processAlive ?? defaultProcessAlive;
    const clock = options.clock ?? (() => Date.now());

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        return new BackendDataRootOwnership({ lockDirectory, ownerPath, owner });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      const existing = await readOwner(ownerPath);
      if (existing && await processAlive(existing.pid)) {
        throw new BackendDataRootOwnershipError(
          `Corptie Backend already owns this Data Root (pid ${existing.pid}, port ${existing.port || "unknown"}).`,
          existing
        );
      }

      if (!existing) {
        const age = await directoryAgeMilliseconds(lockDirectory, clock());
        if (age < INCOMPLETE_OWNER_GRACE_MS) {
          await delay(50);
          continue;
        }
      }
      await retireStaleLock(lockDirectory);
    }

    throw new BackendDataRootOwnershipError("Corptie Backend Data Root ownership could not be acquired safely.");
  }

  constructor({ lockDirectory, ownerPath, owner }) {
    this.lockDirectory = lockDirectory;
    this.ownerPath = ownerPath;
    this.owner = owner;
    this.released = false;
  }

  async release() {
    if (this.released) return false;
    const existing = await readOwner(this.ownerPath);
    if (existing?.ownershipId !== this.owner.ownershipId) {
      this.released = true;
      return false;
    }
    try { await unlink(this.ownerPath); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try { await rmdir(this.lockDirectory); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.released = true;
    return true;
  }
}

async function retireStaleLock(lockDirectory) {
  const retired = `${lockDirectory}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockDirectory, retired);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  try { await unlink(join(retired, OWNER_FILE_NAME)); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rmdir(retired);
}

async function readOwner(ownerPath) {
  try {
    const value = JSON.parse(await readFile(ownerPath, "utf8"));
    return Number.isSafeInteger(value?.pid) && value.pid > 0 ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function directoryAgeMilliseconds(path, now) {
  try {
    const info = await stat(path);
    return Math.max(0, now - info.mtimeMs);
  } catch (error) {
    if (error?.code === "ENOENT") return Number.POSITIVE_INFINITY;
    throw error;
  }
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function safeOwner(owner) {
  if (!owner) return null;
  return {
    pid: Number(owner.pid),
    hostname: String(owner.hostname ?? ""),
    environment: String(owner.environment ?? ""),
    port: Number(owner.port ?? 0),
    acquiredAt: String(owner.acquiredAt ?? "")
  };
}

function resolveRequired(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required.`);
  return resolve(value);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
