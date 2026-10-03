import { deviceError } from "./clientDeviceAuthority.mjs";
import { executeClientCommand } from "./clientEntityCommands.mjs";
import { presentMemory, createUserMemory, reviewExtractedMemory } from "./memoryOperationService.mjs";
import { presentMemoryRecallAudit } from "./memoryRecallService.mjs";
import { validateMemoryInput } from "./entityHttpApi.mjs";

const ACTION_FIELDS = {
  "reference.create": ["targetType", "targetId", "locator", "displayName"],
  "reference.update": ["id", "enabled"], "reference.delete": ["id"], "reference.refresh": ["id"],
  "reference.import": ["fileName", "dataBase64"], "artifact.import": ["fileName", "dataBase64", "title"],
  "artifact.create": ["title", "summary", "content", "mimeType", "relation", "required", "versionPolicy"],
  "artifact.publish": ["id", "title", "summary", "content", "expectedResourceVersion", "expectedPinnedVersion", "expectedPinnedHash", "referenceId"],
  "artifact.reference": ["id", "version", "required", "relation"],
  "artifact.acknowledge": ["id", "confirmed"],
  "artifact.unreference": ["id", "reason", "confirmed"],
  "artifact.revoke": ["id", "reason", "confirmed"],
  "artifact.supersede": ["id", "confirmed"],
  "provider.switch": ["providerId", "expectedRoutingVersion", "confirmed"],
  "memory.create": ["kind", "content", "tags"],
  "memory.update": ["id", "content", "tags", "expectedVersion"],
  "memory.revoke": ["id", "reason", "confirmed", "expectedVersion"],
  "memory.restore": ["id", "reason", "confirmed", "expectedVersion"],
  "memory.rollback": ["id", "auditId", "confirmed", "expectedVersion"],
  "memory.confirm": ["id", "content", "confirmed", "expectedVersion"],
  "memory.reject": ["id", "reason", "confirmed", "expectedVersion"],
  "task.update": ["title", "description", "acceptanceCriteria", "verificationCriteria", "priority", "mainAgentId"],
  "task.reclaimWorktree": ["confirmed"],
};

