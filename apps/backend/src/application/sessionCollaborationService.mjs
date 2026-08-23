import {
  COLLABORATION_RELATION_TYPES,
  COLLABORATION_ROUTING_INTENTS,
  WORK_ITEM_PRIORITIES
} from "../domain/workItemToolSchema.mjs";

const RELATIONS = new Set(COLLABORATION_RELATION_TYPES);
const ROUTING_INTENTS = new Set(COLLABORATION_ROUTING_INTENTS);

export class SessionCollaborationService {
  constructor(options = {}) {
    this.store = options.store;
    this.objectiveService = options.objectiveService;
    this.collaborationCore = options.collaborationCore;
    this.launchWorkItem = options.startWorkItem;
    if (!this.store || !this.objectiveService || !this.collaborationCore || typeof this.launchWorkItem !== "function") {
      throw new TypeError("SessionCollaborationService requires store, objectiveService, collaborationCore, and startWorkItem().");
    }
  }

  capabilities(metadata = {}, actorId = null) {
    const scope = this.#scope(metadata, actorId, { mutation: false });
    const canCreate = scope.session.sessionKind === "objectiveChat"
      || (scope.session.sessionKind === "worker" && Boolean(scope.session.workItemId));
    return {
      actorAgentId: scope.agent.agentId,
      sourceSessionId: scope.logicalSessionId,
      sessionKind: scope.session.sessionKind,
      objectiveId: scope.session.objectiveId,
      workItemId: scope.session.workItemId,
      actions: ["sessions.discover", "sessions.get", "work_items.list", "work_items.get", "work_items.result", ...(canCreate
        ? ["work_items.create", "work_items.relate", "work_items.start", "work_items.cancel"]
        : [])],
      destructiveActions: [],
      arbitraryUpdate: false
    };
  }

