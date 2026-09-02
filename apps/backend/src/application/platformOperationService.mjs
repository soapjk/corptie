import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { resolvePlatformAdminSession } from "../utils/platformAssistantIdentity.mjs";
import { stableJson } from "./platformConfirmationService.mjs";

const PLATFORM_OPERATIONS = Object.freeze({
  corptie_platform_agents_manage: ["list", "get", "create", "update", "delete"],
  corptie_platform_objectives_manage: ["list", "get", "create", "update", "delete"],
  corptie_platform_tasks_manage: ["list", "get", "create", "update", "delete", "dependencies", "add_dependency", "remove_dependency"],
  corptie_platform_sessions_manage: ["list", "get", "create", "send", "interrupt", "resume", "disconnect", "rename", "archive", "pin", "delete", "clear", "restart", "respond_to_approval", "manage_turn_changes", "list_models", "read_account_usage", "read_session_usage", "switch_model", "switch_reasoning", "update_permissions"],
  corptie_platform_artifacts_manage: ["list", "get", "search", "create", "update_metadata", "import", "publish", "reference", "revoke_reference", "acknowledge_reference", "change_visibility", "supersede", "revoke", "restore_artifact", "verify_integrity", "export", "backup", "restore"],
  corptie_platform_collaboration_manage: ["discover_sessions", "get_session", "create_task", "start_worker", "request"]
});

const PLATFORM_DOMAIN_COVERAGE = Object.freeze([
  { domain: "Agent", tool: "corptie_platform_agents_manage", boundary: "Store Agent resource service" },
  { domain: "Objective", tool: "corptie_platform_objectives_manage", boundary: "ObjectiveApplicationService" },
  { domain: "Task", tool: "corptie_platform_tasks_manage", boundary: "ObjectiveApplicationService" },
  { domain: "Session", tool: "corptie_platform_sessions_manage", boundary: "SessionApplicationService / AgentProviderRegistry" },
  { domain: "Artifact", tool: "corptie_platform_artifacts_manage", boundary: "ArtifactService" },
  { domain: "Collaboration", tool: "corptie_platform_collaboration_manage", boundary: "CollaborationCore and shared Session lifecycle" },
  { domain: "Workspace", tool: "corptie_workspace_*", boundary: "provider-neutral project workspace service" },
  { domain: "Worktree", tool: "corptie_workspace_*", boundary: "provider-neutral project worktree service" },
  { domain: "Automation", tool: "corptie_scheduled_tasks_manage", boundary: "ScheduledSessionTaskService" },
  { domain: "Memory", tool: "corptie_memory_*", boundary: "MemoryOperationService" },
  { domain: "Skill", tool: "corptie_skill_*", boundary: "SkillRegistryService" },
  { domain: "Service", tool: null, boundary: "read-only service registry; mutation not exposed" },
  { domain: "Settings", tool: null, boundary: "local-user HTTP settings service; model mutation intentionally unavailable" }
]);

const MUTATIONS_REQUIRING_IDEMPOTENCY = new Set(["create", "import", "publish", "reference", "create_task", "start_worker", "request"]);
const CONFIRMED_ARTIFACT_ACTIONS = new Set(["change_visibility", "supersede", "revoke", "revoke_reference", "acknowledge_reference", "export", "backup", "restore"]);

export class PlatformOperationService {
  constructor(options = {}) {
    Object.assign(this, {
      store: options.store, objectiveService: options.objectiveService, sessionService: options.sessionService,
      artifactService: options.artifactService, collaborationCore: options.collaborationCore,
      confirmationService: options.confirmationService,
      sessionRuntimeReleaseService: options.sessionRuntimeReleaseService ?? null,
      listSessions: options.listSessions ?? ((input) => options.sessionService.listSessions(input)),
      createSession: options.createSession, onEntityChanged: options.onEntityChanged ?? null,
      idFactory: options.idFactory ?? randomUUID, clock: options.clock ?? (() => new Date().toISOString())
    });
    if (!this.store || !this.objectiveService || !this.sessionService) throw new TypeError("PlatformOperationService requires store, objectiveService, and sessionService.");
    if (typeof this.createSession !== "function") throw new TypeError("PlatformOperationService requires createSession().");
  }

