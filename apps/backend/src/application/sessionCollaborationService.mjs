import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, accessSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  COLLABORATION_RELATION_TYPES,
  COLLABORATION_ROUTING_INTENTS,
  TASK_PRIORITIES
} from "../domain/taskToolSchema.mjs";
import { createTaskAndSession } from "./taskCreationApplicationService.mjs";
import { authorizeDirectUserTaskCreation } from "./directUserTaskCreationAuthorization.mjs";
import { validateEntityName, validateTaskInput } from "../domain/workTaskValidation.mjs";
import { resolveTaskCreationDefaults } from "../utils/newSessionDefaults.mjs";
import { taskHierarchyCapabilities } from "./taskHierarchyService.mjs";

const RELATIONS = new Set(COLLABORATION_RELATION_TYPES);
const ROUTING_INTENTS = new Set(COLLABORATION_ROUTING_INTENTS);
const ARTIFACT_RELATIONS = new Set([
  "implementation_spec", "security_requirement", "test_plan", "research_evidence",
  "handoff", "acceptance_evidence"
]);
const ARTIFACT_VERSION_POLICIES = new Set(["fixed", "latest_approved"]);
export const MAX_CHILD_TASK_BATCH_SIZE = 10;

export class SessionCollaborationService {
  constructor(options = {}) {
    this.store = options.store;
    this.workService = options.workService;
    this.artifactService = options.artifactService ?? null;
    this.collaborationCore = options.collaborationCore;
    this.workSessionStartApplicationService = options.workSessionStartApplicationService;
    this.defaultProviderId = options.defaultProviderId;
    this.directUserTaskCreationTtlMs = options.directUserTaskCreationTtlMs ?? 30 * 60_000;
    // Singleflight is an optimization; durable Task/startup receipts remain authoritative.
    this.taskCreations = new Map();
    this.onRoutingEvent = options.onRoutingEvent ?? ((event, details) => {
      console.info(`[collaboration-routing] event=${event} ${JSON.stringify(details)}`);
    });
    if (!this.store || !this.workService || !this.collaborationCore
      || typeof this.workSessionStartApplicationService?.start !== "function" || !this.defaultProviderId) {
      throw new TypeError("SessionCollaborationService requires store, workService, collaborationCore, and WorkSessionStartApplicationService.");
    }
  }

