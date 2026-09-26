import { createHash } from "node:crypto";
import { deviceError } from "./clientDeviceAuthority.mjs";
import { validateEntityName, validateTaskInput } from "../domain/workTaskValidation.mjs";
import { TASK_PRIORITIES } from "../domain/taskToolSchema.mjs";

const taskFields = ["workId", "title", "description", "acceptanceCriteria", "verificationCriteria", "priority", "mainAgentId"];
const providerFields = ["providerId", "model", "reasoningLevel"];
const fields = ["requestId", ...taskFields, ...providerFields];

/** Read-only, Work-scoped choices; never expose configuration, paths, or Provider envelopes. */
export async function clientTaskCreationCatalog(api, identity, sourceID, query) {
  if ([...query.keys()].some(key => key !== "providerId") || query.getAll("providerId").length > 1) {
    throw deviceError("INVALID_QUERY", 400);
  }
  const providerId = query.get("providerId");
  if (providerId !== null && (!providerId.trim() || providerId.length > 512)) throw deviceError("INVALID_PROVIDER_ID", 400);
  if (!api.taskCreation?.options) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
  const { sessionId, session } = api.session(sourceID);
  const work = session.workId ? api.store.getWork(session.workId) : null;
  if (!work) throw deviceError("WORK_REQUIRED", 409);
  const options = await api.taskCreation.options(sessionId, providerId);
  const current = api.session(sourceID);
  if (current.sessionId !== sessionId || current.session.workId !== work.id) throw deviceError("SOURCE_SESSION_CHANGED", 409);
  const currentWork = api.store.getWork(work.id);
  if (!currentWork) throw deviceError("WORK_REQUIRED", 409);
  const providers = (options.providers ?? []).filter(row => typeof row.id === "string").map(row => ({
    id: row.id, name: typeof row.name === "string" ? row.name : row.id,
    available: row.available === true, reason: row.available === true ? null : "PROVIDER_CAPABILITY_UNAVAILABLE",
    supportsModels: row.supportsModels === true
  }));
  if (providerId !== null && !providers.some(row => row.id === providerId && row.available)) {
    throw deviceError("PROVIDER_CAPABILITY_UNAVAILABLE", 409);
  }
  const models = (options.models ?? []).filter(row => typeof row.id === "string").map(row => ({
    id: row.id, name: typeof row.name === "string" ? row.name : row.id,
    reasoningLevels: Array.isArray(row.reasoningLevels) ? row.reasoningLevels.filter(value => typeof value === "string") : [],
    defaultReasoningLevel: typeof row.defaultReasoningLevel === "string" ? row.defaultReasoningLevel : null
  }));
  const agents = (currentWork.contributorAgentIds ?? []).map(id => api.store.getAgent(id)).filter(Boolean)
    .map(agent => ({ id: agent.agentId ?? agent.id, name: agent.name }));
  const result = { schemaVersion: 1, sourceSessionId: sessionId,
    work: { id: currentWork.id, name: currentWork.name }, agents, providers, providerId,
    defaultProviderId: providers.some(row => row.id === options.defaultProviderId && row.available) ? options.defaultProviderId : null,
    models, currentModel: typeof options.currentModel === "string" ? options.currentModel : null,
    currentReasoningLevel: typeof options.currentReasoningLevel === "string" ? options.currentReasoningLevel : null,
    priorities: [...TASK_PRIORITIES] };
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw deviceError("CATALOG_TOO_LARGE", 413);
  return result;
}

