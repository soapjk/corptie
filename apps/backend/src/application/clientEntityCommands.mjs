import { createHash } from "node:crypto";
import { deviceError } from "./clientDeviceAuthority.mjs";
import { validateEntityName } from "../domain/workTaskValidation.mjs";

/**
 * Device-side Work / Task management (the macOS outline context menus).
 * Every write is a receipt-backed idempotent command that calls the same host
 * services the desktop routes use; nothing here mutates the store directly.
 */
export const TASK_PRIORITIES = Object.freeze(["low", "medium", "high", "urgent"]);
export const TASK_COMMANDS = Object.freeze(["update", "archive", "restart", "delete"]);
export const WORK_COMMANDS = Object.freeze(["update", "delete"]);
const TASK_TEXT_FIELDS = ["description", "acceptanceCriteria", "verificationCriteria"];
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const TEXT_LIMIT = 16_000;

function entityId(value, code) {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw deviceError(code, 400);
  return value;
}
function requireTask(api, taskId) {
  const task = api.store.getTask(entityId(taskId, "INVALID_TASK_ID"));
  if (!task) throw deviceError("TASK_NOT_FOUND", 404);
  return task;
}
function requireWork(api, workId) {
  const work = api.store.getWork(entityId(workId, "INVALID_WORK_ID"));
  if (!work) throw deviceError("WORK_NOT_FOUND", 404);
  return work;
}
function requireSupport(api) {
  if (!api.entityCommands) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
  return api.entityCommands;
}
function action(available, reason = null) {
  return { available: available === true, reason: available === true ? null : reason };
}
function deviceActor(identity) {
  return { type: "user", id: `user:paired-device:${identity.deviceId}` };
}
function contributors(api, work) {
  return (work?.contributorAgentIds ?? []).map(id => api.store.getAgent(id)).filter(Boolean)
    .map(agent => ({ id: agent.agentId, name: agent.name }));
}
function text(value, code, { limit = TEXT_LIMIT, required = false } = {}) {
  if (typeof value !== "string" || value.length > limit || (required && !value.trim())) throw deviceError(code, 400);
  return value;
}
function name(value, field, entity, code) {
  text(value, code, { limit: 512, required: true });
  try { validateEntityName(value, field, entity); } catch { throw deviceError(code, 400); }
  return value;
}
function knownFields(input, allowed, code) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !allowed.includes(key))
      || typeof input.requestId !== "string" || !REQUEST_ID.test(input.requestId)) throw deviceError(code, 400);
}
/** Host service errors with a stable 4xx code are definite rejections; everything else is an unknown outcome. */
const REJECTION_ERROR_NAMES = new Set(["EntityValidationError", "WorkNotFoundError", "TaskNotFoundError", "TaskAcceptanceError"]);
function rejection(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? error.code : null;
  if (!code) return null;
  const status = Number(error?.status ?? error?.statusCode);
  if (status >= 400 && status < 500) return { code, status };
  // Domain validation errors are thrown before any write and carry no HTTP status.
  return REJECTION_ERROR_NAMES.has(error?.name) ? { code, status: 400 } : null;
}

function projectTask(task) {
  return { id: task.id, workId: task.work_id, title: task.title, description: task.description ?? "",
    acceptanceCriteria: task.acceptance_criteria ?? "", verificationCriteria: task.verification_criteria ?? "",
    priority: task.priority, lifecycleState: task.lifecycle_state, archived: Boolean(task.archived),
    mainAgentId: task.main_agent_id ?? null,
    deletionStatus: ["deleting", "delete_failed"].includes(task.deletion_status) ? task.deletion_status : null };
}

