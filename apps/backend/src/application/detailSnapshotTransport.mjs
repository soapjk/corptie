import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { clientSafeJSONStringify } from "../utils/unicodeText.mjs";

const compress = promisify(gzip);
export const DETAIL_COMPRESSION_THRESHOLD = 8 * 1024;
export const DETAIL_SNAPSHOT_LIMIT = 256 * 1024;
let activeCompression = 0;

function acceptedEncodings(header = "") {
  const entries = String(header).toLowerCase().split(",").map(part => part.trim().split(";"));
  const quality = entry => {
    if (!entry) return null;
    if (entry.length === 1) return 1;
    if (entry.length !== 2) return 0;
    const match = /^\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(entry[1]);
    return match ? Number(match[1]) : 0;
  };
  const wildcard = quality(entries.find(([name]) => name === "*"));
  return {
    gzip: (quality(entries.find(([name]) => name === "gzip")) ?? wildcard ?? 0) > 0,
    // RFC 9110 12.5.3: identity is allowed unless explicitly excluded.
    identity: (quality(entries.find(([name]) => name === "identity")) ?? (wildcard === 0 ? 0 : 1)) > 0
  };
}

/** Bound CPU and memory without queuing compression ahead of realtime work. */
export async function sendDetailV2Snapshot(request, response, value, authenticate, { compressor = compress, beforeWrite } = {}) {
  // Host-only synchronous guard; never sourced from request headers/body.
  const invalidGuard = () => Object.assign(new Error("DETAIL_WRITE_GUARD_INVALID"), {
    code: "DETAIL_WRITE_GUARD_INVALID", status: 500, statusCode: 500 });
  if (beforeWrite !== undefined && typeof beforeWrite !== "function") throw invalidGuard();
  const guard = () => {
    const result = beforeWrite?.();
    if (result != null && typeof result.then === "function") {
      // Reject accidental async guards, including rejected Promises, without
      // leaving an unhandled rejection or treating settlement as permission.
      void Promise.resolve(result).catch(() => {});
      throw invalidGuard();
    }
  };
  const raw = Buffer.from(clientSafeJSONStringify(value));
  if (raw.length > DETAIL_SNAPSHOT_LIMIT) throw Object.assign(new Error("DETAIL_SNAPSHOT_TOO_LARGE"), { code: "DETAIL_SNAPSHOT_TOO_LARGE", status: 413, statusCode: 413 });
  let body = raw, compressed = false;
  const accepted = acceptedEncodings(request.headers["accept-encoding"]);
  if ((raw.length >= DETAIL_COMPRESSION_THRESHOLD || !accepted.identity) && accepted.gzip && activeCompression < 2) {
    activeCompression++;
    try {
      const candidate = await compressor(raw, { level: 1 });
      if (candidate.length < raw.length || !accepted.identity) { body = candidate; compressed = true; }
    } catch {
      // Compression is optional. Never expose its failure or bypass auth;
      // identity fallback must still be acceptable to this client.
    } finally { activeCompression--; }
    // Outside the compressor catch: guard failure must never become fallback.
    guard();
  }
  await authenticate();
  // No await between this final scope/retirement check and response writes.
  guard();
  if (response.destroyed) return;
  if (!compressed && !accepted.identity) throw Object.assign(new Error("DETAIL_ENCODING_NOT_ACCEPTABLE"), {
    code: "DETAIL_ENCODING_NOT_ACCEPTABLE", status: 406, statusCode: 406 });
  response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", vary: "Accept, X-Corptie-Detail-Capabilities, Accept-Encoding", "content-length": body.length,
    ...(compressed ? { "content-encoding": "gzip" } : {}) });
  response.end(body);
}
