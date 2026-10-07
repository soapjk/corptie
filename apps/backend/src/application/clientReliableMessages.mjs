import { createHash } from "node:crypto";
import { deviceError } from "./clientDeviceAuthority.mjs";
import { parseSlashCommand } from "../commands/unifiedCommands.mjs";

export const reliableMessageLifetimeMs = 7 * 86400000;

export function ensureReliableMessageSchema(store) {
  store.db.run(`CREATE TABLE IF NOT EXISTS client_message_receipts (
    device_id TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL, accepted_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY(device_id, request_id))`);
  store.db.run("CREATE INDEX IF NOT EXISTS client_message_receipts_expiry ON client_message_receipts(expires_at)");
  store.db.run("CREATE INDEX IF NOT EXISTS idx_agent_operations_session_admission ON agent_operations(session_id, created_at)");
}

export function reliableReceipt(store, identity, requestId) {
  const row = store.selectOne("SELECT * FROM client_message_receipts WHERE device_id=? AND request_id=?",
    [identity.deviceId, requestId]);
  return row ? { schemaVersion: 1, requestId, sessionId: row.session_id, kind: "send",
    status: "accepted", errorCode: null, updatedAt: row.accepted_at,
    messageId: `client:${createHash("sha256").update(`${identity.deviceId}:${requestId}`).digest("hex")}` } : null;
}