/** Same gates as the desktop menu: deleting hides everything, restart follows the Session action projection. */
export function taskActions(api, task) {
  const deleting = task.deletion_status === "deleting";
  const archived = Boolean(task.archived);
  const done = task.lifecycle_state === "done";
  let restart = action(false, deleting ? "TASK_DELETING" : "SESSION_NOT_AVAILABLE");
  if (!deleting && task.current_session_id) {
    const session = api.store.getSession(task.current_session_id);
    if (session && session.archived !== true) {
      const projected = api.actions?.(session)?.restart;
      restart = action(projected?.available === true, projected?.reason ?? "RESTART_UNAVAILABLE");
    }
  }
  return {
    rename: action(!deleting, "TASK_DELETING"),
    edit: action(!deleting, "TASK_DELETING"),
    restart,
    archive: action(!deleting && !archived && !done, deleting ? "TASK_DELETING" : archived ? "TASK_ARCHIVED" : "TASK_COMPLETED"),
    unarchive: action(!deleting && archived, deleting ? "TASK_DELETING" : "TASK_NOT_ARCHIVED"),
    delete: action(!deleting, "TASK_DELETING")
  };
}

export function clientTaskManagement(api, identity, taskId) {
  requireSupport(api);
  const task = requireTask(api, taskId);
  const work = api.store.getWork(task.work_id);
  return { schemaVersion: 1, task: projectTask(task), agents: contributors(api, work),
    priorities: [...TASK_PRIORITIES], actions: taskActions(api, task) };
}

/** Desktop deletion plan without host paths; relative file names stay because the user decides on them. */
export async function clientTaskDeletionPlan(api, identity, taskId) {
  const commands = requireSupport(api);
  const task = requireTask(api, taskId);
  let plan;
  try { plan = await commands.inspectTaskDeletion(task.id, deviceActor(identity)); }
  catch (error) {
    const rejected = rejection(error);
    throw deviceError(rejected?.code ?? "TASK_DELETION_INSPECTION_FAILED", rejected?.status ?? 503);
  }
  const risk = row => ({ code: String(row.code), message: typeof row.message === "string" ? row.message.slice(0, 512) : "",
    ...(Array.isArray(row.files) ? { files: row.files.filter(file => typeof file === "string").slice(0, 8).map(file => file.slice(0, 256)) } : {}),
    ...(Number.isFinite(row.commitCount) ? { commitCount: row.commitCount } : {}) });
  return { schemaVersion: 1, taskId: task.id,
    status: ["blocked", "risky", "safe"].includes(plan?.status) ? plan.status : "blocked",
    associatedSessionCount: Number(plan?.associatedSessionCount) || 0,
    artifacts: (plan?.artifacts ?? []).map(row => ({ id: String(row.artifactId), title: typeof row.title === "string" ? row.title : "" })).slice(0, 50),
    worktree: plan?.worktree ? { branchName: typeof plan.worktree.branchName === "string" ? plan.worktree.branchName : null,
      dirty: plan.worktree.dirty === true, mergedIntoMain: plan.worktree.mergedIntoMain === true,
      aheadOfMain: Number(plan.worktree.aheadOfMain) || 0 } : null,
    risks: (plan?.risks ?? []).map(risk), blockers: (plan?.blockers ?? []).map(risk) };
}

export function clientWorkManagement(api, identity, workId) {
  requireSupport(api);
  const work = requireWork(api, workId);
  const deleting = api.store.listTasksByWork(work.id).some(task => task.deletion_status === "deleting");
  return { schemaVersion: 1, work: { id: work.id, name: work.name, description: work.description ?? "", status: work.status },
    actions: { edit: action(true), delete: action(!deleting, "WORK_TASK_DELETING") } };
}