  discoverSessions(metadata, actorId, filters = {}) {
    const scope = this.#scope(metadata, actorId, { mutation: false });
    const visible = this.#visibleSessions(scope, filters);
    return visible
      .filter((session) => !filters.agentId || session.agentId === filters.agentId)
      .filter((session) => !filters.objectiveId || session.objectiveId === filters.objectiveId)
      .filter((session) => !filters.workItemId || session.workItemId === filters.workItemId)
      .filter((session) => !filters.sessionKind || session.sessionKind === filters.sessionKind)
      .map((session) => this.#sessionDescriptor(session, scope));
  }

  getSession(metadata, actorId, sessionId) {
    const scope = this.#scope(metadata, actorId, { mutation: false });
    const target = this.#resolveSession(sessionId);
    if (!target || !this.#isVisibleSession(scope, target, { explicitPeerLookup: true })) {
      throw coded("SESSION_NOT_VISIBLE", "The target Session is outside the authenticated Objective/Agent scope.");
    }
    return this.#sessionDescriptor(target, scope);
  }

  listWorkItems(metadata, actorId) {
    const scope = this.#scope(metadata, actorId, { mutation: false });
    if (!scope.session.objectiveId) return [];
    return this.objectiveService.listWorkItemsByObjective(scope.session.objectiveId)
      .filter((item) => this.#canReadWorkItem(scope, item));
  }

  getWorkItem(metadata, actorId, workItemId) {
    const scope = this.#scope(metadata, actorId, { mutation: false });
    const item = this.objectiveService.getWorkItem(required(workItemId, "work_item_id"));
    if (!this.#canReadWorkItem(scope, item)) throw coded("WORK_ITEM_OUTSIDE_SCOPE", "WorkItem is outside the authenticated Session scope.");
    return item;
  }

  createWorkItem(metadata, actorId, input = {}) {
    assertKnown(input, ["title", "description", "acceptanceCriteria", "priority", "agentId", "mainWorkspaceId",
      "parentWorkItemId", "sourceWorkItemId", "relationship", "idempotencyKey"]);
    const scope = this.#scope(metadata, actorId, { mutation: true });
    const kind = scope.session.sessionKind;
    if (!scope.session.objectiveId || !["objectiveChat", "worker"].includes(kind)) {
      throw coded("COLLABORATION_CREATE_FORBIDDEN", "A bound Objective Chat or Worker Session is required to create a collaboration WorkItem.");
    }
    const relationship = optional(input.relationship);
    const sourceWorkItemId = optional(input.sourceWorkItemId) ?? scope.session.workItemId;
    if (kind === "worker" && (!sourceWorkItemId || !RELATIONS.has(relationship))) {
      throw coded("WORKER_RELATION_REQUIRED", "Worker Sessions must create a WorkItem with delegated_subtask, depends_on, blocks, or review_of relation to their current WorkItem.");
    }
    if (relationship && !RELATIONS.has(relationship)) throw coded("INVALID_RELATION", `Unsupported WorkItem relation: ${relationship}`);
    if (sourceWorkItemId) {
      const source = this.objectiveService.getWorkItem(sourceWorkItemId);
      if (source.objective_id !== scope.session.objectiveId) throw coded("CROSS_OBJECTIVE_FORBIDDEN", "Source WorkItem must belong to the authenticated Objective.");
      if (kind === "worker" && source.id !== scope.session.workItemId) {
        throw coded("SOURCE_WORK_ITEM_FORBIDDEN", "A Worker Session may only delegate from its bound WorkItem.");
      }
    }
    const parentWorkItemId = optional(input.parentWorkItemId);
    if (parentWorkItemId) {
      const parent = this.objectiveService.getWorkItem(parentWorkItemId);
      if (parent.objective_id !== scope.session.objectiveId) throw coded("CROSS_OBJECTIVE_FORBIDDEN", "Parent WorkItem must belong to the authenticated Objective.");
    }
    const targetAgentId = optional(input.agentId);
    if (targetAgentId) this.#requireContributor(scope.session.objectiveId, targetAgentId);
    const workspaceId = optional(input.mainWorkspaceId);
    if (workspaceId) this.#requireWorkspace(scope.session.objectiveId, workspaceId);
    const idempotencyKey = required(input.idempotencyKey, "idempotency_key");
    const prior = this.store.selectOne(
      "SELECT * FROM work_items WHERE created_by_session_id = ? AND idempotency_key = ?",
      [scope.logicalSessionId, idempotencyKey]
    );
    if (prior) {
      if (prior.title !== required(input.title, "title") || prior.objective_id !== scope.session.objectiveId) {
        throw coded("IDEMPOTENCY_CONFLICT", "The idempotency key is already associated with different WorkItem input.", 409);
      }
      return { workItem: prior, idempotentReplay: true, phase: "created" };
    }
    const priority = optional(input.priority) ?? "medium";
    if (!WORK_ITEM_PRIORITIES.includes(priority)) throw coded("INVALID_PRIORITY", `Unsupported WorkItem priority: ${priority}`);
    let item;
    this.store.runInTransaction(() => {
      item = this.objectiveService.createWorkItem({
        objectiveId: scope.session.objectiveId,
        title: required(input.title, "title"),
        description: input.description ?? "",
        acceptanceCriteria: input.acceptanceCriteria ?? "",
        priority,
        status: "todo",
        mainWorkspaceId: workspaceId,
        mainAgentId: targetAgentId
      });
      this.store.db.run(
        `UPDATE work_items SET created_by_session_id=?, source_work_item_id=?, parent_work_item_id=?,
         collaboration_relation=?, idempotency_key=?, resource_version=1 WHERE id=?`,
        [scope.logicalSessionId, sourceWorkItemId, parentWorkItemId, relationship, idempotencyKey, item.id]
      );
      if (sourceWorkItemId && relationship) this.#relate(item.id, sourceWorkItemId, relationship);
    });
    this.store.scheduleSave();
    return { workItem: this.store.getWorkItem(item.id), idempotentReplay: false, phase: "created" };
  }

  relateWorkItems(metadata, actorId, input = {}) {
    assertKnown(input, ["workItemId", "targetWorkItemId", "relationship"]);
    const scope = this.#scope(metadata, actorId, { mutation: true });
    const item = this.getWorkItem(metadata, actorId, input.workItemId);
    const target = this.getWorkItem(metadata, actorId, input.targetWorkItemId);
    const relationship = required(input.relationship, "relationship");
    if (!RELATIONS.has(relationship)) throw coded("INVALID_RELATION", `Unsupported WorkItem relation: ${relationship}`);
    if (scope.session.sessionKind === "worker" && ![item.id, target.id].includes(scope.session.workItemId)) {
      throw coded("WORKER_RELATION_REQUIRED", "Worker Session relationships must include its bound WorkItem.");
    }
    return this.#relate(item.id, target.id, relationship);
  }

  async startWorkItem(metadata, actorId, input = {}) {
    assertKnown(input, ["workItemId", "agentId", "title", "resourceVersion", "idempotencyKey"]);
    const scope = this.#scope(metadata, actorId, { mutation: true });
    const item = this.getWorkItem(metadata, actorId, input.workItemId);
    const expectedVersion = required(input.resourceVersion, "resource_version");
    const actualVersion = String(item.resource_version ?? 1);
    if (expectedVersion !== actualVersion) throw coded("RESOURCE_VERSION_CONFLICT", `Expected WorkItem version ${expectedVersion}, current version is ${actualVersion}.`, 409);
    const idempotencyKey = required(input.idempotencyKey, "idempotency_key");
    if (item.current_session_id) return this.#startReceipt(item, this.store.getSession(item.current_session_id), "already_running", true);
    if (item.execution_status === "starting") {
      if (item.start_idempotency_key !== idempotencyKey) {
        throw coded("START_IN_PROGRESS", "Another start operation is already in progress for this WorkItem.", 409);
      }
      return this.#startReceipt(item, null, "starting", true, idempotencyKey);
    }
    const agentId = optional(input.agentId) ?? item.main_agent_id;
    const agent = this.#requireContributor(scope.session.objectiveId, required(agentId, "agent_id"));
    let transactionOpen = true;
    this.store.db.run("BEGIN IMMEDIATE");
    try {
      const current = this.store.getWorkItem(item.id);
      if (current.current_session_id || current.execution_status === "starting") {
        this.store.db.run("ROLLBACK");
        transactionOpen = false;
        if (current.start_idempotency_key === idempotencyKey) {
          return this.#startReceipt(current, current.current_session_id ? this.store.getSession(current.current_session_id) : null,
            current.current_session_id ? "already_running" : "starting", true, idempotencyKey);
        }
        throw coded("START_IN_PROGRESS", "Another start operation won the concurrency race.", 409);
      }
      this.store.db.run(
        "UPDATE work_items SET execution_status='starting', start_idempotency_key=?, start_error=NULL, updated_at=? WHERE id=?",
        [idempotencyKey, new Date().toISOString(), item.id]
      );
      this.store.db.run("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) this.store.db.run("ROLLBACK");
      throw error;
    }
    try {
      const launched = await this.launchWorkItem({ workItem: item, agent, title: optional(input.title) });
      const session = this.#resolveSession(launched?.id ?? launched?.sessionId ?? this.store.getWorkItem(item.id)?.current_session_id);
      if (!session) throw coded("START_SESSION_UNRESOLVED", "Provider accepted the launch but no Corptie Session binding was persisted.");
      this.store.db.run("UPDATE work_items SET resource_version=resource_version+1, execution_status='running' WHERE id=?", [item.id]);
      this.store.scheduleSave();
      return this.#startReceipt(this.store.getWorkItem(item.id), session, "running", false, idempotencyKey);
    } catch (error) {
      this.store.db.run(
        "UPDATE work_items SET execution_status='start_failed', start_error=?, updated_at=? WHERE id=?",
        [error.message, new Date().toISOString(), item.id]
      );
      this.store.scheduleSave();
      error.receipt = { phase: "created", workItemId: item.id, executionStatus: "start_failed", idempotencyKey };
      throw error;
    }
  }

  cancelWorkItem(metadata, actorId, input = {}) {
    assertKnown(input, ["workItemId", "reason", "resourceVersion"]);
    const scope = this.#scope(metadata, actorId, { mutation: true });
    const item = this.getWorkItem(metadata, actorId, input.workItemId);
    const expectedVersion = required(input.resourceVersion, "resource_version");
    if (expectedVersion !== String(item.resource_version ?? 1)) {
      throw coded("RESOURCE_VERSION_CONFLICT", "WorkItem changed before cancellation; refresh and retry.", 409);
    }
    if (scope.session.sessionKind === "worker" && item.created_by_session_id !== scope.logicalSessionId) {
      throw coded("CANCEL_FORBIDDEN", "Worker Sessions may only cancel collaboration WorkItems they created.");
    }
    const timestamp = new Date().toISOString();
    const reason = required(input.reason, "reason");
    this.store.db.run(
      "UPDATE work_items SET status='canceled', canceled_at=?, cancel_reason=?, resource_version=resource_version+1, updated_at=? WHERE id=?",
      [timestamp, reason, timestamp, item.id]
    );
    this.store.scheduleSave();
    return { workItem: this.store.getWorkItem(item.id), canceled: true, physicallyDeleted: false, auditPreserved: true };
  }

  #scope(metadata, actorId, options = {}) {
    const sourceId = required(metadata?.sessionId, "source session metadata");
    const session = this.#resolveSession(sourceId);
    if (!session) throw coded("SOURCE_SESSION_NOT_FOUND", "Authenticated source Session was not found.");
    const bound = this.collaborationCore.getAgentForSession(session.id);
    if (!bound || bound.agentId !== actorId) throw coded("SOURCE_SESSION_ACTOR_MISMATCH", "Authenticated Agent does not own the source Session.");
    const logical = this.store.getLogicalSession(sourceId) ?? this.store.getLogicalSessionByLegacySessionId(session.id);
    if (options.mutation && logical && logical.activeBinding?.state !== "active") {
      throw coded("STALE_SESSION_ROUTE", "The source Session route is superseded; recover the active Session before mutating collaboration state.", 409);
    }
    return { agent: bound, session, logical, logicalSessionId: logical?.logicalSessionId ?? session.logicalSessionId ?? session.id };
  }

  #visibleSessions(scope, filters = {}) {
    if (scope.session.objectiveId) {
      const own = this.store.listSessionsByObjective(scope.session.objectiveId)
        .filter((session) => this.#isVisibleSession(scope, session));
      if (!filters.agentId && !filters.objectiveId) return own;
      const peerCandidates = filters.objectiveId
        ? this.store.listSessionsByObjective(filters.objectiveId)
        : this.store.listSessionsByAgent(filters.agentId);
      const peer = peerCandidates
        .filter((session) => session.objectiveId !== scope.session.objectiveId)
        .filter((session) => !filters.agentId || session.agentId === filters.agentId)
        .filter((session) => !filters.objectiveId || session.objectiveId === filters.objectiveId)
        .filter((session) => this.#isVisibleSession(scope, session, { explicitPeerLookup: true }));
      return uniqueSessions([...own, ...peer]);
    }
    return this.store.listSessionsByAgent(scope.agent.agentId);
  }

  #isVisibleSession(scope, session, options = {}) {
    const agentId = session.agentId ?? this.collaborationCore.getAgentForSession(session.id)?.agentId;
    if (!agentId) return false;
    if (scope.session.objectiveId && session.objectiveId === scope.session.objectiveId) {
      const objective = this.objectiveService.getObjective(scope.session.objectiveId);
      return agentId === scope.agent.agentId || (objective.contributorAgentIds ?? []).includes(agentId);
    }
    if (!scope.session.objectiveId) return agentId === scope.agent.agentId;
    if (!options.explicitPeerLookup || !session.objectiveId || session.archived) return false;
    const objective = this.store.getObjective(session.objectiveId);
    if (!objective) return false;
    const assignedWorkItem = session.workItemId ? this.store.getWorkItem(session.workItemId) : null;
    const agentAuthorized = (objective.contributorAgentIds ?? []).includes(agentId)
      || assignedWorkItem?.main_agent_id === agentId;
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
    const sameObjective = Boolean(scope.session.objectiveId && session.objectiveId === scope.session.objectiveId);
    const peerObjective = Boolean(scope.session.objectiveId && session.objectiveId && !sameObjective);
    return {
      sessionId: logical?.logicalSessionId ?? session.logicalSessionId ?? session.id,
      providerSessionId: peerObjective ? null : session.id,
      agentId,
      sessionKind: session.sessionKind,
      objectiveId: session.objectiveId,
      workItemId: session.workItemId,
      lifecycle: session.archived ? "archived" : session.status,
      routeStatus: binding?.state ?? (logical ? "unresolved" : "legacy_unresolved"),
      active: binding?.state === "active",
      superseded: binding?.state === "superseded",
      routingVersion: peerObjective ? null : logical?.routingVersion ?? null,
      bindingId: peerObjective ? null : binding?.bindingId ?? null,
      providerId: peerObjective ? null : binding?.providerId ?? session.external?.provider ?? null,
      visibilityScope: peerObjective ? "peer_objective" : "current_scope",
      workspace: peerObjective ? { repositoryId: null, worktreeId: null, path: null } : {
        repositoryId: logical?.repositoryId ?? null,
        worktreeId: logical?.activeWorkspaceId ?? null,
        path: binding?.boundCwd ?? session.external?.cwd ?? null
      },
      collaborationCapabilities: sameObjective || (!scope.session.objectiveId && agentId === scope.agent.agentId)
        ? ["receive_task", "receive_message", "deliver_artifact"]
        : peerObjective ? ["receive_task"] : []
    };
  }

  #resolveSession(sessionId) {
    if (!sessionId) return null;
    const logical = this.store.getLogicalSession(sessionId);
    return logical?.legacySessionId ? this.store.getSession(logical.legacySessionId) : this.store.getSession(sessionId);
  }

  #canReadWorkItem(scope, item) {
    if (!scope.session.objectiveId || item.objective_id !== scope.session.objectiveId) return false;
    if (scope.session.sessionKind === "objectiveChat") return true;
    if (scope.session.sessionKind !== "worker") return false;
    if (item.id === scope.session.workItemId) return true;
    return item.source_work_item_id === scope.session.workItemId
      || item.parent_work_item_id === scope.session.workItemId
      || this.store.listWorkItemDependencies(item.id).some((edge) => edge.target_work_item_id === scope.session.workItemId)
      || this.store.listWorkItemDependents(item.id).some((edge) => edge.work_item_id === scope.session.workItemId);
  }

