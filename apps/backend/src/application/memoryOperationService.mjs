import { createHash, randomUUID } from "node:crypto";

const MEMORY_KINDS = new Set([
  "skill", "procedure", "dev_experience", "fact", "lesson", "preference", "feedback", "episodic"
]);
const SCOPES = new Set(["agent", "objective", "task"]);

export class MemoryOperationService {
  constructor(options = {}) {
    this.store = options.store;
    this.hubService = options.hubService;
    this.recallService = options.recallService ?? null;
    this.resolveAgentForSession = options.resolveAgentForSession ?? null;
    this.onDiagnostic = options.onDiagnostic ?? (() => {});
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    if (!this.store) throw new TypeError("MemoryOperationService requires a store.");
    if (!this.hubService) throw new TypeError("MemoryOperationService requires a hubService.");
  }

  async execute(input = {}) {
    const tool = requiredText(input.tool, "tool");
    const args = input.arguments ?? {};
    if (tool === "corptie_memory_remember") {
      return this.#executeRemember(input.actorId ?? input.agentId, input.metadata, args);
    }
    const context = this.#context(input.actorId ?? input.agentId, input.metadata);
    switch (tool) {
      case "corptie_memory_search":
      case "corptie.memory.search":
        return this.#search(context, args);
      case "corptie_memory_get":
        return this.#get(context, args);
      case "corptie_memory_list":
        return this.#list(context, args);
      case "corptie_memory_update":
        return this.#update(context, args);
      case "corptie_memory_revoke":
        return this.#revoke(context, args);
      default:
        throw operationError("HOST_TOOL_UNSUPPORTED", `Unsupported Memory tool: ${tool}`);
    }
  }

