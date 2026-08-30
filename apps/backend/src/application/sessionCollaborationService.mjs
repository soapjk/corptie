import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, accessSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  COLLABORATION_RELATION_TYPES,
  COLLABORATION_ROUTING_INTENTS,
  WORK_ITEM_PRIORITIES
} from "../domain/workItemToolSchema.mjs";

const RELATIONS = new Set(COLLABORATION_RELATION_TYPES);
const ROUTING_INTENTS = new Set(COLLABORATION_ROUTING_INTENTS);
const ARTIFACT_RELATIONS = new Set([
  "implementation_spec", "security_requirement", "test_plan", "research_evidence",
  "handoff", "acceptance_evidence"
]);
const ARTIFACT_VERSION_POLICIES = new Set(["fixed", "latest_approved"]);

export class SessionCollaborationService {
  constructor(options = {}) {
    this.store = options.store;
    this.objectiveService = options.objectiveService;
    this.artifactService = options.artifactService ?? null;
    this.collaborationCore = options.collaborationCore;
    this.launchWorkItem = options.startWorkItem;
    this.onRoutingEvent = options.onRoutingEvent ?? ((event, details) => {
      console.info(`[collaboration-routing] event=${event} ${JSON.stringify(details)}`);
    });
    if (!this.store || !this.objectiveService || !this.collaborationCore || typeof this.launchWorkItem !== "function") {
      throw new TypeError("SessionCollaborationService requires store, objectiveService, collaborationCore, and startWorkItem().");
    }
  }

