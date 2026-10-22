import { createHash } from "node:crypto";
import { resolveTaskCreationDefaults } from "../utils/newSessionDefaults.mjs";
import { TaskWorktreeHierarchyService } from "./taskWorktreeHierarchyService.mjs";

export async function createTaskAndSession({
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
  if (!workService || typeof startWorkSession !== "function") {
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
        task: workService.createTask(normalizedTaskInput, { creationOrigin, expectedParentResourceVersion }),
        idempotentReplay: false
      };
    }
  }
  // Creation emits synchronous domain events. Use their committed projection,
  // not the pre-event object, while refusing changes to the creation intent.
  const task = workService.store.getTask(persisted.task?.id) ?? persisted.task;
  assertTaskCreationReplay(task, normalizedTaskInput);
  if (Number(task?.revision ?? 1) !== Number(persisted.task?.revision ?? 1)) {
    throw coded("TASK_VERSION_CONFLICT", "Task definition changed during creation.", 409);
  }
  const taskId = task?.id;
  const agentId = task?.main_agent_id ?? task?.mainAgentId;
  if (!taskId || !agentId) {
    throw coded("TASK_AGENT_REQUIRED", "Task creation requires an assigned Independent Contributor Agent.", 400);
  }

  const existingSessionId = task.current_session_id ?? task.currentSessionId;
  if (existingSessionId) {
    const existingSession = workService.store.getSession(existingSessionId);
    if (existingSession) {
      revalidate();
      const proof = verifyExistingSession ? await verifyExistingSession(task, existingSession) : null;
      revalidate();
      return {
        task: workService.getTask(taskId),
        session: existingSession,
        start: proof,
        idempotentReplay: true
      };
    }
  }

  revalidate();
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
  if (started?.status && started.status !== "ready") {
    throw coded(started.error?.code ?? "START_NOT_READY", "Task creation did not produce a ready Session binding.", 409);
  }
  if (!started?.session) {
    throw coded("START_SESSION_UNRESOLVED", "Task creation did not return its companion Session.", 500);
  }
  revalidate();
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
