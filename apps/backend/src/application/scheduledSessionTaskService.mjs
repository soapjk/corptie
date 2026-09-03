import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  nextIntervalRun,
  validateScheduledSessionTaskInput,
  validateScheduledSessionTaskPatch
} from "../domain/scheduledSessionTask.mjs";

const execFileAsync = promisify(execFile);
const TERMINAL_TASK_STATUSES = new Set(["cancelled", "completed", "expired"]);

export class ScheduledSessionTaskService {
  constructor(options = {}) {
    this.store = options.store;
    this.environment = options.environment;
    this.resolveRoute = options.resolveRoute;
    this.resolveActorLogicalSessionId = options.resolveActorLogicalSessionId ?? null;
    this.authorize = options.authorize;
    this.enqueue = options.enqueue;
    this.activate = options.activate ?? (async () => ({ delivered: true }));
    this.notify = options.notify ?? (async () => ({ delivered: true }));
    this.onEvent = options.onEvent ?? null;
    this.observeListPerformance = options.observeListPerformance ?? null;
    this.inspectProcess = options.inspectProcess ?? inspectProcess;
    this.evaluateCondition = options.evaluateCondition ?? executeConditionScript;
    this.logger = options.logger ?? console;
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
    this.timer = setInterval(() => this.#requestTick("interval"), this.tickMs);
    this.timer.unref?.();
    this.#requestTick("startup");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  create(input, actor) {
    const taskInput = input ?? {};
    const logicalSessionId = taskInput.logicalSessionId
      ?? (typeof this.resolveActorLogicalSessionId === "function"
        ? this.resolveActorLogicalSessionId(actor)
        : null);
    const resolvedInput = logicalSessionId ? { ...taskInput, logicalSessionId } : taskInput;
    const now = this.now();
    const normalized = validateScheduledSessionTaskInput(resolvedInput, { now });
    const scope = this.#authorize(actor, normalized.logicalSessionId, "create");
    validateConditionResources(normalized.conditionSpec);
    const task = this.store.createScheduledSessionTask({
      ...normalized,
      taskId: resolvedInput.taskId ?? `scheduled_task:${randomUUID()}`,
      creatorType: actor.type,
      creatorId: actor.id,
      workId: scope.workId ?? null,
      environment: this.environment,
      createdAt: now.toISOString()
    });
    this.#record("ScheduledSessionTaskCreated", task, null, actor, { task });
    return task;
  }

  get(taskId, actor) {
    this.#expireDueTasks(this.now());
    const task = this.#task(taskId);
    this.#authorize(actor, task.logicalSessionId, "read", task);
    return { ...task, runs: this.store.listScheduledSessionRuns(taskId), events: this.store.listScheduledSessionEvents(taskId) };
  }

  list(options = {}, actor) {
    const startedAt = performance.now();
    const phases = {};
    let phaseStartedAt = performance.now();
    this.#expireDueTasks(this.now());
    phases.expirationMs = roundedMilliseconds(performance.now() - phaseStartedAt);
    phaseStartedAt = performance.now();
    const tasks = this.store.listScheduledSessionTasks({
      environment: this.environment,
      logicalSessionId: options.logicalSessionId,
      status: options.status
    });
    phases.taskQueryMs = roundedMilliseconds(performance.now() - phaseStartedAt);
    phaseStartedAt = performance.now();
    const authorizedTasks = tasks.filter((task) => {
      try {
        this.#authorize(actor, task.logicalSessionId, "read", task);
        return true;
      } catch {
        return false;
      }
    });
    phases.authorizationMs = roundedMilliseconds(performance.now() - phaseStartedAt);
    phaseStartedAt = performance.now();
    const result = options.includeRuns
      ? attachRuns(authorizedTasks, this.store.listScheduledSessionRunsForTasks(
        authorizedTasks.map((task) => task.taskId)
      ))
      : authorizedTasks;
    phases.runQueryMs = roundedMilliseconds(performance.now() - phaseStartedAt);
    this.observeListPerformance?.({
      operation: "scheduled-task.list",
      requestId: options.requestId ?? null,
      includeRuns: options.includeRuns === true,
      taskCount: result.length,
      phases,
      totalMs: roundedMilliseconds(performance.now() - startedAt)
    });
    return result;
  }

  update(taskId, input, actor) {
    this.#expireDueTasks(this.now());
    const task = this.#task(taskId);
    this.#authorize(actor, task.logicalSessionId, "update", task);
    if (TERMINAL_TASK_STATUSES.has(task.status)) operationError("TASK_NOT_MUTABLE", `Task ${taskId} is ${task.status}.`);
    const normalized = validateScheduledSessionTaskPatch(input, task, { now: this.now() });
    validateConditionResources(normalized.conditionSpec);
    const updated = this.store.updateScheduledSessionTask(taskId, {
      name: normalized.name,
      message: normalized.message,
      triggerSpec: normalized.triggerSpec,
      conditionSpecs: normalized.conditionSpecs,
      actions: normalized.actions,
      policySpec: normalized.policySpec,
      risk: normalized.risk,
      runAt: normalized.runAt,
      nextRunAt: normalized.nextRunAt,
      expiresAt: normalized.expiresAt,
      intervalSeconds: normalized.intervalSeconds,
      timezone: normalized.timezone,
      missedPolicy: normalized.missedPolicy,
      conditionSpec: normalized.conditionSpec,
      conditionState: normalized.conditionState,
      processSpec: normalized.processSpec,
      processState: normalized.processState,
      maxRetries: normalized.maxRetries,
      maxConcurrentRuns: normalized.maxConcurrentRuns,
      timeoutSeconds: normalized.timeoutSeconds,
      backpressureLimit: normalized.backpressureLimit,
      status: task.status === "error" ? "active" : task.status,
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
    operationError("TASK_PAUSE_UNSUPPORTED", "Automations no longer have a paused state; cancel the Automation instead.");
  }

  resume(taskId, actor) {
    this.#expireDueTasks(this.now());
    const task = this.#task(taskId);
    this.#authorize(actor, task.logicalSessionId, "resume", task);
    if (task.status !== "error") operationError("TASK_NOT_RESUMABLE", `Task ${taskId} is ${task.status}.`);
    const now = this.now();
    const nextRunAt = task.nextRunAt ?? task.pendingScheduledFor ?? (task.scheduleType === "interval"
      ? new Date(now.getTime() + task.intervalSeconds * 1000).toISOString()
      : now.toISOString());
    const updated = this.store.updateScheduledSessionTask(taskId, {
      status: "active", nextRunAt, pausedAt: null, retryCount: 0,
      lastErrorCode: null, lastErrorMessage: null, leaseOwner: null, leaseExpiresAt: null
    });
    this.#record("ScheduledSessionTaskResumed", updated, null, actor, {});
    this.#requestTick("resume");
    return updated;
  }

  cancel(taskId, actor) {
    this.#expireDueTasks(this.now());
    const task = this.#task(taskId);
    this.#authorize(actor, task.logicalSessionId, "cancel", task);
    if (task.status === "cancelled") return task;
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      operationError("TASK_NOT_MUTABLE", `Task ${taskId} is ${task.status}.`);
    }
    const timestamp = this.now().toISOString();
    const updated = this.store.updateScheduledSessionTask(taskId, {
      status: "cancelled", cancelledAt: timestamp, nextRunAt: null,
      leaseOwner: null, leaseExpiresAt: null
    });
    this.#record("ScheduledSessionTaskCancelled", updated, null, actor, {});
    return updated;
  }

  async runNow(taskId, actor) {
    this.#expireDueTasks(this.now());
    const task = this.#task(taskId);
    this.#authorize(actor, task.logicalSessionId, "run", task);
    if (task.status !== "active") operationError("TASK_NOT_ACTIVE", `Task ${taskId} is ${task.status}.`);
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
      stages: [stage("trigger", "completed", timestamp, { reason: "run_now" })],
      deadlineAt: new Date(this.now().getTime() + task.timeoutSeconds * 1000).toISOString(),
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
      this.#expireDueTasks(now);
      this.#recoverExpiredRuns(now);
      const tasks = this.store.claimDueScheduledSessionTasks({
        environment: this.environment,
        now: now.toISOString(),
        leaseOwner: this.leaseOwner,
        leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString(),
        limit: 50
      });
      for (const task of tasks) {
        try {
          if (task.scheduleType === "condition") await this.#tickCondition(task, now);
          else if (task.scheduleType === "process") await this.#tickProcess(task, now);
          else await this.#tickTime(task, now);
        } catch (error) {
          await this.#handleTriggerFailure(task, null, error, now);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  #requestTick(source) {
    void this.tick().catch((error) => {
      // SQLite maintenance and another short transaction may temporarily own
      // the writer lock. A scheduler poll is retryable by definition: keep the
      // Backend alive and let the next interval retry instead of turning a
      // background Automation into a process-level unhandled rejection.
      this.logger.warn?.(
        `[scheduled-session-task] tick failed source=${source} code=${error?.code ?? "unknown"} error=${error?.message ?? error}`
      );
    });
  }

  handleAgentWorkEvent(type, operation) {
    const run = operation?.taskId
      ? this.store.getScheduledSessionRunForAgentTask(operation.taskId)
      : null;
    if (!run) return null;
    if (["completed", "failed", "cancelled", "skipped", "missed"].includes(run.status)) return run;
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
      targetTurnId: operation.targetTurnId ?? run.targetTurnId,
      errorCode: status === "failed" ? "AGENT_WORK_FAILED" : null,
      errorMessage: status === "failed" ? operation.lastError : null,
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
    this.#record(eventType, task, updatedRun, { type: "system", id: this.leaseOwner }, { operation });
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
      const policy = task.policySpec?.misfire ?? (task.missedPolicy === "skip" ? "skip" : "fireOnce");
      if (policy === "skip") {
        return this.#advanceWithoutDispatch(task, now, "missed_policy_skip");
      }
      if (policy === "catchUp" && task.scheduleType === "interval") {
        return this.#catchUp(task, scheduledFor, now);
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
      stages: [stage("trigger", "completed", now.toISOString(), { missed })],
      deadlineAt: new Date(now.getTime() + task.timeoutSeconds * 1000).toISOString(),
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
      stages: [stage("trigger", "completed", now.toISOString(), { observation })],
      deadlineAt: new Date(now.getTime() + task.timeoutSeconds * 1000).toISOString(),
      createdAt: now.toISOString()
    });
    this.store.updateScheduledSessionTask(task.taskId, { processState: state });
    this.#record("ScheduledSessionTaskDue", task, run, { type: "system", id: this.leaseOwner }, {
      triggerReason: observation.reason,
      exitStatus: observation.exitStatus
    });
    await this.#dispatch(task, run);
  }

  async #tickCondition(task, now) {
    // A condition script is itself a side effect. Recheck the persisted,
    // host-derived creator before every execution, not only before delivery.
    this.#authorize(
      { type: task.creatorType, id: task.creatorId },
      task.logicalSessionId,
      "trigger",
      task
    );
    const observation = await this.evaluateCondition(task.conditionSpec);
    const state = {
      ...(task.conditionState ?? {}),
      firstObservedAt: task.conditionState?.firstObservedAt ?? now.toISOString(),
      lastObservedAt: now.toISOString(),
      lastObservation: observation
    };
    if (observation.state === "not_matched" || observation.fire === false) {
      this.store.updateScheduledSessionTask(task.taskId, {
        conditionState: state,
        nextRunAt: new Date(now.getTime() + task.conditionSpec.checkIntervalSeconds * 1000).toISOString(),
        leaseOwner: null,
        leaseExpiresAt: null,
        retryCount: 0,
        lastErrorCode: null,
        lastErrorMessage: null
      });
      return;
    }
    if (observation.state === "indeterminate") {
      this.store.updateScheduledSessionTask(task.taskId, { conditionState: state });
      operationError(observation.errorCode ?? "CONDITION_STATE_INDETERMINATE", observation.errorMessage);
    }
    state.terminalObservedAt = now.toISOString();
    const runKey = `${task.taskId}:condition:${task.createdAt}`;
    const run = this.store.getScheduledSessionRunByKey(runKey) ?? this.store.createScheduledSessionRun({
      runId: stableId("scheduled_run", task.taskId, runKey),
      taskId: task.taskId,
      runKey,
      scheduledFor: now.toISOString(),
      triggerKind: "condition",
      triggerReason: "condition_script_satisfied",
      status: "claimed",
      conditionResult: observation,
      stages: [stage("condition", "completed", now.toISOString(), { result: observation })],
      deadlineAt: new Date(now.getTime() + task.timeoutSeconds * 1000).toISOString(),
      createdAt: now.toISOString()
    });
    this.store.updateScheduledSessionTask(task.taskId, { conditionState: state });
    this.#record("ScheduledSessionTaskDue", task, run, { type: "system", id: this.leaseOwner }, {
      triggerReason: "condition_script_satisfied",
      conditionResult: observation
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
      run = this.store.updateScheduledSessionRun(run.runId, {
        stages: appendStage(run.stages, stage("authorization", "completed", now.toISOString()))
      });
      if (this.store.countActiveScheduledSessionRuns(task.taskId) > task.maxConcurrentRuns) {
        operationError("AUTOMATION_CONCURRENCY_LIMIT", `Automation ${task.taskId} reached its concurrent run limit.`);
      }
      if (this.store.countPendingScheduledSessionRunsForLogicalSession(task.logicalSessionId) > task.backpressureLimit) {
        operationError("AUTOMATION_BACKPRESSURE", `Logical Session ${task.logicalSessionId} reached its automation queue limit.`);
      }
      const route = await this.resolveRoute(task.logicalSessionId, task);
      if (!route?.sessionId || !route?.agentId || !route?.binding) {
        operationError("ROUTE_UNAVAILABLE", `Logical Session ${task.logicalSessionId} has no usable active binding.`);
      }
      run = this.store.updateScheduledSessionRun(run.runId, {
        bindingId: route.binding.bindingId,
        providerSessionId: route.binding.providerSessionId,
        routingVersion: route.binding.routingVersion,
        stages: appendStage(run.stages, stage("routing", "completed", now.toISOString(), {
          logicalSessionId: task.logicalSessionId,
          bindingId: route.binding.bindingId,
          routingVersion: route.binding.routingVersion
        }))
      });
      let currentTask = this.store.getScheduledSessionTask(task.taskId);
      if (currentTask?.status !== "active" || new Date(currentTask.expiresAt).getTime() <= now.getTime()) {
        if (currentTask?.status === "active") currentTask = this.#expireTask(currentTask, now);
        const cancelledRun = this.store.updateScheduledSessionRun(run.runId, {
          status: "cancelled",
          errorCode: currentTask?.status === "cancelled" ? "TASK_CANCELLED" : "TASK_EXPIRED",
          errorMessage: "The task became inactive before queue delivery.",
          completedAt: now.toISOString()
        });
        this.#record("ScheduledSessionRunCancelled", currentTask, cancelledRun, {
          type: "system", id: this.leaseOwner
        }, { reason: "cancelled_before_delivery" });
        return cancelledRun;
      }
      const actionResults = [];
      let queuedOperation = null;
      const actions = task.actions?.length ? task.actions : [{ type: "queueSessionMessage", message: task.message }];
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index];
        run = this.store.updateScheduledSessionRun(run.runId, {
          stages: appendStage(run.stages, stage(`action:${index}:${action.type}`, "running", this.now().toISOString()))
        });
        if (action.type === "queueSessionMessage") {
          const message = run.conditionResult?.message
            ? { ...action.message, text: run.conditionResult.message }
            : action.message;
          const deliveryId = stableId(
            "scheduled_delivery",
            run.runId,
            message.type ?? "scheduled_session_message",
            message.text,
            JSON.stringify(message.payload ?? null)
          );
          const enqueueResult = await this.enqueue({
            taskId: `scheduled:${deliveryId}`,
            agentId: route.agentId,
            sessionId: route.sessionId,
            kind: "user",
            priority: 75,
            text: message.text,
            source: {
              type: "scheduled_session_task",
              automationId: task.taskId,
              scheduledTaskId: task.taskId,
              scheduledRunId: run.runId,
              messageType: message.type,
              payload: message.payload,
              triggerKind: run.triggerKind,
              triggerReason: run.triggerReason,
              scheduledFor: run.scheduledFor,
              deliveryId,
              exitStatus: run.exitStatus,
              conditionResult: run.conditionResult
            },
            localVisibility: "normal",
            createdAt: now.toISOString()
          });
          queuedOperation = enqueueResult?.task ?? enqueueResult;
          if (!queuedOperation?.taskId) {
            operationError("AUTOMATION_DELIVERY_RECEIPT_INVALID", `Delivery ${deliveryId} returned no durable work item.`);
          }
          const deduplicated = enqueueResult?.inserted === false;
          actionResults.push({
            type: action.type,
            status: deduplicated ? "deduplicated" : "queued",
            deliveryId,
            taskId: queuedOperation.taskId,
            completedAt: this.now().toISOString()
          });
          this.#record(
            deduplicated ? "ScheduledSessionDeliveryDeduplicated" : "ScheduledSessionDeliveryCommitted",
            task,
            run,
            { type: "system", id: this.leaseOwner },
            { scheduledFor: run.scheduledFor, deliveryId, agentTaskId: queuedOperation.taskId }
          );
        } else if (action.type === "activateSession") {
          await this.activate({ logicalSessionId: task.logicalSessionId, sessionId: route.sessionId, automationId: task.taskId, runId: run.runId });
          actionResults.push({ type: action.type, status: "requested", completedAt: this.now().toISOString() });
        } else if (action.type === "localNotification") {
          await this.notify({ ...action, logicalSessionId: task.logicalSessionId, sessionId: route.sessionId, automationId: task.taskId, runId: run.runId });
          actionResults.push({ type: action.type, status: "requested", completedAt: this.now().toISOString() });
        } else {
          operationError("AUTOMATION_ACTION_UNSUPPORTED", `Unsupported Automation action ${action.type}.`);
        }
        run = this.store.updateScheduledSessionRun(run.runId, {
          actionResults,
          stages: appendStage(run.stages, stage(
            `action:${index}:${action.type}`,
            action.type === "queueSessionMessage" ? "completed" : "dispatched",
            this.now().toISOString()
          ))
        });
      }
      const deliveryStatus = queuedOperation ? "queued" : "completed";
      const updatedRun = this.store.updateScheduledSessionRun(run.runId, {
        status: deliveryStatus,
        agentTaskId: queuedOperation?.taskId ?? null,
        bindingId: route.binding.bindingId,
        providerSessionId: route.binding.providerSessionId,
        routingVersion: route.binding.routingVersion,
        queuedAt: queuedOperation ? now.toISOString() : null,
        completedAt: queuedOperation ? null : now.toISOString(),
        stages: appendStage(run.stages, stage("dispatch", "completed", this.now().toISOString(), { status: deliveryStatus })),
        actionResults,
        errorCode: null,
        errorMessage: null
      });
      const taskPatch = options.preserveSchedule ? {
        lastRunId: run.runId,
        lastRunStatus: deliveryStatus,
        lastRunAt: now.toISOString(),
        lastErrorCode: null,
        lastErrorMessage: null
      } : this.#successTaskPatch(task, updatedRun, now);
      const updatedTask = this.store.updateScheduledSessionTask(task.taskId, {
        ...taskPatch,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryCount: 0,
        pendingScheduledFor: null
      });
      this.#record(queuedOperation ? "ScheduledSessionRunQueued" : "ScheduledSessionRunCompleted", updatedTask, updatedRun, { type: "system", id: this.leaseOwner }, {
        agentTaskId: queuedOperation?.taskId ?? null,
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
      const nextRunAt = nextIntervalRun(run.scheduledFor, task.intervalSeconds, now);
      return {
        status: "active",
        nextRunAt: this.#beforeExpiration(nextRunAt, task.expiresAt),
        lastRunId: run.runId,
        lastRunStatus: run.status,
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
      lastRunStatus: run.status,
      lastRunAt: now.toISOString(),
      lastErrorCode: null,
      lastErrorMessage: null
    };
  }

  #advanceWithoutDispatch(task, now, reason) {
    const patch = task.scheduleType === "interval"
      ? { status: "active", nextRunAt: this.#beforeExpiration(
        nextIntervalRun(task.nextRunAt, task.intervalSeconds, now), task.expiresAt
      ) }
      : { status: "active", nextRunAt: null };
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

  async #catchUp(task, firstScheduledFor, now) {
    const limit = task.policySpec?.maxCatchUpRuns ?? 10;
    const intervalMs = task.intervalSeconds * 1000;
    const slots = [];
    for (let at = new Date(firstScheduledFor).getTime(); at <= now.getTime() && slots.length < limit; at += intervalMs) {
      slots.push(new Date(at).toISOString());
    }
    let lastRun = null;
    for (const scheduledFor of slots) {
      const runKey = `${task.taskId}:scheduled:${scheduledFor}`;
      const run = this.store.getScheduledSessionRunByKey(runKey) ?? this.store.createScheduledSessionRun({
        runId: stableId("scheduled_run", task.taskId, scheduledFor),
        taskId: task.taskId,
        runKey,
        scheduledFor,
        triggerKind: "recovery",
        triggerReason: "misfire_catch_up",
        status: "claimed",
        stages: [stage("trigger", "completed", now.toISOString(), { missed: true, policy: "catchUp" })],
        deadlineAt: new Date(now.getTime() + task.timeoutSeconds * 1000).toISOString(),
        createdAt: now.toISOString()
      });
      this.#record("ScheduledSessionTaskDue", task, run, { type: "system", id: this.leaseOwner }, {
        scheduledFor, missed: true, policy: "catchUp"
      });
      lastRun = await this.#dispatch(task, run, { preserveSchedule: true });
    }
    const nextRunAt = this.#beforeExpiration(
      nextIntervalRun(slots.at(-1) ?? firstScheduledFor, task.intervalSeconds, now), task.expiresAt
    );
    this.store.updateScheduledSessionTask(task.taskId, {
      status: "active",
      nextRunAt,
      pendingScheduledFor: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastRunId: lastRun?.runId ?? task.lastRunId,
      lastRunStatus: lastRun?.status ?? "missed",
      lastRunAt: now.toISOString()
    });
    return lastRun;
  }

  #recoverExpiredRuns(now) {
    for (const run of this.store.listExpiredScheduledSessionRuns(now.toISOString(), this.environment)) {
      const task = this.store.getScheduledSessionTask(run.taskId);
      if (!task) continue;
      const error = new Error(`Automation run ${run.runId} exceeded ${task.timeoutSeconds} seconds.`);
      error.code = "AUTOMATION_RUN_TIMEOUT";
      if (run.status === "claimed") this.#handleTriggerFailure(task, run, error, now);
      else this.#handleExecutionTimeout(task, run, error, now);
    }
  }

  #handleExecutionTimeout(task, run, error, now) {
    const currentTask = this.store.getScheduledSessionTask(task.taskId) ?? task;
    const failedRun = this.store.updateScheduledSessionRun(run.runId, {
      status: "failed",
      errorCode: error.code,
      errorMessage: error.message,
      completedAt: now.toISOString()
    });
    let updatedTask = currentTask;
    if (currentTask.lastRunId === run.runId) {
      updatedTask = this.store.updateScheduledSessionTask(task.taskId, {
        lastRunStatus: "failed",
        lastRunAt: now.toISOString(),
        lastErrorCode: error.code,
        lastErrorMessage: error.message
      });
    }
    this.#record("ScheduledSessionRunFailed", updatedTask, failedRun, {
      type: "system", id: this.leaseOwner
    }, {
      errorCode: error.code,
      errorMessage: error.message,
      scheduledFor: run.scheduledFor,
      deliveryId: run.agentTaskId,
      retryCount: currentTask.retryCount,
      willRetry: false,
      retrySuppressed: "delivery_already_committed"
    });
    return failedRun;
  }

  #handleTriggerFailure(task, run, error, now = this.now(), options = {}) {
    task = this.store.getScheduledSessionTask(task.taskId) ?? task;
    const code = error?.code ?? "SCHEDULE_TRIGGER_FAILED";
    const message = error?.message ?? String(error);
    const retryCount = task.retryCount + 1;
    const permanent = [
      "SESSION_NOT_FOUND", "SESSION_ARCHIVED", "AGENT_NOT_FOUND", "ROUTE_UNAVAILABLE",
      "AUTHORIZATION_REVOKED", "ENVIRONMENT_MISMATCH", "PROCESS_IDENTITY_MISMATCH"
    ].includes(code);
    const exhausted = retryCount > task.maxRetries;
    const status = permanent || exhausted ? "error" : "active";
    const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(retryCount - 1, 6)));
    const scheduledFor = task.pendingScheduledFor ?? task.nextRunAt ?? now.toISOString();
    let failedRun = run;
    if (!failedRun && !["condition", "process"].includes(task.scheduleType)) {
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
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      failedRun = failedRun?.runId
        ? (this.store.getScheduledSessionRun(failedRun.runId) ?? failedRun)
        : failedRun;
      this.#record("ScheduledSessionRunFailed", task, failedRun, { type: "system", id: this.leaseOwner }, {
        errorCode: code,
        errorMessage: message,
        scheduledFor: failedRun?.scheduledFor ?? scheduledFor,
        deliveryId: failedRun?.agentTaskId ?? null,
        retryCount: task.retryCount,
        willRetry: false,
        retrySuppressed: `task_${task.status}`
      });
      if (options.preserveSchedule) throw error;
      return failedRun;
    }
    if (failedRun) {
      failedRun = this.store.updateScheduledSessionRun(failedRun.runId, {
        status: status === "error" ? "failed" : "retry_wait",
        attemptCount: retryCount,
        errorCode: code,
        errorMessage: message,
        completedAt: status === "error" ? now.toISOString() : null
      });
    }
    const updated = this.store.updateScheduledSessionTask(task.taskId, {
      status,
      nextRunAt: status === "active" && !options.preserveSchedule
        ? this.#beforeExpiration(new Date(now.getTime() + delayMs).toISOString(), task.expiresAt)
        : task.nextRunAt,
      pendingScheduledFor: status === "active" && !options.preserveSchedule ? scheduledFor : task.pendingScheduledFor,
      retryCount,
      lastRunId: failedRun?.runId ?? task.lastRunId,
      lastRunStatus: status === "error" ? "failed" : "retry_wait",
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

  #expireDueTasks(now) {
    for (const task of this.store.listExpiredActiveScheduledSessionTasks(this.environment, now.toISOString())) {
      this.#expireTask(task, now);
    }
  }

  #beforeExpiration(candidate, expiresAt) {
    return new Date(candidate).getTime() < new Date(expiresAt).getTime() ? candidate : null;
  }

  #expireTask(task, now) {
    const updated = this.store.updateScheduledSessionTask(task.taskId, {
      status: "expired",
      nextRunAt: null,
      pendingScheduledFor: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: now.toISOString()
    });
    this.#record("ScheduledSessionTaskExpired", updated, null, { type: "system", id: this.leaseOwner }, {
      expiresAt: updated.expiresAt
    });
    return updated;
  }

  #task(taskId) {
    const task = this.store.getScheduledSessionTask(taskId);
    if (!task || task.environment !== this.environment) operationError("SCHEDULED_TASK_NOT_FOUND", "计划任务 not found.");
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

