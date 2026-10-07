import { createHash } from "node:crypto";
import { deviceError } from "./clientDeviceAuthority.mjs";

export const imageUploadPolicy = Object.freeze({ version: 1, maximumImages: 8,
  maximumBytes: 20 * 1024 * 1024, chunkBytes: 512 * 1024, maximumAgeSeconds: 604800 });
const hash = data => createHash("sha256").update(data).digest("hex");

/** Device/Session scoped, crash-safe staging. No provider credentials or paths
 * are exposed. Chunks are immutable; a lost response can safely be replayed. */
export class ClientImageUploads {
  constructor(store) {
    this.store = store;
    store.db.run(`CREATE TABLE IF NOT EXISTS client_image_uploads (
      device_id TEXT NOT NULL, upload_id TEXT NOT NULL, session_id TEXT NOT NULL,
      file_name TEXT NOT NULL, byte_length INTEGER NOT NULL, sha256 TEXT NOT NULL,
      expires_at INTEGER NOT NULL, PRIMARY KEY(device_id, upload_id))`);
    store.db.run(`CREATE TABLE IF NOT EXISTS client_image_chunks (
      device_id TEXT NOT NULL, upload_id TEXT NOT NULL, offset INTEGER NOT NULL,
      data BLOB NOT NULL, PRIMARY KEY(device_id, upload_id, offset))`);
    store.db.run("CREATE INDEX IF NOT EXISTS client_image_uploads_expiry ON client_image_uploads(expires_at)");
  }
  cleanup() {
    const expired = this.store.selectAll("SELECT device_id,upload_id FROM client_image_uploads WHERE expires_at<=? LIMIT 100", [Date.now()]);
    for (const row of expired) {
      this.store.db.run("DELETE FROM client_image_chunks WHERE device_id=? AND upload_id=?", [row.device_id, row.upload_id]);
      this.store.db.run("DELETE FROM client_image_uploads WHERE device_id=? AND upload_id=?", [row.device_id, row.upload_id]);
    }
  }
  begin(identity, sessionId, input) {
    if (!input || input.schemaVersion !== 1
        || Object.keys(input).some(key => !["schemaVersion", "uploadId", "fileName", "byteLength", "sha256"].includes(key))
        || !/^[A-Za-z0-9_-]{8,128}$/.test(input.uploadId ?? "")
        || typeof input.fileName !== "string" || !input.fileName || input.fileName.length > 256
        || !Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > imageUploadPolicy.maximumBytes
        || !/^[a-f0-9]{64}$/.test(input.sha256 ?? "")) throw deviceError("INVALID_IMAGE_UPLOAD", 400);
    this.cleanup();
    const previous = this.store.selectOne("SELECT * FROM client_image_uploads WHERE device_id=? AND upload_id=?", [identity.deviceId, input.uploadId]);
    if (previous) {
      if (previous.session_id !== sessionId || previous.file_name !== input.fileName
          || previous.byte_length !== input.byteLength || previous.sha256 !== input.sha256) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
      return this.status(identity, sessionId, input.uploadId);
    }
    const owned = this.store.selectOne("SELECT COUNT(*) AS n, COALESCE(SUM(byte_length),0) AS bytes FROM client_image_uploads WHERE device_id=?", [identity.deviceId]);
    const global = this.store.selectOne("SELECT COALESCE(SUM(byte_length),0) AS bytes FROM client_image_uploads");
    if (owned.n >= 64 || owned.bytes + input.byteLength > 40 * 1024 * 1024
        || global.bytes + input.byteLength > 256 * 1024 * 1024) throw deviceError("IMAGE_UPLOAD_STORAGE_FULL", 503);
    this.store.db.run("INSERT INTO client_image_uploads VALUES (?,?,?,?,?,?,?)", [identity.deviceId, input.uploadId,
      sessionId, input.fileName, input.byteLength, input.sha256, Date.now() + imageUploadPolicy.maximumAgeSeconds * 1000]);
    return this.status(identity, sessionId, input.uploadId);
  }
  row(identity, sessionId, uploadId) {
    const row = this.store.selectOne("SELECT * FROM client_image_uploads WHERE device_id=? AND upload_id=? AND session_id=?", [identity.deviceId, uploadId, sessionId]);
    if (!row) throw deviceError("IMAGE_UPLOAD_NOT_FOUND", 404);
    if (row.expires_at <= Date.now()) throw deviceError("IMAGE_UPLOAD_EXPIRED", 410);
    return row;
  }
  status(identity, sessionId, uploadId) {
    const row = this.row(identity, sessionId, uploadId);
    const offset = this.store.selectOne("SELECT COALESCE(SUM(length(data)),0) AS n FROM client_image_chunks WHERE device_id=? AND upload_id=?", [identity.deviceId, uploadId]).n;
    return { schemaVersion: 1, uploadId, offset, byteLength: row.byte_length, sha256: row.sha256 };
  }
  append(identity, sessionId, uploadId, input) {
    const row = this.row(identity, sessionId, uploadId);
    if (!input || Object.keys(input).some(key => !["schemaVersion", "offset", "dataBase64", "sha256"].includes(key))
        || input.schemaVersion !== 1 || !Number.isSafeInteger(input.offset) || input.offset < 0
        || typeof input.dataBase64 !== "string" || !input.dataBase64.length
        || input.dataBase64.length > Math.ceil(imageUploadPolicy.chunkBytes / 3) * 4
        || input.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)) throw deviceError("INVALID_IMAGE_CHUNK", 400);
    const data = Buffer.from(input.dataBase64, "base64");
    if (!data.length || data.length > imageUploadPolicy.chunkBytes || hash(data) !== input.sha256
        || input.offset + data.length > row.byte_length) throw deviceError("INVALID_IMAGE_CHUNK", 400);
    const previous = this.store.selectOne("SELECT data FROM client_image_chunks WHERE device_id=? AND upload_id=? AND offset=?", [identity.deviceId, uploadId, input.offset]);
    if (previous) {
      if (!Buffer.from(previous.data).equals(data)) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
    } else {
      if (this.status(identity, sessionId, uploadId).offset !== input.offset) throw deviceError("IMAGE_UPLOAD_OFFSET_CONFLICT", 409);
      this.store.db.run("INSERT INTO client_image_chunks VALUES (?,?,?,?)", [identity.deviceId, uploadId, input.offset, data]);
    }
    return this.status(identity, sessionId, uploadId);
  }
  resolve(identity, sessionId, uploadId) {
    const row = this.row(identity, sessionId, uploadId);
    const chunks = this.store.selectAll("SELECT data FROM client_image_chunks WHERE device_id=? AND upload_id=? ORDER BY offset", [identity.deviceId, uploadId]);
    const data = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data)));
    if (data.length !== row.byte_length) throw deviceError("IMAGE_UPLOAD_INCOMPLETE", 409);
    if (hash(data) !== row.sha256) throw deviceError("IMAGE_UPLOAD_HASH_MISMATCH", 422);
    return { fileName: row.file_name, dataBase64: data.toString("base64") };
  }
  remove(identity, sessionId, uploadId) {
    this.row(identity, sessionId, uploadId);
    this.store.db.run("DELETE FROM client_image_chunks WHERE device_id=? AND upload_id=?", [identity.deviceId, uploadId]);
    this.store.db.run("DELETE FROM client_image_uploads WHERE device_id=? AND upload_id=?", [identity.deviceId, uploadId]);
  }
}