  capabilities(metadata = {}, actorId = null, options = {}) {
    const scope = this.#scope(metadata, actorId, {
      mutation: false,
      validateContext: options.validateContext === true
    });
    const active = scope.logical?.activeBinding?.state === "active" && !scope.logical.archived && !scope.session.archived && !scope.session.deletedAt;
    const canCreate = active && (scope.session.sessionKind === "workChat"
      || (scope.session.sessionKind === "worker" && Boolean(scope.session.taskId)));
    const requestDenial = this.#collaborationRequestDenial(scope);
    const parent = scope.session.taskId ? this.store.getTask(scope.session.taskId) : null;
    const childReason = requestDenial?.code ?? (!canCreate ? "COLLABORATION_CREATE_FORBIDDEN"
      : parent && (parent.archived || parent.deletion_status) ? "TASK_PARENT_UNAVAILABLE" : null);
    const managesChildren = canCreate && !childReason && scope.session.sessionKind === "worker" && parent?.lifecycle_state !== "done";
    return {
      actorAgentId: scope.agent.agentId,
      sourceSessionId: scope.logicalSessionId,
      providerSessionId: scope.session.id,
      sessionKind: scope.session.sessionKind,
      workId: scope.session.workId,
      taskId: scope.session.taskId,
      actions: ["sessions.discover", "sessions.get", "channels.open", "channels.list", "channels.get",
        "channels.message_send", "channels.revoke", ...(managesChildren ? ["tasks.dispatch", "tasks.delete_child"] : []), ...(scope.session.workId ? ["tasks.list", "tasks.get"] : []), ...(canCreate && !requestDenial
        ? ["tasks.create", ...(!childReason ? ["tasks.create_child", "tasks.create_batch"] : []), "tasks.relate", "tasks.share_artifact"]
        : [])],
      denials: { ...(requestDenial ? { "tasks.create": requestDenial } : {}),
        ...(childReason ? { "tasks.create_child": { code: childReason } } : {}) },
      taskHierarchyCapabilities: { ...taskHierarchyCapabilities, createChild: !childReason },
      taskCreation: { independent: canCreate && !requestDenial, child: !childReason,
        parentTaskId: scope.session.sessionKind === "worker" ? scope.session.taskId : null,
        requiresExplicitUserIntent: false, independentRequiresExplicitUserIntent: true, requiresParentPreflight: true,
        childCountPolicy: "session_decides", childBatch: !childReason, maxChildBatchSize: MAX_CHILD_TASK_BATCH_SIZE },
      channelPolicy: {
        actor: "authenticated_session",
        firstUse: "user_confirmation",
        activeChannel: "endpoint_members_only",
        createsTaskImplicitly: false
      },
      destructiveActions: managesChildren ? ["tasks.delete_child_safe"] : [],
      arbitraryUpdate: false
    };
  }

  discoverSessions(metadata, actorId, filters = {}) {
    const scope = this.#scope(metadata, actorId, { mutation: false });
    const visible = this.#visibleSessions(scope, filters);
    return visible
      .filter((session) => !filters.agentId || session.agentId === filters.agentId)
      .filter((session) => !filters.workId || session.workId === filters.workId)
      .filter((session) => !filters.taskId || session.taskId === filters.taskId)
      .filter((session) => !filters.sessionKind || session.sessionKind === filters.sessionKind)
      .map((session) => this.#sessionDescriptor(session, scope));
  }

  getSession(metadata, actorId, sessionId) {
    const scope = this.#scope(metadata, actorId, { mutation: false });
    const target = this.#resolveSession(sessionId);
    if (!target) {
      throw coded("SESSION_NOT_VISIBLE", "The target Session is outside the authenticated Work/Agent scope.");
    }
    if (!this.#isVisibleSession(scope, target, { explicitPeerLookup: true })) {
      const eligibility = collaborationSessionEligibility(this.store, target);
      if (eligibility.reasons.includes("session_archived")
        && this.#isVisibleSession(scope, target, { explicitPeerLookup: true, includeArchived: true })) {
        throw coded(
          "RECIPIENT_SESSION_UNAVAILABLE",
          `The target Session is archived and cannot join a new communication Channel: ${target.archiveReason ?? "session_archived"}.`,
          409
        );
      }
      throw coded("SESSION_NOT_VISIBLE", "The target Session is outside the authenticated Work/Agent scope.");
    }
    return this.#sessionDescriptor(target, scope);
  }

  listTasks(metadata, actorId) {
    const scope = this.#scope(metadata, actorId, { mutation: false });
    if (!scope.session.workId) return [];
    const items = this.workService.listTasksByWork(scope.session.workId).filter(item => this.#canReadTask(scope, item));
    const summaries = this.store.hierarchySummaries(items.map(item => item.id));
    return items.map(item => this.#presentTask(item, summaries.get(item.id), this.#canReadTask(scope, item, false)));
  }

  getTask(metadata, actorId, taskId) {
    const scope = this.#scope(metadata, actorId, { mutation: false });
    const item = this.workService.getTask(required(taskId, "task_id"));
    if (!this.#canReadTask(scope, item)) throw coded("TASK_OUTSIDE_SCOPE", "Task is outside the authenticated Session scope.");
    return this.#presentTask(item, undefined, this.#canReadTask(scope, item, false));
  }

  async createChildTasksBatch(metadata, actorId, input = {}) {
    assertKnown(input, ["parentTaskId", "expectedParentResourceVersion", "logicalSessionId",
      "userMessageEventId", "userMessageSequence", "turnId", "items"]);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
      throw coded("INVALID_TASK_BATCH_SIZE", "Each request accepts 1-100 items, admitted in groups of ten.", 400);
    }
    const parentTaskId = required(input.parentTaskId, "parentTaskId");
    const scope = this.#scope(metadata, actorId, { mutation: true });
    this.#assertCreationSource(scope);
    this.#authorizeTaskCreation(scope, input);
    this.#assertCreationParent(scope, { ...input, parentTaskId });
    const keys = new Set();
    for (const item of input.items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw coded("INVALID_TASK_BATCH_ITEM", "Every batch item must be an object.", 400);
      assertKnown(item, ["title", "priority", "agentId",
        "providerId", "artifactReference", "fileReference", "idempotencyKey"]);
      const key = required(item.idempotencyKey, "items[].idempotencyKey");
      if (keys.has(key)) throw coded("DUPLICATE_TASK_BATCH_KEY", "Each child Task must have a distinct stable idempotency key.", 400);
      keys.add(key);
    }
    if(this.taskCoordinationService && scope.session.sessionKind==="worker") {
      const receipt=this.taskCoordinationService.acceptDispatch(metadata,actorId,{items:input.items.map(item=>({
        action:"create",text:`执行子任务：${item.title}`,
        idempotencyKey:item.idempotencyKey,
        creation:Object.fromEntries(Object.entries(item).filter(([key])=>key!=="idempotencyKey"))
      }))});
      return {...receipt,parentTaskId,total:input.items.length,status:"accepted",results:receipt.dispatches};
    }
    const { items, ...shared } = input;
    const results = [];
    // One transport call, bounded sequential startup. Each existing Task/startup
    // receipt is authoritative; no batch journal or batch fingerprint is needed.
    for (const [index, item] of items.entries()) {
      try {
        const result = await this.createTaskAndSession(metadata, actorId, { ...item, ...shared, parentTaskId });
        results.push({ index, idempotencyKey: item.idempotencyKey, status: "succeeded", result });
      } catch (error) {
        results.push({ index, idempotencyKey: item.idempotencyKey, status: "failed", error: {
          code: error?.code ?? "TASK_CREATION_FAILED", message: String(error?.message ?? "Task creation failed."),
          ...(error?.creationRecovery ? { creationRecovery: error.creationRecovery } : {})
        } });
      }
    }
    const succeeded = results.filter(item => item.status === "succeeded").length;
    return { parentTaskId, total: results.length, succeeded, failed: results.length - succeeded,
      status: succeeded === results.length ? "completed" : succeeded === 0 ? "failed" : "partial", results };
  }

  async createTaskAndSession(metadata, actorId, input = {}, options = {}) {
    const scope = this.#scope(metadata, actorId, { mutation: true });
    const authorization = this.#authorizeTaskCreation(scope, input);
    const intent = this.#creationIntent(scope, input, authorization);
    const key = JSON.stringify([scope.logicalSessionId, required(input.idempotencyKey, "idempotency_key")]);
    const inFlight = this.taskCreations.get(key);
    if (inFlight) {
      if (inFlight.fingerprint !== intent.fingerprint) throw coded("IDEMPOTENCY_CONFLICT", "Task input changed while creation is in progress.", 409);
      return inFlight.promise;
    }
    const entry = { fingerprint: intent.fingerprint };
    entry.promise = this.#createTaskAndSession(metadata, actorId, input, scope, authorization, intent, options);
    this.taskCreations.set(key, entry);
    try { return await entry.promise; }
    catch (error) {
      const task = this.store.selectOne("SELECT id FROM tasks WHERE created_by_session_id=? AND idempotency_key=?", [scope.logicalSessionId, input.idempotencyKey]);
      if (task) {
        const startup = this.store.selectOne("SELECT startup_operation_id,state,error_retryable FROM work_session_startup_operations WHERE task_id=? ORDER BY rowid DESC LIMIT 1", [task.id]);
        const sandbox = !startup && this.store.selectOne("SELECT execution_space_id,status FROM execution_spaces WHERE task_id=? AND idempotency_key=?", [task.id, `task-create:${input.idempotencyKey}`]);
        error.creationRecovery = { ...error.creationRecovery, taskId: task.id, parentTaskId: input.parentTaskId ?? null,
          startupOperationId: startup?.startup_operation_id ?? sandbox?.execution_space_id ?? null,
          phase: startup?.state ?? sandbox?.status ?? "created",
          retryable: startup ? Boolean(startup.error_retryable) : true, nextAction: "read_task_then_retry_same_request" };
      }
      throw error;
    }
    finally { if (this.taskCreations.get(key) === entry) this.taskCreations.delete(key); }
  }

  async #createTaskAndSession(metadata, actorId, input, scope, authorization, intent, options) {
    const frozenRuntime = options.runtimeConfiguration;
    const prior = this.#creationReplay(scope, input, intent);
    const taskInput = prior?.creation_intent_fingerprint
      ? { id: prior.id, workId: prior.work_id, parentTaskId: prior.parent_task_id ?? null }
      : { ...intent.taskInput, ...(prior ? { id: prior.id } : {}) };
    const runtime = prior?.creation_intent_json ? JSON.parse(prior.creation_intent_json).runtime
      : frozenRuntime ?? resolveTaskCreationDefaults({ providerId: input.providerId }, this.store.settings?.().newSessionDefaults ?? {}, this.defaultProviderId);
    const revalidate = () => {
      const current = this.#scope(metadata, actorId, { mutation: true });
      this.#assertCreationSource(current);
      if (current.logicalSessionId !== scope.logicalSessionId || current.session.id !== scope.session.id
        || current.session.workId !== scope.session.workId || current.session.taskId !== scope.session.taskId) {
        throw coded("SOURCE_SESSION_CHANGED", "The source Session binding changed during creation.", 409);
      }
      this.#authorizeTaskCreation(current, input);
      this.#assertCreationParent(current, input);
      this.#requireContributor(scope.session.workId, intent.taskInput.mainAgentId);
    };
    const created = await createTaskAndSession({
      workService: this.workService,
      startWorkSession: (command) => {
        revalidate();
        if (prior && options.retryStartupOperationId) {
          return this.workSessionStartApplicationService.resumeTaskStartup({ taskId: command.taskId,
            sourceSessionId: scope.logicalSessionId, retryStartupOperationId: options.retryStartupOperationId });
        }
        const row = this.store.getTask(command.taskId);
        const saved = row?.creation_intent_json ? JSON.parse(row.creation_intent_json) : null;
        const allocated = this.store.selectOne("SELECT startup_operation_id FROM work_session_startup_operations WHERE task_id=? AND idempotency_key=?", [command.taskId, command.idempotencyKey])
          ?? this.store.selectOne("SELECT execution_space_id FROM execution_spaces WHERE task_id=? AND idempotency_key=?", [command.taskId, command.idempotencyKey]);
        const frozen = allocated && saved?.startupCommand ? saved.startupCommand : command;
        if (saved) {
          this.store.db.run("UPDATE tasks SET creation_intent_json=? WHERE id=?", [JSON.stringify({ ...saved, startupCommand: frozen }), command.taskId]);
          this.store.scheduleSave();
        }
        return this.workSessionStartApplicationService.start(frozen);
      },
      taskInput,
      sourceSessionId: scope.logicalSessionId,
      runtimeConfiguration: runtime,
      idempotencyKey: required(input.idempotencyKey, "idempotency_key"),
      revalidate,
      verifyExistingSession: (task, session) => this.#verifyCreationBinding(task, session),
      persistTask: () => this.createTask(metadata, actorId, input, authorization, { ...intent, runtime, taskInput })
    });
    const currentTask = this.store.getTask(created.task.id);
    const currentSession = this.#resolveSession(
      created.session?.id ?? currentTask?.current_session_id
    );
    if (!currentSession) {
      throw coded(
        "START_SESSION_UNRESOLVED",
        "Task creation did not resolve its companion logical Session.",
        500
      );
    }
    this.#verifyCreationBinding(currentTask, currentSession);
    return {
      ...created,
      ...this.#startReceipt(
        currentTask,
        currentSession,
        currentTask.execution_status ?? "running",
        created.idempotentReplay,
        required(input.idempotencyKey, "idempotency_key")
      ),
      task: this.#presentTask(currentTask),
      start: created.start,
      phase: "started",
      startupStatus: "ready",
      runtime: { providerId: runtime.providerId, model: runtime.model, reasoningLevel: runtime.reasoningLevel }
    };
  }

  // Internal metadata primitive retained for existing callers. Transport uses
  // createTaskAndSession; child persistence additionally requires prepared intent.
  createTask(metadata, actorId, input = {}, creationAuthorization = null, prepared = null) {
    assertKnown(input, ["title", "priority", "agentId",
      "parentTaskId", "expectedParentResourceVersion",
      "providerId", "artifactReference", "fileReference", "logicalSessionId",
      "userMessageEventId", "userMessageSequence", "turnId", "idempotencyKey"]);
    const scope = this.#scope(metadata, actorId, { mutation: true });
    this.#assertCreationParent(scope, input);
    if (input.providerId != null && (typeof input.providerId !== "string" || !input.providerId.trim())) throw coded("INVALID_PROVIDER_ID", "Provider override must be an explicit nonempty identifier.", 400);
    if (input.parentTaskId && (!prepared || !creationAuthorization)) throw coded("TASK_CREATION_WORKFLOW_REQUIRED", "Child creation must use the common Task and Session startup workflow.", 409);
    const title = validateEntityName(input.title, "title", "Task");
    const kind = scope.session.sessionKind;
    if (!scope.session.workId || !["workChat", "worker"].includes(kind)) {
      throw coded("COLLABORATION_CREATE_FORBIDDEN", "A bound Work Chat or Worker Session is required to create a collaboration Task.");
    }
    const targetAgentId = optional(input.agentId);
    if (targetAgentId) this.#requireContributor(scope.session.workId, targetAgentId);
    const idempotencyKey = required(input.idempotencyKey, "idempotency_key");
    if (input.artifactReference != null && input.fileReference != null) {
      throw coded("TASK_REFERENCE_CONFLICT", "Choose either artifactReference or fileReference, not both.", 400);
    }
    const creationReferenceFingerprint = fingerprintCreationReference(input);
    const prior = this.store.selectOne(
      "SELECT * FROM tasks WHERE created_by_session_id = ? AND idempotency_key = ?",
      [scope.logicalSessionId, idempotencyKey]
    );
    if (prior) {
      if ((prior.parent_task_id ?? null) !== (input.parentTaskId ?? null)
        || prepared && prior.creation_intent_fingerprint && prior.creation_intent_fingerprint !== prepared.fingerprint) {
        throw coded("IDEMPOTENCY_CONFLICT", "The request is bound to another Task intent.", 409);
      }
      const priorOrigin = this.store.getTaskCreationOrigin(prior.id);
      if ((!prepared || !prior.creation_intent_fingerprint) && prior.title !== title || prior.work_id !== scope.session.workId
        || (prior.creation_reference_fingerprint ?? null) !== creationReferenceFingerprint
        || (!prepared && creationAuthorization && priorOrigin?.creationContextMessageId !== creationAuthorization.eventId)) {
        throw coded("IDEMPOTENCY_CONFLICT", "The idempotency key is already associated with different Task input.", 409);
      }
      return { task: this.#presentTask(prior), idempotentReplay: true, phase: "created" };
    }
    const artifactReference = input.artifactReference == null
      ? null
      : this.#prepareArtifactReference(scope, input.artifactReference);
    const fileReference = input.fileReference == null
      ? null
      : this.#prepareFileReference(scope, input.fileReference);
    const priority = optional(input.priority) ?? "medium";
    if (!TASK_PRIORITIES.includes(priority)) throw coded("INVALID_PRIORITY", `Unsupported Task priority: ${priority}`);
    let item;
    this.store.runInTransaction(() => {
      if (creationAuthorization && !input.parentTaskId) {
        const grant = this.#authorizeDirectUserTaskCreation(scope, input);
        const used = this.store.selectOne("SELECT COUNT(*) AS count FROM task_creation_origins WHERE creator_session_id=? AND creation_context_message_id=?", [scope.logicalSessionId, grant.eventId]).count;
        if (used >= grant.maxTaskCount) throw coded("TASK_CREATION_QUOTA_EXCEEDED", "The direct user request has already created its authorized Task count. Read existing Tasks or obtain an explicit new creation request.", 409);
      }
      item = this.workService.createTask(prepared?.taskInput ?? {
        workId: scope.session.workId,
        title,

        priority,
        lifecycleState: "todo",
        mainAgentId: targetAgentId
      }, {
        creationOrigin: {
          originType: "session",
          creatorSessionId: scope.logicalSessionId,
          creationContextTaskId: scope.session.taskId,
          creationContextMessageId: creationAuthorization?.eventId,
          operationId: idempotencyKey
        },
        creationPending: Boolean(prepared)
      });
      this.store.db.run(
        `UPDATE tasks SET created_by_session_id=?, idempotency_key=?,
         creation_reference_fingerprint=?, creation_intent_json=?, creation_intent_fingerprint=?, resource_version=1 WHERE id=?`,
        [scope.logicalSessionId, idempotencyKey, creationReferenceFingerprint,
          prepared ? JSON.stringify({ version: 1, request: prepared.request, runtime: prepared.runtime }) : null,
          prepared?.fingerprint ?? null, item.id]
      );
      if (artifactReference) this.artifactService.createPreparedTaskReference(artifactReference, item.id);
      if (fileReference) this.store.createTaskFileReference({
        referenceId: `task_file_reference:${randomUUID()}`,
        workId: scope.session.workId,
        taskId: item.id,
        ...fileReference,
        actorId: scope.logicalSessionId,
        sessionId: scope.logicalSessionId,
        authorizedAt: new Date().toISOString()
      });
    });
    this.store.scheduleSave();
    return { task: this.#presentTask(this.store.getTask(item.id)), idempotentReplay: false, phase: "created" };
  }

  #assertCreationParent(scope, input) {
    if (input.parentTaskId == null) {
      if (input.expectedParentResourceVersion != null) throw coded("INVALID_TASK_PARENT", "A parent version requires an explicit parent Task.", 400);
      return;
    }
    const id = required(input.parentTaskId, "parentTaskId");
    // Deprecated transport input: accepted for old clients, never a creation fence.
    if (input.expectedParentResourceVersion != null && (!Number.isSafeInteger(input.expectedParentResourceVersion) || input.expectedParentResourceVersion < 1)) throw coded("INVALID_TASK_PARENT", "Legacy parent version must be a positive integer.", 400);
    if (!scope.session.workId || !["workChat", "worker"].includes(scope.session.sessionKind)) throw coded("COLLABORATION_CREATE_FORBIDDEN", "A bound Work Session is required.", 403);
    if (scope.session.sessionKind === "worker" && id !== scope.session.taskId) throw coded("TASK_PARENT_OUTSIDE_SCOPE", "Worker can create children only under its own bound Task.", 403);
    const parent = this.store.getTask(id);
    if (!parent || parent.work_id !== scope.session.workId) throw coded("TASK_PARENT_OUTSIDE_SCOPE", "Parent is outside the current Work.", 403);
    if (parent.archived || parent.deletion_status || parent.lifecycle_state === "done") throw coded("TASK_PARENT_UNAVAILABLE", "Parent Task is unavailable.", 409);
  }

  #creationIntent(scope, input, authorization) {
    assertKnown(input, ["title", "priority", "agentId", "providerId",
      "parentTaskId", "expectedParentResourceVersion", "artifactReference", "fileReference", "logicalSessionId",
      "userMessageEventId", "userMessageSequence", "turnId", "idempotencyKey"]);
    this.#assertCreationSource(scope);
    this.#assertCreationParent(scope, input);
    if (input.providerId != null && (typeof input.providerId !== "string" || !input.providerId.trim())) throw coded("INVALID_PROVIDER_ID", "Provider override must be an explicit nonempty identifier.", 400);
    if (!scope.session.workId || !["workChat", "worker"].includes(scope.session.sessionKind)) throw coded("COLLABORATION_CREATE_FORBIDDEN", "A bound Work Session is required.", 403);
    const agentId = required(input.agentId, "agentId");
    this.#requireContributor(scope.session.workId, agentId);
    const taskInput = validateTaskInput({ workId: scope.session.workId, title: validateEntityName(input.title, "title", "Task"),

      priority: input.priority ?? "medium", mainAgentId: agentId, parentTaskId: input.parentTaskId ?? null });
    if (input.artifactReference != null && input.fileReference != null) throw coded("TASK_REFERENCE_CONFLICT", "Choose one creation reference.", 400);
    const request = { ...taskInput, providerId: optional(input.providerId),
      referenceFingerprint: fingerprintCreationReference(input), eventId: authorization.eventId };
    // Authorization is revalidated on every attempt. A renewed direct-user
    // grant may resume the same operation after expiry without changing the
    // immutable creation origin or treating its event id as Task definition.
    const { eventId, ...definition } = request;
    return { taskInput, request, fingerprint: createHash("sha256").update(JSON.stringify(definition)).digest("hex") };
  }

  #assertCreationSource(scope) {
    if (!scope.logical || scope.logical.archived || scope.session.archived || scope.session.deletedAt
      || scope.logical.activeBinding?.state !== "active") throw coded("STALE_SESSION_ROUTE", "An active authenticated Session is required for Task creation.", 409);
    if (!["workChat", "worker"].includes(scope.session.sessionKind)) throw coded("COLLABORATION_CREATE_FORBIDDEN", "A bound Work Chat or Worker Session is required.", 403);
    if (scope.session.sessionKind === "worker" && this.store.getTask(scope.session.taskId)?.work_id !== scope.session.workId) {
      throw coded("COLLABORATION_CONTEXT_MISMATCH", "Worker Task does not belong to the authenticated Work.", 409);
    }
  }

  #creationReplay(scope, input, intent) {
    const prior = this.store.selectOne("SELECT * FROM tasks WHERE created_by_session_id=? AND idempotency_key=?", [scope.logicalSessionId, required(input.idempotencyKey, "idempotency_key")]);
    if (!prior) return null;
    if (prior.creation_intent_fingerprint) {
      if (prior.creation_intent_fingerprint !== intent.fingerprint) throw coded("IDEMPOTENCY_CONFLICT", "Task creation intent changed.", 409);
      if (prior.main_agent_id !== intent.taskInput.mainAgentId) throw coded("IDEMPOTENCY_CONFLICT", "The existing Task was reassigned; read its current state instead of replaying creation.", 409);
    } else {
      // Historical root requests predate intent storage. Never reinterpret one
      // as a child or silently accept changed persisted definition fields.
      if (intent.taskInput.parentTaskId || prior.parent_task_id || prior.work_id !== scope.session.workId
        || prior.title !== intent.taskInput.title
        || prior.priority !== intent.taskInput.priority || prior.main_agent_id !== intent.taskInput.mainAgentId
        || (prior.creation_reference_fingerprint ?? null) !== intent.request.referenceFingerprint) throw coded("IDEMPOTENCY_CONFLICT", "Legacy creation intent cannot be changed.", 409);
    }
    if (prior.archived || prior.deletion_status) throw coded("TASK_PARENT_UNAVAILABLE", "Created Task is no longer available.", 409);
    return prior;
  }

  #verifyCreationBinding(task, session) {
    if (!session) throw coded("START_SESSION_UNRESOLVED", "The companion Session is unavailable.", 409);
    const logical = this.store.getLogicalSessionByLegacySessionId(session.id);
    if (!session || session.taskId !== task.id || session.workId !== task.work_id || session.agentId !== task.main_agent_id || session.archived || logical?.archived
      || logical?.activeBinding?.state !== "active" || task.current_session_id !== session.id) throw coded("START_SESSION_UNRESOLVED", "The companion Session no longer has the expected active binding.", 409);
    if (typeof this.workSessionStartApplicationService.getSessionBinding !== "function") {
      throw coded("START_REFERENCE_INVALID", "Verified startup proof is unavailable.", 409);
    }
    const proof = this.workSessionStartApplicationService.getSessionBinding(logical.logicalSessionId);
    if (proof?.status !== "ready" || proof.task?.id !== task.id || proof.session?.id !== session.id) throw coded("START_REFERENCE_INVALID", "Startup receipt does not match this Task and Session.", 409);
    return proof;
  }

  #authorizeDirectUserTaskCreation(scope, input) {
    return authorizeDirectUserTaskCreation({
      store: this.store,
      providerSessionId: scope.session.id,
      expectedLogicalSessionId: scope.logicalSessionId,
      logicalSessionId: input.logicalSessionId,
      userMessageEventId: input.userMessageEventId,
      userMessageSequence: input.userMessageSequence,
      turnId: input.turnId,
      ttlMs: this.directUserTaskCreationTtlMs
    });
  }

  #authorizeTaskCreation(scope, input) {
    if(input.parentTaskId == null) return this.#authorizeDirectUserTaskCreation(scope,input);
    // Child decomposition is an authenticated Session capability, not a
    // per-message user grant. Keep the existing ownership/startup boundaries,
    // and never manufacture user-message provenance for autonomous creation.
    this.#assertCreationSource(scope);
    this.#assertCreationParent(scope,input);
    if(input.logicalSessionId != null && input.logicalSessionId!==scope.logicalSessionId) {
      throw coded("LOGICAL_SESSION_MISMATCH","The supplied logical Session does not match the authenticated Session.",403);
    }
    return {logicalSessionId:scope.logicalSessionId,eventId:null};
  }

  #prepareArtifactReference(scope, input) {
    if (!this.artifactService) {
      throw coded("ARTIFACT_CAPABILITY_UNAVAILABLE", "Artifact references are unavailable for Task creation.", 503);
    }
    assertKnown(input, ["artifactId", "relation", "required", "versionPolicy", "version"]);
    return this.artifactService.prepareTaskCreationReference({
      actorId: scope.agent.agentId,
      sessionId: scope.session.id,
      workId: scope.session.workId,
      taskId: scope.session.taskId
    }, required(input.artifactId, "artifact_reference.artifact_id"), input);
  }

  #prepareFileReference(scope, input) {
    assertKnown(input, ["path", "relation", "required"]);
    const requestedPath = required(input.path, "file_reference.path");
    if (!isAbsolute(requestedPath)) {
      throw coded("INVALID_FILE_REFERENCE", "Task file references require an absolute path.", 400);
    }
    const workspacePath = scope.logical?.activeBinding?.boundCwd ?? scope.session.external?.cwd ?? null;
    if (!workspacePath) {
      throw coded("FILE_REFERENCE_WORKSPACE_REQUIRED", "The authenticated Session has no active Workspace path for file authorization.", 409);
    }
    let workspaceRoot;
    let canonicalPath;
    let info;
    try {
      workspaceRoot = realpathSync(workspacePath);
      canonicalPath = realpathSync(requestedPath);
      info = statSync(canonicalPath);
    } catch (error) {
      if (error?.code === "ENOENT") throw coded("FILE_REFERENCE_NOT_FOUND", "Referenced file does not exist.", 404);
      throw coded("FILE_REFERENCE_UNAVAILABLE", "Referenced file could not be inspected.", 400);
    }
    const pathFromWorkspace = relative(workspaceRoot, canonicalPath);
    if (pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace)) {
      throw coded("FILE_REFERENCE_FORBIDDEN", "Referenced file must be inside the authenticated Session Workspace.", 403);
    }
    if (!info.isFile()) throw coded("INVALID_FILE_REFERENCE", "Referenced path must be a regular file.", 400);
    try {
      accessSync(canonicalPath, fsConstants.R_OK);
    } catch {
      throw coded("FILE_REFERENCE_FORBIDDEN", "Referenced file is not readable by the Corptie backend.", 403);
    }
    const relation = artifactRelation(input.relation ?? "implementation_spec");
    if (input.required != null && typeof input.required !== "boolean") {
      throw coded("INVALID_FILE_REFERENCE", "file_reference.required must be a boolean.", 400);
    }
    return {
      canonicalPath,
      workspaceRoot,
      displayName: basename(canonicalPath),
      relation,
      required: input.required === true,
      byteLength: info.size,
      modifiedAt: info.mtime.toISOString()
    };
  }

  coordinationScope(metadata, actorId) {
    const scope = this.#scope(metadata, actorId, { mutation: true });
    this.#assertCreationSource(scope);
    const parent = this.store.getTask(scope.session.taskId);
    if (scope.session.sessionKind !== "worker" || !parent || parent.archived
      || parent.deletion_status || parent.lifecycle_state === "done") throw coded("TASK_PARENT_UNAVAILABLE", "An active root Task Session is required.", 403);
    if (metadata.providerBindingId && metadata.providerBindingId !== scope.logical.activeBinding.bindingId) throw coded("STALE_SESSION_ROUTE", "Refresh the Session route.", 409);
    return { ...scope, parent };
  }

  assertDirectChild(scope, child) {
    if (!child || child.parent_task_id !== scope.parent.id || child.work_id !== scope.parent.work_id) throw coded("TASK_PARENT_OUTSIDE_SCOPE", "Only direct children of this Session's Task are allowed.", 403);
    if (child.archived || child.deletion_status || child.lifecycle_state === "done") throw coded("RECIPIENT_TASK_UNAVAILABLE", "The child is archived, deleting or completed.", 409);
  }

  prepareCoordinationDispatch(scope, item, { replay = false } = {}) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw coded("INVALID_DISPATCH", "Invalid dispatch.", 400);
    assertKnown(item, ["action", "taskId", "text", "idempotencyKey", "creation"]);
    const request = { action: item.action, taskId: item.taskId ?? null, text: required(item.text, "text"),
      idempotencyKey: required(item.idempotencyKey, "idempotencyKey"), creation: null };
    if (Buffer.byteLength(request.text) > 48 * 1024 || request.idempotencyKey.length > 200) throw coded("DISPATCH_TOO_LARGE", "Dispatch exceeds its input budget.", 400);
    if (request.action === "send") {
      required(request.taskId, "taskId");
      if (!replay) this.assertDirectChild(scope, this.store.getTask(request.taskId));
      if (item.creation != null) throw coded("INVALID_DISPATCH", "send cannot create a Task.", 400);
    } else if (request.action === "create") {
      if (request.taskId !== null) throw coded("INVALID_DISPATCH", "create cannot target an existing Task.", 400);
      const creation = item.creation ?? {};
      assertKnown(creation, ["title", "priority", "agentId", "providerId", "artifactReference", "fileReference"]);
      required(creation.agentId, "agentId");
      if (!replay) this.#requireContributor(scope.session.workId, creation.agentId);
      const normalized = validateTaskInput({ title: creation.title, workId: scope.parent.work_id, mainAgentId: creation.agentId,
           priority: creation.priority ?? "medium" });
      if (!replay && creation.artifactReference != null) this.#prepareArtifactReference(scope, creation.artifactReference);
      if (!replay && creation.fileReference != null) this.#prepareFileReference(scope, creation.fileReference);
      if (creation.artifactReference && creation.fileReference) throw coded("TASK_REFERENCE_CONFLICT", "Choose one reference.", 400);
      request.creation = { title: normalized.title,
         priority: normalized.priority, agentId: creation.agentId,
        ...(creation.providerId ? { providerId: creation.providerId } : {}),
        ...(creation.artifactReference ? { artifactReference: creation.artifactReference } : {}),
        ...(creation.fileReference ? { fileReference: creation.fileReference } : {}) };
    } else throw coded("INVALID_DISPATCH", "action must be create or send.", 400);
    return { request, runtime: resolveTaskCreationDefaults({ providerId: request.creation?.providerId }, this.store.settings?.().newSessionDefaults ?? {}, this.defaultProviderId) };
  }

  async deleteChildTask(metadata, actorId, input = {}) {
    assertKnown(input, ["childTaskId", "idempotencyKey", "artifactDisposition", "stopRunning", "cancelStartup", "deleteAssociatedTasks", "cancelIntegration", "inspectOnly"]);
    const scope = this.coordinationScope(metadata, actorId);
    const key = `parent:${scope.logicalSessionId}:${required(input.idempotencyKey, "idempotencyKey")}`;
    const replay = this.store.getTaskDeletionOperationByKey(required(input.childTaskId, "childTaskId"), key);
    if (replay) {
      if (replay.input?.actor?.type !== "parent_session" || replay.input.actor.id !== scope.logicalSessionId
        || replay.input.target?.parentTaskId !== scope.parent.id) throw coded("TASK_PARENT_OUTSIDE_SCOPE", "Deletion receipt does not belong to this parent Session.", 403);
      if (input.inspectOnly !== true && (replay.state !== "failed" || !replay.retryable)) {
        return { accepted: true, operation: replay, idempotentReplay: true };
      }
    }
    const child = this.store.getTask(required(input.childTaskId, "childTaskId"));
    // Deletion retries may revisit a child whose deletion is already queued.
    if (!child || child.parent_task_id !== scope.parent.id || child.work_id !== scope.parent.work_id) throw coded("TASK_PARENT_OUTSIDE_SCOPE", "Only this Session's direct child may be deleted.", 403);
    const service = this.taskCoordinationService?.deletion;
    if (!service) throw coded("CAPABILITY_UNAVAILABLE", "Task deletion is unavailable.", 503);
    const actor = { type: "parent_session", id: scope.logicalSessionId };
    if (input.inspectOnly === true) return { deletion: await service.inspect(child.id, actor) };
    return service.request(child.id, { mode: "force", deleteWorktree: true,
      artifactDisposition: input.artifactDisposition ?? "retain", stopRunning: input.stopRunning === true,
      cancelStartup: input.cancelStartup === true, deleteAssociatedTasks: input.deleteAssociatedTasks === true,
      cancelIntegration: input.cancelIntegration === true, idempotencyKey: key }, actor);
  }

  #presentTask(item, hierarchy = undefined, referencesAvailable = true) {
    const { creation_intent_json, creation_intent_fingerprint, ...fields } = item;
    return {
      ...fields,
      parentTaskId: item.parent_task_id ?? null,
      resourceVersion: item.resource_version,
      coordinationEnabled: item.coordination_enabled === 1,
      coordinationDispatches: this.taskCoordinationService?.listForParent(item.id) ?? [],
      hierarchy: hierarchy ?? this.store.hierarchySummaries([item.id]).get(item.id),
      creationOrigin: this.store.getTaskCreationOrigin(item.id),
      referencesAvailable,
      references: {
        artifacts: referencesAvailable ? this.store.listArtifactReferences({ taskId: item.id }) : [],
        files: referencesAvailable ? this.store.listTaskFileReferences(item.id) : []
      }
    };
  }

  relateTasks(metadata, actorId, input = {}) {
    assertKnown(input, ["taskId", "targetTaskId", "relationship"]);
    const scope = this.#scope(metadata, actorId, { mutation: true });
    const item = this.getTask(metadata, actorId, input.taskId);
    const target = this.getTask(metadata, actorId, input.targetTaskId);
    const relationship = required(input.relationship, "relationship");
    if (!RELATIONS.has(relationship)) throw coded("INVALID_RELATION", `Unsupported Task relation: ${relationship}`);
    if (scope.session.sessionKind === "worker" && ![item.id, target.id].includes(scope.session.taskId)) {
      throw coded("WORKER_RELATION_REQUIRED", "Worker Session relationships must include its bound Task.");
    }
    return this.#relate(item.id, target.id, relationship);
  }

  shareArtifact(metadata, actorId, input = {}) {
    assertKnown(input, ["taskId", "artifactId", "relation", "required", "versionPolicy", "version"]);
    const scope = this.#scope(metadata, actorId, { mutation: true });
    if (!scope.session.workId || !["workChat", "worker"].includes(scope.session.sessionKind)) {
      throw coded("ARTIFACT_SHARE_FORBIDDEN", "A bound Work Chat or Worker Session is required to share an Artifact.", 403);
    }
    const target = this.workService.getTask(required(input.taskId, "task_id"));
    if (!this.#canReadTask(scope, target)) {
      throw coded("TASK_OUTSIDE_SCOPE", "The target Task is outside the authenticated Session scope.", 403);
    }
    if (scope.session.sessionKind === "worker" && target.id === scope.session.taskId) {
      throw coded("ARTIFACT_SHARE_TARGET_REQUIRED", "Choose another explicitly related Task as the read-only Artifact recipient.", 400);
    }
    const prepared = this.#prepareArtifactReference(scope, {
      artifactId: input.artifactId,
      relation: input.relation,
      required: input.required,
      versionPolicy: input.versionPolicy,
      version: input.version
    });
    const artifact = this.store.getArtifact(prepared.artifactId);
    if (scope.session.sessionKind === "worker" && artifact?.boundTaskId !== scope.session.taskId) {
      throw coded(
        "ARTIFACT_RESHARE_FORBIDDEN",
        "Worker Sessions may share only Artifacts owned by their current Task; received read-only Artifacts cannot be re-shared.",
        403
      );
    }
    let reference;
    let idempotentReplay = false;
    this.store.runInTransaction(() => {
      reference = this.store.listArtifactReferences({ artifactId: prepared.artifactId, taskId: target.id })
        .find((candidate) => candidate.relation === prepared.relation
          && candidate.required === prepared.required
          && candidate.versionPolicy === prepared.versionPolicy
          && candidate.pinnedVersion === prepared.pinnedVersion
          && candidate.pinnedHash === prepared.pinnedHash) ?? null;
      if (reference) {
        idempotentReplay = true;
        return;
      }
      reference = this.artifactService.createPreparedTaskReference(prepared, target.id);
    });
    this.store.scheduleSave();
    return {
      access: "read_only",
      reference,
      task: this.#presentTask(this.store.getTask(target.id)),
      idempotentReplay
    };
  }

  async startTask(metadata, actorId, input = {}) {
    assertStartKnown(input);
    const scope = this.#scope(metadata, actorId, { mutation: true });
    if (input.sourceSessionId !== scope.logicalSessionId) {
      throw coded("SOURCE_SESSION_ACTOR_MISMATCH", "Work Session command source does not match the authenticated Session.", 403);
    }
    const taskId = required(input.taskId, "task_id");
    const expectedVersion = input.expectedTaskVersion;
    const idempotencyKey = input.idempotencyKey;
    const assigneeAgentId = input.assigneeAgentId;
    try {
      const launched = await this.workSessionStartApplicationService.start({
        taskId,
        assigneeAgentId,
        expectedTaskVersion: Number(expectedVersion),
        providerId: required(input.providerId, "provider_id"),
        title: optional(input.title),
        idempotencyKey,
        sourceSessionId: input.sourceSessionId
      });
      const session = this.#resolveSession(launched?.session?.id ?? this.store.getTask(taskId)?.current_session_id);
      if (!session) throw coded("START_SESSION_UNRESOLVED", "Provider accepted the launch but no Corptie Session binding was persisted.");
      return this.#startReceipt(this.store.getTask(taskId), session, "running", false, idempotencyKey);
    } catch (error) {
      error.receipt ??= {
        phase: "failed",
        taskId,
        executionStatus: this.store.getTask(taskId)?.execution_status ?? "start_failed",
        idempotencyKey
      };
      throw error;
    }
  }

  #scope(metadata, actorId, options = {}) {
    const sourceId = required(metadata?.sessionId, "source session metadata");
    const session = this.#resolveSession(sourceId);
    if (!session) throw coded("SOURCE_SESSION_NOT_FOUND", "Authenticated source Session was not found.");
    const bound = this.collaborationCore.getAgentForSession(session.id);
    if (!bound || bound.agentId !== actorId) throw coded("SOURCE_SESSION_ACTOR_MISMATCH", "Authenticated Agent does not own the source Session.");
    const logical = this.store.getLogicalSession(sourceId) ?? this.store.getLogicalSessionByLegacySessionId(session.id);
    const claimedWorkId = optional(metadata?.workId);
    const claimedTaskId = optional(metadata?.taskId);
    if ((options.mutation || options.validateContext) && claimedWorkId && claimedWorkId !== session.workId) {
      throw coded(
        "COLLABORATION_CONTEXT_MISMATCH",
        `Runtime Work ${claimedWorkId} does not match authenticated Session ${logical?.logicalSessionId ?? session.id} bound Work ${session.workId ?? "none"}. Refresh the Session route before retrying.`,
        409
      );
    }
    if ((options.mutation || options.validateContext) && claimedTaskId && claimedTaskId !== session.taskId) {
      throw coded(
        "COLLABORATION_CONTEXT_MISMATCH",
        `Runtime parent Task ${claimedTaskId} does not match authenticated Session ${logical?.logicalSessionId ?? session.id} bound Task ${session.taskId ?? "none"}. Refresh the Session route before retrying.`,
        409
      );
    }
    if (options.mutation && logical && logical.activeBinding?.state !== "active") {
      throw coded("STALE_SESSION_ROUTE", "The source Session route is superseded; recover the active Session before mutating collaboration state.", 409);
    }
    return { agent: bound, session, logical, logicalSessionId: logical?.logicalSessionId ?? session.logicalSessionId ?? session.id };
  }

  #collaborationRequestDenial(scope) {
    if (!scope.session.workId || !["workChat", "worker"].includes(scope.session.sessionKind)) {
      return {
        code: "COLLABORATION_REQUEST_FORBIDDEN",
        reason: "collaboration.request requires an Work Chat or Worker Session bound to an Work."
      };
    }
    if (scope.session.sessionKind === "workChat") return null;
    if (!scope.session.taskId) {
      return {
        code: "COLLABORATION_REQUEST_FORBIDDEN",
        reason: "collaboration.request requires the Worker Session to be bound to a current parent Task."
      };
    }
    const task = this.store.getTask(scope.session.taskId);
    if (!task || task.work_id !== scope.session.workId) {
      return {
        code: "COLLABORATION_REQUEST_FORBIDDEN",
        reason: `The Worker Session parent Task ${scope.session.taskId} is missing or outside its bound Work.`
      };
    }
    if (task.lifecycle_state === "done") {
      return {
        code: "COLLABORATION_REQUEST_FORBIDDEN",
        reason: `The Worker Session parent Task ${scope.session.taskId} is terminal and cannot initiate a new collaboration request.`
      };
    }
    return null;
  }

  #visibleSessions(scope, filters = {}) {
    if (scope.session.workId) {
      const own = this.store.listSessionsByWork(scope.session.workId)
        .filter((session) => this.#isVisibleSession(scope, session));
      if (!filters.agentId && !filters.workId) return own;
      const peerCandidates = filters.workId
        ? this.store.listSessionsByWork(filters.workId)
        : this.store.listSessionsByAgent(filters.agentId);
      const peer = peerCandidates
        .filter((session) => session.workId !== scope.session.workId)
        .filter((session) => !filters.agentId || session.agentId === filters.agentId)
        .filter((session) => !filters.workId || session.workId === filters.workId)
        .filter((session) => this.#isVisibleSession(scope, session, { explicitPeerLookup: true }));
      return uniqueSessions([...own, ...peer]);
    }
    return this.store.listSessionsByAgent(scope.agent.agentId);
  }

  #isVisibleSession(scope, session, options = {}) {
    const agentId = session.agentId ?? this.collaborationCore.getAgentForSession(session.id)?.agentId;
    if (!agentId) return false;
    if (scope.session.workId && session.workId === scope.session.workId) {
      const work = this.workService.getWork(scope.session.workId);
      return agentId === scope.agent.agentId || (work.contributorAgentIds ?? []).includes(agentId);
    }
    if (!scope.session.workId && !options.explicitPeerLookup) return agentId === scope.agent.agentId;
    if (options.explicitPeerLookup && session.sessionKind === "assistantChat") {
      const logical = this.store.getLogicalSessionByLegacySessionId(session.id);
      return (!session.archived || options.includeArchived) && logical?.activeBinding?.state === "active";
    }
    if (!options.explicitPeerLookup
      || !session.workId
      || (session.archived && !options.includeArchived)) return false;
    const work = this.store.getWork(session.workId);
    if (!work) return false;
    const assignedTask = session.taskId ? this.store.getTask(session.taskId) : null;
    const agentAuthorized = (work.contributorAgentIds ?? []).includes(agentId)
      || assignedTask?.main_agent_id === agentId;
    if (!agentAuthorized) return false;
    const logical = this.store.getLogicalSession(session.logicalSessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(session.id);
    return logical?.activeBinding?.state === "active";
  }

  #sessionDescriptor(session, scope) {
    const logical = this.store.getLogicalSession(session.logicalSessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(session.id);
    const binding = logical?.activeBinding ?? null;
    const agentId = session.agentId ?? this.collaborationCore.getAgentForSession(session.id)?.agentId ?? null;
    const sameWork = Boolean(scope.session.workId && session.workId === scope.session.workId);
    // Exact cross-scope lookup exposes a route, never another Session's
    // Provider or Workspace details, including callers without a Work.
    const peerWork = session.id !== scope.session.id && !sameWork;
    const eligibility = collaborationSessionEligibility(this.store, session);
    return {
      sessionId: logical?.logicalSessionId ?? session.logicalSessionId ?? session.id,
      providerSessionId: peerWork ? null : session.id,
      agentId,
      sessionKind: session.sessionKind,
      workId: session.workId,
      taskId: session.taskId,
      lifecycle: session.archived ? "archived" : session.status,
      routeStatus: binding?.state ?? (logical ? "unresolved" : "legacy_unresolved"),
      active: eligibility.active,
      routingRejectionReasons: eligibility.reasons,
      superseded: binding?.state === "superseded",
      routingVersion: peerWork ? null : logical?.routingVersion ?? null,
      bindingId: peerWork ? null : binding?.bindingId ?? null,
      providerId: peerWork ? null : binding?.providerId ?? session.external?.provider ?? null,
      visibilityScope: peerWork ? "peer_work" : "current_scope",
      workspace: peerWork ? { repositoryId: null, worktreeId: null, path: null } : {
        repositoryId: logical?.repositoryId ?? null,
        worktreeId: logical?.activeWorkspaceId ?? null,
        path: binding?.boundCwd ?? session.external?.cwd ?? null
      },
      collaborationCapabilities: sameWork || (!scope.session.workId && agentId === scope.agent.agentId)
        ? ["receive_task", "receive_message", "deliver_artifact"]
        : peerWork ? ["receive_task"] : []
    };
  }

  async prepareChannelRequestTarget(channelRequest) {
    if (!channelRequest?.requestId || channelRequest.status !== "pending") {
      throw coded("CHANNEL_REQUEST_REQUIRED", "A pending Channel request is required before preparing its target Session.");
    }
    if (channelRequest.requestedRecipientSessionId) {
      const session = this.#resolveSession(channelRequest.requestedRecipientSessionId);
      const eligibility = collaborationSessionEligibility(this.store, session);
      if (!eligibility.active) {
        throw coded("RECIPIENT_SESSION_UNAVAILABLE", `The selected target Session is unavailable: ${eligibility.reasons.join(", ")}.`, 409);
      }
      return {
        recipientSessionId: eligibility.logicalSessionId,
        taskId: session.taskId,
        created: false
      };
    }

    const request = channelRequest.request ?? {};
    const targetWorkId = required(request.targetWorkId, "target_work_id");
    const agent = this.#requireContributor(targetWorkId, required(request.sessionAgentId, "session_agent_id"));
    const work = this.workService.getWork(targetWorkId);
    const taskId = request.taskId ?? `task:channel:${channelRequest.requestId}`;
    let task = this.store.getTask(taskId);
    if (!task) {
      task = this.workService.createTask({
        id: taskId,
        workId: targetWorkId,
        title: optional(request.title) ?? "Session Channel",

        priority: "medium",
        lifecycleState: "todo",
        mainAgentId: agent.agentId
      }, {
        creationOrigin: {
          originType: "session",
          creatorSessionId: channelRequest.requestingSessionId,
          creationContextTaskId: request.sourceContext?.taskId ?? null,
          operationId: `channel-request:${channelRequest.requestId}`
        }, creationPending: true
      });
    }
    if (task.work_id !== targetWorkId || task.main_agent_id !== agent.agentId) {
      throw coded("CHANNEL_TARGET_RESOURCE_MISMATCH", "The prepared Task does not match the target Work and Agent resource.", 409);
    }
    let session = task.current_session_id ? this.#resolveSession(task.current_session_id) : null;
    let eligibility = session ? collaborationSessionEligibility(this.store, session) : null;
    if (!eligibility?.active) {
      const launched = await this.workSessionStartApplicationService.start({
        taskId: task.id,
        assigneeAgentId: agent.agentId,
        expectedTaskVersion: Number(task.resource_version ?? 1),
        providerId: this.store.settings?.().newSessionDefaults?.taskCreation?.providerId ?? this.defaultProviderId,
        title: optional(request.title),
        idempotencyKey: `channel-request:${channelRequest.requestId}:start`,
        sourceSessionId: channelRequest.requestingSessionId
      });
      session = this.#resolveSession(launched?.session?.id ?? this.store.getTask(task.id)?.current_session_id);
      eligibility = collaborationSessionEligibility(this.store, session);
    }
    if (!eligibility?.active) {
      throw coded("CREATED_SESSION_NOT_ACTIVE", `The target Worker Session was not created successfully: ${eligibility?.reasons.join(", ") || "unresolved"}.`, 503);
    }
    this.store.setTaskCreationState(task.id, "ready");
    return {
      recipientSessionId: eligibility.logicalSessionId,
      taskId: task.id,
      created: true
    };
  }

  async prepareTaskConfirmationTarget(confirmation) {
    if (!confirmation?.confirmationId || confirmation.status !== "pending") {
      throw coded("COLLABORATION_CONFIRMATION_REQUIRED", "A pending collaboration confirmation is required before preparing its target Session.");
    }
    const request = confirmation.request ?? {};
    if (confirmation.recipientSessionId) {
      const target = collaborationTargetEligibility(this.store, {
        taskId: request.targetTaskId ?? confirmation.recipientTaskId,
        targetWorkId: request.targetWorkId ?? confirmation.targetWorkId,
        recipientAgentId: request.sessionAgentId
          ?? request.recipientAgentId
          ?? confirmation.recipientAgentId
      }, confirmation.recipientSessionId);
      if (!target.active) {
        throw coded("RECIPIENT_SESSION_UNAVAILABLE", `The selected target Session is unavailable: ${target.reasons.join(", ")}.`, 409);
      }
      const owner = this.collaborationCore.getAgentForSession(target.providerSessionId);
      return {
        recipientSessionId: target.logicalSessionId,
        recipientAgentId: owner?.agentId ?? request.recipientAgentId,
        targetTaskId: target.session.taskId,
        recipientNameAtSend: target.logical?.sessionName ?? target.session.title,
        created: false
      };
    }

    const targetWorkId = required(request.targetWorkId, "target_work_id");
    const agentResourceId = required(request.sessionAgentId ?? request.recipientAgentId, "session_agent_id");
    const agent = this.#requireContributor(targetWorkId, agentResourceId);
    const work = this.workService.getWork(targetWorkId);
    const taskId = request.targetTaskId ?? `task:collaboration:${confirmation.confirmationId}`;
    let task = this.store.getTask(taskId);
    if (!task) {
      task = this.workService.createTask({
        id: taskId,
        workId: targetWorkId,
        title: required(request.title, "title"),

        priority: "medium",
        lifecycleState: "todo",
        mainAgentId: agent.agentId
      }, {
        creationOrigin: {
          originType: "session",
          creatorSessionId: confirmation.initiatorSessionId,
          creationContextTaskId: request.sourceTaskId ?? null,
          operationId: `collaboration-confirmation:${confirmation.confirmationId}`
        }, creationPending: true
      });
      this.store.db.run(
        `UPDATE tasks SET created_by_session_id=?, idempotency_key=?, resource_version=1 WHERE id=?`,
        [confirmation.initiatorSessionId,
          `collaboration-confirmation:${confirmation.confirmationId}`, task.id]
      );
    }
    if (task.work_id !== targetWorkId || task.main_agent_id !== agent.agentId) {
      throw coded("COLLABORATION_TARGET_RESOURCE_MISMATCH", "The prepared Task does not match the target Work and Agent resource.", 409);
    }
    const targetContext = {
      taskId: task.id,
      targetWorkId,
      recipientAgentId: agent.agentId
    };
    const existing = task.current_session_id
      ? collaborationTargetEligibility(this.store, targetContext, task.current_session_id)
      : null;
    let target = existing?.active ? existing : null;
    if (!target) {
      const launched = await this.workSessionStartApplicationService.start({
        taskId: task.id,
        assigneeAgentId: agent.agentId,
        expectedTaskVersion: Number(task.resource_version ?? 1),
        providerId: this.store.settings?.().newSessionDefaults?.taskCreation?.providerId ?? this.defaultProviderId,
        title: request.title,
        idempotencyKey: `collaboration-confirmation:${confirmation.confirmationId}:start`,
        sourceSessionId: confirmation.initiatorSessionId
      });
      target = collaborationTargetEligibility(this.store, targetContext, launched?.session?.id);
    }
    if (!target?.active) {
      throw coded("CREATED_SESSION_NOT_ACTIVE", `The target Worker Session was not created successfully: ${target?.reasons.join(", ") || "unresolved"}.`, 503);
    }
    this.store.setTaskCreationState(task.id, "ready");
    return {
      recipientSessionId: target.logicalSessionId,
      recipientAgentId: agent.agentId,
      targetTaskId: task.id,
      recipientNameAtSend: target.logical?.sessionName ?? target.session.title,
      created: true
    };
  }

  async ensureTaskRecipientSession(task, options = {}) {
    if (!task?.taskId) throw coded("COLLABORATION_TASK_REQUIRED", "A collaboration Task is required for recipient routing.");
    if (!task.targetTaskId) {
      throw coded("COLLABORATION_TARGET_TASK_REQUIRED", `Collaboration request ${task.taskId} has no target Task.`);
    }
    if (!task.targetWorkId) {
      throw coded("COLLABORATION_TARGET_WORK_REQUIRED", `Collaboration Task ${task.taskId} has no target Work.`);
    }
    if (!task.recipientAgentId) {
      throw coded("COLLABORATION_RECIPIENT_AGENT_REQUIRED", `Collaboration Task ${task.taskId} has no recipient Agent.`);
    }
    const targetTask = this.store.getTask(task.targetTaskId);
    if (!targetTask) {
      throw coded("COLLABORATION_TARGET_TASK_NOT_FOUND", `Target Task ${task.targetTaskId} was not found.`);
    }
    if (targetTask.work_id !== task.targetWorkId) {
      throw coded(
        "COLLABORATION_TARGET_TASK_WORK_MISMATCH",
        `Target Task ${task.targetTaskId} belongs to ${targetTask.work_id}, not target Work ${task.targetWorkId}.`
      );
    }
    if (targetTask.main_agent_id && targetTask.main_agent_id !== task.recipientAgentId) {
      throw coded(
        "COLLABORATION_TARGET_TASK_AGENT_MISMATCH",
        `Target Task ${task.targetTaskId} is assigned to ${targetTask.main_agent_id}, not recipient Agent ${task.recipientAgentId}.`
      );
    }
    const current = collaborationTargetEligibility(this.store, task, task.recipientSessionId);
    if (current.active) {
      if (["confirmation_approved", "initial_selection"].includes(options.reason)) {
        this.onRoutingEvent("session_reused", {
          taskId: task.taskId,
          sessionId: current.logicalSessionId,
          reason: options.reason
        });
      }
      return { task, sessionId: current.logicalSessionId, providerSessionId: current.providerSessionId, created: false };
    }
    if (task.protocolVersion === "3.0") {
      throw coded(
        "RECIPIENT_SESSION_UNAVAILABLE",
        `The immutable target Session for task ${task.taskId} is unavailable: ${current.reasons.join(", ") || "unresolved"}. Recover that logical Session before retrying delivery.`,
        409
      );
    }

    const sessions = this.store.listSessionsByWork(task.targetWorkId)
      .filter((session) => (session.agentId ?? this.collaborationCore.getAgentForSession(session.id)?.agentId) === task.recipientAgentId);
    const evaluated = sessions.map((session) => ({
      session,
      eligibility: collaborationTargetEligibility(this.store, task, session)
    }));
    this.onRoutingEvent("candidates_filtered", {
      taskId: task.taskId,
      recipientAgentId: task.recipientAgentId,
      targetWorkId: task.targetWorkId,
      candidates: evaluated.map(({ session, eligibility }) => ({
        sessionId: eligibility.logicalSessionId ?? session.id,
        sessionKind: session.sessionKind,
        taskId: session.taskId ?? null,
        active: eligibility.active,
        rejectionReasons: eligibility.reasons
      }))
    });
    const active = evaluated.filter((item) => item.eligibility.active);
    const replacement = active[0] ?? null;
    if (replacement) {
      const rerouted = this.collaborationCore.rerouteTaskRecipient(task.taskId, replacement.eligibility.logicalSessionId, {
        reason: options.reason ?? "selected_route_became_inactive",
        previousRejectionReasons: current.reasons
      });
      this.onRoutingEvent("session_reselected", {
        taskId: task.taskId,
        previousSessionId: task.recipientSessionId,
        sessionId: replacement.eligibility.logicalSessionId
      });
      return {
        task: rerouted,
        sessionId: replacement.eligibility.logicalSessionId,
        providerSessionId: replacement.eligibility.providerSessionId,
        created: false
      };
    }

    const productTask = targetTask;
    const agent = this.store.getAgent(task.recipientAgentId);
    if (!agent) throw coded("AGENT_NOT_FOUND", `Agent not found: ${task.recipientAgentId}`);
    this.onRoutingEvent("task_session_creation_started", {
      taskId: task.taskId,
      taskId: productTask.id,
      recipientAgentId: agent.agentId,
      previousSessionId: task.recipientSessionId,
      previousRejectionReasons: current.reasons
    });
    let launched;
    try {
      launched = await this.workSessionStartApplicationService.start({
        taskId: productTask.id,
        assigneeAgentId: agent.agentId,
        expectedTaskVersion: Number(productTask.resource_version ?? 1),
        providerId: this.store.settings?.().newSessionDefaults?.taskCreation?.providerId ?? this.defaultProviderId,
        title: productTask.title,
        idempotencyKey: `collaboration-delivery:${task.taskId}:start`,
        sourceSessionId: task.initiatorSessionId ?? task.sourceSessionId
      });
    } catch (error) {
      this.onRoutingEvent("task_session_creation_failed", {
        taskId: task.taskId,
        taskId: productTask.id,
        code: error.code ?? "SESSION_CREATION_FAILED",
        error: error.message
      });
      throw error;
    }
    const created = collaborationTargetEligibility(this.store, task, launched?.session?.id);
    if (!created.active) {
      throw coded(
        "CREATED_SESSION_NOT_ACTIVE",
        `Created Session is not an active collaboration target: ${created.reasons.join(", ") || "unresolved"}.`,
        503
      );
    }
    const rerouted = this.collaborationCore.rerouteTaskRecipient(task.taskId, created.logicalSessionId, {
      reason: options.reason ?? "no_suitable_active_session",
      createdTaskSession: true,
      previousRejectionReasons: current.reasons
    });
    this.onRoutingEvent("task_session_created", {
      taskId: task.taskId,
      taskId: productTask.id,
      sessionId: created.logicalSessionId,
      providerSessionId: created.providerSessionId
    });
    return {
      task: rerouted,
      sessionId: created.logicalSessionId,
      providerSessionId: created.providerSessionId,
      created: true
    };
  }

  #resolveSession(sessionId) {
    if (!sessionId) return null;
    const logical = this.store.getLogicalSession(sessionId);
    return logical?.legacySessionId ? this.store.getSession(logical.legacySessionId) : this.store.getSession(sessionId);
  }

  #canReadTask(scope, item, includeHierarchy = true) {
    if (!scope.session.workId || item.work_id !== scope.session.workId) return false;
    if (scope.session.sessionKind === "workChat") return true;
    if (scope.session.sessionKind !== "worker") return false;
    if (item.id === scope.session.taskId) return true;
    const bound = this.store.getTask(scope.session.taskId);
    if (includeHierarchy && (item.parent_task_id === bound?.id || bound?.parent_task_id === item.id)) return true;
    if (item.created_by_session_id === scope.logicalSessionId) return true;
    return this.store.listTaskDependencies(item.id).some((edge) => edge.target_task_id === scope.session.taskId)
      || this.store.listTaskDependents(item.id).some((edge) => edge.task_id === scope.session.taskId);
  }

  #requireContributor(workId, agentId) {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw coded("AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    const work = this.workService.getWork(workId);
    if (!(work.contributorAgentIds ?? []).includes(agentId)) {
      throw coded("AGENT_OUTSIDE_WORK", "Target Agent must be attached to the authenticated Work.");
    }
    return agent;
  }

  #requireWorkspace(workId, workspaceId) {
    const work = this.workService.getWork(workId);
    if (this.store.getGitRepositoryForWorkspace(work.workspaceId)?.id !== workspaceId) {
      throw coded("WORKSPACE_OUTSIDE_WORK", "Workspace must be a registered repository: ID attached to the authenticated Work.");
    }
  }

  #relate(taskId, targetTaskId, relationship) {
    if (relationship === "blocks") return this.workService.addDependency(targetTaskId, taskId, relationship);
    return this.workService.addDependency(taskId, targetTaskId, relationship);
  }

  #startReceipt(item, session, executionStatus, idempotentReplay, idempotencyKey = null) {
    const logical = session ? this.store.getLogicalSession(session.logicalSessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(session.id) : null;
    const agent = item.main_agent_id ? this.store.getAgent(item.main_agent_id) : null;
    return {
      phase: executionStatus === "running" ? "started" : "created",
      task: item,
      session: session ? this.#sessionDescriptor(session, {
        session: { workId: item.work_id }, agent: agent ?? { agentId: session.agentId }
      }) : null,
      agent: agent ? { agentId: agent.agentId, name: agent.name } : null,
      providerBinding: logical?.activeBinding ?? null,
      logicalWorktree: logical ? { repositoryId: logical.repositoryId, worktreeId: logical.activeWorkspaceId } : null,
      executionStatus,
      resourceVersion: String(item.resource_version ?? 1),
      idempotencyKey,
      idempotentReplay
    };
  }
}