export function clientTaskCommand(api, identity, taskId, command, input, revalidateIdentity) {
  if (!TASK_COMMANDS.includes(command)) throw deviceError("ROUTE_NOT_AVAILABLE", 404);
  const commands = requireSupport(api);
  const task = requireTask(api, taskId);
  const fields = validateTaskCommand(api, task, command, input);
  return execute(api, identity, revalidateIdentity, { kind: `task_${command}`,
    entityId: task.id, requestId: input.requestId, fields, uncertainCode: `TASK_${command.toUpperCase()}_OUTCOME_UNCERTAIN`,
    run: async fingerprint => {
      const current = requireTask(api, task.id);
      if (current.deletion_status === "deleting") throw Object.assign(new Error("TASK_DELETING"), { code: "TASK_DELETING", status: 409 });
      switch (command) {
        case "update": {
          const updated = await commands.updateTask(current.id, fields);
          return { taskId: current.id, title: updated?.title ?? fields.title ?? current.title };
        }
        case "archive": {
          const updated = await commands.setTaskArchived(current.id, fields.archived);
          return { taskId: current.id, archived: Boolean(updated?.archived ?? fields.archived) };
        }
        case "restart": {
          const session = current.current_session_id ? api.store.getSession(current.current_session_id) : null;
          if (!session || session.archived === true) throw Object.assign(new Error("SESSION_NOT_AVAILABLE"), { code: "SESSION_NOT_AVAILABLE", status: 409 });
          const result = await commands.restartTask(current.id, { source: "client-device", idempotencyKey: `task-restart:device:${fingerprint}` });
          return { taskId: current.id, status: typeof result?.status === "string" ? result.status : "restarted" };
        }
        case "delete": {
          const result = await commands.deleteTask(current.id, { ...fields, idempotencyKey: `task-delete:${current.id}:device:${fingerprint}` },
            deviceActor(identity));
          return { taskId: current.id, operationId: result?.operation?.operationId ?? null, state: result?.operation?.state ?? null };
        }
        default: throw new Error("unreachable");
      }
    } });
}

export function clientWorkCommand(api, identity, workId, command, input, revalidateIdentity) {
  if (!WORK_COMMANDS.includes(command)) throw deviceError("ROUTE_NOT_AVAILABLE", 404);
  const commands = requireSupport(api);
  const work = requireWork(api, workId);
  const fields = validateWorkCommand(command, input);
  return execute(api, identity, revalidateIdentity, { kind: `work_${command}`,
    entityId: work.id, requestId: input.requestId, fields, uncertainCode: `WORK_${command.toUpperCase()}_OUTCOME_UNCERTAIN`,
    run: async () => {
      const current = requireWork(api, work.id);
      if (command === "update") {
        const updated = await commands.updateWork(current.id, fields);
        return { workId: current.id, name: updated?.name ?? fields.name ?? current.name };
      }
      if (api.store.listTasksByWork(current.id).some(task => task.deletion_status === "deleting")) {
        throw Object.assign(new Error("WORK_TASK_DELETING"), { code: "WORK_TASK_DELETING", status: 409 });
      }
      await commands.deleteWork(current.id);
      return { workId: current.id };
    } });
}

