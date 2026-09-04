import { createHash } from "node:crypto";

export async function createTaskAndSession({
  workService,
  startWorkSession,
  taskInput,
  creationOrigin,
  sourceSessionId,
  providerId,
  idempotencyKey,
  persistTask = null
}) {
  if (!workService || typeof startWorkSession !== "function") {
    throw coded("CAPABILITY_UNAVAILABLE", "Task creation and Session startup are unavailable.", 503);
  }
  const source = required(sourceSessionId, "sourceSessionId");
  const provider = required(providerId, "providerId");
  const operationKey = required(idempotencyKey, "idempotencyKey");
  const normalizedTaskInput = {
    ...taskInput,
    id: taskInput?.id ?? stableTaskId(source, operationKey)
  };
  let persisted;
  if (persistTask) {
    persisted = await persistTask();
  } else {
    const existing = workService.store.getTask(normalizedTaskInput.id);
    if (existing) {
      assertTaskCreationReplay(existing, normalizedTaskInput);
      persisted = { task: existing, idempotentReplay: true };
    } else {
      persisted = {
        task: workService.createTask(normalizedTaskInput, { creationOrigin }),
        idempotentReplay: false
      };
    }
  }
  const task = persisted.task;
  const taskId = task?.id;
  const agentId = task?.main_agent_id ?? task?.mainAgentId;
  if (!taskId || !agentId) {
    throw coded("TASK_AGENT_REQUIRED", "Task creation requires an assigned Independent Contributor Agent.", 400);
  }

  const existingSessionId = task.current_session_id ?? task.currentSessionId;
  if (existingSessionId) {
    const existingSession = workService.store.getSession(existingSessionId);
    if (existingSession) {
      return {
        task: workService.getTask(taskId),
        session: existingSession,
        start: null,
        idempotentReplay: true
      };
    }
  }

  const started = await startWorkSession({
    taskId,
    assigneeAgentId: agentId,
    expectedTaskVersion: Number(task.resource_version ?? task.resourceVersion ?? 1),
    providerId: provider,
    title: task.title,
    idempotencyKey: `task-create:${operationKey}`,
    sourceSessionId: source
  });
  if (started?.status && started.status !== "ready") {
    throw coded("START_NOT_READY", "Task creation did not produce a ready Session binding.", 409);
  }
  if (!started?.session) {
    throw coded("START_SESSION_UNRESOLVED", "Task creation did not return its companion Session.", 500);
  }
  return {
    task: workService.getTask(taskId),
    session: started.session,
    start: started.receipt ?? null,
    idempotentReplay: persisted.idempotentReplay === true || started.idempotentReplay === true
  };
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
