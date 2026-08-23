import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

const CREATE_FIELDS = new Set([
  "target_path", "branch", "base_ref", "create_branch", "detach",
  "switch_after_create", "inventory_version", "continuation_checkpoint", "idempotency_key"
]);

export class SessionWorkspaceOperationService {
  constructor(options = {}) {
    this.store = options.store;
    this.collaborationCore = options.collaborationCore;
    this.worktrees = options.worktrees;
    this.inventory = options.inventory;
    this.onAudit = options.onAudit ?? (() => {});
    this.inflight = new Map();
    if (!this.store || !this.collaborationCore || !this.worktrees || typeof this.inventory !== "function") {
      throw new TypeError("SessionWorkspaceOperationService requires store, collaborationCore, worktrees, and inventory().");
    }
  }

  async listWorkspaces(metadata, actorId) {
    const scope = this.#scope(metadata, actorId);
    const result = await this.inventory(scope.logical);
    return {
      ...result,
      sourceContext: context(scope),
      workspaces: (result.workspaces ?? []).filter((item) => item.repositoryId === scope.logical.repositoryId)
    };
  }

  async createWorktree(metadata, actorId, input = {}) {
    let scope;
    try {
      scope = this.#scope(metadata, actorId, { mutation: true });
      assertKnown(input, CREATE_FIELDS);
      required(input.target_path, "target_path", "WORKSPACE_TARGET_PATH_REQUIRED");
      if (!isAbsolute(input.target_path)) {
        throw coded("WORKSPACE_TARGET_PATH_INVALID", "target_path must be an absolute local filesystem path.", 400, "input_validation");
      }
    } catch (error) {
      this.#failureAudit(metadata, actorId, input, error);
      throw error;
    }

    const targetPath = resolve(input.target_path);
    const idempotencyKey = optional(input.idempotency_key) ?? `target:${targetPath}`;
    const fingerprint = digest({
      targetPath,
      branch: optional(input.branch),
      baseRef: optional(input.base_ref),
      createBranch: input.create_branch ?? true,
      detach: input.detach === true,
      switchAfterCreate: input.switch_after_create ?? true,
      inventoryVersion: optional(input.inventory_version),
      continuationCheckpoint: optional(input.continuation_checkpoint)
    });
    const flightKey = `${scope.logical.logicalSessionId}\u0000${idempotencyKey}`;
    const running = this.inflight.get(flightKey);
    if (running) return running;
    let operation;
    try {
      operation = this.#claim(scope, actorId, idempotencyKey, fingerprint, targetPath, input);
    } catch (error) {
      this.#failureAudit(metadata, actorId, input, error);
      throw error;
    }
    if (operation.replay) return operation.result;

    const promise = this.#performCreate(scope, actorId, input, operation, idempotencyKey)
      .finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, promise);
    return promise;
  }

  async switchWorkspace(metadata, actorId, input = {}) {
    const scope = this.#scope(metadata, actorId, { mutation: true });
    const targetWorktreeId = required(input.target_worktree_id, "target_worktree_id", "WORKSPACE_TARGET_REQUIRED");
    const target = this.store.getGitWorktree(targetWorktreeId);
    if (!target || target.repositoryId !== scope.logical.repositoryId) {
      throw coded(
        "WORKSPACE_OUTSIDE_OBJECTIVE",
        `Worktree ${targetWorktreeId} is not in the repository authorized for Objective ${scope.session.objectiveId}.`,
        403,
        "authorization"
      );
    }
    this.#audit("workspace_switch_requested", { ...context(scope), actorAgentId: actorId, targetWorktreeId });
    try {
      const transition = await this.worktrees.switchWorkspace(
        scope.session.id,
        targetWorktreeId,
        input.continuation_checkpoint
      );
      this.#audit("workspace_switch_succeeded", {
        ...context(scope), actorAgentId: actorId, targetWorktreeId, status: transition?.status ?? "completed"
      });
      return { ...transition, transition, sourceContext: context(scope) };
    } catch (error) {
      error.code ??= "WORKSPACE_SWITCH_FAILED";
      error.stage ??= "workspace_transition";
      this.#audit("workspace_switch_failed", {
        ...context(scope), actorAgentId: actorId, targetWorktreeId,
        failureStage: error.stage, errorCode: error.code, errorMessage: error.message
      });
      throw error;
    }
  }

  async #performCreate(scope, actorId, input, operation, idempotencyKey) {
    this.#audit("workspace_creation_requested", {
      operationId: operation.operationId,
      ...context(scope),
      actorAgentId: actorId,
      targetPath: operation.targetPath,
      idempotencyKey
    });
    try {
      const created = await this.worktrees.createWorktree(scope.session.id, {
        logicalSessionId: scope.logical.logicalSessionId,
        targetPath: operation.targetPath,
        branch: input.branch,
        baseRef: input.base_ref,
        createBranch: input.create_branch,
        detach: input.detach,
        switchAfterCreate: input.switch_after_create,
        inventoryVersion: input.inventory_version,
        continuationPrompt: input.continuation_checkpoint
      });
      const result = {
        ...created,
        sourceContext: context(scope),
        request: { operationId: operation.operationId, idempotencyKey, idempotentReplay: false }
      };
      this.store.db.run(
        `UPDATE workspace_creation_requests
         SET status='succeeded', failure_stage=NULL, error_code=NULL, error_message=NULL,
             result_json=?, updated_at=? WHERE operation_id=?`,
        [JSON.stringify(result), now(), operation.operationId]
      );
      this.store.scheduleSave();
      this.#audit("workspace_creation_succeeded", {
        operationId: operation.operationId,
        ...context(scope), actorAgentId: actorId,
        targetPath: operation.targetPath,
        worktreeId: created.worktree?.worktreeId ?? created.worktree?.id ?? null,
        transitionStatus: created.transition?.status ?? (created.transition === null ? "not_requested" : "completed")
      });
      return result;
    } catch (error) {
      error.code ??= "WORKSPACE_CREATION_FAILED";
      error.stage ??= "workspace_creation";
      error.statusCode ??= 422;
      this.store.db.run(
        `UPDATE workspace_creation_requests
         SET status='failed', failure_stage=?, error_code=?, error_message=?, updated_at=?
         WHERE operation_id=?`,
        [error.stage, error.code, error.message, now(), operation.operationId]
      );
      this.store.scheduleSave();
      this.#audit("workspace_creation_failed", {
        operationId: operation.operationId,
        ...context(scope), actorAgentId: actorId, targetPath: operation.targetPath,
        failureStage: error.stage, errorCode: error.code, errorMessage: error.message
      });
      throw error;
    }
  }

  #claim(scope, actorId, idempotencyKey, fingerprint, targetPath, input) {
    const existing = this.store.selectOne(
      `SELECT * FROM workspace_creation_requests
       WHERE logical_session_id=? AND idempotency_key=?`,
      [scope.logical.logicalSessionId, idempotencyKey]
    );
    if (existing) {
      if (existing.input_fingerprint !== fingerprint) {
        throw coded(
          "WORKSPACE_IDEMPOTENCY_CONFLICT",
          `idempotency_key ${idempotencyKey} is already associated with different Workspace creation input.`,
          409,
          "idempotency"
        );
      }
      if (existing.status === "succeeded" && existing.result_json) {
        const result = JSON.parse(existing.result_json);
        result.request = { ...result.request, idempotentReplay: true };
        this.#audit("workspace_creation_replayed", {
          operationId: existing.operation_id, ...context(scope), actorAgentId: actorId,
          targetPath, idempotencyKey
        });
        return { replay: true, result };
      }
      if (existing.status === "pending") {
        throw coded(
          "WORKSPACE_CREATION_IN_PROGRESS",
          `Workspace creation request ${existing.operation_id} is still in progress.`,
          409,
          "idempotency"
        );
      }
      throw coded(
        "WORKSPACE_CREATION_RETRY_REQUIRES_NEW_KEY",
        `Workspace creation request ${existing.operation_id} previously failed at ${existing.failure_stage ?? "unknown"}; use a new idempotency_key after resolving the failure.`,
        409,
        "idempotency"
      );
    }
    const operationId = `workspace_operation:${randomUUID()}`;
    const timestamp = now();
    this.store.db.run(
      `INSERT INTO workspace_creation_requests (
        operation_id, idempotency_key, input_fingerprint, actor_agent_id,
        source_session_id, logical_session_id, objective_id, work_item_id,
        repository_id, target_path, status, failure_stage, request_json, result_json,
        error_code, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'workspace_creation', ?, NULL, NULL, NULL, ?, ?)`,
      [operationId, idempotencyKey, fingerprint, actorId, scope.session.id,
        scope.logical.logicalSessionId, scope.session.objectiveId, scope.session.workItemId ?? null,
        scope.logical.repositoryId, targetPath, JSON.stringify(input), timestamp, timestamp]
    );
    this.store.scheduleSave();
    return { replay: false, operationId, targetPath };
  }

  #scope(metadata, actorId, options = {}) {
    const sourceSessionId = required(
      metadata?.sessionId,
      "x-corptie-session-id",
      "WORKSPACE_SESSION_CONTEXT_REQUIRED",
      "context_validation"
    );
    const logicalById = this.store.getLogicalSession(sourceSessionId);
    const session = logicalById?.legacySessionId
      ? this.store.getSession(logicalById.legacySessionId)
      : this.store.getSession(sourceSessionId);
    const logical = logicalById ?? (session ? this.store.getLogicalSessionByLegacySessionId(session.id) : null);
    if (!session || !logical) {
      throw coded(
        "WORKSPACE_SOURCE_SESSION_NOT_FOUND",
        `Workspace source Session ${sourceSessionId} was not found or has no logical route.`,
        404,
        "context_validation"
      );
    }
    const objectiveId = required(
      metadata?.objectiveId,
      "x-corptie-objective-id",
      "WORKSPACE_OBJECTIVE_CONTEXT_REQUIRED",
      "context_validation"
    );
    if (!session.objectiveId || session.objectiveId !== objectiveId) {
      throw coded(
        "WORKSPACE_OBJECTIVE_CONTEXT_MISMATCH",
        `Request Objective ${objectiveId} does not match source Session ${logical.logicalSessionId}.`,
        403,
        "context_validation"
      );
    }
    if (session.workItemId && metadata?.workItemId !== session.workItemId) {
      throw coded(
        "WORKSPACE_WORK_ITEM_CONTEXT_MISMATCH",
        `Request WorkItem context does not match source Session ${logical.logicalSessionId}.`,
        403,
        "context_validation"
      );
    }
    const bound = this.collaborationCore.getAgentForSession(session.id);
    if (!bound || bound.agentId !== actorId) {
      throw coded(
        "WORKSPACE_ACTOR_FORBIDDEN",
        `Agent ${actorId || "<missing>"} does not own source Session ${logical.logicalSessionId}.`,
        403,
        "authorization"
      );
    }
    if (options.mutation && logical.activeBinding?.state !== "active") {
      throw coded(
        "WORKSPACE_SESSION_ROUTE_STALE",
        `Source Session ${logical.logicalSessionId} has no active Provider route.`,
        409,
        "route_validation"
      );
    }
    const objective = this.store.getObjective(objectiveId);
    if (!objective) {
      throw coded("WORKSPACE_OBJECTIVE_NOT_FOUND", `Objective ${objectiveId} was not found.`, 404, "context_validation");
    }
    if (!(objective.contributorAgentIds ?? []).includes(actorId)) {
      throw coded(
        "WORKSPACE_OBJECTIVE_ACCESS_DENIED",
        `Agent ${actorId} is not a contributor to Objective ${objectiveId}.`,
        403,
        "authorization"
      );
    }
    if (!logical.repositoryId || !(objective.workspaceIds ?? []).includes(logical.repositoryId)) {
      throw coded(
        "WORKSPACE_OBJECTIVE_ACCESS_DENIED",
        `Objective ${objectiveId} is not authorized for Session repository ${logical.repositoryId ?? "<missing>"}.`,
        403,
        "authorization"
      );
    }
    return { session, logical, objective };
  }

  #failureAudit(metadata, actorId, input, error) {
    this.#audit("workspace_creation_rejected", {
      actorAgentId: actorId ?? null,
      sourceSessionId: metadata?.sessionId ?? null,
      objectiveId: metadata?.objectiveId ?? null,
      workItemId: metadata?.workItemId ?? null,
      targetPath: input?.target_path ?? null,
      failureStage: error.stage ?? "context_validation",
      errorCode: error.code ?? "WORKSPACE_REQUEST_REJECTED",
      errorMessage: error.message
    });
  }

  #audit(event, payload) {
    this.onAudit({ event, at: now(), ...payload });
  }
}

function context(scope) {
  return {
    sourceSessionId: scope.logical.logicalSessionId,
    providerSessionId: scope.session.id,
    objectiveId: scope.session.objectiveId,
    workItemId: scope.session.workItemId ?? null,
    repositoryId: scope.logical.repositoryId
  };
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertKnown(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw coded("WORKSPACE_INPUT_INVALID", "Workspace creation input must be an object.", 400, "input_validation");
  }
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) {
    throw coded("WORKSPACE_INPUT_UNKNOWN_FIELD", `Unknown Workspace creation field: ${unknown}.`, 400, "input_validation");
  }
}

function required(value, field, code, stage = "input_validation") {
  const text = optional(value);
  if (!text) throw coded(code, `${field} is required.`, 400, stage);
  return text;
}

function optional(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function coded(code, message, statusCode, stage) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.stage = stage;
  return error;
}

function now() {
  return new Date().toISOString();
}