function validateTaskCommand(api, task, command, input) {
  const code = "INVALID_TASK_COMMAND";
  switch (command) {
    case "update": {
      knownFields(input, ["requestId", "title", ...TASK_TEXT_FIELDS, "priority", "mainAgentId"], code);
      const fields = {};
      if ("title" in input) fields.title = name(input.title, "title", "Task", code);
      for (const key of TASK_TEXT_FIELDS) if (key in input) fields[key] = text(input[key], code);
      if ("priority" in input) {
        if (!TASK_PRIORITIES.includes(input.priority)) throw deviceError(code, 400);
        fields.priority = input.priority;
      }
      if ("mainAgentId" in input) {
        entityId(input.mainAgentId, code);
        const work = api.store.getWork(task.work_id);
        if (!(work?.contributorAgentIds ?? []).includes(input.mainAgentId)) throw deviceError("AGENT_OUTSIDE_WORK", 403);
        if (!api.store.getAgent(input.mainAgentId)) throw deviceError("AGENT_NOT_FOUND", 404);
        fields.mainAgentId = input.mainAgentId;
      }
      if (Object.keys(fields).length === 0) throw deviceError(code, 400);
      return fields;
    }
    case "archive":
      knownFields(input, ["requestId", "archived"], code);
      if (typeof input.archived !== "boolean") throw deviceError(code, 400);
      return { archived: input.archived };
    case "restart":
      knownFields(input, ["requestId"], code);
      return {};
    case "delete": {
      knownFields(input, ["requestId", "mode", "deleteWorktree", "artifactDisposition", "acknowledgeDataLoss", "confirmedBranchName"], code);
      const fields = { mode: input.mode ?? "safe", deleteWorktree: input.deleteWorktree ?? true,
        artifactDisposition: input.artifactDisposition ?? "delete" };
      if (!["safe", "force"].includes(fields.mode) || typeof fields.deleteWorktree !== "boolean"
          || !["delete", "work", "retain"].includes(fields.artifactDisposition)) throw deviceError(code, 400);
      if ("acknowledgeDataLoss" in input) {
        if (typeof input.acknowledgeDataLoss !== "boolean") throw deviceError(code, 400);
        fields.acknowledgeDataLoss = input.acknowledgeDataLoss;
      }
      if ("confirmedBranchName" in input) fields.confirmedBranchName = text(input.confirmedBranchName, code, { limit: 512 });
      return fields;
    }
    default: throw deviceError("ROUTE_NOT_AVAILABLE", 404);
  }
}

function validateWorkCommand(command, input) {
  const code = "INVALID_WORK_COMMAND";
  if (command === "delete") {
    knownFields(input, ["requestId"], code);
    return {};
  }
  knownFields(input, ["requestId", "name", "description"], code);
  const fields = {};
  if ("name" in input) fields.name = name(input.name, "name", "Work", code);
  if ("description" in input) fields.description = text(input.description, code);
  if (Object.keys(fields).length === 0) throw deviceError(code, 400);
  return fields;
}

/** Fingerprint → replay → revalidate → journal → run → durable receipt. Never dispatches twice. */
async function execute(api, identity, revalidateIdentity, { kind, entityId: id, requestId, fields, uncertainCode, run }) {
  const fingerprint = createHash("sha256").update(JSON.stringify([kind, id, requestId, fields])).digest("hex");
  const replay = () => {
    const row = api.store.selectOne("SELECT payload_hash FROM client_command_receipts WHERE device_id=? AND request_id=?", [identity.deviceId, requestId]);
    if (!row) return null;
    if (row.payload_hash !== fingerprint) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
    return api.receipt(identity, requestId);
  };
  const existing = replay();
  if (existing) return existing;
  if (revalidateIdentity) {
    const current = revalidateIdentity();
    if (current.deviceId !== identity.deviceId) throw deviceError("INVALID_CREDENTIAL", 401);
    identity = current;
  }
  const raced = replay();
  if (raced) return raced;
  if (api.store.selectOne("SELECT COUNT(*) AS count FROM client_command_receipts").count >= 10000) throw deviceError("COMMAND_JOURNAL_FULL", 503);
  const now = new Date().toISOString();
  api.store.db.run(`INSERT INTO client_command_receipts
    (device_id, request_id, session_id, kind, payload_hash, status, error_code, created_at, updated_at)
    VALUES (?, ?, '', ?, ?, 'dispatching', NULL, ?, ?)`, [identity.deviceId, requestId, kind, fingerprint, now, now]);
  const key = `${identity.deviceId}:${requestId}`;
  api.inFlight.add(key);
  try {
    const result = await run(fingerprint);
    api.update(identity.deviceId, requestId, "completed", null, result);
  } catch (error) {
    const rejected = rejection(error);
    // A 4xx host code is a definite refusal before side effects; anything else may have partially applied.
    api.update(identity.deviceId, requestId, rejected ? "rejected" : "unknown", rejected?.code ?? uncertainCode);
  } finally { api.inFlight.delete(key); }
  return api.receipt(identity, requestId);
}