  capabilities(metadata = {}, actorId = null, options = {}) {
    const scope = this.#scope(metadata, actorId, {
      mutation: false,
      validateContext: options.validateContext === true
    });
    const canCreate = scope.session.sessionKind === "objectiveChat"
      || (scope.session.sessionKind === "worker" && Boolean(scope.session.workItemId));
    const requestDenial = this.#collaborationRequestDenial(scope);
    return {
      actorAgentId: scope.agent.agentId,
      sourceSessionId: scope.logicalSessionId,
      providerSessionId: scope.session.id,
      sessionKind: scope.session.sessionKind,
      objectiveId: scope.session.objectiveId,
      workItemId: scope.session.workItemId,
      actions: ["sessions.discover", "sessions.get", "work_items.list", "work_items.get", "work_items.result",
        ...(!requestDenial ? ["collaboration.request"] : []), ...(canCreate
        ? ["work_items.create", "work_items.relate", "work_items.share_artifact", "work_items.start", "work_items.cancel"]
        : [])],
      denials: requestDenial ? { "collaboration.request": requestDenial } : {},
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
    if (!target) {
      throw coded("SESSION_NOT_VISIBLE", "The target Session is outside the authenticated Objective/Agent scope.");
    }
    if (!this.#isVisibleSession(scope, target, { explicitPeerLookup: true })) {
      const eligibility = collaborationSessionEligibility(this.store, target);
      if (eligibility.reasons.includes("session_archived")
        && this.#isVisibleSession(scope, target, { explicitPeerLookup: true, includeArchived: true })) {
        throw coded(
          "RECIPIENT_SESSION_UNAVAILABLE",
          `The target Session is archived and cannot receive a new collaboration task: ${target.archiveReason ?? "session_archived"}.`,
          409
        );
      }
      throw coded("SESSION_NOT_VISIBLE", "The target Session is outside the authenticated Objective/Agent scope.");
    }
    return this.#sessionDescriptor(target, scope);
  }

  listWorkItems(metadata, actorId) {
    const scope = this.#scope(metadata, actorId, { mutation: false });
    if (!scope.session.objectiveId) return [];
    return this.objectiveService.listWorkItemsByObjective(scope.session.objectiveId)
      .filter((item) => this.#canReadWorkItem(scope, item))
      .map((item) => this.#presentWorkItem(item));
  }

  getWorkItem(metadata, actorId, workItemId) {
    const scope = this.#scope(metadata, actorId, { mutation: false });
    const item = this.objectiveService.getWorkItem(required(workItemId, "work_item_id"));
    if (!this.#canReadWorkItem(scope, item)) throw coded("WORK_ITEM_OUTSIDE_SCOPE", "WorkItem is outside the authenticated Session scope.");
    return this.#presentWorkItem(item);
  }

  createWorkItem(metadata, actorId, input = {}) {
    assertKnown(input, ["title", "description", "acceptanceCriteria", "priority", "agentId", "mainWorkspaceId",
      "parentWorkItemId", "sourceWorkItemId", "relationship", "artifactReference", "fileReference", "idempotencyKey"]);
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
    if (input.artifactReference != null && input.fileReference != null) {
      throw coded("WORK_ITEM_REFERENCE_CONFLICT", "Choose either artifactReference or fileReference, not both.", 400);
    }
    const creationReferenceFingerprint = fingerprintCreationReference(input);
    const prior = this.store.selectOne(
      "SELECT * FROM work_items WHERE created_by_session_id = ? AND idempotency_key = ?",
      [scope.logicalSessionId, idempotencyKey]
    );
    if (prior) {
      if (prior.title !== required(input.title, "title") || prior.objective_id !== scope.session.objectiveId
        || (prior.creation_reference_fingerprint ?? null) !== creationReferenceFingerprint) {
        throw coded("IDEMPOTENCY_CONFLICT", "The idempotency key is already associated with different WorkItem input.", 409);
      }
      return { workItem: this.#presentWorkItem(prior), idempotentReplay: true, phase: "created" };
    }
    const artifactReference = input.artifactReference == null
      ? null
      : this.#prepareArtifactReference(scope, input.artifactReference);
    const fileReference = input.fileReference == null
      ? null
      : this.#prepareFileReference(scope, input.fileReference);
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
         collaboration_relation=?, idempotency_key=?, creation_reference_fingerprint=?, resource_version=1 WHERE id=?`,
        [scope.logicalSessionId, sourceWorkItemId, parentWorkItemId, relationship, idempotencyKey,
          creationReferenceFingerprint, item.id]
      );
      if (sourceWorkItemId && relationship) this.#relate(item.id, sourceWorkItemId, relationship);
      if (artifactReference) this.artifactService.createPreparedWorkItemReference(artifactReference, item.id);
      if (fileReference) this.store.createWorkItemFileReference({
        referenceId: `work_item_file_reference:${randomUUID()}`,
        objectiveId: scope.session.objectiveId,
        workItemId: item.id,
        ...fileReference,
        actorId: scope.logicalSessionId,
        sessionId: scope.logicalSessionId,
        authorizedAt: new Date().toISOString()
      });
    });
    this.store.scheduleSave();
    return { workItem: this.#presentWorkItem(this.store.getWorkItem(item.id)), idempotentReplay: false, phase: "created" };
  }

  #prepareArtifactReference(scope, input) {
    if (!this.artifactService) {
      throw coded("ARTIFACT_CAPABILITY_UNAVAILABLE", "Artifact references are unavailable for WorkItem creation.", 503);
    }
    assertKnown(input, ["artifactId", "relation", "required", "versionPolicy", "version"]);
    return this.artifactService.prepareWorkItemCreationReference({
      actorId: scope.agent.agentId,
      sessionId: scope.session.id,
      objectiveId: scope.session.objectiveId,
      workItemId: scope.session.workItemId
    }, required(input.artifactId, "artifact_reference.artifact_id"), input);
  }

  #prepareFileReference(scope, input) {
    assertKnown(input, ["path", "relation", "required"]);
    const requestedPath = required(input.path, "file_reference.path");
    if (!isAbsolute(requestedPath)) {
      throw coded("INVALID_FILE_REFERENCE", "WorkItem file references require an absolute path.", 400);
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

  #presentWorkItem(item) {
    return {
      ...item,
      references: {
        artifacts: this.store.listArtifactReferences({ workItemId: item.id }),
        files: this.store.listWorkItemFileReferences(item.id)
      }
    };
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

  shareArtifact(metadata, actorId, input = {}) {
    assertKnown(input, ["workItemId", "artifactId", "relation", "required", "versionPolicy", "version"]);
    const scope = this.#scope(metadata, actorId, { mutation: true });
    if (!scope.session.objectiveId || !["objectiveChat", "worker"].includes(scope.session.sessionKind)) {
      throw coded("ARTIFACT_SHARE_FORBIDDEN", "A bound Objective Chat or Worker Session is required to share an Artifact.", 403);
    }
    const target = this.objectiveService.getWorkItem(required(input.workItemId, "work_item_id"));
    if (!this.#canReadWorkItem(scope, target)) {
      throw coded("WORK_ITEM_OUTSIDE_SCOPE", "The target WorkItem is outside the authenticated Session scope.", 403);
    }
    if (scope.session.sessionKind === "worker" && target.id === scope.session.workItemId) {
      throw coded("ARTIFACT_SHARE_TARGET_REQUIRED", "Choose another explicitly related WorkItem as the read-only Artifact recipient.", 400);
    }
    const prepared = this.#prepareArtifactReference(scope, {
      artifactId: input.artifactId,
      relation: input.relation,
      required: input.required,
      versionPolicy: input.versionPolicy,
      version: input.version
    });
    const artifact = this.store.getArtifact(prepared.artifactId);
    if (scope.session.sessionKind === "worker" && artifact?.boundWorkItemId !== scope.session.workItemId) {
      throw coded(
        "ARTIFACT_RESHARE_FORBIDDEN",
        "Worker Sessions may share only Artifacts owned by their current WorkItem; received read-only Artifacts cannot be re-shared.",
        403
      );
    }
    let reference;
    let idempotentReplay = false;
    this.store.runInTransaction(() => {
      reference = this.store.listArtifactReferences({ artifactId: prepared.artifactId, workItemId: target.id })
        .find((candidate) => candidate.relation === prepared.relation
          && candidate.required === prepared.required
          && candidate.versionPolicy === prepared.versionPolicy
          && candidate.pinnedVersion === prepared.pinnedVersion
          && candidate.pinnedHash === prepared.pinnedHash) ?? null;
      if (reference) {
        idempotentReplay = true;
        return;
      }
      reference = this.artifactService.createPreparedWorkItemReference(prepared, target.id);
    });
    this.store.scheduleSave();
    return {
      access: "read_only",
      reference,
      workItem: this.#presentWorkItem(this.store.getWorkItem(target.id)),
      idempotentReplay
    };
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
    const agentId = optional(input.agentId) ?? item.main_agent_id;
    const agent = this.#requireContributor(scope.session.objectiveId, required(agentId, "agent_id"));
    try {
      const launched = await this.launchWorkItem({
        workItem: item,
        agent,
        title: optional(input.title),
        idempotencyKey,
        source: "collaboration"
      });
      const session = this.#resolveSession(launched?.id ?? launched?.sessionId ?? this.store.getWorkItem(item.id)?.current_session_id);
      if (!session) throw coded("START_SESSION_UNRESOLVED", "Provider accepted the launch but no Corptie Session binding was persisted.");
      return this.#startReceipt(this.store.getWorkItem(item.id), session, "running", false, idempotencyKey);
    } catch (error) {
      error.receipt ??= {
        phase: "failed",
        workItemId: item.id,
        executionStatus: this.store.getWorkItem(item.id)?.execution_status ?? "start_failed",
        idempotencyKey
      };
      throw error;
    }
  }

  cancelWorkItem(metadata, actorId, input = {}) {
    assertKnown(input, ["workItemId", "reason", "resourceVersion"]);
    const scope = this.#scope(metadata, actorId, { mutation: true });
    const item = this.getWorkItem(metadata, actorId, input.workItemId);
    const expectedVersion = required(input.resourceVersion, "resource_version");
    if (scope.session.sessionKind === "worker" && item.created_by_session_id !== scope.logicalSessionId) {
      throw coded("CANCEL_FORBIDDEN", "Worker Sessions may only cancel collaboration WorkItems they created.");
    }
    const reason = required(input.reason, "reason");
    const result = this.store.cancelWorkItem({
      workItemId: item.id,
      sourceType: "collaboration_work_item_cancel",
      idempotencyKey: `${scope.logicalSessionId}:${item.id}`,
      expectedResourceVersion: expectedVersion,
      reason,
      actorSessionId: scope.logicalSessionId,
      authorityType: "session",
      authorityId: scope.logicalSessionId
    });
    return {
      workItem: result.workItem,
      cancellationOperation: result.operation,
      canceled: true,
      idempotentReplay: result.idempotentReplay,
      physicallyDeleted: false,
      auditPreserved: true
    };
  }

  #scope(metadata, actorId, options = {}) {
    const sourceId = required(metadata?.sessionId, "source session metadata");
    const session = this.#resolveSession(sourceId);
    if (!session) throw coded("SOURCE_SESSION_NOT_FOUND", "Authenticated source Session was not found.");
    const bound = this.collaborationCore.getAgentForSession(session.id);
    if (!bound || bound.agentId !== actorId) throw coded("SOURCE_SESSION_ACTOR_MISMATCH", "Authenticated Agent does not own the source Session.");
    const logical = this.store.getLogicalSession(sourceId) ?? this.store.getLogicalSessionByLegacySessionId(session.id);
    const claimedObjectiveId = optional(metadata?.objectiveId);
    const claimedWorkItemId = optional(metadata?.workItemId);
    if ((options.mutation || options.validateContext) && claimedObjectiveId && claimedObjectiveId !== session.objectiveId) {
      throw coded(
        "COLLABORATION_CONTEXT_MISMATCH",
        `Runtime Objective ${claimedObjectiveId} does not match authenticated Session ${logical?.logicalSessionId ?? session.id} bound Objective ${session.objectiveId ?? "none"}. Refresh the Session route before retrying.`,
        409
      );
    }
    if ((options.mutation || options.validateContext) && claimedWorkItemId && claimedWorkItemId !== session.workItemId) {
      throw coded(
        "COLLABORATION_CONTEXT_MISMATCH",
        `Runtime parent WorkItem ${claimedWorkItemId} does not match authenticated Session ${logical?.logicalSessionId ?? session.id} bound WorkItem ${session.workItemId ?? "none"}. Refresh the Session route before retrying.`,
        409
      );
    }
    if (options.mutation && logical && logical.activeBinding?.state !== "active") {
      throw coded("STALE_SESSION_ROUTE", "The source Session route is superseded; recover the active Session before mutating collaboration state.", 409);
    }
    return { agent: bound, session, logical, logicalSessionId: logical?.logicalSessionId ?? session.logicalSessionId ?? session.id };
  }

  #collaborationRequestDenial(scope) {
    if (!scope.session.objectiveId || !["objectiveChat", "worker"].includes(scope.session.sessionKind)) {
      return {
        code: "COLLABORATION_REQUEST_FORBIDDEN",
        reason: "collaboration.request requires an Objective Chat or Worker Session bound to an Objective."
      };
    }
    if (scope.session.sessionKind === "objectiveChat") return null;
    if (!scope.session.workItemId) {
      return {
        code: "COLLABORATION_REQUEST_FORBIDDEN",
        reason: "collaboration.request requires the Worker Session to be bound to a current parent WorkItem."
      };
    }
    const workItem = this.store.getWorkItem(scope.session.workItemId);
    if (!workItem || workItem.objective_id !== scope.session.objectiveId) {
      return {
        code: "COLLABORATION_REQUEST_FORBIDDEN",
        reason: `The Worker Session parent WorkItem ${scope.session.workItemId} is missing or outside its bound Objective.`
      };
    }
    if (["done", "complete", "completed", "canceled", "cancelled"].includes(workItem.status)) {
      return {
        code: "COLLABORATION_REQUEST_FORBIDDEN",
        reason: `The Worker Session parent WorkItem ${scope.session.workItemId} is terminal and cannot initiate a new collaboration request.`
      };
    }
    return null;
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
    if (!options.explicitPeerLookup
      || !session.objectiveId
      || (session.archived && !options.includeArchived)) return false;
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
    const eligibility = collaborationSessionEligibility(this.store, session);
    return {
      sessionId: logical?.logicalSessionId ?? session.logicalSessionId ?? session.id,
      providerSessionId: peerObjective ? null : session.id,
      agentId,
      sessionKind: session.sessionKind,
      objectiveId: session.objectiveId,
      workItemId: session.workItemId,
      lifecycle: session.archived ? "archived" : session.status,
      routeStatus: binding?.state ?? (logical ? "unresolved" : "legacy_unresolved"),
      active: eligibility.active,
      routingRejectionReasons: eligibility.reasons,
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

  async prepareTaskConfirmationTarget(confirmation) {
    if (!confirmation?.confirmationId || confirmation.status !== "pending") {
      throw coded("COLLABORATION_CONFIRMATION_REQUIRED", "A pending collaboration confirmation is required before preparing its target Session.");
    }
    const request = confirmation.request ?? {};
    if (confirmation.recipientSessionId) {
      const target = collaborationTargetEligibility(this.store, {
        workItemId: request.workItemId ?? confirmation.recipientWorkItemId,
        targetObjectiveId: request.targetObjectiveId ?? confirmation.targetObjectiveId,
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
        workItemId: target.session.workItemId,
        recipientNameAtSend: target.logical?.sessionName ?? target.session.title,
        created: false
      };
    }

    const targetObjectiveId = required(request.targetObjectiveId, "target_objective_id");
    const agentResourceId = required(request.sessionAgentId ?? request.recipientAgentId, "session_agent_id");
    const agent = this.#requireContributor(targetObjectiveId, agentResourceId);
    const objective = this.objectiveService.getObjective(targetObjectiveId);
    const workItemId = request.workItemId ?? `work_item:collaboration:${confirmation.confirmationId}`;
    let workItem = this.store.getWorkItem(workItemId);
    if (!workItem) {
      const repositoryId = (objective.workspaceIds ?? [])
        .find((candidate) => this.store.getGitRepository(candidate)) ?? null;
      workItem = this.objectiveService.createWorkItem({
        id: workItemId,
        objectiveId: targetObjectiveId,
        title: required(request.title, "title"),
        description: required(request.summary, "summary"),
        acceptanceCriteria: (request.acceptanceCriteria ?? []).map((entry) => `- ${entry}`).join("\n"),
        priority: "medium",
        status: "todo",
        mainWorkspaceId: repositoryId,
        mainAgentId: agent.agentId
      });
      this.store.db.run(
        `UPDATE work_items SET created_by_session_id=?, source_work_item_id=?, collaboration_relation=?,
         idempotency_key=?, resource_version=1 WHERE id=?`,
        [confirmation.initiatorSessionId, request.sourceWorkItemId ?? null,
          request.sourceWorkItemId ? "delegated_subtask" : null,
          `collaboration-confirmation:${confirmation.confirmationId}`, workItem.id]
      );
      if (request.sourceWorkItemId && this.store.getWorkItem(request.sourceWorkItemId)?.objective_id === targetObjectiveId) {
        this.#relate(workItem.id, request.sourceWorkItemId, "delegated_subtask");
      }
    }
    if (workItem.objective_id !== targetObjectiveId || workItem.main_agent_id !== agent.agentId) {
      throw coded("COLLABORATION_TARGET_RESOURCE_MISMATCH", "The prepared WorkItem does not match the target Objective and Agent resource.", 409);
    }
    const targetContext = {
      workItemId: workItem.id,
      targetObjectiveId,
      recipientAgentId: agent.agentId
    };
    const existing = workItem.current_session_id
      ? collaborationTargetEligibility(this.store, targetContext, workItem.current_session_id)
      : null;
    let target = existing?.active ? existing : null;
    if (!target) {
      const launched = await this.launchWorkItem({
        workItem,
        agent,
        title: request.title,
        autoUniqueTitle: true,
        source: "collaboration_confirmation"
      });
      target = collaborationTargetEligibility(this.store, targetContext, launched?.id ?? launched?.sessionId);
    }
    if (!target?.active) {
      throw coded("CREATED_SESSION_NOT_ACTIVE", `The target Worker Session was not created successfully: ${target?.reasons.join(", ") || "unresolved"}.`, 503);
    }
    return {
      recipientSessionId: target.logicalSessionId,
      recipientAgentId: agent.agentId,
      workItemId: workItem.id,
      recipientNameAtSend: target.logical?.sessionName ?? target.session.title,
      created: true
    };
  }

  async ensureTaskRecipientSession(task, options = {}) {
    if (!task?.taskId) throw coded("COLLABORATION_TASK_REQUIRED", "A collaboration Task is required for recipient routing.");
    if (!task.workItemId) {
      throw coded("COLLABORATION_WORK_ITEM_REQUIRED", `Collaboration Task ${task.taskId} has no target WorkItem.`);
    }
    if (!task.targetObjectiveId) {
      throw coded("COLLABORATION_TARGET_OBJECTIVE_REQUIRED", `Collaboration Task ${task.taskId} has no target Objective.`);
    }
    if (!task.recipientAgentId) {
      throw coded("COLLABORATION_RECIPIENT_AGENT_REQUIRED", `Collaboration Task ${task.taskId} has no recipient Agent.`);
    }
    const targetWorkItem = this.store.getWorkItem(task.workItemId);
    if (!targetWorkItem) {
      throw coded("COLLABORATION_WORK_ITEM_NOT_FOUND", `Collaboration WorkItem ${task.workItemId} was not found.`);
    }
    if (targetWorkItem.objective_id !== task.targetObjectiveId) {
      throw coded(
        "COLLABORATION_WORK_ITEM_OBJECTIVE_MISMATCH",
        `Collaboration WorkItem ${task.workItemId} belongs to ${targetWorkItem.objective_id}, not target Objective ${task.targetObjectiveId}.`
      );
    }
    if (targetWorkItem.main_agent_id && targetWorkItem.main_agent_id !== task.recipientAgentId) {
      throw coded(
        "COLLABORATION_WORK_ITEM_AGENT_MISMATCH",
        `Collaboration WorkItem ${task.workItemId} is assigned to ${targetWorkItem.main_agent_id}, not recipient Agent ${task.recipientAgentId}.`
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

    const sessions = this.store.listSessionsByObjective(task.targetObjectiveId)
      .filter((session) => (session.agentId ?? this.collaborationCore.getAgentForSession(session.id)?.agentId) === task.recipientAgentId);
    const evaluated = sessions.map((session) => ({
      session,
      eligibility: collaborationTargetEligibility(this.store, task, session)
    }));
    this.onRoutingEvent("candidates_filtered", {
      taskId: task.taskId,
      recipientAgentId: task.recipientAgentId,
      targetObjectiveId: task.targetObjectiveId,
      candidates: evaluated.map(({ session, eligibility }) => ({
        sessionId: eligibility.logicalSessionId ?? session.id,
        sessionKind: session.sessionKind,
        workItemId: session.workItemId ?? null,
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

    let workItem = targetWorkItem;
    if (!workItem.main_workspace_id) {
      const objective = this.store.getObjective(task.targetObjectiveId);
      const repositoryId = (objective?.workspaceIds ?? [])
        .find((candidate) => this.store.getGitRepository(candidate));
      if (repositoryId) {
        workItem = this.store.updateWorkItem(workItem.id, { mainWorkspaceId: repositoryId });
        this.onRoutingEvent("work_item_workspace_selected", {
          taskId: task.taskId,
          workItemId: workItem.id,
          repositoryId,
          source: "target_objective"
        });
      }
    }
    const agent = this.store.getAgent(task.recipientAgentId);
    if (!agent) throw coded("AGENT_NOT_FOUND", `Agent not found: ${task.recipientAgentId}`);
    this.onRoutingEvent("work_item_session_creation_started", {
      taskId: task.taskId,
      workItemId: workItem.id,
      recipientAgentId: agent.agentId,
      previousSessionId: task.recipientSessionId,
      previousRejectionReasons: current.reasons
    });
    let launched;
    try {
      launched = await this.launchWorkItem({
        workItem,
        agent,
        title: task.title,
        autoUniqueTitle: true
      });
    } catch (error) {
      this.onRoutingEvent("work_item_session_creation_failed", {
        taskId: task.taskId,
        workItemId: workItem.id,
        code: error.code ?? "SESSION_CREATION_FAILED",
        error: error.message
      });
      throw error;
    }
    const created = collaborationTargetEligibility(this.store, task, launched?.id ?? launched?.sessionId);
    if (!created.active) {
      throw coded(
        "CREATED_SESSION_NOT_ACTIVE",
        `Created Session is not an active collaboration target: ${created.reasons.join(", ") || "unresolved"}.`,
        503
      );
    }
    const rerouted = this.collaborationCore.rerouteTaskRecipient(task.taskId, created.logicalSessionId, {
      reason: options.reason ?? "no_suitable_active_session",
      createdWorkItemSession: true,
      previousRejectionReasons: current.reasons
    });
    this.onRoutingEvent("work_item_session_created", {
      taskId: task.taskId,
      workItemId: workItem.id,
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
  if (input.recipientSessionId) {
    let explicit;
    try {
      explicit = service.getSession(metadata, actorId, input.recipientSessionId);
    } catch (error) {
      if (error.code === "RECIPIENT_SESSION_UNAVAILABLE"
        && optional(input.targetObjectiveId)
        && optional(input.sessionAgentId)) {
        return null;
      }
      throw error;
    }
    return explicit.active
      && explicit.sessionKind === "worker"
      && (!input.workItemId || explicit.workItemId === input.workItemId)
      ? explicit
      : null;
  }
  const intent = optional(input.routingIntent);
  if (!intent) {
    throw coded("ROUTING_INTENT_REQUIRED", "When only an Agent is specified, routing_intent must be existing_work_item_session, create_dedicated_session, or best_available. Objective Chat is not a collaboration delivery target.");
  }
  if (!ROUTING_INTENTS.has(intent)) {
    throw coded("INVALID_ROUTING_INTENT", `Unsupported collaboration routing intent: ${intent}. Objective Chat is not a collaboration delivery target.`);
  }
  const candidates = service.discoverSessions(metadata, actorId, {
    agentId: input.recipientAgentId,
    objectiveId: input.targetObjectiveId
  });
  if (intent === "create_dedicated_session" || !input.workItemId) return null;
  return candidates.find((item) => item.active
    && item.sessionKind === "worker"
    && item.workItemId === input.workItemId) ?? null;
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
  if (["failed", "cancelled", "canceled"].includes(session?.status)) reasons.push(`session_${session.status}`);
  if (session?.capabilities?.canSend === false || session?.rawStatus?.capabilities?.canSend === false) {
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

function collaborationTargetEligibility(store, task, sessionOrId) {
  const eligibility = collaborationSessionEligibility(store, sessionOrId);
  const reasons = [...eligibility.reasons];
  if (eligibility.session && eligibility.session.sessionKind !== "worker") reasons.push("session_not_worker");
  if (eligibility.session?.sessionKind === "worker" && eligibility.session.workItemId !== task.workItemId) {
    reasons.push("work_item_mismatch");
  }
  const workItem = task?.workItemId ? store.getWorkItem(task.workItemId) : null;
  if (!task?.workItemId) reasons.push("work_item_missing");
  else if (!workItem) reasons.push("work_item_not_found");
  if (workItem && eligibility.session?.sessionKind === "worker") {
    if (workItem.objective_id !== task.targetObjectiveId) reasons.push("work_item_objective_mismatch");
    if (workItem.main_agent_id && workItem.main_agent_id !== task.recipientAgentId) {
      reasons.push("work_item_agent_mismatch");
    }
    if (workItem.current_session_id !== eligibility.session.id) reasons.push("work_item_session_superseded");
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
    throw coded("INVALID_REFERENCE_RELATION", `Unsupported WorkItem reference relation: ${relation}.`);
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
    if (!isAbsolute(path)) throw coded("INVALID_FILE_REFERENCE", "WorkItem file references require an absolute path.");
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
  if (unknown) throw coded("UNKNOWN_FIELD", `Unknown collaboration WorkItem field: ${unknown}.`);
}
function coded(code, message, statusCode = 400) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