export function resolveRecipientSession(service, metadata, actorId, input = {}) {
  if (input.recipientSessionId) {
    let explicit;
    try {
      explicit = service.getSession(metadata, actorId, input.recipientSessionId);
    } catch (error) {
      if (error.code === "RECIPIENT_SESSION_UNAVAILABLE"
        && optional(input.targetWorkId)
        && optional(input.sessionAgentId)) {
        return null;
      }
      throw error;
    }
    return explicit.active
      && explicit.sessionKind === "worker"
      && (!input.taskId || explicit.taskId === input.taskId)
      ? explicit
      : null;
  }
  const intent = optional(input.routingIntent);
  if (!intent) {
    throw coded("ROUTING_INTENT_REQUIRED", "When only an Agent is specified, routing_intent must be existing_task_session, create_dedicated_session, or best_available. Work Chat is not a collaboration delivery target.");
  }
  if (!ROUTING_INTENTS.has(intent)) {
    throw coded("INVALID_ROUTING_INTENT", `Unsupported collaboration routing intent: ${intent}. Work Chat is not a collaboration delivery target.`);
  }
  const candidates = service.discoverSessions(metadata, actorId, {
    agentId: input.recipientAgentId,
    workId: input.targetWorkId
  });
  if (intent === "create_dedicated_session" || !input.taskId) return null;
  return candidates.find((item) => item.active
    && item.sessionKind === "worker"
    && item.taskId === input.taskId) ?? null;
}

