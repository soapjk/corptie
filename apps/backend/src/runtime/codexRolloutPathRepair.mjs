import { access, stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SESSION_PATH_MARKER = `${sep}sessions${sep}`;

export async function repairRelocatedCodexRolloutPaths(codexHome, options = {}) {
  const runtimeHome = resolveRequiredPath(codexHome, "Codex runtime home");
  const statePath = resolve(options.statePath ?? join(runtimeHome, "state_5.sqlite"));
  if (!await pathExists(statePath)) return emptyResult(statePath, "state_database_missing");

  const database = new DatabaseSync(statePath);
  try {
    const threadsTable = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'threads'"
    ).get();
    if (!threadsTable) return emptyResult(statePath, "threads_table_missing");

    const columns = new Set(database.prepare("PRAGMA table_info(threads)").all().map((row) => row.name));
    if (!columns.has("id") || !columns.has("rollout_path")) {
      return emptyResult(statePath, "rollout_columns_missing");
    }

    const repairs = [];
    for (const row of database.prepare("SELECT id, rollout_path FROM threads").all()) {
      const candidate = await relocatedRolloutCandidate(runtimeHome, row);
      if (candidate) repairs.push({ id: row.id, from: row.rollout_path, to: candidate });
    }
    if (repairs.length === 0) return { ...emptyResult(statePath, null), checked: true };

    const update = database.prepare(
      "UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?"
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const repair of repairs) {
        const result = update.run(repair.to, repair.id, repair.from);
        if (Number(result.changes ?? 0) !== 1) {
          throw rolloutRepairError(
            "CODEX_ROLLOUT_PATH_REPAIR_CONFLICT",
            `Codex rollout path changed while repairing thread ${repair.id}.`
          );
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return { statePath, checked: true, repairedCount: repairs.length, repairs };
  } catch (cause) {
    if (cause?.code?.startsWith?.("CODEX_ROLLOUT_PATH_")) throw cause;
    const error = rolloutRepairError(
      "CODEX_ROLLOUT_PATH_REPAIR_FAILED",
      `Codex rollout path recovery failed for ${statePath}: ${cause?.message ?? cause}`
    );
    error.cause = cause;
    throw error;
  } finally {
    database.close();
  }
}

async function relocatedRolloutCandidate(runtimeHome, row) {
  if (typeof row?.id !== "string" || !row.id.trim()
      || typeof row?.rollout_path !== "string" || !row.rollout_path.trim()) return null;
  const previousPath = resolve(row.rollout_path);
  if (await pathExists(previousPath)) return null;

  const normalized = normalize(previousPath);
  const markerIndex = normalized.lastIndexOf(SESSION_PATH_MARKER);
  if (markerIndex < 0) return null;
  const relativeSessionPath = normalized.slice(markerIndex + SESSION_PATH_MARKER.length);
  if (!relativeSessionPath || relativeSessionPath.split(sep).includes("..")) return null;
  const candidate = resolve(runtimeHome, "sessions", relativeSessionPath);
  const sessionsRoot = resolve(runtimeHome, "sessions");
  if (candidate !== sessionsRoot && !candidate.startsWith(`${sessionsRoot}${sep}`)) return null;
  if (!candidate.includes(row.id)) return null;
  try {
    const info = await stat(candidate);
    return info.isFile() ? candidate : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function resolveRequiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required.`);
  return resolve(value.trim());
}

function emptyResult(statePath, skippedReason) {
  return { statePath, checked: false, repairedCount: 0, repairs: [], skippedReason };
}

function rolloutRepairError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