  #executeRemember(actorValue, metadata, args) {
    let context = null;
    let failureStage = "context_resolution";
    try {
      context = this.#context(actorValue, metadata);
      failureStage = "input_validation";
      return this.#remember(context, args);
    } catch (error) {
      const requestedSessionId = optionalText(metadata?.sessionId);
      const failureContext = context ?? (requestedSessionId
        ? { session: this.store.getSession(requestedSessionId) }
        : null);
      this.#recordRememberFailure(failureContext, actorValue, metadata, error, error.stage ?? failureStage);
      throw locateRememberError(error, failureContext, metadata, error.stage ?? failureStage);
    }
  }

  async #search(context, args) {
    if (this.recallService) {
      const recall = await this.recallService.explicitSearch(String(args.intent ?? ""), context.scopes, {
        deepRecall: args.deep_recall === true
      });
      return { ...this.#result(context, recall.memories), recall: omitMemories(recall) };
    }
    const memories = await this.hubService.retrieveMemory(String(args.intent ?? ""), context.scopes, {
      allowEmbedding: args.deep_recall === true
    });
    return this.#result(context, memories);
  }

  #get(context, args) {
    const memory = this.#manageableMemory(context, args.memory_id);
    return {
      scopes: context.scopes,
      memory: presentMemory(memory),
      audit: this.store.listMemoryAudit({ memoryId: memory.id })
    };
  }

  #list(context, args) {
    const requestedScope = optionalScope(args.scope);
    const owners = requestedScope
      ? [this.#owner(context, requestedScope)]
      : Array.from(context.owners.values());
    const includeRevoked = args.include_revoked === true;
    const memories = owners
      .flatMap((owner) => this.store.listMemoriesByOwner(owner.ownerType, owner.ownerId))
      .filter((memory) => includeRevoked || !memory.revoked_at)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
    return this.#result(context, memories);
  }

  #remember(context, args) {
    const content = requiredText(args.content, "content");
    const kind = requiredText(args.kind, "kind");
    if (!MEMORY_KINDS.has(kind)) throw operationError("INVALID_MEMORY_KIND", `Unsupported memory kind: ${kind}`);
    const memoryScope = optionalScope(args.scope) ?? mostSpecificScope(context);
    const owner = this.#owner(context, memoryScope);
    const tags = stringList(args.tags);
    const idempotencyKey = optionalText(args.idempotency_key);
    if (idempotencyKey && idempotencyKey.length > 200) {
      throw operationError("INVALID_INPUT", "idempotency_key must not exceed 200 characters.");
    }
    const requestFingerprint = digest({
      sessionId: context.session.id,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      kind,
      content,
      tags
    });
    if (idempotencyKey) {
      const prior = this.store.getMemoryRememberOperation(context.session.id, idempotencyKey);
      if (prior) {
        if (prior.request_fingerprint !== requestFingerprint) {
          throw operationError(
            "MEMORY_IDEMPOTENCY_CONFLICT",
            "idempotency_key is already associated with different Memory input.",
            "idempotency_resolution"
          );
        }
        const replay = this.store.getMemory(prior.memory_id);
        if (!replay || replay.source_session_id !== context.session.id
          || replay.owner_type !== owner.ownerType || replay.owner_id !== owner.ownerId) {
          throw operationError(
            "MEMORY_IDEMPOTENCY_RECORD_INVALID",
            "The prior Memory request no longer resolves to its authenticated Session scope.",
            "idempotency_resolution"
          );
        }
        return { scopes: context.scopes, memory: presentMemory(replay), idempotentReplay: true };
      }
    }
    const id = `memory:${this.idFactory()}`;
    let memory;
    try {
      memory = this.store.runInTransaction(() => {
        const event = this.#appendEvent(context, "memory/remember", {
          memoryId: id,
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          taskId: owner.ownerType === "task" ? owner.ownerId : null,
          kind
        });
        const created = this.store.createMemory({
          id,
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          kind,
          content,
          tags,
          sourceType: "user",
          sourceSessionId: context.session.id,
          sourceEventSeqs: event ? [event.sequence] : [],
          promotionStatus: "active",
          autoApplied: false,
          appliedAt: this.clock(),
          trustLevel: "trusted"
        });
        this.store.createMemoryAudit({
          memoryId: created.id, action: "remember", actorType: "user", actorId: context.actorId,
          after: created
        });
        if (idempotencyKey) {
          this.store.createMemoryRememberOperation({
            sessionId: context.session.id,
            idempotencyKey,
            requestFingerprint,
            objectiveId: context.session.objectiveId,
            memoryId: created.id
          });
        }
        return created;
      });
    } catch (error) {
      if (String(error.code ?? "").startsWith("MEMORY_")) {
        error.stage ??= "memory_persistence";
        throw error;
      }
      const wrapped = operationError(
        "MEMORY_PERSISTENCE_FAILED",
        "Memory persistence failed before confirmation.",
        "memory_persistence"
      );
      wrapped.cause = error;
      throw wrapped;
    }
    return { scopes: context.scopes, memory: presentMemory(memory), idempotentReplay: false };
  }

  #recordRememberFailure(context, actorValue, metadata, error, failureStage) {
    const requestedSessionId = optionalText(metadata?.sessionId);
    const session = context?.session ?? (requestedSessionId ? this.store.getSession(requestedSessionId) : null);
    const diagnostic = {
      event: "memory_remember_failed",
      sessionId: session?.id ?? requestedSessionId ?? null,
      targetObjectiveId: session?.objectiveId ?? optionalText(metadata?.objectiveId),
      failureStage,
      errorCode: error.code ?? "MEMORY_REMEMBER_FAILED",
      actorId: optionalText(actorValue)
    };
    try {
      this.onDiagnostic(diagnostic);
    } catch {
      // Diagnostics must never hide the original Memory failure.
    }
    if (!session) return;
    try {
      this.store.appendSessionEvent({
        eventId: `event:${this.idFactory()}`,
        sessionId: session.id,
        type: "memory/remember-failed",
        producer: "host-tool",
        surface: false,
        source: { type: "memory-tool", actorId: optionalText(actorValue) },
        payload: diagnostic
      });
    } catch {
      // A diagnostic write failure must never replace the actionable operation error.
    }
  }

  #update(context, args) {
    const memory = this.#manageableMemory(context, args.memory_id);
    if (memory.revoked_at) throw operationError("MEMORY_REVOKED", "A revoked memory is immutable.");
    const hasContent = Object.prototype.hasOwnProperty.call(args, "content");
    const hasTags = Object.prototype.hasOwnProperty.call(args, "tags");
    if (!hasContent && !hasTags) {
      throw operationError("INVALID_INPUT", "content or tags is required.");
    }
    const patch = { version: Number(memory.version ?? 1) + 1 };
    if (hasContent) patch.content = requiredText(args.content, "content");
    if (hasTags) patch.tags = stringList(args.tags);
    this.#appendEvent(context, "memory/update", {
      memoryId: memory.id,
      changedFields: [hasContent ? "content" : null, hasTags ? "tags" : null].filter(Boolean)
    });
    const updated = this.store.updateMemory(memory.id, patch);
    this.store.createMemoryAudit({
      memoryId: memory.id, action: "update", actorType: "user", actorId: context.actorId,
      before: memory, after: updated
    });
    return { scopes: context.scopes, memory: presentMemory(updated) };
  }

  #revoke(context, args) {
    const memory = this.#manageableMemory(context, args.memory_id);
    if (memory.revoked_at) return { scopes: context.scopes, memory: presentMemory(memory), alreadyRevoked: true };
    const revokedAt = this.clock();
    const reason = optionalText(args.reason);
    this.#appendEvent(context, "memory/revoke", { memoryId: memory.id, reason, revokedAt });
    const structuredJson = safeJson(memory.structured_json, {});
    const updated = this.store.updateMemory(memory.id, {
      revokedAt,
      version: Number(memory.version ?? 1) + 1,
      structuredJson: reason
        ? { ...structuredJson, revocation: { reason, revokedAt, sessionId: context.session.id } }
        : structuredJson
    });
    this.store.createMemoryAudit({
      memoryId: memory.id, action: "revoke", actorType: "user", actorId: context.actorId,
      reason, before: memory, after: updated
    });
    return { scopes: context.scopes, memory: presentMemory(updated), alreadyRevoked: false };
  }

  #context(actorValue, metadata = {}) {
    const actorId = requiredText(actorValue, "actorId");
    const agent = this.store.getAgent(actorId);
    if (!agent) throw operationError("AGENT_NOT_FOUND", `Agent not found: ${actorId}`);
    const requestedSessionId = optionalText(metadata?.sessionId);
    const sessionId = requestedSessionId ?? optionalText(agent.currentSessionId);
    const session = sessionId ? this.store.getSession(sessionId) : null;
    if (!session) throw operationError("MEMORY_SESSION_SCOPE_REQUIRED", "Memory tools require the authenticated Agent's current bound Session.");
    const hasBindingResolver = typeof this.resolveAgentForSession === "function";
    const boundAgent = hasBindingResolver
      ? this.resolveAgentForSession(session.id)
      : null;
    if ((hasBindingResolver && !boundAgent) || (boundAgent?.agentId ?? session.agentId) !== actorId) {
      throw operationError("MEMORY_SESSION_SCOPE_REQUIRED", "The requested Session is not bound to the authenticated Agent.");
    }
    const claimedObjectiveId = optionalText(metadata?.objectiveId);
    const claimedTaskId = optionalText(metadata?.taskId);
    if (claimedObjectiveId && claimedObjectiveId !== session.objectiveId) {
      throw operationError("MEMORY_SESSION_SCOPE_REQUIRED", "Objective scope does not match the current Session binding.");
    }
    if (claimedTaskId && claimedTaskId !== session.taskId) {
      throw operationError("MEMORY_SESSION_SCOPE_REQUIRED", "Task scope does not match the current Session binding.");
    }
    const objective = session.objectiveId ? this.store.getObjective(session.objectiveId) : null;
    if (session.objectiveId && !objective) {
      throw operationError("MEMORY_SESSION_SCOPE_REQUIRED", "The current Session references a missing Objective.");
    }
    const task = session.taskId ? this.store.getTask(session.taskId) : null;
    if (session.taskId && (!task || task.objective_id !== session.objectiveId
      || task.current_session_id !== session.id)) {
      throw operationError("MEMORY_SESSION_SCOPE_REQUIRED", "The current Session references an invalid Task binding.");
    }
    const owners = new Map([["agent", { ownerType: "agent", ownerId: actorId }]]);
    if (session.objectiveId) owners.set("objective", { ownerType: "objective", ownerId: session.objectiveId });
    if (session.taskId) owners.set("task", { ownerType: "task", ownerId: session.taskId });
    return {
      actorId,
      agent,
      session,
      owners,
      scopes: {
        sessionId: session.id,
        agentId: actorId,
        objectiveId: session.objectiveId ?? null,
        taskId: session.taskId ?? null
      }
    };
  }

  #owner(context, scope) {
    const owner = context.owners.get(scope);
    if (!owner) {
      throw operationError("MEMORY_SCOPE_FORBIDDEN", `The current Session is not bound to a ${scope} scope.`);
    }
    return owner;
  }

  #manageableMemory(context, memoryIdValue) {
    const memoryId = requiredText(memoryIdValue, "memory_id");
    const memory = this.store.getMemory(memoryId);
    if (!memory) throw operationError("MEMORY_NOT_FOUND", `Memory not found: ${memoryId}`);
    const owner = context.owners.get(memory.owner_type);
    if (!owner || owner.ownerId !== memory.owner_id) {
      throw operationError("MEMORY_SCOPE_FORBIDDEN", "The memory is outside the authenticated current Session scope.");
    }
    return memory;
  }

  #appendEvent(context, type, payload) {
    return this.store.appendSessionEvent({
      eventId: `event:${this.idFactory()}`,
      sessionId: context.session.id,
      type,
      producer: "host-tool",
      surface: false,
      source: { type: "memory-tool", actorId: context.actorId },
      payload
    });
  }

  #result(context, memories) {
    return {
      scopes: context.scopes,
      count: memories.length,
      memories: memories.map(presentMemory)
    };
  }
}

