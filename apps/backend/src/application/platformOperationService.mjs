import { isPlatformAssistant } from "../utils/platformAssistantIdentity.mjs";

const PLATFORM_OPERATIONS = Object.freeze({
  corptie_platform_agents_manage: ["list", "get", "create", "update", "delete"],
  corptie_platform_objectives_manage: ["list", "get", "create", "update", "delete"],
  corptie_platform_work_items_manage: [
    "list", "get", "create", "update", "delete", "dependencies", "add_dependency", "remove_dependency"
  ],
  corptie_platform_sessions_manage: [
    "list", "get", "create", "send", "interrupt", "resume", "disconnect", "rename", "archive", "pin", "delete",
    "clear", "restart", "respond_to_approval", "manage_turn_changes", "list_models", "read_account_usage",
    "read_session_usage", "switch_model", "switch_reasoning", "update_permissions", "update_avatar"
  ]
});

export class PlatformOperationService {
  constructor(options = {}) {
    this.store = options.store;
    this.objectiveService = options.objectiveService;
    this.sessionService = options.sessionService;
    this.listSessions = options.listSessions ?? ((input) => this.sessionService.listSessions(input));
    this.createSession = options.createSession;
    if (!this.store || !this.objectiveService || !this.sessionService) {
      throw new TypeError("PlatformOperationService requires store, objectiveService, and sessionService.");
    }
    if (typeof this.createSession !== "function") {
      throw new TypeError("PlatformOperationService requires createSession().");
    }
  }

  capabilities() {
    return Object.entries(PLATFORM_OPERATIONS).map(([tool, actions]) => ({ tool, actions: [...actions] }));
  }

  async execute(input = {}) {
    const actor = this.store.getAgent(required(input.actorId, "actorId"));
    if (!isPlatformAssistant(actor)) {
      const error = new Error("Only the built-in Corptie Assistant may manage the Corptie platform.");
      error.code = "PLATFORM_ADMIN_REQUIRED";
      throw error;
    }
    const args = input.arguments ?? {};
    let result;
    switch (input.tool) {
      case "corptie_platform_capabilities":
        result = this.capabilities();
        break;
      case "corptie_platform_agents_manage":
        result = await this.#agents(args);
        break;
      case "corptie_platform_objectives_manage":
        result = await this.#objectives(args);
        break;
      case "corptie_platform_work_items_manage":
        result = await this.#workItems(args);
        break;
      case "corptie_platform_sessions_manage":
        result = await this.#sessions(args, actor);
        break;
      default: {
        const error = new Error(`Unsupported Corptie platform tool: ${input.tool}`);
        error.code = "HOST_TOOL_UNSUPPORTED";
        throw error;
      }
    }
    return { ok: true, tool: input.tool, action: args.action ?? "list", result };
  }