/** Only ordinary chat: no schedule, slash command, or implicit authorization reply. */
export async function acceptReliableMessage(api, identity, targetId, input, authenticate = () => identity) {
  if (!api.admitReliableMessage) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
  if (!input || Array.isArray(input) || input.schemaVersion !== 1
      || Object.keys(input).some(key => !["schemaVersion", "requestId", "createdAt", "text", "images", "imageUploadIds", "mentions"].includes(key))
      || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId ?? "")
      || typeof input.text !== "string" || input.text.length > 16000 || parseSlashCommand(input.text)) {
    throw deviceError("INVALID_MESSAGE", 400);
  }
  const uploadIds = input.imageUploadIds ?? [];
  if (!Array.isArray(uploadIds) || uploadIds.length > 8 || new Set(uploadIds).size !== uploadIds.length
      || uploadIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(id))
      || (uploadIds.length && (input.images?.length ?? 0))) throw deviceError("INVALID_MESSAGE", 400);
  // Accepted requests reconcile before staging is read: clients can release
  // uploads after the durable receipt without making a lost-ACK retry fail.
  const referenceFingerprint = uploadIds.length && Array.isArray(input.mentions ?? [])
    ? createHash("sha256").update(JSON.stringify([targetId, input.createdAt, input.text,
      ["uploads", uploadIds], (input.mentions ?? []).map(mention => [mention?.targetType, mention?.targetId, mention?.displayName])])).digest("hex") : null;
  if (referenceFingerprint) {
    const committed = api.store.selectOne("SELECT payload_hash FROM client_message_receipts WHERE device_id=? AND request_id=?", [identity.deviceId, input.requestId]);
    if (committed) {
      if (committed.payload_hash !== referenceFingerprint) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
      return reliableReceipt(api.store, identity, input.requestId);
    }
  }
  const images = uploadIds.length ? uploadIds.map(id => api.imageUploads.resolve(identity, api.session(targetId).sessionId, id)) : input.images ?? [];
  const mentions = input.mentions ?? [];
  if (!Array.isArray(images) || images.length > 8 || images.some(image => !image
      || Object.keys(image).some(key => !["fileName", "dataBase64"].includes(key))
      || typeof image.fileName !== "string" || image.fileName.length > 256
      || typeof image.dataBase64 !== "string" || image.dataBase64.length > 28 * 1024 * 1024
      || !image.dataBase64.length || image.dataBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.dataBase64))
      || images.reduce((sum, image) => sum + Buffer.from(image.dataBase64, "base64").length, 0) > 20 * 1024 * 1024
      || (!input.text.trim() && !images.length)
      || !Array.isArray(mentions) || mentions.length > 8 || mentions.some(mention => !mention
        || Object.keys(mention).some(key => !["targetType", "targetId", "displayName"].includes(key))
        || !["work", "session"].includes(mention.targetType)
        || typeof mention.targetId !== "string" || !mention.targetId.trim() || mention.targetId.length > 200
        || typeof mention.displayName !== "string" || !mention.displayName || mention.displayName.length > 200)) {
    throw deviceError("INVALID_MESSAGE", 400);
  }
  const createdAt = Date.parse(input.createdAt);
  if (typeof input.createdAt !== "string" || !Number.isFinite(createdAt) || createdAt > Date.now() + 300000) {
    throw deviceError("INVALID_MESSAGE_TIME", 400);
  }
  // JSON object key order is not intent. Swift encoders may reorder keys on a
  // retry, so fingerprint ordered field tuples rather than raw decoded objects.
  const fingerprint = referenceFingerprint ?? createHash("sha256").update(JSON.stringify([targetId, input.createdAt, input.text,
    images.map(image => [image.fileName, image.dataBase64]),
    mentions.map(mention => [mention.targetType, mention.targetId, mention.displayName])])).digest("hex");
  const existing = api.store.selectOne("SELECT * FROM client_message_receipts WHERE device_id=? AND request_id=?",
    [identity.deviceId, input.requestId]);
  if (existing) {
    if (existing.payload_hash !== fingerprint) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
    return reliableReceipt(api.store, identity, input.requestId);
  }
  if (api.store.selectOne("SELECT request_id FROM client_command_receipts WHERE device_id=? AND request_id=?",
    [identity.deviceId, input.requestId])) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
  const expiresAt = new Date(createdAt + reliableMessageLifetimeMs).toISOString();
  if (Date.parse(expiresAt) <= Date.now()) throw deviceError("MESSAGE_EXPIRED", 410);
  const key = `${identity.deviceId}:${input.requestId}`;
  console.info(`[client-message] request=${input.requestId} phase=received`);
  const running = api.reliableMessagesInFlight.get(key);
  if (running) {
    if (running.fingerprint !== fingerprint) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
    await running.operation;
    authenticate();
    return reliableReceipt(api.store, identity, input.requestId);
  }
  const operation = (async () => {
    const resolved = api.session(targetId);
    if (images.length && !api.images?.available(resolved.session)) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    const attachments = [];
    for (const image of images) attachments.push(await api.images.import(resolved.sessionId, image));
    authenticate();
    if (Date.parse(expiresAt) <= Date.now()) throw deviceError("MESSAGE_EXPIRED", 410);
    const receipt = { deviceId: identity.deviceId, requestId: input.requestId, payloadHash: fingerprint,
      expiresAt, acceptedAt: new Date().toISOString() };
    // Admission is synchronous. Receipt, message and queued work commit in one transaction.
    api.admitReliableMessage(resolved.sessionId, { text: input.text,
      ...(attachments.length ? { images: attachments } : {}), ...(mentions.length ? { mentions } : {}) },
    { type: "remote-client", deviceId: identity.deviceId,
      messageId: `client:${createHash("sha256").update(key).digest("hex")}`, clientReceipt: receipt });
    const result = reliableReceipt(api.store, identity, input.requestId);
    if (!result) throw new Error("Reliable admission did not commit its receipt");
    console.info(`[client-message] request=${input.requestId} phase=accepted`);
    api.onReceiptChanged?.(identity.deviceId, result);
    // Only release staging after the durable message owns its imported images.
    for (const id of uploadIds) {
      try { api.imageUploads.remove(identity, resolved.sessionId, id); }
      catch { console.warn(`[client-image] upload=${id} phase=cleanup-deferred`); }
    }
    // Expired requests can never be admitted again, even after their deduplication key is removed.
    api.store.db.run(`DELETE FROM client_message_receipts WHERE rowid IN
      (SELECT rowid FROM client_message_receipts WHERE expires_at < ? LIMIT 100)`,
    [new Date(Date.now() - 86400000).toISOString()]);
  })();
  api.reliableMessagesInFlight.set(key, { fingerprint, operation });
  try { await operation; }
  catch (error) {
    // Projection publication can fail after a successful durable commit.
    const committed = api.store.selectOne("SELECT payload_hash FROM client_message_receipts WHERE device_id=? AND request_id=?",
      [identity.deviceId, input.requestId]);
    if (!committed) throw error;
    if (committed.payload_hash !== fingerprint) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
  } finally { api.reliableMessagesInFlight.delete(key); }
  return reliableReceipt(api.store, identity, input.requestId);
}