function mostSpecificScope(context) {
  if (context.owners.has("task")) return "task";
  if (context.owners.has("objective")) return "objective";
  return "agent";
}

export function presentMemory(memory) {
  return {
    id: memory.id,
    ownerType: memory.owner_type,
    ownerId: memory.owner_id,
    taskId: memory.task_id ?? null,
    kind: memory.kind,
    content: memory.content,
    structured: safeJson(memory.structured_json, {}),
    tags: safeJson(memory.tags_json, []),
    confidence: Number(memory.confidence ?? 0),
    usageCount: Number(memory.usage_count ?? 0),
    lastAccessedAt: memory.last_accessed_at ?? null,
    sourceType: memory.source_type,
    sourceSessionId: memory.source_session_id ?? null,
    sourceEventSeqs: safeJson(memory.source_event_seqs_json, []),
    promotionStatus: memory.promotion_status,
    promotedSkillId: memory.promoted_skill_id ?? null,
    trustLevel: memory.trust_level ?? "untrusted",
    expiresAt: memory.expires_at ?? null,
    replacesMemoryId: memory.replaces_memory_id ?? null,
    autoApplied: Boolean(memory.auto_applied),
    appliedAt: memory.applied_at ?? null,
    version: Number(memory.version ?? 1),
    revokedAt: memory.revoked_at ?? null,
    createdAt: memory.created_at,
    updatedAt: memory.updated_at
  };
}

