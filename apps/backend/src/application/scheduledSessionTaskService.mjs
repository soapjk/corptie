import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  nextIntervalRun,
  validateScheduledSessionTaskInput,
  validateScheduledSessionTaskPatch
} from "../domain/scheduledSessionTask.mjs";

const execFileAsync = promisify(execFile);
const TERMINAL_TASK_STATUSES = new Set(["completed", "cancelled"]);

export class ScheduledSessionTaskService {
  constructor(options = {}) {
    this.store = options.store;
    this.environment = options.environment;
    this.resolveRoute = options.resolveRoute;
    this.authorize = options.authorize;
    this.enqueue = options.enqueue;
    this.onEvent = options.onEvent ?? null;
    this.inspectProcess = options.inspectProcess ?? inspectProcess;
    this.now = options.now ?? (() => new Date());
    this.leaseOwner = options.leaseOwner ?? `scheduler:${process.pid}:${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.tickMs = options.tickMs ?? 1_000;
    this.missedGraceMs = options.missedGraceMs ?? Math.max(1_000, this.tickMs * 2);
    this.timer = null;
    this.ticking = false;
    if (!this.store || !this.environment || typeof this.resolveRoute !== "function"
      || typeof this.authorize !== "function" || typeof this.enqueue !== "function") {
      throw new TypeError("ScheduledSessionTaskService requires store, environment, route, authorization, and enqueue ports.");
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  create(input, actor) {
    const normalized = validateScheduledSessionTaskInput(input, { now: this.now() });
    const scope = this.#authorize(actor, normalized.logicalSessionId, "create");
    const task = this.store.createScheduledSessionTask({
      ...normalized,
      taskId: input.taskId ?? `scheduled_task:${randomUUID()}`,
      creatorType: actor.type,
      creatorId: actor.id,
      objectiveId: scope.objectiveId ?? null,
      environment: this.environment
    });
    this.#record("ScheduledSessionTaskCreated", task, null, actor, { task });
    return task;
  }

  get(taskId, actor) {
    const task = this.#task(taskId);
    this.#authorize(actor, task.logicalSessionId, "read", task);
    return { ...task, runs: this.store.listScheduledSessionRuns(taskId), events: this.store.listScheduledSessionEvents(taskId) };
  }

  list(options = {}, actor) {
    const tasks = this.store.listScheduledSessionTasks({
      environment: this.environment,
      logicalSessionId: options.logicalSessionId,
      status: options.status
    });
    return tasks.filter((task) => {
      try {
        this.#authorize(actor, task.logicalSessionId, "read", task);
        return true;
      } catch {
        return false;
      }
    });
  }

  update(taskId, input, actor) {
    const task = this.#task(taskId);
    this.#authorize(actor, task.logicalSessionId, "update", task);
    if (TERMINAL_TASK_STATUSES.has(task.status)) operationError("TASK_NOT_MUTABLE", `Task ${taskId} is ${task.status}.`);
    const normalized = validateScheduledSessionTaskPatch(input, task, { now: this.now() });
    const updated = this.store.updateScheduledSessionTask(taskId, {
      message: normalized.message,
      runAt: normalized.runAt,
      nextRunAt: normalized.nextRunAt,
      intervalSeconds: normalized.intervalSeconds,
      timezone: normalized.timezone,
      missedPolicy: normalized.missedPolicy,
      processSpec: normalized.processSpec,
      processState: normalized.processState,
      maxRetries: normalized.maxRetries,
      retryCount: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      pendingScheduledFor: null
    }, input.resourceVersion);
    this.#record("ScheduledSessionTaskUpdated", updated, null, actor, { before: task, task: updated });
    return updated;
  }

  pause(taskId, actor) {
    const task = this.#task(taskId);
    this.#authorize(actor, task.logicalSessionId, "pause", task);
    if (TERMINAL_TASK_STATUSES.has(task.status)) operationError("TASK_NOT_MUTABLE", `Task ${taskId} is ${task.status}.`);
    if (task.status === "paused") return task;
    const updated = this.store.updateScheduledSessionTask(taskId, {
      status: "paused", pausedAt: this.now().toISOString(), leaseOwner: null, leaseExpiresAt: null
    });
    this.#record("ScheduledSessionTaskPaused", updated, null, actor, {});
    return updated;
  }

  resume(taskId, actor) {
    const task = this.#task(taskId);
    this.#authorize(actor, task.logicalSessionId, "resume", task);
    if (!["paused", "failed"].includes(task.status)) operationError("TASK_NOT_RESUMABLE", `Task ${taskId} is ${task.status}.`);
    const now = this.now();
    const nextRunAt = task.nextRunAt ?? task.pendingScheduledFor ?? (task.scheduleType === "interval"
      ? new Date(now.getTime() + task.intervalSeconds * 1000).toISOString()
      : now.toISOString());
    const updated = this.store.updateScheduledSessionTask(taskId, {
      status: "active", nextRunAt, pausedAt: null, retryCount: 0,
      lastErrorCode: null, lastErrorMessage: null, leaseOwner: null, leaseExpiresAt: null
    });
    this.#record("ScheduledSessionTaskResumed", updated, null, actor, {});
    void this.tick();
    return updated;
  }

  cancel(taskId, actor) {
    const task = this.#task(taskId);
    this.#authorize(actor, task.logicalSessionId, "cancel", task);
    if (task.status === "cancelled") return task;
    const timestamp = this.now().toISOString();
    const updated = this.store.updateScheduledSessionTask(taskId, {
      status: "cancelled", cancelledAt: timestamp, nextRunAt: null,
      leaseOwner: null, leaseExpiresAt: null
    });
    this.#record("ScheduledSessionTaskCancelled", updated, null, actor, {});
    return updated;
  }

  async runNow(taskId, actor) {
    const task = this.#task(taskId);
    this.#authorize(actor, task.logicalSessionId, "run", task);
    if (task.status === "cancelled") operationError("TASK_CANCELLED", `Task ${taskId} is cancelled.`);
    const timestamp = this.now().toISOString();
    const nonce = randomUUID();
    const run = this.store.createScheduledSessionRun({
      runId: `scheduled_run:${nonce}`,
      taskId,
      runKey: `${taskId}:manual:${nonce}`,
      scheduledFor: timestamp,
      triggerKind: "manual",
      triggerReason: "run_now",
      status: "claimed",
      createdAt: timestamp
    });
    this.#record("ScheduledSessionTaskDue", task, run, actor, { triggerReason: "run_now" });
    return this.#dispatch(task, run, { preserveSchedule: true });
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const tasks = this.store.claimDueScheduledSessionTasks({
        environment: this.environment,
        now: now.toISOString(),
        leaseOwner: this.leaseOwner,
        leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString(),
        limit: 50
      });
      for (const task of tasks) {
        try {
          if (task.scheduleType === "process") await this.#tickProcess(task, now);
          else await this.#tickTime(task, now);
        } catch (error) {
          await this.#handleTriggerFailure(task, null, error, now);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  handleAgentWorkEvent(type, workItem) {
    const run = workItem?.workItemId
      ? this.store.getScheduledSessionRunForAgentWorkItem(workItem.workItemId)
      : null;
    if (!run) return null;
    const task = this.store.getScheduledSessionTask(run.taskId);
    if (!task || task.environment !== this.environment) return null;
    const timestamp = this.now().toISOString();
    let status;
    let eventType;
    if (type === "AgentWorkStarted") {
      status = "running";
      eventType = "ScheduledSessionRunStarted";
    } else if (type === "AgentWorkCompleted") {
      status = "completed";
      eventType = "ScheduledSessionRunCompleted";
    } else if (type === "AgentWorkFailed") {
      status = "failed";
      eventType = "ScheduledSessionRunFailed";
    } else return null;
    const updatedRun = this.store.updateScheduledSessionRun(run.runId, {
      status,
      targetTurnId: workItem.targetTurnId ?? run.targetTurnId,
      errorCode: status === "failed" ? "AGENT_WORK_FAILED" : null,
      errorMessage: status === "failed" ? workItem.lastError : null,
      startedAt: status === "running" ? timestamp : run.startedAt,
      completedAt: ["completed", "failed"].includes(status) ? timestamp : run.completedAt
    });
    this.store.updateScheduledSessionTask(task.taskId, {
      lastRunId: run.runId,
      lastRunStatus: status,
      lastErrorCode: updatedRun.errorCode,
      lastErrorMessage: updatedRun.errorMessage,
      lastRunAt: timestamp
    });
    this.#record(eventType, task, updatedRun, { type: "system", id: this.leaseOwner }, { workItem });
    return updatedRun;
  }

  async #tickTime(task, now) {
    const scheduledFor = task.pendingScheduledFor ?? task.nextRunAt;
    const missed = now.getTime() - new Date(scheduledFor).getTime() > this.missedGraceMs;
    if (missed) {
      const missedRun = this.store.createScheduledSessionRun({
        runId: stableId("scheduled_missed", task.taskId, scheduledFor),
        taskId: task.taskId,
        runKey: `${task.taskId}:missed:${scheduledFor}`,
        scheduledFor,
        triggerKind: "recovery",
        triggerReason: "backend_or_computer_unavailable",
        status: "missed",
        createdAt: now.toISOString()
      });
      this.#record("ScheduledSessionRunMissed", task, missedRun, { type: "system", id: this.leaseOwner }, {
        scheduledFor, policy: task.missedPolicy
      });
      if (task.missedPolicy === "skip") {
        return this.#advanceWithoutDispatch(task, now, "missed_policy_skip");
      }
    }
    const runKey = `${task.taskId}:scheduled:${scheduledFor}`;
    const existing = this.store.getScheduledSessionRunByKey(runKey);
    const run = existing ?? this.store.createScheduledSessionRun({
      runId: stableId("scheduled_run", task.taskId, scheduledFor),
      taskId: task.taskId,
      runKey,
      scheduledFor,
      triggerKind: missed ? "recovery" : "scheduled",
      triggerReason: missed ? "missed_run_coalesced" : "schedule_due",
      status: "claimed",
      attemptCount: task.retryCount + 1,
      createdAt: now.toISOString()
    });
    this.#record("ScheduledSessionTaskDue", task, run, { type: "system", id: this.leaseOwner }, {
      scheduledFor, missed
    });
    await this.#dispatch(task, run);
  }

  async #tickProcess(task, now) {
    const observation = await this.inspectProcess(task.processSpec);
    const state = {
      ...(task.processState ?? {}),
      firstObservedAt: task.processState?.firstObservedAt ?? now.toISOString(),
      lastObservedAt: now.toISOString(),
      lastObservation: observation
    };
    if (observation.state === "running") {
      this.store.updateScheduledSessionTask(task.taskId, {
        processState: state,
        nextRunAt: new Date(now.getTime() + task.processSpec.pollIntervalSeconds * 1000).toISOString(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null
      });
      return;
    }
    if (observation.state === "indeterminate") {
      const error = operationError(observation.errorCode ?? "PROCESS_STATE_INDETERMINATE", observation.errorMessage);
      throw error;
    }
    state.terminalObservedAt = now.toISOString();
    const identity = task.processSpec.expectedStartTime ?? state.firstObservedAt ?? task.createdAt;
    const runKey = `${task.taskId}:process:${task.processSpec.pid}:${identity}`;
    const run = this.store.getScheduledSessionRunByKey(runKey) ?? this.store.createScheduledSessionRun({
      runId: stableId("scheduled_run", task.taskId, runKey),
      taskId: task.taskId,
      runKey,
      scheduledFor: now.toISOString(),
      triggerKind: "process",
      triggerReason: observation.reason,
      status: "claimed",
      exitStatus: observation.exitStatus,
      createdAt: now.toISOString()
    });
    this.store.updateScheduledSessionTask(task.taskId, { processState: state });
    this.#record("ScheduledSessionTaskDue", task, run, { type: "system", id: this.leaseOwner }, {
      triggerReason: observation.reason,
      exitStatus: observation.exitStatus
    });
    await this.#dispatch(task, run);
  }

  async #dispatch(task, run, options = {}) {
    const now = this.now();
    try {
      // Authorization is re-evaluated immediately before the side effect.
      // Persisted creator identity is host-derived at creation time; it is
      // never accepted from the scheduled message or model arguments.
      this.#authorize(
        { type: task.creatorType, id: task.creatorId },
        task.logicalSessionId,
        "trigger",
        task
      );
      const route = await this.resolveRoute(task.logicalSessionId, task);
      if (!route?.sessionId || !route?.agentId || !route?.binding) {
        operationError("ROUTE_UNAVAILABLE", `Logical Session ${task.logicalSessionId} has no usable active binding.`);
      }
      const currentTask = this.store.getScheduledSessionTask(task.taskId);
      if (currentTask?.status === "cancelled") {
        const cancelledRun = this.store.updateScheduledSessionRun(run.runId, {
          status: "cancelled",
          errorCode: "TASK_CANCELLED",
          errorMessage: "The task was cancelled before queue delivery.",
          completedAt: now.toISOString()
        });
        this.#record("ScheduledSessionRunCancelled", currentTask, cancelledRun, {
          type: "system", id: this.leaseOwner
        }, { reason: "cancelled_before_delivery" });
        return cancelledRun;
      }
      const workItemId = `scheduled:${run.runId}`;
      const workItem = await this.enqueue({
        workItemId,
        agentId: route.agentId,
        sessionId: route.sessionId,
        kind: "user",
        priority: 75,
        text: task.message.text,
        source: {
          type: "scheduled_session_task",
          scheduledTaskId: task.taskId,
          scheduledRunId: run.runId,
          messageType: task.message.type,
          payload: task.message.payload,
          triggerKind: run.triggerKind,
          triggerReason: run.triggerReason,
          scheduledFor: run.scheduledFor,
          exitStatus: run.exitStatus
        },
        localVisibility: "normal",
        createdAt: now.toISOString()
      });
      const updatedRun = this.store.updateScheduledSessionRun(run.runId, {
        status: "queued",
        agentWorkItemId: workItem.workItemId,
        bindingId: route.binding.bindingId,
        providerSessionId: route.binding.providerSessionId,
        routingVersion: route.binding.routingVersion,
        queuedAt: now.toISOString(),
        errorCode: null,
        errorMessage: null
      });
      const taskPatch = options.preserveSchedule ? {
        lastRunId: run.runId,
        lastRunStatus: "queued",
        lastRunAt: now.toISOString(),
        lastErrorCode: null,
        lastErrorMessage: null
      } : this.#successTaskPatch(task, run, now);
      const updatedTask = this.store.updateScheduledSessionTask(task.taskId, {
        ...taskPatch,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryCount: 0,
        pendingScheduledFor: null
      });
      this.#record("ScheduledSessionRunQueued", updatedTask, updatedRun, { type: "system", id: this.leaseOwner }, {
        agentWorkItemId: workItem.workItemId,
        targetSessionId: route.sessionId,
        bindingId: route.binding.bindingId,
        routingVersion: route.binding.routingVersion
      });
      return updatedRun;
    } catch (error) {
      return this.#handleTriggerFailure(task, run, error, now, options);
    }
  }

  #successTaskPatch(task, run, now) {
    if (task.scheduleType === "interval") {
      return {
        status: "active",
        nextRunAt: nextIntervalRun(run.scheduledFor, task.intervalSeconds, now),
        lastRunId: run.runId,
        lastRunStatus: "queued",
        lastRunAt: now.toISOString(),
        lastErrorCode: null,
        lastErrorMessage: null
      };
    }
    return {
      status: "completed",
      nextRunAt: null,
      completedAt: now.toISOString(),
      lastRunId: run.runId,
      lastRunStatus: "queued",
      lastRunAt: now.toISOString(),
      lastErrorCode: null,
      lastErrorMessage: null
    };
  }

  #advanceWithoutDispatch(task, now, reason) {
    const patch = task.scheduleType === "interval"
      ? { status: "active", nextRunAt: nextIntervalRun(task.nextRunAt, task.intervalSeconds, now) }
      : { status: "completed", nextRunAt: null, completedAt: now.toISOString() };
    const updated = this.store.updateScheduledSessionTask(task.taskId, {
      ...patch,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastRunStatus: "missed",
      lastRunAt: now.toISOString(),
      lastErrorCode: null,
      lastErrorMessage: reason
    });
    return updated;
  }

  #handleTriggerFailure(task, run, error, now = this.now(), options = {}) {
    const code = error?.code ?? "SCHEDULE_TRIGGER_FAILED";
    const message = error?.message ?? String(error);
    const retryCount = task.retryCount + 1;
    const permanent = [
      "SESSION_NOT_FOUND", "SESSION_ARCHIVED", "AGENT_NOT_FOUND", "ROUTE_UNAVAILABLE",
      "AUTHORIZATION_REVOKED", "ENVIRONMENT_MISMATCH", "PROCESS_IDENTITY_MISMATCH"
    ].includes(code);
    const exhausted = retryCount > task.maxRetries;
    const status = permanent || exhausted ? "failed" : "active";
    const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(retryCount - 1, 6)));
    const scheduledFor = task.pendingScheduledFor ?? task.nextRunAt ?? now.toISOString();
    let failedRun = run;
    if (!failedRun && task.scheduleType !== "process") {
      const runKey = `${task.taskId}:scheduled:${scheduledFor}`;
      failedRun = this.store.getScheduledSessionRunByKey(runKey) ?? this.store.createScheduledSessionRun({
        runId: stableId("scheduled_run", task.taskId, scheduledFor),
        taskId: task.taskId,
        runKey,
        scheduledFor,
        triggerKind: "scheduled",
        triggerReason: "schedule_due",
        status: "claimed",
        createdAt: now.toISOString()
      });
    }
    if (failedRun) {
      failedRun = this.store.updateScheduledSessionRun(failedRun.runId, {
        status: status === "failed" ? "failed" : "retry_wait",
        attemptCount: retryCount,
        errorCode: code,
        errorMessage: message,
        completedAt: status === "failed" ? now.toISOString() : null
      });
    }
    const updated = this.store.updateScheduledSessionTask(task.taskId, {
      status,
      nextRunAt: status === "active" && !options.preserveSchedule
        ? new Date(now.getTime() + delayMs).toISOString()
        : task.nextRunAt,
      pendingScheduledFor: status === "active" && !options.preserveSchedule ? scheduledFor : task.pendingScheduledFor,
      retryCount,
      lastRunId: failedRun?.runId ?? task.lastRunId,
      lastRunStatus: status === "failed" ? "failed" : "retry_wait",
      lastRunAt: now.toISOString(),
      lastErrorCode: code,
      lastErrorMessage: message,
      leaseOwner: null,
      leaseExpiresAt: null
    });
    this.#record("ScheduledSessionRunFailed", updated, failedRun, { type: "system", id: this.leaseOwner }, {
      errorCode: code,
      errorMessage: message,
      retryCount,
      willRetry: status === "active"
    });
    if (options.preserveSchedule) throw error;
    return failedRun;
  }

  #task(taskId) {
    const task = this.store.getScheduledSessionTask(taskId);
    if (!task || task.environment !== this.environment) operationError("SCHEDULED_TASK_NOT_FOUND", "Scheduled Session task not found.");
    return task;
  }

  #authorize(actor, logicalSessionId, action, task = null) {
    if (!actor?.type || !actor?.id) operationError("ACTOR_REQUIRED", "An authenticated actor is required.");
    return this.authorize({ actor, logicalSessionId, action, task, environment: this.environment }) ?? {};
  }

  #record(type, task, run, actor, payload) {
    const event = this.store.recordScheduledSessionEvent({
      taskId: task.taskId,
      runId: run?.runId ?? null,
      type,
      actorType: actor?.type ?? null,
      actorId: actor?.id ?? null,
      payload,
      environment: this.environment,
      createdAt: this.now().toISOString()
    });
    this.onEvent?.(type, { task, run, event, ...payload });
    return event;
  }
}

export async function inspectProcess(spec) {
  try {
    process.kill(spec.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") {
      return {
        state: "exited",
        reason: "process_disappeared",
        exitStatus: { kind: "unknown", code: null, signal: null, diagnostic: "The OS no longer exposes the monitored process." }
      };
    }
    return {
      state: "indeterminate",
      errorCode: error.code === "EPERM" ? "PROCESS_PERMISSION_DENIED" : "PROCESS_INSPECTION_FAILED",
      errorMessage: error.message
    };
  }
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(spec.pid), "-o", "lstart=", "-o", "stat=", "-o", "xstat="]
    );
    return processObservationFromPs(stdout, spec);
  } catch (error) {
    return { state: "indeterminate", errorCode: "PROCESS_INSPECTION_FAILED", errorMessage: error.message };
  }
}

export function processObservationFromPs(output, spec) {
  const line = String(output ?? "").trim();
  if (!line) {
    return {
      state: "exited",
      reason: "process_disappeared",
      exitStatus: { kind: "unknown", code: null, signal: null }
    };
  }
  const fields = line.match(/^(.*\d{4})\s+(\S+)\s+(\d+)$/);
  if (!fields) {
    return {
      state: "indeterminate",
      errorCode: "PROCESS_INSPECTION_FAILED",
      errorMessage: `Unexpected ps output for PID ${spec.pid}.`
    };
  }
  const [, startText, status, rawWaitStatusText] = fields;
  if (spec.expectedStartTime) {
    const observedStart = new Date(startText);
    if (Number.isFinite(observedStart.getTime())
      && Math.abs(observedStart.getTime() - new Date(spec.expectedStartTime).getTime()) > 1_000) {
      return {
        state: "indeterminate",
        errorCode: "PROCESS_IDENTITY_MISMATCH",
        errorMessage: `PID ${spec.pid} now belongs to a different process.`
      };
    }
  }
  if (!status.startsWith("Z")) return { state: "running", status };

  // macOS/BSD ps exposes the wait(2) status as xstat while a terminated
  // process remains observable as a zombie. Decode it before the parent
  // reaps the process; a later ESRCH is deliberately recorded as unknown.
  const rawWaitStatus = Number(rawWaitStatusText);
  const signal = rawWaitStatus & 0x7f;
  const exitCode = (rawWaitStatus >> 8) & 0xff;
  const normal = signal === 0;
  return {
    state: "exited",
    reason: normal ? "process_normal_exit" : "process_abnormal_termination",
    exitStatus: {
      kind: normal ? "normal" : "abnormal",
      code: normal ? exitCode : null,
      signal: normal ? null : signal,
      rawWaitStatus
    }
  };
}

function stableId(prefix, ...parts) {
  return `${prefix}:${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32)}`;
}

function operationError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