/** Device boundary only; creation and Provider operations remain in the shared application service. */
export async function createClientTask(api, identity, sourceID, input, revalidateIdentity = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !fields.includes(key))
      || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId ?? "")) throw deviceError("INVALID_TASK_CREATION", 400);
  for (const key of [...taskFields, ...providerFields]) {
    if (input[key] !== undefined && (typeof input[key] !== "string"
        || input[key].length > (["description", "acceptanceCriteria", "verificationCriteria"].includes(key) ? 16000 : 512))) {
      throw deviceError("INVALID_TASK_CREATION", 400);
    }
  }
  for (const key of ["mainAgentId", "providerId"]) {
    if (!input[key]?.trim()) throw deviceError("INVALID_TASK_CREATION", 400);
  }
  const taskInput = validateTaskInput(Object.fromEntries(taskFields.filter(key => input[key] !== undefined)
    .map(key => [key, input[key]])));
  validateEntityName(taskInput.title, "title", "Task");
  const fingerprint = createHash("sha256").update(JSON.stringify([sourceID, "create_task",
    ...fields.map(key => input[key] ?? null)])).digest("hex");
  const findReplay = () => {
    const existing = api.store.selectOne("SELECT payload_hash FROM client_command_receipts WHERE device_id=? AND request_id=?",
      [identity.deviceId, input.requestId]);
    if (!existing) return null;
    if (existing.payload_hash !== fingerprint) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
    return api.receipt(identity, input.requestId);
  };
  const replay = findReplay();
  if (replay) return replay;
  if (!api.taskCreation) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
  const { sessionId, session } = api.session(sourceID);
  if (!session.workId || session.workId !== taskInput.workId) throw deviceError("TASK_OUTSIDE_WORK", 403);
  const work = api.store.getWork(taskInput.workId);
  if (!work || !(work.contributorAgentIds ?? []).includes(taskInput.mainAgentId)) {
    throw deviceError("AGENT_OUTSIDE_WORK", 403);
  }
  if (!api.store.getAgent(taskInput.mainAgentId)) throw deviceError("AGENT_NOT_FOUND", 404);
  const provider = Object.fromEntries(providerFields.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  await api.taskCreation.validate(sessionId, { taskInput, ...provider });
  if (revalidateIdentity) {
    const current = revalidateIdentity();
    if (current.deviceId !== identity.deviceId) throw deviceError("INVALID_CREDENTIAL", 401);
    identity = current;
  }
  // Recheck scope after asynchronous preflight, before claiming or dispatching.
  const currentSession = api.session(sourceID);
  if (currentSession.sessionId !== sessionId || currentSession.session.workId !== taskInput.workId) {
    throw deviceError("SOURCE_SESSION_CHANGED", 409);
  }
  if (!(api.store.getWork(taskInput.workId)?.contributorAgentIds ?? []).includes(taskInput.mainAgentId)) {
    throw deviceError("AGENT_OUTSIDE_WORK", 403);
  }
  const raced = findReplay();
  if (raced) return raced;
  if (api.store.selectOne("SELECT COUNT(*) AS count FROM client_command_receipts").count >= 10000) {
    throw deviceError("COMMAND_JOURNAL_FULL", 503);
  }
  const now = new Date().toISOString();
  const key = `${identity.deviceId}:${input.requestId}`;
  api.store.db.run(`INSERT INTO client_command_receipts
    (device_id, request_id, session_id, kind, payload_hash, status, error_code, created_at, updated_at)
    VALUES (?, ?, ?, 'create_task', ?, 'dispatching', NULL, ?, ?)`,
    [identity.deviceId, input.requestId, sessionId, fingerprint, now, now]);
  api.inFlight.add(key);
  try {
    const operationID = `device-task:${createHash("sha256").update(key).digest("hex")}`;
    const result = await api.taskCreation.create(sessionId, { taskInput, ...provider, operationID });
    if (typeof result?.task?.id !== "string" || typeof result?.session?.id !== "string") {
      throw new Error("Creation result is not a complete Task/Session binding");
    }
    api.update(identity.deviceId, input.requestId, "completed", null,
      { taskId: result.task.id, sessionId: result.session.id, workId: taskInput.workId });
  } catch {
    // The Task may already exist even if companion Session startup failed.
    // Never represent a partial write as a pre-dispatch rejection or auto-replay it.
    api.update(identity.deviceId, input.requestId, "unknown", "TASK_CREATION_OUTCOME_UNCERTAIN");
  } finally { api.inFlight.delete(key); }
  return api.receipt(identity, input.requestId);
}