function omitMemories(recall) {
  const { memories: _memories, ...metadata } = recall;
  return metadata;
}

function requiredText(value, field) {
  const normalized = optionalText(value);
  if (!normalized) throw operationError("INVALID_INPUT", `${field} is required.`);
  return normalized;
}

function optionalText(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function optionalScope(value) {
  const normalized = optionalText(value);
  if (!normalized) return null;
  if (!SCOPES.has(normalized)) throw operationError("INVALID_MEMORY_SCOPE", `Unsupported memory scope: ${normalized}`);
  return normalized;
}

function stringList(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw operationError("INVALID_INPUT", "tags must be an array.");
  return [...new Set(value.map((entry) => requiredText(entry, "tags[]")))];
}

function safeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function operationError(code, message, stage = null) {
  const error = new Error(message);
  error.code = code;
  if (stage) error.stage = stage;
  return error;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function locateRememberError(error, context, metadata, failureStage) {
  const sessionId = context?.session?.id ?? optionalText(metadata?.sessionId) ?? "unknown";
  const objectiveId = context?.session?.objectiveId ?? optionalText(metadata?.objectiveId) ?? "none";
  if (!String(error.message).includes("[memory context:")) {
    error.message = `${error.message} [memory context: sessionId=${sessionId}, objectiveId=${objectiveId}, stage=${failureStage}]`;
  }
  error.stage = failureStage;
  return error;
}
