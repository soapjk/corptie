import { createHash } from "node:crypto";
import { deviceError } from "./clientDeviceAuthority.mjs";

export function requireDevicePermission(identity, permission) {
  if (!identity.permissions?.includes(permission)) throw deviceError("DEVICE_PERMISSION_REQUIRED", 403);
}

/** v1 text messaging + stop commands. Provider-neutral callbacks, durable at-most-once dispatch. */
export class ClientSessionAPI {
  constructor({ store, readWindow, send, stop, actions, resolveSession = id => id, composer = null, images = null, schedule = null }) {
    Object.assign(this, { store, readWindow, send, stop, actions, resolveSession, composer, images, schedule });
    store.db.run(`CREATE TABLE IF NOT EXISTS client_command_receipts (
      device_id TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL,
      kind TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL,
      error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(device_id, request_id))`);
    this.inFlight = new Set();
  }

  session(id) {
    const sessionId = this.resolveSession(id);
    const session = sessionId ? this.store.getSession(sessionId) : null;
    if (!session || session.archived === true) throw deviceError("SESSION_NOT_AVAILABLE", 404);
    return { sessionId, session };
  }

  async messages(identity, sessionId, query) {
    requireDevicePermission(identity, "messages.read");
    sessionId = this.session(sessionId).sessionId;
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
      userMessageStatus: item.userMessageStatus ?? null, queuePosition: item.queuePosition ?? null,
    }));
    const result = { schemaVersion: 1, sessionId, revision: window.revision, items,
      hasEarlier: window.hasEarlier === true, nextBefore: window.hasEarlier && items.length ? items[0].id : null };
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw deviceError("MESSAGE_WINDOW_TOO_LARGE", 413);
    return result;
  }

  capabilities(identity, sessionId) {
    const resolved = this.session(sessionId);
    sessionId = resolved.sessionId;
    const actions = this.actions(resolved.session);
    return { schemaVersion: 1, sessionId,
      composer: Boolean(this.composer),
      sendImages: Boolean(this.images?.available(resolved.session)),
      sendMentions: true,
      scheduleMessage: Boolean(this.schedule) && identity.permissions.includes("messages.write"),
      currentModel: resolved.session.external?.currentModel ?? null,
      currentReasoningLevel: resolved.session.external?.currentReasoningLevel ?? null,
      readMessages: identity.permissions.includes("messages.read"),
      send: { available: identity.permissions.includes("messages.write") && actions.send?.available === true,
        reason: identity.permissions.includes("messages.write") ? actions.send?.reason ?? null : "DEVICE_PERMISSION_REQUIRED" },
      stop: { available: identity.permissions.includes("sessions.stop") && actions.interrupt?.available === true,
        reason: identity.permissions.includes("sessions.stop") ? actions.interrupt?.reason ?? null : "DEVICE_PERMISSION_REQUIRED" } };
  }

  async configuration(identity, id, input = null) {
    requireDevicePermission(identity, "messages.write");
    const { sessionId, session } = this.session(id);
    if (!this.composer) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    if (input !== null) {
      if (!input || Array.isArray(input) || typeof input !== "object"
          || Object.keys(input).length !== 1) throw deviceError("INVALID_CONFIGURATION", 400);
      const key = Object.keys(input)[0];
      if (!["model", "reasoningLevel"].includes(key) || typeof input[key] !== "string"
          || !input[key].trim() || input[key].length > 256) throw deviceError("INVALID_CONFIGURATION", 400);
      const action = this.actions(session)[key === "model" ? "switchModel" : "switchReasoning"];
      if (action?.available !== true) throw deviceError(action?.reason ?? "CAPABILITY_UNSUPPORTED", 409);
      await this.composer.update(sessionId, key, input[key]);
    }
    const catalog = await this.composer.read(sessionId);
    const actions = this.actions(this.session(sessionId).session);
    return { schemaVersion: 1, sessionId, currentModel: catalog.currentModel ?? null,
      currentReasoningLevel: catalog.currentReasoningLevel ?? null,
      models: (catalog.models ?? []).map(model => ({ id: model.id, name: model.name,
        reasoningLevels: model.reasoningLevels ?? [], defaultReasoningLevel: model.defaultReasoningLevel ?? null })),
      switchModel: actions.switchModel ?? { available: false },
      switchReasoning: actions.switchReasoning ?? { available: false } };
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
        || Object.keys(input).some(k => !["requestId", ...(kind === "send" ? ["text", "images", "mentions", "schedule"] : [])].includes(k))
        || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId ?? "")) throw deviceError("INVALID_COMMAND", 400);
    if (kind === "send" && (typeof input.text !== "string" || (!input.text.trim() && !input.images?.length) || input.text.length > 16000
      || input.text.trim().startsWith("/"))) throw deviceError("INVALID_MESSAGE", 400);
    const resolved = this.session(sessionId);
    sessionId = resolved.sessionId;
    const images = input.images ?? [], mentions = input.mentions ?? [];
    if (!Array.isArray(images) || images.length > 8 || images.some(image => !image || typeof image !== "object"
      || Object.keys(image).some(key => !["fileName", "dataBase64"].includes(key))
      || typeof image.fileName !== "string" || image.fileName.length > 256
      || typeof image.dataBase64 !== "string" || image.dataBase64.length > 28 * 1024 * 1024
      || image.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.dataBase64)
      || !image.dataBase64.length)
      || images.reduce((sum, image) => sum + image.dataBase64.length / 4 * 3
        - (image.dataBase64.endsWith("==") ? 2 : image.dataBase64.endsWith("=") ? 1 : 0), 0) > 20 * 1024 * 1024) throw deviceError("INVALID_IMAGES", 400);
    if (images.length && !this.images?.available(resolved.session)) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    if (!Array.isArray(mentions) || mentions.length > 8 || mentions.some(mention => !mention
      || Object.keys(mention).some(key => !["targetType", "targetId", "displayName"].includes(key))
      || !["work", "session"].includes(mention.targetType) || typeof mention.targetId !== "string"
      || !mention.targetId.trim() || mention.targetId.length > 200 || typeof mention.displayName !== "string"
      || !mention.displayName || mention.displayName.length > 200)) throw deviceError("INVALID_MENTIONS", 400);
    if (input.schedule !== undefined) {
      const schedule = input.schedule;
      if (!this.schedule) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
      if (!schedule || Array.isArray(schedule) || typeof schedule !== "object" || images.length || mentions.length
        || Object.keys(schedule).some(key => !["runAt", "expiresAt", "intervalSeconds"].includes(key))
        || typeof schedule.runAt !== "string" || !Number.isFinite(Date.parse(schedule.runAt))
        || typeof schedule.expiresAt !== "string" || !Number.isFinite(Date.parse(schedule.expiresAt))
        || Date.parse(schedule.expiresAt) <= Date.parse(schedule.runAt)
        || (schedule.intervalSeconds != null && (!Number.isInteger(schedule.intervalSeconds)
          || schedule.intervalSeconds < 60 || schedule.intervalSeconds > 31536000))) throw deviceError("INVALID_SCHEDULE", 400);
    }
    // Preserve the fingerprint of existing text-only receipts across upgrades.
    const payload = [sessionId, kind, input.text ?? null];
    if (images.length || mentions.length) payload.push(images, mentions);
    if (input.schedule) payload.push(input.schedule);
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const existing = this.store.selectOne("SELECT payload_hash FROM client_command_receipts WHERE device_id = ? AND request_id = ?", [identity.deviceId, input.requestId]);
    if (existing) {
      if (existing.payload_hash !== fingerprint) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
      return this.receipt(identity, input.requestId);
    }
    if (input.schedule && Date.parse(input.schedule.runAt) <= Date.now()) throw deviceError("INVALID_SCHEDULE", 400);
    const actions = this.actions(resolved.session);
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
      if (kind === "send" && input.schedule) await this.schedule(sessionId, input.text, input.schedule, identity);
      else if (kind === "send") {
        const attachments = [];
        for (const image of images) attachments.push(await this.images.import(sessionId, image));
        await this.send(sessionId, { text: input.text, ...(attachments.length ? { images: attachments } : {}),
          ...(mentions.length ? { mentions } : {}) }, commandSource);
      }
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