  #agents(args) {
    switch (required(args.action, "action")) {
      case "list": return this.store.listAgents();
      case "get": return found(this.store.getAgent(required(args.agent_id, "agent_id")), "AGENT_NOT_FOUND");
      case "create": return this.store.createAgentWithRegistrySkills({
        name: required(args.name, "name"),
        description: args.description ?? "",
        role: args.role,
        provider: optional(args.provider),
        systemPrompt: args.system_prompt ?? "",
        capabilities: array(args.capabilities),
        workDir: optional(args.work_dir),
        avatarPath: optional(args.avatar_path)
      }, array(args.skill_ids));
      case "update": {
        const id = required(args.agent_id, "agent_id");
        const patch = compact({
          name: args.name,
          description: args.description,
          provider: args.provider,
          systemPrompt: args.system_prompt,
          capabilities: args.capabilities,
          workDir: args.work_dir,
          avatarPath: args.avatar_path
        });
        return found(this.store.updateAgentWithRegistrySkills(
          id,
          patch,
          Array.isArray(args.skill_ids) ? args.skill_ids : null
        ), "AGENT_NOT_FOUND");
      }
      case "delete": {
        const id = required(args.agent_id, "agent_id");
        found(this.store.getAgent(id), "AGENT_NOT_FOUND");
        this.store.deleteAgent(id);
        return { deleted: true };
      }
      default: throw unsupported("Agent", args.action);
    }
  }

  #objectives(args) {
    switch (required(args.action, "action")) {
      case "list": return this.objectiveService.listObjectives();
      case "get": return this.objectiveService.getObjective(required(args.objective_id, "objective_id"));
      case "create": return this.objectiveService.createObjective({ ...(args.patch ?? {}), name: required(args.name, "name") });
      case "update": return this.objectiveService.updateObjective(required(args.objective_id, "objective_id"), args.patch ?? {});
      case "delete":
        this.objectiveService.deleteObjective(required(args.objective_id, "objective_id"));
        return { deleted: true };
      default: throw unsupported("Objective", args.action);
    }
  }

  #workItems(args) {
    switch (required(args.action, "action")) {
      case "list": return args.objective_id
        ? this.objectiveService.listWorkItemsByObjective(args.objective_id)
        : this.objectiveService.listWorkItems();
      case "get": return this.objectiveService.getWorkItem(required(args.work_item_id, "work_item_id"));
      case "create": return this.objectiveService.createWorkItem({
        ...(args.patch ?? {}),
        objectiveId: required(args.objective_id, "objective_id"),
        title: required(args.title, "title")
      });
      case "update": return this.objectiveService.updateWorkItem(required(args.work_item_id, "work_item_id"), args.patch ?? {});
      case "delete":
        this.objectiveService.deleteWorkItem(required(args.work_item_id, "work_item_id"));
        return { deleted: true };
      case "dependencies": return this.objectiveService.listDependencies(required(args.work_item_id, "work_item_id"));
      case "add_dependency": return this.objectiveService.addDependency(
        required(args.work_item_id, "work_item_id"),
        required(args.target_work_item_id, "target_work_item_id"),
        args.dependency_type ?? "depends_on"
      );
      case "remove_dependency":
        this.objectiveService.removeDependency(
          required(args.work_item_id, "work_item_id"),
          required(args.target_work_item_id, "target_work_item_id")
        );
        return { removed: true };
      default: throw unsupported("WorkItem", args.action);
    }
  }

  async #sessions(args, actor) {
    const context = { source: "platform-assistant", actorId: actor.agentId };
    switch (required(args.action, "action")) {
      case "list": {
        const active = await this.listSessions({ archived: false });
        if (args.include_archived !== true) return active;
        const archived = await this.listSessions({ archived: true });
        const byId = new Map([...active, ...archived].map((session) => [session.id, session]));
        return [...byId.values()];
      }
      case "get": return this.sessionService.readSession(required(args.session_id, "session_id"));
      case "create": return this.createSession({
        agentId: required(args.agent_id, "agent_id"),
        workItemId: optional(args.work_item_id),
        title: optional(args.title),
        prompt: optional(args.prompt)
      });
      case "send": return this.sessionService.sendMessage(required(args.session_id, "session_id"), required(args.message, "message"), context);
      case "interrupt": return this.sessionService.interrupt(required(args.session_id, "session_id"), context);
      case "resume": return this.sessionService.resumeSession(required(args.session_id, "session_id"), context);
      case "disconnect": return this.sessionService.disconnectSession(required(args.session_id, "session_id"), context);
      case "rename": return this.sessionService.renameSession(required(args.session_id, "session_id"), required(args.title, "title"), context);
      case "archive": return found(this.store.archiveSession(required(args.session_id, "session_id"), args.archived !== false), "SESSION_NOT_FOUND");
      case "pin": return found(this.store.pinSession(required(args.session_id, "session_id"), args.pinned !== false), "SESSION_NOT_FOUND");
      case "delete": return this.sessionService.deleteSession(required(args.session_id, "session_id"), context);
      case "clear": return this.sessionService.clearConversation(required(args.session_id, "session_id"), context);
      case "restart": return this.sessionService.restartSession(required(args.session_id, "session_id"), context);
      case "respond_to_approval": return this.sessionService.respondToApproval(
        required(args.session_id, "session_id"), args.approval ?? {}, context
      );
      case "manage_turn_changes": return this.sessionService.manageTurnChanges(
        required(args.session_id, "session_id"),
        required(args.turn_id, "turn_id"),
        required(args.change_action, "change_action"),
        context
      );
      case "list_models": return this.sessionService.listModelsForSession(required(args.session_id, "session_id"), context);
      case "read_account_usage": return this.sessionService.readAccountUsage(required(args.session_id, "session_id"), context);
      case "read_session_usage": return this.sessionService.readSessionUsage(required(args.session_id, "session_id"), context);
      case "switch_model": return this.sessionService.switchModel(
        required(args.session_id, "session_id"), required(args.model_id, "model_id"), context
      );
      case "switch_reasoning": return this.sessionService.switchReasoning(
        required(args.session_id, "session_id"), required(args.reasoning_level, "reasoning_level"), context
      );
      case "update_permissions": return this.sessionService.updatePermissions(
        required(args.session_id, "session_id"), args.permissions ?? {}, context
      );
      case "update_avatar": return this.sessionService.updateAvatar(
        required(args.session_id, "session_id"), args.avatar_path ?? null, context
      );
      default: throw unsupported("Session", args.action);
    }
  }
}

function required(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    const error = new TypeError(`${field} is required.`);
    error.code = "INVALID_INPUT";
    throw error;
  }
  return normalized;
}

function optional(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function found(value, code) {
  if (value) return value;
  const error = new Error(code.replaceAll("_", " ").toLowerCase());
  error.code = code;
  throw error;
}

function unsupported(domain, action) {
  const error = new Error(`Unsupported ${domain} action: ${action}`);
  error.code = "INVALID_ACTION";
  return error;
}
