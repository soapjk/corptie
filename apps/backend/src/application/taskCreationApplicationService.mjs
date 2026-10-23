import { createHash } from "node:crypto";
import { resolveTaskCreationDefaults } from "../utils/newSessionDefaults.mjs";
import { TaskWorktreeHierarchyService } from "./taskWorktreeHierarchyService.mjs";

const creations = new WeakMap();

export async function createTaskAndSession(input) {
  const store = input.workService?.store;
  if (!store) return createTaskAndSessionOnce(input);
  let active = creations.get(store);
  if (!active) { active = new Map(); creations.set(store, active); }
  const key = JSON.stringify([input.sourceSessionId, input.idempotencyKey]);
  const fingerprint = JSON.stringify([Object.entries(input.taskInput ?? {}).sort(), input.providerId, input.model, input.reasoningLevel, input.runtimeConfiguration]);
  const existing = active.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw coded("IDEMPOTENCY_CONFLICT", "Task creation input changed while creation is pending.", 409);
    return existing.promise;
  }
  const entry = { fingerprint };
  entry.promise = createTaskAndSessionOnce(input);
  active.set(key, entry);
  try { return await entry.promise; }
  finally { if (active.get(key) === entry) active.delete(key); }
}

async function createTaskAndSessionOnce({
  workService,
  startWorkSession,
  taskInput,
  creationOrigin,
  sourceSessionId,
  providerId,
  model,
  reasoningLevel,
  idempotencyKey,
  expectedParentResourceVersion,
  runtimeConfiguration = null,
  revalidate = () => {},
  verifyExistingSession = null,
  persistTask = null
}) {
  if (!workService || typeof startWorkSession !== "function" || typeof workService.store?.setTaskCreationState !== "function") {
    throw coded("CAPABILITY_UNAVAILABLE", "Task creation and Session startup are unavailable.", 503);
  }
  const source = required(sourceSessionId, "sourceSessionId");
  const runtime = runtimeConfiguration ?? resolveTaskCreationDefaults({ providerId, model, reasoningLevel },
    workService.store.settings?.().newSessionDefaults ?? {});
  const provider = required(runtime.providerId, "providerId");
  const operationKey = required(idempotencyKey, "idempotencyKey");
  const normalizedTaskInput = {
    ...taskInput,
    id: taskInput?.id ?? stableTaskId(source, operationKey)
  };
  let persisted;
  if (normalizedTaskInput.parentTaskId && !workService.store.getTask(normalizedTaskInput.id)) {
    await new TaskWorktreeHierarchyService({ store: workService.store }).validateCreate(normalizedTaskInput, { expectedParentResourceVersion });
  }
  if (persistTask) {
    revalidate();
    persisted = await persistTask();
  } else {
    const existing = workService.store.getTask(normalizedTaskInput.id);
    if (existing) {
      assertTaskCreationReplay(existing, normalizedTaskInput);
      persisted = { task: existing, idempotentReplay: true };
    } else {
      revalidate();
      persisted = {
        task: workService.createTask(normalizedTaskInput, { creationOrigin, expectedParentResourceVersion, creationPending: true }),
        idempotentReplay: false
      };
    }
  }
  const taskId = persisted.task?.id;
  try {
    // Creation emits synchronous domain events. Use their committed projection,
    // not the pre-event object, while refusing changes to the creation intent.
    const task = workService.store.getTask(persisted.task?.id) ?? persisted.task;
    assertTaskCreationReplay(task, normalizedTaskInput);
    if (Number(task?.revision ?? 1) !== Number(persisted.task?.revision ?? 1)) {
      throw coded("TASK_VERSION_CONFLICT", "Task definition changed during creation.", 409);
    }
    const agentId = task?.main_agent_id ?? task?.mainAgentId;
    if (!taskId || !agentId) {
      throw coded("TASK_AGENT_REQUIRED", "Task creation requires an assigned Independent Contributor Agent.", 400);
    }

    const existingSessionId = task.current_session_id ?? task.currentSessionId;
    if (existingSessionId) {
      const existingSession = workService.store.getSession(existingSessionId);
      if (existingSession) {
        revalidate();
        const pair = verifiedPair(workService.store, taskId, existingSession.id);
        const proof = verifyExistingSession ? await verifyExistingSession(pair.task, pair.session) : null;
        revalidate();
        publish(workService, taskId);
        return {
          task: workService.getTask(taskId),
          session: pair.session,
          start: proof,
          idempotentReplay: true
        };
      }
    }

    revalidate();
    workService.store.setTaskCreationState(taskId, "pending");
    const started = await startWorkSession({
      taskId,
      assigneeAgentId: agentId,
      expectedTaskVersion: Number(task.resource_version ?? task.resourceVersion ?? 1),
      providerId: provider,
      ...(runtime.model != null ? { model: runtime.model } : {}),
      ...(runtime.reasoningLevel != null ? { reasoningLevel: runtime.reasoningLevel } : {}),
      title: task.title,
      idempotencyKey: `task-create:${operationKey}`,
      sourceSessionId: source,
      dispatchInitialTurn: false
    });
    if (started?.status !== "ready") {
      const error = coded(started?.error?.code ?? "START_NOT_READY", started?.error?.message ?? "Task creation did not produce a ready Session binding.", 409);
      error.creationPending = started?.status === "pending";
      error.retryable = error.creationPending || started?.error?.retryable === true;
      throw error;
    }
    if (!started?.session) {
      throw coded("START_SESSION_UNRESOLVED", "Task creation did not return its companion Session.", 500);
    }
    const pair = verifiedPair(workService.store, taskId, started.session.id);
    const proof = verifyExistingSession ? await verifyExistingSession(pair.task, pair.session) : null;
    revalidate();
    publish(workService, taskId);
    return {
      task: workService.getTask(taskId),
      session: pair.session,
      start: started.receipt ?? proof ?? null,
      idempotentReplay: persisted.idempotentReplay === true || started.idempotentReplay === true
    };
  } catch (error) {
    // Keep failed rows as exact retry/audit evidence, never ordinary Tasks.
    // Do not delete a Session or Worktree based on a partially returned object.
    const current = workService.store.getTask(taskId);
    let complete = false;
    try { verifiedPair(workService.store, taskId, current?.current_session_id ?? current?.currentSessionId); complete = true; } catch { /* incomplete */ }
    if (current && !complete) {
      workService.store.setTaskCreationState(taskId, error.creationPending ? "pending" : "failed", error.code ?? "TASK_CREATION_FAILED");
      workService.emit?.("TaskChanged", workService.store.getTask(taskId), error.creationPending ? "creation-pending" : "creation-failed");
    }
    error.creationRecovery = { ...error.creationRecovery, taskId, status: complete ? "binding_ready" : error.creationPending ? "pending" : "failed", retryable: error.retryable === true };
    throw error;
  }
}

