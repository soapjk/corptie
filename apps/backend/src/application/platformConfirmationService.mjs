import { createHash, randomUUID } from "node:crypto";
import { resolvePlatformAdminSession } from "../utils/platformAssistantIdentity.mjs";

export class PlatformConfirmationService {
  constructor({ store, clock = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
    if (!store) throw new TypeError("PlatformConfirmationService requires a store.");
    this.store = store;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  digest(actorSessionId, tool, args = {}) {
    return createHash("sha256").update(stableJson({ actorSessionId, tool, args: withoutConfirmation(args) })).digest("hex");
  }

  issue(input = {}) {
    const binding = resolvePlatformAdminSession(this.store, input);
    const tool = required(input.tool, "tool");
    const args = plainObject(input.arguments, "arguments");
    const confirmationId = `platform_confirmation:${this.idFactory()}`;
    const operationDigest = this.digest(binding.actorSessionId, tool, args);
    this.store.db.run(
      `INSERT INTO platform_admin_confirmations
       (confirmation_id, actor_session_id, operation_digest, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`,
      [confirmationId, binding.actorSessionId, operationDigest, this.clock()]
    );
    this.store.scheduleSave();
    return { confirmationId, actorSessionId: binding.actorSessionId, operationDigest, status: "pending" };
  }

  resolve(confirmationIdValue, approved) {
    const confirmationId = required(confirmationIdValue, "confirmationId");
    const row = this.store.selectOne("SELECT * FROM platform_admin_confirmations WHERE confirmation_id=?", [confirmationId]);
    if (!row) throw coded("PLATFORM_CONFIRMATION_NOT_FOUND", "Platform confirmation was not found.");
    if (row.status !== "pending") throw coded("PLATFORM_CONFIRMATION_ALREADY_RESOLVED", "Platform confirmation was already resolved.");
    this.store.db.run(
      `UPDATE platform_admin_confirmations SET status=?, confirmed_at=? WHERE confirmation_id=? AND status='pending'`,
      [approved ? "confirmed" : "rejected", this.clock(), confirmationId]
    );
    this.store.scheduleSave();
    return this.get(confirmationId);
  }

  consume(input = {}) {
    const confirmationId = required(input.confirmationId, "confirmation_id");
    const row = this.store.selectOne("SELECT * FROM platform_admin_confirmations WHERE confirmation_id=?", [confirmationId]);
    if (!row) throw coded("PLATFORM_CONFIRMATION_NOT_FOUND", "Platform confirmation was not found.");
    const expected = this.digest(required(input.actorSessionId, "actorSessionId"), required(input.tool, "tool"), input.arguments ?? {});
    if (row.actor_session_id !== input.actorSessionId || row.operation_digest !== expected) {
      throw coded("PLATFORM_CONFIRMATION_MISMATCH", "Confirmation is bound to another Session or immutable operation payload.");
    }
    if (row.status !== "confirmed") {
      throw coded(row.status === "consumed" ? "PLATFORM_CONFIRMATION_REPLAYED" : "PLATFORM_CONFIRMATION_REQUIRED", "A fresh server-confirmed user approval is required.");
    }
    this.store.db.run(
      `UPDATE platform_admin_confirmations SET status='consumed', consumed_at=? WHERE confirmation_id=? AND status='confirmed'`,
      [this.clock(), confirmationId]
    );
    if (Number(this.store.db.rowsModified ?? 0) !== 1) throw coded("PLATFORM_CONFIRMATION_REPLAYED", "Confirmation was already consumed.");
    this.store.scheduleSave();
    return { confirmationId, operationDigest: expected, consumed: true };
  }

  get(confirmationId) {
    const row = this.store.selectOne("SELECT * FROM platform_admin_confirmations WHERE confirmation_id=?", [confirmationId]);
    return row ? {
      confirmationId: row.confirmation_id, actorSessionId: row.actor_session_id,
      operationDigest: row.operation_digest, status: row.status, createdAt: row.created_at,
      confirmedAt: row.confirmed_at ?? null, consumedAt: row.consumed_at ?? null
    } : null;
  }
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function withoutConfirmation(args) {
  const copy = { ...(args ?? {}) };
  delete copy.confirmation_id;
  return copy;
}
function required(value, field) { const text = typeof value === "string" ? value.trim() : ""; if (!text) throw coded("INVALID_INPUT", `${field} is required.`); return text; }
function plainObject(value, field) { if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("INVALID_INPUT", `${field} must be an object.`); return value; }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