export async function executeConditionScript(spec) {
  try {
    const resourceWrappedScript = [
      "ulimit -t 5",
      "ulimit -f 128",
      spec.script
    ].join("\n");
    const sandboxProfile = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow file-read*)",
      "(allow sysctl-read)",
      "(allow mach-lookup)"
    ].join(" ");
    const command = process.platform === "darwin" ? "/usr/bin/sandbox-exec" : "/bin/zsh";
    const args = process.platform === "darwin"
      ? ["-p", sandboxProfile, "/bin/zsh", "-f", "-c", resourceWrappedScript]
      : ["-f", "-c", resourceWrappedScript];
    const { stdout, stderr } = await execFileAsync(
      command,
      args,
      {
        cwd: spec.workingDirectory ?? undefined,
        timeout: spec.timeoutSeconds * 1_000,
        maxBuffer: 65_536,
        env: {
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "en_US.UTF-8",
          CORPTIE_SCHEDULED_TASK: "1",
          CORPTIE_AUTOMATION_OBSERVER: "readonly-v1"
        }
      }
    );
    return conditionObservation("matched", 0, stdout, stderr);
  } catch (error) {
    if (error.killed || error.signal === "SIGTERM" && error.code == null) {
      return {
        state: "indeterminate",
        errorCode: "CONDITION_SCRIPT_TIMEOUT",
        errorMessage: `Condition script exceeded ${spec.timeoutSeconds} seconds.`,
        stdout: boundedOutput(error.stdout),
        stderr: boundedOutput(error.stderr)
      };
    }
    if (Number.isInteger(error.code)) {
      return conditionObservation("not_matched", error.code, error.stdout, error.stderr);
    }
    return {
      state: "indeterminate",
      errorCode: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ? "CONDITION_OUTPUT_LIMIT_EXCEEDED"
        : "CONDITION_SCRIPT_EXECUTION_FAILED",
      errorMessage: error.message,
      stdout: boundedOutput(error.stdout),
      stderr: boundedOutput(error.stderr)
    };
  }
}

