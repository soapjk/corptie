import { createHash } from "node:crypto";
import { deviceError } from "./clientDeviceAuthority.mjs";

export function requireDevicePermission(identity, permission) {
  if (!identity.permissions?.includes(permission)) throw deviceError("DEVICE_PERMISSION_REQUIRED", 403);
}

/** v1 text messaging + stop commands. Provider-neutral callbacks, durable at-most-once dispatch. */
export class ClientSessionAPI {
  constructor({ store, readWindow, send, stop, actions }) {
    Object.assign(this, { store, readWindow, send, stop, actions });
    store.db.run(`CREATE TABLE IF NOT EXISTS client_command_receipts (
      device_id TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL,
      kind TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL,
      error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(device_id, request_id))`);
    this.inFlight = new Set();
  }

  session(id) {
    const session = this.store.getSession(id);
    if (!session || session.archived === true) throw deviceError("SESSION_NOT_AVAILABLE", 404);
    return session;
  }

  async messages(identity, sessionId, query) {
    requireDevicePermission(identity, "messages.read");
    this.session(sessionId);
    if ([...query.keys()].some(k => !["limit", "before"].includes(k))
        || query.getAll("limit").length > 1 || query.getAll("before").length > 1) throw deviceError("INVALID_QUERY", 400);
    const rawLimit = query.get("limit") ?? "40";
    if (!/^[1-9]$|^[1-4][0-9]$|^50$/.test(rawLimit)) throw deviceError("INVALID_LIMIT", 400);
    const limit = Number(rawLimit), anchor = query.get("before");
    if (anchor != null && (!anchor || anchor.length > 1024)) throw deviceError("INVALID_ANCHOR", 400);
    const window = await this.readWindow(sessionId, { anchorKind: "item", anchorId: anchor,
      before: limit, after: 0, limit: limit + (anchor ? 1 : 0) });
    if (anchor && (window.anchor?.status === "missing" || !window.items.some(item => item.id === anchor))) throw deviceError("ANCHOR_NOT_FOUND", 409);
    // The shared timeline window may include newer rows even for after=0.
    // v1 history pagination is strictly before the anchor, never a mixed window.
    const candidates = anchor ? window.items.slice(0, window.items.findIndex(item => item.id === anchor)) : window.items;
    const items = candidates.slice(-limit).map(item => ({
      id: item.id, turnId: item.turnId ?? null, type: item.type,
      text: typeof item.text === "string" ? item.text : "", status: item.status ?? null,
      createdAt: item.createdAt ?? null,
    }));
    const result = { schemaVersion: 1, sessionId, revision: window.revision, items,
      hasEarlier: window.hasEarlier === true, nextBefore: window.hasEarlier && items.length ? items[0].id : null };
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw deviceError("MESSAGE_WINDOW_TOO_LARGE", 413);
    return result;
  }

  capabilities(identity, sessionId) {
    const actions = this.actions(this.session(sessionId));
    return { schemaVersion: 1, sessionId,
      readMessages: identity.permissions.includes("messages.read"),
      send: { available: identity.permissions.includes("messages.write") && actions.send?.available === true,
        reason: identity.permissions.includes("messages.write") ? actions.send?.reason ?? null : "DEVICE_PERMISSION_REQUIRED" },
      stop: { available: identity.permissions.includes("sessions.stop") && actions.interrupt?.available === true,
        reason: identity.permissions.includes("sessions.stop") ? actions.interrupt?.reason ?? null : "DEVICE_PERMISSION_REQUIRED" } };
  }

  receipt(identity, requestId) {
    const row = this.store.selectOne("SELECT * FROM client_command_receipts WHERE device_id = ? AND request_id = ?", [identity.deviceId, requestId]);
    if (!row) throw deviceError("COMMAND_NOT_FOUND", 404);
    const key = `${identity.deviceId}:${requestId}`;
    return { schemaVersion: 1, requestId: row.request_id, sessionId: row.session_id, kind: row.kind,
      status: row.status === "dispatching" && !this.inFlight.has(key) ? "unknown" : row.status,
      errorCode: row.error_code, updatedAt: row.updated_at };
  }

  async command(identity, sessionId, kind, input) {
    requireDevicePermission(identity, kind === "send" ? "messages.write" : "sessions.stop");
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(k => !["requestId", ...(kind === "send" ? ["text"] : [])].includes(k))
        || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId ?? "")) throw deviceError("INVALID_COMMAND", 400);
    if (kind === "send" && (typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000
      || input.text.trim().startsWith("/"))) throw deviceError("INVALID_MESSAGE", 400);
    const fingerprint = createHash("sha256").update(JSON.stringify([sessionId, kind, input.text ?? null])).digest("hex");
    const existing = this.store.selectOne("SELECT payload_hash FROM client_command_receipts WHERE device_id = ? AND request_id = ?", [identity.deviceId, input.requestId]);
    if (existing) {
      if (existing.payload_hash !== fingerprint) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
      return this.receipt(identity, input.requestId);
    }
    const actions = this.actions(this.session(sessionId));
    const action = kind === "send" ? actions.send : actions.interrupt;
    if (action?.available !== true) throw deviceError(action?.reason ?? "CAPABILITY_UNSUPPORTED", 409);
    // Bound retention without silently evicting deduplication keys.
    const count = this.store.selectOne("SELECT COUNT(*) AS count FROM client_command_receipts").count;
    if (count >= 10000) throw deviceError("COMMAND_JOURNAL_FULL", 503);
    const now = new Date().toISOString(), key = `${identity.deviceId}:${input.requestId}`;
    this.store.db.run("INSERT INTO client_command_receipts VALUES (?, ?, ?, ?, ?, 'dispatching', NULL, ?, ?)",
      [identity.deviceId, input.requestId, sessionId, kind, fingerprint, now, now]);
    this.inFlight.add(key);
    const commandSource = { type: "remote-client", deviceId: identity.deviceId,
      messageId: `client:${createHash("sha256").update(key).digest("hex")}` };
    try {
      if (kind === "send") await this.send(sessionId, { text: input.text }, commandSource);
      else await this.stop(sessionId, commandSource);
      this.update(identity.deviceId, input.requestId, kind === "send" ? "accepted" : "stop_requested", null);
    } catch {
      // Failure can occur after side effects. Never auto-replay an uncertain command.
      this.update(identity.deviceId, input.requestId, "unknown", "COMMAND_OUTCOME_UNCERTAIN");
    } finally { this.inFlight.delete(key); }
    return this.receipt(identity, input.requestId);
  }

  update(deviceId, requestId, status, errorCode) {
    this.store.db.run("UPDATE client_command_receipts SET status = ?, error_code = ?, updated_at = ? WHERE device_id = ? AND request_id = ?",
      [status, errorCode, new Date().toISOString(), deviceId, requestId]);
  }
}