export function collaborationSessionEligibility(store, sessionOrId) {
  const logical = typeof sessionOrId === "string"
    ? (store.getLogicalSession(sessionOrId) ?? store.getLogicalSessionByLegacySessionId(sessionOrId))
    : (store.getLogicalSession(sessionOrId?.logicalSessionId) ?? store.getLogicalSessionByLegacySessionId(sessionOrId?.id));
  const session = typeof sessionOrId === "string"
    ? (logical?.legacySessionId ? store.getSession(logical.legacySessionId) : store.getSession(sessionOrId))
    : sessionOrId;
  const reasons = [];
  if (!session) reasons.push("session_missing");
  if (!logical) reasons.push("logical_route_missing");
  if (session?.archived || logical?.archived) reasons.push("session_archived");
  if (!logical?.activeBinding) reasons.push("active_binding_missing");
  else if (logical.activeBinding.state !== "active") reasons.push(`binding_${logical.activeBinding.state}`);
  const interrupted = ["cancelled", "canceled"].includes(session?.status);
  if (session?.status === "failed") reasons.push("session_failed");
  if (!interrupted && (
    session?.capabilities?.canSend === false
    || session?.rawStatus?.capabilities?.canSend === false
  )) {
    reasons.push("send_capability_unavailable");
  }
  return {
    active: reasons.length === 0,
    reasons,
    session,
    logical,
    logicalSessionId: logical?.logicalSessionId ?? session?.logicalSessionId ?? null,
    providerSessionId: logical?.legacySessionId ?? session?.id ?? null
  };
}