  #requireContributor(objectiveId, agentId) {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw coded("AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    const objective = this.objectiveService.getObjective(objectiveId);
    if (agent.role !== "independentContributor" || !(objective.contributorAgentIds ?? []).includes(agentId)) {
      throw coded("AGENT_OUTSIDE_OBJECTIVE", "Target Agent must be an Independent Contributor attached to the authenticated Objective.");
    }
    return agent;
  }

  #requireWorkspace(objectiveId, workspaceId) {
    const objective = this.objectiveService.getObjective(objectiveId);
    if (!(objective.workspaceIds ?? []).includes(workspaceId) || !this.store.getGitRepository(workspaceId)) {
      throw coded("WORKSPACE_OUTSIDE_OBJECTIVE", "Workspace must be a registered repository: ID attached to the authenticated Objective.");
    }
  }

  #relate(workItemId, targetWorkItemId, relationship) {
    if (relationship === "blocks") return this.objectiveService.addDependency(targetWorkItemId, workItemId, relationship);
    return this.objectiveService.addDependency(workItemId, targetWorkItemId, relationship);
  }

  #startReceipt(item, session, executionStatus, idempotentReplay, idempotencyKey = null) {
    const logical = session ? this.store.getLogicalSession(session.logicalSessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(session.id) : null;
    const agent = item.main_agent_id ? this.store.getAgent(item.main_agent_id) : null;
    return {
      phase: executionStatus === "running" ? "started" : "created",
      workItem: item,
      session: session ? this.#sessionDescriptor(session, {
        session: { objectiveId: item.objective_id }, agent: agent ?? { agentId: session.agentId }
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
  if (input.recipientSessionId) return service.getSession(metadata, actorId, input.recipientSessionId);
  const intent = optional(input.routingIntent);
  if (!ROUTING_INTENTS.has(intent)) {
    throw coded("ROUTING_INTENT_REQUIRED", "When only an Agent is specified, routing_intent must be existing_work_item_session, objective_chat, create_dedicated_session, or best_available.");
  }
  const candidates = service.discoverSessions(metadata, actorId, {
    agentId: input.recipientAgentId,
    objectiveId: input.targetObjectiveId
  });
  const filtered = intent === "objective_chat" ? candidates.filter((item) => item.sessionKind === "objectiveChat")
    : intent === "existing_work_item_session" ? candidates.filter((item) => item.workItemId)
      : candidates;
  if (intent === "create_dedicated_session") return null;
  if (!filtered.length) {
    throw coded(
      "RECIPIENT_SESSION_NOT_FOUND",
      `No visible ${intent} Session was found for Agent ${input.recipientAgentId}${input.targetObjectiveId ? ` in Objective ${input.targetObjectiveId}` : ""}.`,
      404
    );
  }
  if (filtered.length > 1 && intent !== "best_available") {
    throw coded("AMBIGUOUS_RECIPIENT_SESSION", `Routing intent ${intent} resolved ${filtered.length} Sessions; specify recipient_session_id or target_objective_id.`, 409);
  }
  return filtered.find((item) => item.active && item.sessionKind === "objectiveChat")
    ?? filtered.find((item) => item.active)
    ?? filtered.find((item) => item.sessionKind === "objectiveChat")
    ?? filtered[0];
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
function assertKnown(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw coded("INVALID_INPUT", "Tool input must be an object.");
  const allowed = new Set(fields);
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) throw coded("UNKNOWN_FIELD", `Unknown collaboration WorkItem field: ${unknown}.`);
}
function coded(code, message, statusCode = 400) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
