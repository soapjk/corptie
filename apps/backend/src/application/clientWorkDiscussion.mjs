import { createHash } from "node:crypto";
import { deviceError } from "./clientDeviceAuthority.mjs";

function work(api, id) {
  if (typeof id !== "string" || !id.trim() || id.length > 512) throw deviceError("INVALID_WORK_ID", 400);
  const value = api.store.getWork(id);
  if (!value) throw deviceError("WORK_NOT_FOUND", 404);
  return value;
}

export async function clientDiscussionOptions(api, identity, workId) {
  work(api, workId);
  if (!api.workDiscussion) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
  const catalog = await api.workDiscussion.options();
  const current = work(api, workId);
  const providers = (catalog.providers ?? []).filter(row => typeof row.id === "string").map(row => ({
    id: row.id, name: typeof row.name === "string" ? row.name : row.id,
    available: row.available === true, reason: row.available === true ? null : "PROVIDER_CAPABILITY_UNAVAILABLE"
  }));
  const result = { schemaVersion: 1, work: { id: current.id, name: current.name },
    agents: (current.contributorAgentIds ?? []).map(id => api.store.getAgent(id)).filter(Boolean)
      .map(agent => ({ id: agent.agentId, name: agent.name })), providers,
    defaultProviderId: providers.some(row => row.id === catalog.defaultProviderId && row.available) ? catalog.defaultProviderId : null };
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw deviceError("CATALOG_TOO_LARGE", 413);
  return result;
}

/** Device-only boundary; creation and concurrent Work deduplication use the Mac service.
 * No source Session exists yet. Receipts therefore use an empty source sessionId;
 * only discussionResult identifies the resulting Session. No initial turn is sent.
 */
export async function openClientDiscussion(api, identity, workId, input, revalidateIdentity) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["requestId", "agentId", "providerId"].includes(key))
      || typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId)
      || ["agentId", "providerId"].some(key => typeof input[key] !== "string" || !input[key].trim() || input[key].length > 512)
      || typeof workId !== "string" || !workId.trim() || workId.length > 512) {
    throw deviceError("INVALID_DISCUSSION_CREATION", 400);
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(["open_work_discussion", workId, input.requestId, input.agentId, input.providerId])).digest("hex");
  const replay = () => {
    const row = api.store.selectOne("SELECT payload_hash FROM client_command_receipts WHERE device_id=? AND request_id=?", [identity.deviceId, input.requestId]);
    if (!row) return null;
    if (row.payload_hash !== fingerprint) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
    return api.receipt(identity, input.requestId);
  };
  const existing = replay();
  if (existing) return existing;
  const options = await clientDiscussionOptions(api, identity, workId);
  if (revalidateIdentity) {
    const current = revalidateIdentity();
    if (current.deviceId !== identity.deviceId) throw deviceError("INVALID_CREDENTIAL", 401);
    identity = current;
  }
  if (!options.providers.some(row => row.id === input.providerId && row.available)) throw deviceError("PROVIDER_CAPABILITY_UNAVAILABLE", 409);
  if (!(work(api, workId).contributorAgentIds ?? []).includes(input.agentId)) throw deviceError("AGENT_OUTSIDE_WORK", 403);
  if (!api.store.getAgent(input.agentId)) throw deviceError("AGENT_NOT_FOUND", 404);
  const raced = replay();
  if (raced) return raced;
  if (api.store.selectOne("SELECT COUNT(*) AS count FROM client_command_receipts").count >= 10000) throw deviceError("COMMAND_JOURNAL_FULL", 503);
  const now = new Date().toISOString();
  api.store.db.run(`INSERT INTO client_command_receipts
    (device_id, request_id, session_id, kind, payload_hash, status, error_code, created_at, updated_at)
    VALUES (?, ?, '', 'open_work_discussion', ?, 'dispatching', NULL, ?, ?)`,
    [identity.deviceId, input.requestId, fingerprint, now, now]);
  const key = `${identity.deviceId}:${input.requestId}`;
  api.inFlight.add(key);
  try {
    const result = await api.workDiscussion.open({ workId, agentId: input.agentId, providerId: input.providerId });
    if (typeof result?.session?.id !== "string" || !result.session.id || result.session.workId !== workId
        || result.session.sessionKind !== "workChat" || typeof result.created !== "boolean") throw new Error("Invalid discussion result");
    api.update(identity.deviceId, input.requestId, "completed", null,
      { workId, sessionId: result.session.id, created: result.created });
  } catch {
    // Provider failure may follow a partial creation; never automatically dispatch again.
    api.update(identity.deviceId, input.requestId, "unknown", "DISCUSSION_CREATION_OUTCOME_UNCERTAIN");
  } finally { api.inFlight.delete(key); }
  return api.receipt(identity, input.requestId);
}