function collaborationTargetEligibility(store, collaborationTask, sessionOrId) {
  const eligibility = collaborationSessionEligibility(store, sessionOrId);
  const reasons = [...eligibility.reasons];
  if (eligibility.session && eligibility.session.sessionKind !== "worker") reasons.push("session_not_worker");
  if (eligibility.session?.sessionKind === "worker" && eligibility.session.taskId !== collaborationTask.taskId) {
    reasons.push("task_mismatch");
  }
  const productTask = collaborationTask?.taskId ? store.getTask(collaborationTask.taskId) : null;
  if (!collaborationTask?.taskId) reasons.push("task_missing");
  else if (!productTask) reasons.push("task_not_found");
  if (productTask && eligibility.session?.sessionKind === "worker") {
    if (productTask.work_id !== collaborationTask.targetWorkId) reasons.push("task_work_mismatch");
    if (productTask.main_agent_id && productTask.main_agent_id !== collaborationTask.recipientAgentId) {
      reasons.push("task_agent_mismatch");
    }
    if (productTask.current_session_id !== eligibility.session.id) reasons.push("task_session_superseded");
  }
  return { ...eligibility, active: reasons.length === 0, reasons };
}

function uniqueSessions(sessions) {
  return [...new Map(sessions.map((session) => [session.id, session])).values()];
}

