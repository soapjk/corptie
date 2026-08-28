import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import {
  atomicWriteJson,
  migrateDataRoot,
  preflightDataRootMigration,
  resolveDataRootLayout
} from "./dataRootLayout.mjs";

export const DATA_ROOT_MIGRATION_PHASES = Object.freeze([
  "preflight", "quiescing", "checkpointing", "copying", "verifying",
  "switching", "restartRequired", "reconnecting", "completed", "failed"
]);

export class DataRootMigrationCoordinator {
  constructor(options = {}) {
    if (!options.store) throw new TypeError("DataRootMigrationCoordinator requires a Store.");
    this.store = options.store;
    this.environment = options.environment ?? "production";
    this.selectionPath = options.selectionPath ?? this.store.rootSelectionPath;
    this.operationPath = options.operationPath ?? `${this.selectionPath}.migration-operation.json`;
    this.inspectBlockers = options.inspectBlockers ?? (() => []);
    this.quiesce = options.quiesce ?? (async () => {});
    this.resume = options.resume ?? (async () => {});
    this.migrateRoot = options.migrateRoot ?? migrateDataRoot;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.bootId = options.bootId ?? randomUUID();
    this.operation = null;
  }

  async initialize() {
    this.operation = await readJson(this.operationPath);
    if (!this.operation || terminal(this.operation.phase)) return this.operation;
    const selection = await readJson(this.selectionPath);
    if (selection?.operationId === this.operation.operationId
      && resolve(selection.dataRoot) === resolve(this.operation.targetDataRoot)) {
      await this.transition("completed", {
        restartRequired: false,
        completedAt: this.clock(),
        recoveredByBootId: this.bootId
      });
    } else {
      await this.transition("failed", {
        restartRequired: false,
        failedAt: this.clock(),
        error: {
          code: "DATA_ROOT_MIGRATION_INTERRUPTED",
          message: "The previous migration stopped before the Data Root selection was committed. The original Data Root remains active."
        }
      });
    }
    return this.operation;
  }

  status() { return this.operation ? structuredClone(this.operation) : null; }
  isMaintaining() { return Boolean(this.operation && !terminal(this.operation.phase)); }

  async migrate(targetDataRoot) {
    if (this.isMaintaining()) throw operationError("DATA_ROOT_MIGRATION_IN_PROGRESS", "A Data Root migration is already in progress.");
    const targetLayout = resolveDataRootLayout(targetDataRoot, this.environment);
    const sourceLayout = this.store.layout;
    const operationId = `data_root_migration:${randomUUID()}`;
    const currentSelection = await readJson(this.selectionPath);
    const generation = Number(currentSelection?.generation ?? 0) + 1;
    this.operation = {
      schemaVersion: 1,
      operationId,
      generation,
      bootId: this.bootId,
      phase: "preflight",
      sourceDataRoot: sourceLayout.dataRoot,
      targetDataRoot: targetLayout.dataRoot,
      restartRequired: false,
      oldDataRootRetained: true,
      createdAt: this.clock(),
      updatedAt: this.clock(),
      history: []
    };
    await this.transition("preflight");
    let quiesced = false;
    try {
      let blockers = await this.inspectBlockers();
      if (blockers.length > 0) {
        const error = operationError("DATA_ROOT_MIGRATION_BUSY", "Data Root migration is blocked by active persistent work.");
        error.details = { blockers };
        throw error;
      }
      // Close the admission race before filesystem preflight: route-level
      // maintenance rejects new commands while already-started background
      // writers are drained through the runtime lifecycle contract below.
      this.store.migrationInProgress = true;
      blockers = await this.inspectBlockers();
      if (blockers.length > 0) {
        const error = operationError("DATA_ROOT_MIGRATION_BUSY", "Data Root migration is blocked by active persistent work.");
        error.details = { blockers };
        throw error;
      }
      const preflight = await preflightDataRootMigration({ sourceLayout, targetLayout });
      this.operation.preflight = preflight;

      await this.transition("quiescing");
      await this.quiesce();
      quiesced = true;
      await waitForStableDataRoot(sourceLayout);
      this.store.db.setWriteBlocked(true);
      await new Promise((settle) => setImmediate(settle));

      await this.transition("checkpointing");
      this.store.db.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const receipt = await this.migrateRoot({
        sourceLayout,
        targetLayout,
        sourceDatabase: this.store.db.database,
        onPhase: (phase) => this.transition(phase)
      });

      // The selector is the only authority changed by this process. The Store,
      // services and environment remain bound to the old root until process exit.
      await atomicWriteJson(this.selectionPath, {
        schemaVersion: 1,
        dataRoot: targetLayout.dataRoot,
        generation,
        operationId,
        committedAt: this.clock()
      });
      await this.transition("restartRequired", { restartRequired: true, receipt });
      return this.status();
    } catch (cause) {
      console.error(`[data-root-migration] operation=${operationId} phase=${this.operation?.phase ?? "unknown"} code=${cause?.code ?? "unknown"} error=${cause?.message ?? cause}`);
      const error = stableMigrationError(cause);
      await this.transition("failed", {
        restartRequired: false,
        failedAt: this.clock(),
        error: { code: error.code, message: error.message, details: error.details ?? null }
      });
      this.store.db.setWriteBlocked(false);
      this.store.migrationInProgress = false;
      if (quiesced) {
        await this.resume().catch((resumeError) => {
          console.error(`[data-root-migration] failed to resume old-root services error=${resumeError?.message ?? resumeError}`);
        });
      }
      throw error;
    }
  }

  async transition(phase, patch = {}) {
    if (!DATA_ROOT_MIGRATION_PHASES.includes(phase)) throw new TypeError(`Unknown Data Root migration phase: ${phase}`);
    const at = this.clock();
    this.operation = {
      ...this.operation,
      ...patch,
      phase,
      updatedAt: at,
      history: [...(this.operation?.history ?? []), { phase, at }]
    };
    await atomicWriteJson(this.operationPath, this.operation);
    return this.operation;
  }
}

function terminal(phase) { return phase === "completed" || phase === "failed"; }

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

function stableMigrationError(cause) {
  if (cause?.code && String(cause.code).startsWith("DATA_ROOT_")) return cause;
  const error = operationError("DATA_ROOT_MIGRATION_FAILED", "The Data Root migration failed before activation; the original Data Root remains authoritative.");
  error.cause = cause;
  return error;
}

function operationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = code === "DATA_ROOT_INSUFFICIENT_SPACE" ? 507 : 409;
  return error;
}

async function waitForStableDataRoot(layout, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const intervalMs = options.intervalMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let stablePasses = 0;
  while (Date.now() < deadline) {
    const current = await persistentFileFingerprint(layout);
    if (current === previous) stablePasses += 1;
    else stablePasses = 0;
    if (stablePasses >= 2) return;
    previous = current;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw operationError(
    "DATA_ROOT_WRITERS_DID_NOT_DRAIN",
    "Persistent files continued changing after runtime shutdown. The original Data Root remains active."
  );
}

async function persistentFileFingerprint(layout) {
  const rows = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && !path.startsWith(`${layout.databaseDirectory}/`)) {
        const info = await stat(path);
        rows.push(`${path.slice(layout.dataRoot.length)}:${info.size}:${info.mtimeMs}`);
      }
    }
  }
  await visit(layout.dataRoot);
  return rows.sort().join("\n");
}