function verifiedPair(store, taskId, sessionId) {
  const task = store.getTask(taskId);
  const session = sessionId ? store.getSession(sessionId) : null;
  if (!task || !session || (task.current_session_id ?? task.currentSessionId) !== session.id
      || (session.taskId ?? session.task_id) !== task.id || (session.workId ?? session.work_id) !== (task.work_id ?? task.workId)
      || session.deletedAt || session.deleted_at || session.status === "deleted"
      || session.sessionKind && session.sessionKind !== "worker") {
    throw coded("TASK_SESSION_BINDING_INCOMPLETE", "Task creation failed: its persisted companion Session is missing or not bound to the same Task and Work.", 409);
  }
  return { task, session };
}

function publish(workService, taskId) {
  const wasReady = workService.store.getTask(taskId)?.creation_state === "ready";
  const task = workService.store.setTaskCreationState(taskId, "ready");
  if (!wasReady) workService.emit?.("TaskChanged", task, "creation-ready");
}

function stableTaskId(sourceSessionId, idempotencyKey) {
  const digest = createHash("sha256")
    .update(sourceSessionId)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex");
  return `task:create:${digest}`;
}

function required(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw coded("INVALID_INPUT", `${field} is required.`, 400);
  return normalized;
}

function assertTaskCreationReplay(existing, input) {
  if ((existing?.parent_task_id ?? existing?.parentTaskId ?? null) !== (input.parentTaskId ?? null)) {
    throw coded("ENTITY_CREATION_CONFLICT", "Task creation parent differs from the original request.", 409);
  }
  const comparisons = [
    ["workId", existing.work_id, input.workId],
    ["title", existing.title, input.title],
    ["description", existing.description, input.description],
    ["acceptanceCriteria", existing.acceptance_criteria, input.acceptanceCriteria],
    ["verificationCriteria", existing.verification_criteria, input.verificationCriteria],
    ["priority", existing.priority, input.priority],
    ["mainAgentId", existing.main_agent_id, input.mainAgentId]
  ];
  const mismatch = comparisons.find(([, stored, requested]) =>
    requested != null && String(stored ?? "") !== String(requested)
  );
  if (mismatch) {
    throw coded(
      "ENTITY_CREATION_CONFLICT",
      `Task ${existing.id} already exists with different ${mismatch[0]}.`,
      409
    );
  }
}

function coded(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
