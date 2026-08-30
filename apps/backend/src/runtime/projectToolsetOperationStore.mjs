import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contractError } from "./projectToolsetCanonical.mjs";

export class SqliteProjectToolsetStore {
  constructor(options = {}) {
    if (typeof options.databasePath !== "string" || !options.databasePath) throw contractError("TOOLSET_DATA_ROOT_UNAVAILABLE", "Project Toolset requires an external dataRoot database path.");
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
    this.database = options.database ?? new DatabaseSync(options.databasePath);
    this.ownsDatabase = !options.database;
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS project_toolset_operations (
        operation_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('detect','plan','generate','update','validate','ready','failed')),
        resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
        operation_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repository_id, worktree_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS project_toolset_operations_recovery
        ON project_toolset_operations(state, updated_at);
      CREATE TABLE IF NOT EXISTS project_toolset_validation_receipts (
        receipt_id TEXT PRIMARY KEY,
        receipt_hash TEXT NOT NULL UNIQUE,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_toolset_validation_plans (
        validation_plan_identity TEXT PRIMARY KEY,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  async get(id) {
    return parse(this.database.prepare("SELECT operation_json FROM project_toolset_operations WHERE operation_id=?").get(id)?.operation_json);
  }

  async findByIdempotency(repositoryId, worktreeId, idempotencyKey) {
    return parse(this.database.prepare("SELECT operation_json FROM project_toolset_operations WHERE repository_id=? AND worktree_id=? AND idempotency_key=?").get(repositoryId, worktreeId, idempotencyKey)?.operation_json);
  }

  async create(value) {
    const input = value.input;
    try {
      this.database.prepare(`INSERT INTO project_toolset_operations
        (operation_id,repository_id,worktree_id,idempotency_key,request_hash,state,resource_version,cancel_requested,operation_json,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(value.id, input.repositoryId, input.worktreeId, input.idempotencyKey, value.requestHash, value.state, value.resourceVersion, 0, JSON.stringify(value), new Date().toISOString());
    } catch (error) {
      if (/constraint/i.test(`${error.code ?? ""} ${error.message ?? ""}`)) throw contractError("TOOLSET_CAS_CONFLICT", "Project Toolset operation already exists.");
      throw error;
    }
    return structuredClone(value);
  }

  async compareAndSwap(id, version, patch) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT operation_json,resource_version,cancel_requested FROM project_toolset_operations WHERE operation_id=?").get(id);
      if (!row || row.resource_version !== version) throw contractError("TOOLSET_CAS_CONFLICT", "Project Toolset operation changed concurrently.");
      const current = JSON.parse(row.operation_json); const next = { ...current, ...structuredClone(patch), cancelRequested: Boolean(row.cancel_requested) || patch.cancelRequested === true };
      if (next.resourceVersion !== version + 1 || !allowedTransition(current.state, next.state)) throw contractError("TOOLSET_CAS_CONFLICT", "Project Toolset state transition is invalid.");
      const result = this.database.prepare(`UPDATE project_toolset_operations SET state=?,resource_version=?,cancel_requested=?,operation_json=?,updated_at=?
        WHERE operation_id=? AND resource_version=?`).run(next.state, next.resourceVersion, next.cancelRequested ? 1 : 0, JSON.stringify(next), new Date().toISOString(), id, version);
      if (result.changes !== 1) throw contractError("TOOLSET_CAS_CONFLICT", "Project Toolset operation changed concurrently.");
      this.database.exec("COMMIT"); return structuredClone(next);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  async requestCancel(id) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT operation_json FROM project_toolset_operations WHERE operation_id=?").get(id);
      if (!row) { this.database.exec("COMMIT"); return null; }
      const next = { ...JSON.parse(row.operation_json), cancelRequested: true };
      this.database.prepare("UPDATE project_toolset_operations SET cancel_requested=1,operation_json=?,updated_at=? WHERE operation_id=?").run(JSON.stringify(next), new Date().toISOString(), id);
      this.database.exec("COMMIT"); return structuredClone(next);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  async listRecoverable() {
    return this.database.prepare("SELECT operation_json FROM project_toolset_operations WHERE state NOT IN ('ready','failed') ORDER BY updated_at").all().map((row) => JSON.parse(row.operation_json));
  }

  async put(receipt) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT receipt_hash,receipt_json FROM project_toolset_validation_receipts WHERE receipt_id=?").get(receipt.receiptId);
      if (existing) {
        if (existing.receipt_hash !== receipt.receiptHash) throw contractError("TOOLSET_CAS_CONFLICT", "Toolset receipt identity cannot be overwritten.");
        this.database.exec("COMMIT"); return JSON.parse(existing.receipt_json);
      }
      this.database.prepare(`INSERT INTO project_toolset_validation_receipts(receipt_id,receipt_hash,receipt_json,created_at)
        VALUES(?,?,?,?)`).run(receipt.receiptId, receipt.receiptHash, JSON.stringify(receipt), new Date().toISOString());
      this.database.exec("COMMIT"); return structuredClone(receipt);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  async getReceipt(receiptId) { return parse(this.database.prepare("SELECT receipt_json FROM project_toolset_validation_receipts WHERE receipt_id=?").get(receiptId)?.receipt_json); }
  async getValidationPlan(identity) { return parse(this.database.prepare("SELECT plan_json FROM project_toolset_validation_plans WHERE validation_plan_identity=?").get(identity)?.plan_json); }
  async putValidationPlan(identity, value) {
    const json = JSON.stringify(value);
    try {
      this.database.prepare("INSERT INTO project_toolset_validation_plans(validation_plan_identity,plan_json,created_at) VALUES(?,?,?)")
        .run(identity, json, new Date().toISOString());
    } catch (error) {
      if (!/constraint/i.test(`${error.code ?? ""} ${error.message ?? ""}`)) throw error;
      const existing = await this.getValidationPlan(identity);
      if (JSON.stringify(existing) !== json) throw contractError("TOOLSET_CAS_CONFLICT", "ValidationPlan identity cannot be overwritten.");
    }
    return structuredClone(value);
  }
  close() { if (this.ownsDatabase) this.database.close(); }
}

function parse(value) { return value ? JSON.parse(value) : null; }
function allowedTransition(from, to) {
  if (from === to) return from === "validate";
  return ({ detect: ["plan", "failed"], plan: ["generate", "update", "failed"], generate: ["validate", "failed"], update: ["validate", "failed"], validate: ["ready", "failed"] }[from] ?? []).includes(to);
}