  emitEntityChanged(type, entity, action) { this.onEntityChanged?.(type, { action, entity }); return entity; }
  capabilities() { return { operations: Object.entries(PLATFORM_OPERATIONS).map(([tool, actions]) => ({ tool, actions: [...actions] })), domains: PLATFORM_DOMAIN_COVERAGE }; }

  async execute(input = {}) {
    const binding = resolvePlatformAdminSession(this.store, { actorId: input.actorId, sessionId: input.sessionId });
    const args = plainObject(input.arguments ?? {}, "arguments");
    if (input.tool === "corptie_platform_capabilities") assertKnown(args, []);
    const action = input.tool === "corptie_platform_capabilities" ? "list" : required(args.action, "action");
    const requestDigest = digest({ tool: input.tool, action, args });
    const idempotencyKey = optional(args.idempotency_key);
    if (["corptie_platform_artifacts_manage", "corptie_platform_collaboration_manage"].includes(input.tool)
      && MUTATIONS_REQUIRING_IDEMPOTENCY.has(action) && !idempotencyKey) {
      throw coded("IDEMPOTENCY_KEY_REQUIRED", `idempotency_key is required for platform ${action}.`);
    }
    if (idempotencyKey) {
      const prior = this.store.selectOne("SELECT * FROM platform_admin_operations WHERE actor_session_id=? AND idempotency_key=?", [binding.actorSessionId, idempotencyKey]);
      if (prior) {
        if (prior.request_digest !== requestDigest) throw coded("IDEMPOTENCY_CONFLICT", "idempotency_key is already bound to different platform input.");
        return { ...JSON.parse(prior.result_json), idempotentReplay: true };
      }
    }
    let result;
    switch (input.tool) {
      case "corptie_platform_capabilities": result = this.capabilities(); break;
      case "corptie_platform_agents_manage": result = await this.#agents(args); break;
      case "corptie_platform_objectives_manage": result = await this.#objectives(args); break;
      case "corptie_platform_tasks_manage": result = await this.#tasks(args); break;
      case "corptie_platform_sessions_manage": result = await this.#sessions(args, binding); break;
      case "corptie_platform_artifacts_manage": result = await this.#artifacts(args, binding, input.tool); break;
      case "corptie_platform_collaboration_manage": result = await this.#collaboration(args, binding); break;
      default: throw coded("HOST_TOOL_UNSUPPORTED", `Unsupported Corptie platform tool: ${input.tool}`);
    }
    const target = receiptTarget(input.tool, args, result);
    const receipt = { ok: true, operation: `${input.tool}.${action}`, actorSessionId: binding.actorSessionId, target, auditId: `platform_operation:${this.idFactory()}`, idempotencyKey, idempotentReplay: false, result };
    this.store.db.run(
      `INSERT INTO platform_admin_operations
       (operation_id, actor_session_id, tool_name, action, target_type, target_id, target_version, idempotency_key, request_digest, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [receipt.auditId, binding.actorSessionId, input.tool, action, target.type, target.id, target.version == null ? null : String(target.version), idempotencyKey, requestDigest, JSON.stringify(receipt), this.clock()]
    );
    this.store.scheduleSave();
    return receipt;
  }

  #agents(args) {
    assertKnown(args, ["action", "agent_id", "name", "description", "role", "system_prompt", "capabilities", "skill_ids", "work_dir", "avatar_path", "idempotency_key"]);
    switch (required(args.action, "action")) {
      case "list": return this.store.listAgents();
      case "get": return found(this.store.getAgent(required(args.agent_id, "agent_id")), "AGENT_NOT_FOUND");
      case "create": return this.emitEntityChanged("AgentChanged", this.store.createAgentWithRegistrySkills({ name: required(args.name, "name"), description: args.description ?? "", role: args.role, systemPrompt: args.system_prompt ?? "", capabilities: array(args.capabilities), workDir: optional(args.work_dir), avatarPath: optional(args.avatar_path) }, array(args.skill_ids)), "created");
      case "update": return this.emitEntityChanged("AgentChanged", found(this.store.updateAgentWithRegistrySkills(required(args.agent_id, "agent_id"), compact({ name: args.name, description: args.description, systemPrompt: args.system_prompt, capabilities: args.capabilities, workDir: args.work_dir, avatarPath: args.avatar_path }), Array.isArray(args.skill_ids) ? args.skill_ids : null), "AGENT_NOT_FOUND"), "updated");
      case "delete": { const agentId = required(args.agent_id, "agent_id"); found(this.store.getAgent(agentId), "AGENT_NOT_FOUND"); this.store.deleteAgent(agentId); this.emitEntityChanged("AgentChanged", { agentId }, "deleted"); return { deleted: true }; }
      default: throw unsupported("Agent", args.action);
    }
  }

  #objectives(args) {
    assertKnown(args, ["action", "objective_id", "name", "patch", "idempotency_key"]);
    switch (required(args.action, "action")) {
      case "list": return this.objectiveService.listObjectives();
      case "get": return this.objectiveService.getObjective(required(args.objective_id, "objective_id"));
      case "create": return this.objectiveService.createObjective({ ...(args.patch ?? {}), name: required(args.name, "name") });
      case "update": return this.objectiveService.updateObjective(required(args.objective_id, "objective_id"), args.patch ?? {});
      case "delete": this.objectiveService.deleteObjective(required(args.objective_id, "objective_id")); return { deleted: true };
      default: throw unsupported("Objective", args.action);
    }
  }

  #tasks(args) {
    assertKnown(args, ["action", "task_id", "target_task_id", "objective_id", "title", "dependency_type", "patch", "idempotency_key"]);
    switch (required(args.action, "action")) {
      case "list": return args.objective_id ? this.objectiveService.listTasksByObjective(args.objective_id) : this.objectiveService.listTasks();
      case "get": return this.objectiveService.getTask(required(args.task_id, "task_id"));
      case "create": return this.objectiveService.createTask({ ...(args.patch ?? {}), objectiveId: required(args.objective_id, "objective_id"), title: required(args.title, "title") });
      case "update": return this.objectiveService.updateTask(required(args.task_id, "task_id"), args.patch ?? {});
      case "delete": this.objectiveService.deleteTask(required(args.task_id, "task_id")); return { deleted: true };
      case "dependencies": return this.objectiveService.listDependencies(required(args.task_id, "task_id"));
      case "add_dependency": return this.objectiveService.addDependency(required(args.task_id, "task_id"), required(args.target_task_id, "target_task_id"), args.dependency_type ?? "depends_on");
      case "remove_dependency": this.objectiveService.removeDependency(required(args.task_id, "task_id"), required(args.target_task_id, "target_task_id")); return { removed: true };
      default: throw unsupported("Task", args.action);
    }
  }

  async #sessions(args, binding) {
    assertKnown(args, ["action", "session_id", "agent_id", "provider_id", "task_id", "resource_version", "title", "prompt", "message", "archived", "pinned", "include_archived", "approval", "turn_id", "change_action", "model_id", "reasoning_level", "permissions", "idempotency_key"]);
    const context = {
      source: "platform-assistant",
      actorId: binding.agent.agentId,
      actorSessionId: binding.actorSessionId,
      idempotencyKey: optional(args.idempotency_key)
    };
    switch (required(args.action, "action")) {
      case "list": { const active = await this.listSessions({ archived: false }); if (args.include_archived !== true) return active; const archived = await this.listSessions({ archived: true }); return [...new Map([...active, ...archived].map((item) => [item.id, item])).values()]; }
      case "get": return this.#storedSession(required(args.session_id, "session_id"));
      case "create": return this.createSession({
        agentId: required(args.agent_id, "agent_id"),
        providerId: required(args.provider_id, "provider_id"),
        taskId: optional(args.task_id),
        expectedTaskVersion: args.task_id ? positiveInteger(args.resource_version, "resource_version") : undefined,
        title: optional(args.title),
        prompt: optional(args.prompt),
        sourceSessionId: binding.logicalSessionId ?? binding.actorSessionId,
        idempotencyKey: optional(args.idempotency_key)
      });
      case "send": return this.sessionService.sendMessage(required(args.session_id, "session_id"), required(args.message, "message"), context);
      case "interrupt": return this.sessionService.interrupt(required(args.session_id, "session_id"), context);
      case "resume": return this.sessionService.resumeSession(required(args.session_id, "session_id"), context);
      case "disconnect": return this.sessionService.disconnectSession(required(args.session_id, "session_id"), context);
      case "rename": return this.sessionService.renameSession(required(args.session_id, "session_id"), required(args.title, "title"), context);
      case "archive": {
        const sessionId = required(args.session_id, "session_id");
        const archived = args.archived !== false;
        const session = found(this.store.archiveSession(sessionId, archived), "SESSION_NOT_FOUND");
        if (archived) void this.sessionRuntimeReleaseService?.request(session.id, "manual-archive");
        else if (this.sessionRuntimeReleaseService) await this.sessionRuntimeReleaseService.restore(session.id);
        return session;
      }
      case "pin": return found(this.store.pinSession(required(args.session_id, "session_id"), args.pinned !== false), "SESSION_NOT_FOUND");
      case "delete": return this.sessionService.deleteSession(required(args.session_id, "session_id"), context);
      case "clear": return this.sessionService.clearConversation(required(args.session_id, "session_id"), context);
      case "restart": return this.sessionService.restartSession(required(args.session_id, "session_id"), context);
      case "respond_to_approval": return this.sessionService.respondToApproval(required(args.session_id, "session_id"), args.approval ?? {}, context);
      case "manage_turn_changes": return this.sessionService.manageTurnChanges(required(args.session_id, "session_id"), required(args.turn_id, "turn_id"), required(args.change_action, "change_action"), context);
      case "list_models": return this.sessionService.listModelsForSession(required(args.session_id, "session_id"), context);
      case "read_account_usage": return this.#storedUsage(required(args.session_id, "session_id")).account;
      case "read_session_usage": return this.#storedUsage(required(args.session_id, "session_id")).context;
      case "switch_model": return this.sessionService.switchModel(required(args.session_id, "session_id"), required(args.model_id, "model_id"), context);
      case "switch_reasoning": return this.sessionService.switchReasoning(required(args.session_id, "session_id"), required(args.reasoning_level, "reasoning_level"), context);
      case "update_permissions": return this.sessionService.updatePermissions(required(args.session_id, "session_id"), args.permissions ?? {}, context);
      default: throw unsupported("Session", args.action);
    }
  }

  async #artifacts(args, binding, tool) {
    assertKnown(args, ["action", "objective_id", "artifact_id", "reference_id", "title", "summary", "content", "query", "limit", "offset", "version", "visibility", "scope", "kind", "category_path", "tags", "aliases", "keywords", "kinds", "category_prefix", "bound_task_id", "bound_session_id", "repository_locator", "mime_type", "approval_status", "task_id", "session_id", "relation", "required", "version_policy", "reason", "source_path", "destination_path", "confirmation_id", "confirmed_repository_write", "confirmed_overwrite", "include_revoked", "idempotency_key"]);
    if (!this.artifactService) throw coded("PLATFORM_ARTIFACTS_UNAVAILABLE", "Artifact platform service is unavailable.");
    const objectiveId = required(args.objective_id, "objective_id");
    const context = { kind: "platform_admin", actorId: binding.agent.agentId, sessionId: binding.actorSessionId, objectiveId };
    const action = required(args.action, "action");
    if (CONFIRMED_ARTIFACT_ACTIONS.has(action) || (action === "create" && args.visibility === "repository_tracked")) {
      if (!this.confirmationService) throw coded("PLATFORM_CONFIRMATION_UNAVAILABLE", "Server confirmation service is unavailable.");
      this.confirmationService.consume({ confirmationId: args.confirmation_id, actorSessionId: binding.actorSessionId, tool, arguments: args });
    }
    switch (action) {
      case "list": return { artifacts: this.artifactService.list(context, { includeRevoked: args.include_revoked }) };
      case "get": return this.artifactService.get(context, required(args.artifact_id, "artifact_id"), { version: args.version, offset: args.offset, limit: args.limit });
      case "search": return this.artifactService.search(context, required(args.query, "query"), { limit: args.limit, scope: args.scope, kinds: args.kinds, categoryPrefix: args.category_prefix, tags: args.tags });
      case "create": return this.artifactService.create(context, artifactCreateInput(args, args.visibility === "repository_tracked"));
      case "update_metadata": return this.artifactService.updateMetadata(context, required(args.artifact_id, "artifact_id"), { title: args.title, summary: args.summary, kind: args.kind, categoryPath: args.category_path, tags: args.tags, aliases: args.aliases, keywords: args.keywords });
      case "import": assertAbsolute(args.source_path, "source_path"); return this.artifactService.importLocalFile(context, { ...artifactCreateInput(args, false), path: args.source_path });
      case "publish": return this.artifactService.publishVersion(context, required(args.artifact_id, "artifact_id"), { content: args.content, summary: args.summary, mimeType: args.mime_type, approvalStatus: args.approval_status });
      case "reference": return this.artifactService.createReference(context, required(args.artifact_id, "artifact_id"), { taskId: args.task_id, sessionId: args.session_id, relation: args.relation, required: args.required, versionPolicy: args.version_policy, version: args.version });
      case "revoke_reference": return this.artifactService.revokeReference(context, required(args.reference_id, "reference_id"), required(args.reason, "reason"));
      case "acknowledge_reference": return this.artifactService.acknowledgePendingReference(context, required(args.reference_id, "reference_id"));
      case "change_visibility": return this.artifactService.changeVisibility(context, required(args.artifact_id, "artifact_id"), required(args.visibility, "visibility"), { confirmed: true });
      case "supersede": return this.artifactService.supersede(context, required(args.artifact_id, "artifact_id"));
      case "revoke": return this.artifactService.revokeArtifact(context, required(args.artifact_id, "artifact_id"), required(args.reason, "reason"));
      case "restore_artifact": return this.artifactService.restoreArtifact(context, required(args.artifact_id, "artifact_id"));
      case "verify_integrity": { const artifact = this.store.getArtifact(required(args.artifact_id, "artifact_id")); if (!artifact || artifact.objectiveId !== objectiveId) throw coded("ARTIFACT_NOT_FOUND", "Artifact not found in the selected Objective."); return this.artifactService.verifyIntegrity(artifact.artifactId); }
      case "export": assertAbsolute(args.destination_path, "destination_path"); return this.artifactService.exportArtifact(context, required(args.artifact_id, "artifact_id"), { version: args.version, destinationPath: args.destination_path, confirmed: true, confirmedRepositoryWrite: args.confirmed_repository_write === true, confirmedOverwrite: args.confirmed_overwrite === true });
      case "backup": assertAbsolute(args.destination_path, "destination_path"); return this.artifactService.backupObjective(context, { destinationPath: args.destination_path, confirmed: true });
      case "restore": assertAbsolute(args.source_path, "source_path"); return this.artifactService.restoreObjective(context, { sourcePath: args.source_path, confirmed: true });
      default: throw unsupported("Artifact", action);
    }
  }

  async #collaboration(args, binding) {
    assertKnown(args, ["action", "session_id", "objective_id", "agent_id", "task_id", "resource_version", "title", "description", "acceptance_criteria", "priority", "provider_id", "summary", "type", "max_iterations", "idempotency_key"]);
    if (!this.collaborationCore) throw coded("PLATFORM_COLLABORATION_UNAVAILABLE", "Collaboration platform service is unavailable.");
    switch (required(args.action, "action")) {
      case "discover_sessions": return { sessions: this.store.listSessions().filter((session) => !session.deletedAt).filter((session) => !args.objective_id || session.objectiveId === args.objective_id).filter((session) => !args.agent_id || session.agentId === args.agent_id).map((session) => sessionDescriptor(this.store, session)) };
      case "get_session": return sessionDescriptor(this.store, found(resolveSession(this.store, required(args.session_id, "session_id")), "SESSION_NOT_FOUND"));
      case "create_task": {
        const objectiveId = required(args.objective_id, "objective_id");
        found(this.store.getObjective(objectiveId), "OBJECTIVE_NOT_FOUND");
        if (args.agent_id) found(this.store.getAgent(args.agent_id), "AGENT_NOT_FOUND");
        return this.store.runInTransaction(() => {
          const item = this.objectiveService.createTask({ objectiveId, title: required(args.title, "title"), description: args.description ?? "", acceptanceCriteria: array(args.acceptance_criteria).join("\n"), priority: args.priority ?? "medium", mainAgentId: optional(args.agent_id) });
          this.store.db.run("UPDATE tasks SET created_by_session_id=?, idempotency_key=? WHERE id=?", [binding.actorSessionId, required(args.idempotency_key, "idempotency_key"), item.id]);
          return this.store.getTask(item.id);
        });
      }
      case "start_worker": {
        return this.createSession({
          agentId: required(args.agent_id, "agent_id"),
          providerId: required(args.provider_id, "provider_id"),
          taskId: required(args.task_id, "task_id"),
          expectedTaskVersion: positiveInteger(args.resource_version, "resource_version"),
          title: optional(args.title),
          prompt: null,
          sourceSessionId: binding.logicalSessionId ?? binding.actorSessionId,
          idempotencyKey: required(args.idempotency_key, "idempotency_key")
        });
      }
      case "request": {
        const recipientSession = found(resolveSession(this.store, required(args.session_id, "session_id")), "SESSION_NOT_FOUND");
        if (recipientSession.id === binding.actorSessionId) throw coded("COLLABORATION_SELF_TARGET_FORBIDDEN", "Source and recipient Session must differ.");
        const recipientAgent = this.collaborationCore.getAgentForSession(recipientSession.id) ?? this.store.getAgent(recipientSession.agentId);
        if (!recipientAgent) throw coded("SESSION_RESOURCE_OWNER_NOT_FOUND", "Recipient Session has no bound Agent resource.");
        const sourceLogical = this.store.getLogicalSessionByLegacySessionId(binding.actorSessionId);
        const recipientLogical = this.store.getLogicalSessionByLegacySessionId(recipientSession.id);
        return { confirmation: this.collaborationCore.proposeTask({ initiatorAgentId: binding.agent.agentId, initiatorSessionId: sourceLogical?.logicalSessionId ?? binding.actorSessionId, sourceSessionId: binding.actorSessionId, recipientAgentId: recipientAgent.agentId, recipientSessionId: recipientLogical?.logicalSessionId ?? recipientSession.id, targetObjectiveId: recipientSession.objectiveId ?? undefined, taskId: recipientSession.taskId ?? undefined, type: args.type ?? "change_request", title: required(args.title, "title"), summary: required(args.summary, "summary"), acceptanceCriteria: array(args.acceptance_criteria), maxIterations: args.max_iterations ?? 3, idempotencyKey: required(args.idempotency_key, "idempotency_key") }) };
      }
      default: throw unsupported("Collaboration", args.action);
    }
  }

  #storedSession(sessionId) { const summary = found(resolveSession(this.store, sessionId), "SESSION_NOT_FOUND"); const detail = this.store.getDetail?.(summary.id) ?? {}; return { ...detail, ...summary, id: summary.id, items: detail.items ?? this.store.getItems?.(summary.id) ?? [] }; }
  #storedUsage(sessionId) { const session = found(resolveSession(this.store, sessionId), "SESSION_NOT_FOUND"); const usage = this.store.getSessionUsageSnapshot?.(session.id); return { account: usage?.account ?? { available: false, provider: session.external?.provider ?? "unknown", model: usage?.model ?? session.external?.currentModel ?? null }, context: usage?.context ?? null }; }
}

function artifactCreateInput(args, confirmedRepositoryTracked) { return { title: args.title, summary: args.summary, content: args.content, visibility: args.visibility, scope: args.scope, kind: args.kind, categoryPath: args.category_path, tags: args.tags, aliases: args.aliases, keywords: args.keywords, boundTaskId: args.bound_task_id, boundSessionId: args.bound_session_id, repositoryLocator: args.repository_locator, confirmedRepositoryTracked, mimeType: args.mime_type, approvalStatus: args.approval_status }; }
function sessionDescriptor(store, session) { const logical = store.getLogicalSessionByLegacySessionId(session.id); return { sessionId: logical?.logicalSessionId ?? session.id, providerSessionId: session.id, agentId: session.agentId ?? null, objectiveId: session.objectiveId ?? null, taskId: session.taskId ?? null, sessionKind: session.sessionKind, status: session.status, activeBinding: logical?.activeBinding ?? null }; }
function resolveSession(store, id) { return store.getSession(id) ?? store.getSession(store.getLogicalSession(id)?.legacySessionId); }
function receiptTarget(tool, args, result) {
  const type = tool.includes("artifacts") ? "Artifact" : tool.includes("collaboration") ? "Collaboration" : tool.includes("sessions") ? "Session" : tool.includes("tasks") ? "Task" : tool.includes("objectives") ? "Objective" : tool.includes("agents") ? "Agent" : "Platform";
  const createdId = result?.artifact?.artifactId ?? result?.artifactId ?? result?.task?.id
    ?? result?.confirmation?.confirmationId ?? result?.agentId ?? result?.id ?? null;
  const requestedId = type === "Artifact"
    ? (args.artifact_id ?? args.reference_id ?? args.objective_id)
    : type === "Session" ? args.session_id
      : type === "Task" ? args.task_id
        : type === "Objective" ? args.objective_id
          : type === "Agent" ? args.agent_id
            : (args.session_id ?? args.task_id ?? args.objective_id);
  const version = result?.resourceVersion ?? result?.resource_version ?? result?.version?.version ?? null;
  return { type, id: createdId ?? requestedId ?? null, version };
}
function digest(value) { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function required(value, field) { const text = typeof value === "string" ? value.trim() : ""; if (!text) throw coded("INVALID_INPUT", `${field} is required.`); return text; }
function optional(value) { const text = typeof value === "string" ? value.trim() : ""; return text || null; }
function positiveInteger(value, field) { const result = Number(value); if (!Number.isInteger(result) || result < 1) throw coded("TASK_VERSION_CONFLICT", `${field} must be a positive integer.`); return result; }
function array(value) { return Array.isArray(value) ? value : []; }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)); }
function plainObject(value, field) { if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("INVALID_INPUT", `${field} must be an object.`); return value; }
function assertKnown(input, fields) { const allowed = new Set(fields); const unknown = Object.keys(input).find((key) => !allowed.has(key)); if (unknown) { const error = coded("UNKNOWN_FIELD", `Unknown field: ${unknown}`); error.field = unknown; throw error; } }
function assertAbsolute(value, field) { const path = required(value, field); if (!isAbsolute(path)) throw coded("INVALID_PATH", `${field} must be an absolute local path.`); return path; }
function found(value, code) { if (value) return value; throw coded(code, code.replaceAll("_", " ").toLowerCase()); }
function unsupported(domain, action) { return coded("INVALID_ACTION", `Unsupported ${domain} action: ${action}`); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