/** Paired-user facade over the same services as desktop. Never proxies a URL. */
export class ClientInspectorAPI {
  constructor(options) { Object.assign(this, options); }
  scope(id, identity) {
    let reference;
    try { reference = this.resolveSession(id); }
    catch (error) {
      if (error.code === "SESSION_NOT_FOUND") throw deviceError("SESSION_NOT_FOUND", 404);
      throw error;
    }
    const session = this.store.getSession(reference.sessionId);
    if (!session || session.archived) throw deviceError("SESSION_NOT_FOUND", 404);
    const task = session.taskId ? this.store.getTask(session.taskId) : null;
    const workId = task?.work_id ?? session.workId ?? null;
    return { session, sessionId: reference.sessionId, logicalSessionId: reference.logicalSessionId, routingVersion: reference.routingVersion,
      task, workId, actor: { type: "user", id: `client-device:${identity.deviceId}` },
      context: { kind: "local_user", actorId: `client-device:${identity.deviceId}`, workId } };
  }
  async snapshot(identity, id) {
    const scope = this.scope(id, identity);
    const { session, task, workId, sessionId } = scope;
    const sections = {};
    const errors = {};
    // Independent sections retain independent failures; an Artifact timeout is not an empty list.
    const read = async (key, operation) => {
      try { sections[key] = await operation(); }
      catch (error) { errors[key] = error.code ?? "INSPECTOR_SECTION_FAILED"; }
    };
    await Promise.all([
      read("references", () => this.references.list(sessionId)),
      read("artifacts", () => workId ? this.artifactPage(scope, 0) : { items: [], hasMore: false }),
      read("memories", () => this.memoryPage(scope)),
      read("recalls", () => this.store.listMemoryRecallAudit({ sessionId, limit: 8 })
        .map((audit) => presentMemoryRecallAudit(this.store, audit))),
      read("schedules", () => this.schedules.list({ logicalSessionId: scope.logicalSessionId, status: "active" }, scope.actor)),
      read("turn", () => this.observability.latestSummary(scope.logicalSessionId ?? sessionId, { kind: "local_user" })),
      read("providers", () => this.providers(sessionId))
    ]);
    if (workId && !task) {
      const focus = this.store.listTasksByWork(workId).filter(row => !row.archived && !row.deletion_status && row.lifecycle_state !== "done")
        .map(row => {
          const summary = parseSummary(row.user_summary_json);
          const current = summary?.state === "ready" && summary?.content?.schemaVersion === 1 && summary?.content?.basis?.taskRevision === row.revision;
          return { id: row.id, title: row.title, taskRevision: row.revision, updatedAt: row.updated_at,
            needsIntervention: current && summary.content.intervention === "required", summary };
        }).sort((a, b) => Number(b.needsIntervention) - Number(a.needsIntervention) || b.updatedAt.localeCompare(a.updatedAt));
      sections.focusTasks = focus.slice(0, 3);
    }
    return { schemaVersion: 1, sessionId: id, resolvedSessionId: sessionId,
      workId, taskId: task?.id ?? null, taskDefinition: task ? {
        description: task.description ?? "", acceptanceCriteria: task.acceptance_criteria ?? "",
        verificationCriteria: task.verification_criteria ?? "", summary: parseSummary(task.user_summary_json),
        title: task.title, revision: task.revision, priority: task.priority, mainAgentId: task.main_agent_id, lifecycleState: task.lifecycle_state,
        agents: (this.store.getWork(workId)?.contributorAgentIds ?? []).map(id => {
          const agent = this.store.getAgent(id); return { id, name: agent?.name ?? id };
        })
      } : null,
      workDescription: workId ? this.store.getWork(workId)?.description ?? "" : null,
      summary: session.summary ?? null,
      environment: { provider: session.external?.provider ?? null, agentId: session.agentId ?? null,
        cwd: session.external?.cwd ?? null, routingVersion: scope.routingVersion ?? null },
      sections, errors };
  }
  artifactPage(scope, offset) {
    const { task, workId, context } = scope;
    const options = { limit: 20, offset, currentWorkOnly: true };
    const items = task ? this.artifacts.listForTask(context, task.id, options) : this.artifacts.list(context, options);
    const total = task ? this.store.countArtifactsReferencedByTask(task.id) : this.store.countArtifactsByWork(workId);
    const projected = items.map(item => ({ ...item,
      versions: (item.versions ?? []).map(({ storageKey, ...version }) => version),
      audit: (item.audit ?? []).slice(0, 30)
    }));
    return { items: projected, hasMore: offset + items.length < total, nextOffset: offset + items.length < total ? offset + items.length : null };
  }
  memoryPage(scope, cursor = undefined) {
    const ownerType = scope.task ? "task" : "work";
    const ownerId = scope.task?.id ?? scope.workId;
    if (!ownerId) return { items: [], hasMore: false };
    const page = this.store.listMemoryPage({ ownerType, ownerId, includeRevoked: true, limit: 50, cursor });
    return { items: page.items.map(presentMemory), hasMore: page.hasMore, nextCursor: page.nextCursor ?? null };
  }
  async read(identity, sessionId, resource, input = {}) {
    const scope = this.scope(sessionId, identity);
    if (resource === "artifacts") {
      if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !scope.workId) throw deviceError("INVALID_OFFSET", 400);
      return this.artifactPage(scope, input.offset);
    }
    if (resource === "memories") return this.memoryPage(scope, input.cursor);
    if (resource === "artifact") {
      this.artifact(scope, input.id);
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.readId ?? "")) throw deviceError("INVALID_READ_ID", 400);
      return this.artifacts.get(scope.context, input.id, {
        version: input.version, contentHash: input.contentHash, referenceId: input.referenceId,
        offset: input.offset, limit: 65536, turnExecutionId: `device-inspector:${identity.deviceId}:${input.readId}`
      });
    }
    if (resource === "trace") {
      const summary = this.observability.summary(input.id, { kind: "local_user" });
      if (!summary || summary.identity.logicalSessionId !== (scope.logicalSessionId ?? scope.sessionId)) throw deviceError("TURN_NOT_CURRENT", 409);
      return this.observability.spans(input.id, { cursor: input.cursor, limit: 100, context: { kind: "local_user" } });
    }
    if (resource === "memory-audit") {
      this.memory(scope, input.id);
      return { items: this.store.listMemoryAudit({ memoryId: input.id }) };
    }
    if (resource === "task-worktree") {
      if (!scope.task) throw deviceError("TASK_REQUIRED", 409);
      return this.inspectTaskWorktree(scope.task.id);
    }
    throw deviceError("ROUTE_NOT_AVAILABLE", 404);
  }
  artifact(scope, id) {
    const artifact = this.store.getArtifact(id);
    if (!artifact || artifact.workId !== scope.workId) throw deviceError("ARTIFACT_NOT_FOUND", 404);
    return artifact;
  }
  memory(scope, id) {
    const memory = this.store.getMemory(id);
    if (!memory || memory.owner_type !== (scope.task ? "task" : "work")
        || memory.owner_id !== (scope.task?.id ?? scope.workId)) throw deviceError("MEMORY_NOT_FOUND", 404);
    return memory;
  }
  command(api, identity, sessionId, input, revalidate) {
    const scope = this.scope(sessionId, identity);
    const fields = ACTION_FIELDS[input?.action];
    if (!fields || !/^[A-Za-z0-9_-]{8,128}$/.test(input?.requestId ?? "")
        || !input.fields || typeof input.fields !== "object" || Array.isArray(input.fields)
        || Object.keys(input.fields).some(key => !fields.includes(key))) throw deviceError("INVALID_INSPECTOR_COMMAND", 400);
    return executeClientCommand(api, identity, revalidate, {
      kind: `inspector:${input.action}`, entityId: scope.sessionId, requestId: input.requestId,
      fields: input.fields, uncertainCode: "INSPECTOR_OUTCOME_UNCERTAIN",
      run: fingerprint => this.perform(this.scope(sessionId, identity), input.action, input.fields, fingerprint)
    });
  }
  async perform(scope, action, fields, fingerprint) {
    const { sessionId, context, task } = scope;
    switch (action) {
      case "reference.import": case "artifact.import": return this.importFile(scope, action, fields);
      case "reference.create": return this.references.create(sessionId, fields.targetType === "session"
        ? { ...fields, targetId: this.resolveSession(fields.targetId).sessionId } : fields);
      case "reference.update": {
        if (typeof fields.enabled !== "boolean") throw deviceError("INVALID_ENABLED", 400);
        return this.references.update(sessionId, fields.id, { enabled: fields.enabled });
      }
      case "reference.delete": this.references.delete(sessionId, fields.id); return { removed: true };
      case "reference.refresh": return this.references.refresh(sessionId, fields.id);
      case "artifact.create": {
        if (!scope.workId) throw deviceError("WORK_REQUIRED", 409);
        if (fields.versionPolicy && !["fixed", "latest_approved"].includes(fields.versionPolicy)) throw deviceError("INVALID_VERSION_POLICY", 400);
        if (fields.relation && !["implementation_spec", "security_requirement", "test_plan", "research_evidence", "handoff", "acceptance_evidence"].includes(fields.relation)) throw deviceError("INVALID_ARTIFACT_RELATION", 400);
        const artifact = await this.artifacts.create(context, { ...fields,
          visibility: task ? "task_private" : "work_private", boundTaskId: task?.id });
        if (task) {
          try { this.artifacts.createReference(context, artifact.artifactId, {
            taskId: task.id, relation: fields.relation ?? "implementation_spec", required: fields.required === true, versionPolicy: fields.versionPolicy ?? "fixed"
          }); } catch { throw deviceError("ARTIFACT_CREATED_REFERENCE_UNCERTAIN", 500); }
        }
        return { artifactId: artifact.artifactId };
      }
      case "artifact.publish": {
        const artifact = this.artifact(scope, fields.id);
        if (task && artifact.visibility === "task_private" && artifact.boundTaskId === task.id) {
          return this.artifacts.publishAndRepin(context, fields.id,
            { ...fields, taskId: task.id, idempotencyKey: fingerprint });
        }
        if (task && artifact.scope !== "work") throw deviceError("ARTIFACT_READ_ONLY", 409);
        return this.artifacts.publishVersion(context, fields.id, fields);
      }
      case "artifact.reference": {
        this.artifact(scope, fields.id);
        if (!task) throw deviceError("TASK_REQUIRED", 409);
        return this.artifacts.createReference(context, fields.id, { ...fields, taskId: task.id, versionPolicy: "fixed" });
      }
      case "artifact.acknowledge": case "artifact.unreference": {
        const reference = this.store.getArtifactReference(fields.id);
        if (!reference || reference.workId !== scope.workId || reference.taskId !== task?.id) throw deviceError("REFERENCE_NOT_FOUND", 404);
        if (fields.confirmed !== true) throw deviceError("CONFIRMATION_REQUIRED", 409);
        return action === "artifact.acknowledge" ? this.artifacts.acknowledgePendingReference(context, fields.id)
          : this.artifacts.revokeReference(context, fields.id, fields.reason);
      }
      case "artifact.supersede": case "artifact.revoke": {
        this.artifact(scope, fields.id);
        if (fields.confirmed !== true) throw deviceError("CONFIRMATION_REQUIRED", 409);
        return action === "artifact.supersede" ? this.artifacts.supersede(context, fields.id)
          : this.artifacts.revokeArtifact(context, fields.id, fields.reason);
      }
      case "provider.switch": {
        if (fields.confirmed !== true) throw deviceError("CONFIRMATION_REQUIRED", 409);
        return this.switchProvider(sessionId, fields.providerId, fingerprint, fields.expectedRoutingVersion);
      }
      case "task.update": {
        if (!task) throw deviceError("TASK_REQUIRED", 409);
        if (fields.mainAgentId && !(this.store.getWork(scope.workId)?.contributorAgentIds ?? []).includes(fields.mainAgentId)) {
          throw deviceError("AGENT_OUTSIDE_WORK", 403);
        }
        return this.updateTask(task.id, fields);
      }
      case "task.reclaimWorktree": {
        if (!task) throw deviceError("TASK_REQUIRED", 409);
        if (fields.confirmed !== true) throw deviceError("CONFIRMATION_REQUIRED", 409);
        return this.reclaimTaskWorktree(task.id);
      }
      case "memory.create": {
        const input = { ownerType: task ? "task" : "work", ownerId: task?.id ?? scope.workId,
          kind: fields.kind, content: fields.content, tags: tags(fields.tags), sourceSessionId: sessionId };
        validateMemoryInput(input, this.store);
        return presentMemory(createUserMemory(this.store, input, scope.actor.id));
      }
      case "memory.rollback": {
        const memory = this.memory(scope, fields.id);
        const audit = this.store.getMemoryAudit(fields.auditId);
        if (!audit || audit.memoryId !== memory.id) throw deviceError("MEMORY_AUDIT_NOT_FOUND", 404);
        if (fields.confirmed !== true) throw deviceError("CONFIRMATION_REQUIRED", 409);
        if (Number(fields.expectedVersion) !== Number(memory.version ?? 1)) throw deviceError("MEMORY_VERSION_CHANGED", 409);
        const restored = this.store.rollbackMemoryAudit(fields.auditId, scope.actor.id);
        if (!restored) throw deviceError("MEMORY_AUDIT_NOT_ROLLBACKABLE", 409);
        return presentMemory(restored);
      }
      case "memory.confirm": case "memory.reject": {
        this.memory(scope, fields.id);
        if (fields.confirmed !== true) throw deviceError("CONFIRMATION_REQUIRED", 409);
        return presentMemory(reviewExtractedMemory(this.store, fields.id, {
          action: action === "memory.confirm" ? "confirm" : "reject",
          content: fields.content, expectedVersion: fields.expectedVersion,
          reason: fields.reason, actorId: scope.actor.id
        }));
      }
      case "memory.update": case "memory.revoke": case "memory.restore": {
        const memory = this.memory(scope, fields.id);
        if (Number(fields.expectedVersion) !== Number(memory.version ?? 1)) throw deviceError("MEMORY_VERSION_CHANGED", 409);
        const patch = { version: Number(memory.version ?? 1) + 1 };
        if (action === "memory.update") {
          if (memory.revoked_at) throw deviceError("MEMORY_REVOKED", 409);
          if (typeof fields.content !== "string" || !fields.content.trim()) throw deviceError("INVALID_MEMORY_CONTENT", 400);
          patch.content = fields.content.trim(); patch.tags = tags(fields.tags);
        } else {
          if (fields.confirmed !== true) throw deviceError("CONFIRMATION_REQUIRED", 409);
          patch.revokedAt = action === "memory.revoke" ? new Date().toISOString() : null;
        }
        const updated = this.store.updateMemory(memory.id, patch);
        this.store.createMemoryAudit({ memoryId: memory.id, action: action.split(".")[1],
          actorType: "user", actorId: scope.actor.id, before: memory, after: updated, reason: fields.reason ?? null });
        return presentMemory(updated);
      }
      default: throw deviceError("ROUTE_NOT_AVAILABLE", 404);
    }
  }
}

function tags(value) {
  const items = typeof value === "string" ? value.split(",").map(v => v.trim()).filter(Boolean) : value ?? [];
  if (!Array.isArray(items) || items.some(v => typeof v !== "string" || !v.trim())) throw deviceError("INVALID_TAGS", 400);
  return items;
}
function parseSummary(value) { try { return JSON.parse(value ?? "null"); } catch { return null; } }
