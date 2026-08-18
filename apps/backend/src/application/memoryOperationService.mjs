import { randomUUID } from "node:crypto";

const MEMORY_KINDS = new Set([
  "skill", "procedure", "dev_experience", "fact", "lesson", "preference", "feedback", "episodic"
]);
const SCOPES = new Set(["agent", "objective", "work_item"]);

export class MemoryOperationService {
  constructor(options = {}) {
    this.store = options.store;
    this.hubService = options.hubService;
    this.resolveAgentForSession = options.resolveAgentForSession ?? null;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    if (!this.store) throw new TypeError("MemoryOperationService requires a store.");
    if (!this.hubService) throw new TypeError("MemoryOperationService requires a hubService.");
  }

  async execute(input = {}) {
    const tool = requiredText(input.tool, "tool");
    const context = this.#context(input.actorId ?? input.agentId, input.metadata);
    const args = input.arguments ?? {};
    switch (tool) {
      case "corptie_memory_search":
      case "corptie.memory.search":
        return this.#search(context, args);
      case "corptie_memory_list":
        return this.#list(context, args);
      case "corptie_memory_remember":
        return this.#remember(context, args);
      case "corptie_memory_update":
        return this.#update(context, args);
      case "corptie_memory_revoke":
        return this.#revoke(context, args);
      default:
        throw operationError("HOST_TOOL_UNSUPPORTED", `Unsupported Memory tool: ${tool}`);
    }
  }

  async #search(context, args) {
    const memories = await this.hubService.retrieveMemory(String(args.intent ?? ""), context.scopes);
    return this.#result(context, memories);
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
    const memoryScope = optionalScope(args.scope) ?? "agent";
    const owner = this.#owner(context, memoryScope);
    const id = `memory:${this.idFactory()}`;
    const event = this.#appendEvent(context, "memory/remember", {
      memoryId: id,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      kind,
      content
    });
    const memory = this.store.createMemory({
      id,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      kind,
      content,
      tags: stringList(args.tags),
      sourceType: "user",
      sourceSessionId: context.session.id,
      sourceEventSeqs: event ? [event.sequence] : [],
      promotionStatus: "active",
      autoApplied: false,
      appliedAt: this.clock()
    });
    return { scopes: context.scopes, memory: presentMemory(memory) };
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
    return { scopes: context.scopes, memory: presentMemory(this.store.updateMemory(memory.id, patch)) };
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
    const boundAgent = typeof this.resolveAgentForSession === "function"
      ? this.resolveAgentForSession(session.id)
      : null;
    if ((boundAgent?.agentId ?? session.agentId) !== actorId) {
      throw operationError("MEMORY_SESSION_SCOPE_REQUIRED", "The requested Session is not bound to the authenticated Agent.");
    }
    if (requestedSessionId && agent.currentSessionId && requestedSessionId !== agent.currentSessionId) {
      throw operationError("MEMORY_SESSION_SCOPE_REQUIRED", "Memory tools are restricted to the Agent's current Session.");
    }
    const claimedObjectiveId = optionalText(metadata?.objectiveId);
    const claimedWorkItemId = optionalText(metadata?.workItemId);
    if (claimedObjectiveId && claimedObjectiveId !== session.objectiveId) {
      throw operationError("MEMORY_SESSION_SCOPE_REQUIRED", "Objective scope does not match the current Session binding.");
    }
    if (claimedWorkItemId && claimedWorkItemId !== session.workItemId) {
      throw operationError("MEMORY_SESSION_SCOPE_REQUIRED", "WorkItem scope does not match the current Session binding.");
    }
    const objective = session.objectiveId ? this.store.getObjective(session.objectiveId) : null;
    if (session.objectiveId && !objective) {
      throw operationError("MEMORY_SESSION_SCOPE_REQUIRED", "The current Session references a missing Objective.");
    }
    const workItem = session.workItemId ? this.store.getWorkItem(session.workItemId) : null;
    if (session.workItemId && (!workItem || workItem.objective_id !== session.objectiveId)) {
      throw operationError("MEMORY_SESSION_SCOPE_REQUIRED", "The current Session references an invalid WorkItem binding.");
    }
    const owners = new Map([["agent", { ownerType: "agent", ownerId: actorId }]]);
    if (session.objectiveId) owners.set("objective", { ownerType: "objective", ownerId: session.objectiveId });
    if (session.workItemId) owners.set("work_item", { ownerType: "work_item", ownerId: session.workItemId });
    return {
      actorId,
      agent,
      session,
      owners,
      scopes: {
        sessionId: session.id,
        agentId: actorId,
        objectiveId: session.objectiveId ?? null,
        workItemId: session.workItemId ?? null
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

export function presentMemory(memory) {
  return {
    id: memory.id,
    ownerType: memory.owner_type,
    ownerId: memory.owner_id,
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
    version: Number(memory.version ?? 1),
    revokedAt: memory.revoked_at ?? null,
    createdAt: memory.created_at,
    updatedAt: memory.updated_at
  };
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

function operationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