function required(value, field) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw coded("INVALID_INPUT", `${field} is required.`);
  return result;
}
function optional(value) { const result = typeof value === "string" ? value.trim() : ""; return result || null; }
function artifactRelation(value) {
  const relation = required(value, "reference.relation");
  if (!ARTIFACT_RELATIONS.has(relation)) {
    throw coded("INVALID_REFERENCE_RELATION", `Unsupported Task reference relation: ${relation}.`);
  }
  return relation;
}
function fingerprintCreationReference(input) {
  if (input.artifactReference == null && input.fileReference == null) return null;
  let normalized;
  if (input.artifactReference != null) {
    const value = input.artifactReference;
    assertKnown(value, ["artifactId", "relation", "required", "versionPolicy", "version"]);
    const artifactId = required(value.artifactId, "artifact_reference.artifact_id");
    const relation = artifactRelation(value.relation ?? "implementation_spec");
    const versionPolicy = value.versionPolicy ?? "fixed";
    if (!ARTIFACT_VERSION_POLICIES.has(versionPolicy)) {
      throw coded("ARTIFACT_VERSION_POLICY_INVALID", `Unsupported Artifact version policy: ${versionPolicy}.`);
    }
    if (value.required != null && typeof value.required !== "boolean") {
      throw coded("ARTIFACT_INVALID_INPUT", "artifact_reference.required must be a boolean.");
    }
    if (value.version != null && (!Number.isSafeInteger(value.version) || value.version < 1)) {
      throw coded("ARTIFACT_INVALID_INPUT", "artifact_reference.version must be a positive integer.");
    }
    normalized = {
      type: "artifact", artifactId, relation, required: value.required === true,
      versionPolicy, version: value.version ?? null
    };
  } else {
    const value = input.fileReference;
    assertKnown(value, ["path", "relation", "required"]);
    const path = required(value.path, "file_reference.path");
    if (!isAbsolute(path)) throw coded("INVALID_FILE_REFERENCE", "Task file references require an absolute path.");
    if (value.required != null && typeof value.required !== "boolean") {
      throw coded("INVALID_FILE_REFERENCE", "file_reference.required must be a boolean.");
    }
    normalized = {
      type: "file", requestedPath: resolve(path),
      relation: artifactRelation(value.relation ?? "implementation_spec"),
      required: value.required === true
    };
  }
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
function assertKnown(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw coded("INVALID_INPUT", "Tool input must be an object.");
  const allowed = new Set(fields);
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) throw coded("UNKNOWN_FIELD", `Unknown collaboration Task field: ${unknown}.`);
}
function assertStartKnown(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw coded("UNKNOWN_START_FIELD", "Work Session start input must be an object.");
  }
  const allowed = new Set([
    "taskId", "assigneeAgentId", "providerId", "title", "expectedTaskVersion",
    "idempotencyKey", "sourceSessionId"
  ]);
  const unknown = Object.keys(input).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw coded("UNKNOWN_START_FIELD", `Unknown Work Session start field: ${unknown.sort().join(", ")}.`);
  }
}
function coded(code, message, statusCode = 400) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