function conditionObservation(state, exitCode, stdout, stderr) {
  const boundedStdout = boundedOutput(stdout);
  const structured = structuredConditionResult(boundedStdout);
  if (structured) {
    return {
      state: structured.state,
      fire: structured.fire,
      message: structured.message,
      observerState: structured.statePayload,
      exitCode,
      stdout: boundedStdout,
      stderr: boundedOutput(stderr),
      protocol: "structured-json-v1",
      sandbox: process.platform === "darwin" ? "macos-readonly" : "resource-limited"
    };
  }
  return {
    state,
    exitCode,
    stdout: boundedStdout,
    stderr: boundedOutput(stderr)
  };
}

function structuredConditionResult(stdout) {
  const line = String(stdout).split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
  if (!line?.startsWith("{")) return null;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value.fire !== "boolean") return null;
  if (value.message != null && typeof value.message !== "string") return null;
  if (value.state != null && (typeof value.state !== "object" || Array.isArray(value.state))) return null;
  return {
    fire: value.fire,
    message: value.message ?? null,
    statePayload: value.state ?? null,
    state: value.fire ? "matched" : "not_matched"
  };
}

function boundedOutput(value) {
  const text = String(value ?? "");
  return text.length <= 16_384 ? text : `${text.slice(0, 16_384)}\n[truncated]`;
}

function stage(name, status, at, details = {}) {
  return { name, status, at, details };
}

function appendStage(stages, next) {
  const values = Array.isArray(stages) ? [...stages] : [];
  const runningIndex = values.findIndex((value) => value.name === next.name && value.status === "running");
  if (runningIndex >= 0 && next.status !== "running") values.splice(runningIndex, 1);
  values.push(next);
  return values;
}

function validateConditionResources(spec) {
  if (!spec?.workingDirectory) return;
  let stats;
  try {
    stats = statSync(spec.workingDirectory);
  } catch (error) {
    operationError("CONDITION_WORKING_DIRECTORY_INVALID", `Condition working directory is unavailable: ${error.message}`);
  }
  if (!stats.isDirectory()) {
    operationError("CONDITION_WORKING_DIRECTORY_INVALID", "Condition workingDirectory must identify a directory.");
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

function attachRuns(tasks, runsByTaskId) {
  return tasks.map((task) => ({ ...task, runs: runsByTaskId.get(task.taskId) ?? [] }));
}

function roundedMilliseconds(value) {
  return Math.round(value * 1000) / 1000;
}

function operationError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
