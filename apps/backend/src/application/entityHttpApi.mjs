// 实体层 + hub 的 HTTP API（15 Phase 1-3 落地：objective/work_item/memory/hub 路由）。
// 自包含（sendJson/readJson/apiError 本地定义，不依赖 server.mjs），与 collaborationHttpApi 同风格。

import { createGitWorkspaceSnapshot } from "../utils/gitWorktreeInventory.mjs";
import { saveAgentAvatar, clearAgentAvatar } from "../runtime/agentAvatar.mjs";
import { assertPlatformAssistantPatch, isPlatformAssistant } from "../utils/platformAssistantIdentity.mjs";
import { presentWorkItemAcceptance } from "./workItemAcceptance.mjs";
import os from "node:os";

function normalizeEnvironment(value = "") {
  const normalized = String(value || "").toLowerCase();
  return normalized === "dev" || normalized === "development" ? "development" : "production";
}

export function handleEntityHttpRequest({
  request,
  response,
  url,
  objectiveService,
  hubService,
  router,
  memoryExtractor,
  assistantService,
  launchSession,
  launchAgentSession,
  launchObjectiveChatSession,
  createSession,
  backgroundAgentService,
  skillRegistryService,
  inspectWorkItemWorktree,
  reclaimWorkItemWorktree,
  restoreWorkItemExecution,
  resolveAgentAvailability,
  suggestAgentSessionTitle,
  onEntityChanged
}) {
  const path = url.pathname;
  const presentAgent = (agent) => {
    if (!agent) return null;
    let availability = null;
    try {
      availability = typeof resolveAgentAvailability === "function"
        ? resolveAgentAvailability(agent)
        : null;
    } catch (error) {
      availability = { status: "unavailable", reason: error?.message ?? "Agent availability check failed." };
    }
    const unavailable = availability?.status === "unavailable";
    const suggestedSessionTitle = typeof suggestAgentSessionTitle === "function"
      ? suggestAgentSessionTitle(agent)
      : null;
    return {
      ...agent,
      status: unavailable ? "unavailable" : "available",
      statusReason: unavailable && typeof availability?.reason === "string"
        ? availability.reason.trim() || null
        : null,
      skillIds: objectiveService.store.listRegistrySkillIdsForAgent(agent.agentId),
      suggestedSessionTitle
    };
  };
  const normalizeSkillIds = (value) => [...new Set((Array.isArray(value) ? value : [])
    .map((id) => String(id).trim()).filter(Boolean))];
  const validateSkillIds = (value) => {
    const skillIds = normalizeSkillIds(value);
    const missing = skillIds.filter((id) => !objectiveService.store.getRegistrySkill(id));
    if (missing.length > 0) throw apiError("SKILL_NOT_FOUND", `Skill not found: ${missing.join(", ")}`, 404);
    return skillIds;
  };

  const isEntityApi =
    path === "/objectives" || path.startsWith("/objectives/") ||
    path === "/work-items" || path.startsWith("/work-items/") ||
    path === "/repositories" || path === "/repositories/detect" ||
    path === "/memories" || path === "/memories/extract" ||
    path === "/agents" || path.startsWith("/agents/") ||
    path === "/skills" || path.startsWith("/skills/") ||
    path === "/assistant/chat" || path === "/assist/draft" || path === "/assist/form-draft" ||
    path === "/hub/search" || path === "/collaboration/route" ||
    // 只拦截 POST /sessions（创建，供 WorkItem 执行绑定）；
    // DELETE /sessions/:id 一律交给 server.mjs 的完整删除链路
    // （会清理 provider 线程 + logical route + store，只删表行会导致会话“复活”）。
    (path === "/sessions" && request.method === "POST");

  if (!isEntityApi) return false;

  Promise.resolve()
    .then(async () => {
      // ---- Assistant ----
      if (request.method === "POST" && path === "/assistant/chat") {
        const input = await readJson(request);
        const content = String(input.content ?? "").trim();
        if (!content) throw apiError("INVALID_INPUT", "content is required.", 400);
        const result = await assistantService.chat(content, input.sessionId ?? null);
        return sendJson(response, 200, result);
      }

      // ---- Agent 辅助填写（长文本字段的「帮我写」）----
      // provider-neutral：复用 BackgroundAgentService（BACKGROUND_PROMPT 能力），
      // 生成文本返回 { text }，不写文件、不产生会话历史。
      if (request.method === "POST" && path === "/assist/draft") {
        if (!backgroundAgentService) {
          throw apiError("INTERNAL", "backgroundAgentService is not configured.", 500);
        }
        const input = await readJson(request);
        const fieldLabel = String(input.fieldLabel ?? "").trim();
        const prompt = String(input.prompt ?? "").trim();
        if (!fieldLabel || !prompt) {
          throw apiError("INVALID_INPUT", "fieldLabel and prompt are required.", 400);
        }
        const cwd = typeof input.cwd === "string" && input.cwd.trim()
          ? input.cwd.trim()
          : os.homedir();
        const agentId = typeof input.agentId === "string" && input.agentId.trim()
          ? input.agentId.trim()
          : null;
        const result = await backgroundAgentService.run({
          purpose: "assist-draft",
          cwd,
          allowedRoots: [cwd],
          permissionProfile: "read-only",
          agentId,
          intent: `${fieldLabel}: ${prompt}`,
          developerInstructions: draftInstructions(fieldLabel),
          prompt: draftPrompt(fieldLabel, prompt),
          timeoutMs: input.timeoutMs ?? 120_000
        });
        return sendJson(response, 200, { text: result.text ?? "", providerId: result.providerId });
      }

      // ---- 创建表单统一辅助填写 ----
      // 一次后台生成该实体表单的全部可生成字段。结果只返回给客户端回填，绝不创建实体。
      if (request.method === "POST" && path === "/assist/form-draft") {
        if (!backgroundAgentService) {
          throw apiError("INTERNAL", "backgroundAgentService is not configured.", 500);
        }
        const input = await readJson(request);
        const formType = String(input.formType ?? "").trim();
        const intent = String(input.prompt ?? "").trim();
        const schema = FORM_DRAFT_SCHEMAS[formType];
        if (!schema || !intent) {
          throw apiError("INVALID_INPUT", "A supported formType and prompt are required.", 400);
        }
        const currentValues = validateCurrentFormValues(input.currentValues, schema);
        const cwd = typeof input.cwd === "string" && input.cwd.trim()
          ? input.cwd.trim()
          : os.homedir();
        const agentId = typeof input.agentId === "string" && input.agentId.trim()
          ? input.agentId.trim()
          : null;
        const result = await backgroundAgentService.run({
          purpose: "assist-form-draft",
          cwd,
          allowedRoots: [cwd],
          permissionProfile: "read-only",
          agentId,
          intent: `${formType}: ${intent}`,
          developerInstructions: formDraftInstructions(formType, schema),
          prompt: formDraftPrompt(formType, intent, currentValues, schema),
          timeoutMs: input.timeoutMs ?? 120_000
        });
        const fields = parseGeneratedFormDraft(result.text, schema);
        return sendJson(response, 200, { formType, fields, providerId: result.providerId });
      }

      // ---- Agent ----
      if (request.method === "GET" && path === "/agents") {
        return sendJson(response, 200, { agents: objectiveService.store.listAgents().map(presentAgent) });
      }
      if (request.method === "POST" && path === "/agents") {
        const input = await readJson(request);
        const name = String(input.name ?? "").trim();
        if (!name) throw apiError("INVALID_INPUT", "name is required.", 400);
        const skillIds = validateSkillIds(input.skillIds);
        const agent = objectiveService.store.createAgentWithRegistrySkills({
          name,
          description: input.description ?? "",
          role: input.role === "assistant" ? "assistant" : "independentContributor",
          systemPrompt: input.systemPrompt ?? "",
          capabilities: Array.isArray(input.capabilities) ? input.capabilities : [],
          workDir: input.workDir
        }, skillIds);
        onEntityChanged?.("AgentChanged", { action: "created", entity: agent });
        return sendJson(response, 201, { agent: presentAgent(agent) });
      }

      const agentSessionsMatch = path.match(/^\/agents\/([^/]+)\/sessions$/);
      if (agentSessionsMatch) {
        const id = decodeURIComponent(agentSessionsMatch[1]);
        if (request.method === "GET") {
          return sendJson(response, 200, { sessions: objectiveService.store.listSessionsByAgent(id) });
        }
        // 自由对话：仅凭 Assistant Agent 开聊（可选标题/首条提示），不绑定工作项。
        // 工作目录由该 Agent 独占的 work_dir 托管（仅同一 Assistant 的会话共享），
        // 客户端无需也不应传 cwd。
        if (request.method === "POST") {
          const agent = objectiveService.store.getAgent(id);
          if (!agent) throw apiError("AGENT_NOT_FOUND", "Agent not found.", 404);
          if (agent.role !== "assistant") {
            throw apiError("AGENT_NOT_ASSISTANT", "只有 Assistant 类型的 Agent 才能创建自由会话。", 400);
          }
          if (typeof launchAgentSession !== "function") {
            throw apiError("INTERNAL", "launchAgentSession is not configured.", 500);
          }
          const input = await readJson(request);
          rejectSessionAvatarInput(input);
          const providerId = requiredProviderId(input);
          const session = await launchAgentSession({
            agent,
            providerId,
            title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined,
            prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt.trim() : undefined
          });
          return sendJson(response, 201, { session });
        }
      }

      const agentMatch = path.match(/^\/agents\/([^/]+)$/);
      if (agentMatch) {
        const id = decodeURIComponent(agentMatch[1]);
        if (request.method === "GET") {
          const agent = objectiveService.store.getAgent(id);
          if (!agent) throw apiError("AGENT_NOT_FOUND", "Agent not found.", 404);
          return sendJson(response, 200, {
            agent: presentAgent(agent)
          });
        }
        if (request.method === "PATCH") {
          const input = await readJson(request);
          // Fail before avatar file I/O so a mixed cosmetic + protected patch cannot leave orphaned files.
          if (isPlatformAssistant(id)) assertPlatformAssistantPatch(input);
          const skillIds = Array.isArray(input.skillIds) ? validateSkillIds(input.skillIds) : null;
          // 头像：avatarPath 传源文件路径 → 复制到托管目录并落库；传 null/空串 → 清除。
          // 未传 avatarPath 键则不动头像。
          if (Object.prototype.hasOwnProperty.call(input, "avatarPath")) {
            const sourcePath = typeof input.avatarPath === "string" ? input.avatarPath.trim() : "";
            if (sourcePath) {
              const managedPath = await saveAgentAvatar(id, sourcePath, {
                environmentName: normalizeEnvironment(process.env.CORPTIE_ENV)
              });
              input.avatarPath = managedPath;
            } else {
              await clearAgentAvatar(id, { environmentName: normalizeEnvironment(process.env.CORPTIE_ENV) });
              input.avatarPath = null;
            }
          }
          const agent = objectiveService.store.updateAgentWithRegistrySkills(id, input, skillIds);
          onEntityChanged?.("AgentChanged", { action: "updated", entity: agent });
          return sendJson(response, 200, { agent: presentAgent(objectiveService.store.getAgent(id) ?? agent) });
        }
        if (request.method === "DELETE") {
          objectiveService.store.deleteAgent(id);
          onEntityChanged?.("AgentChanged", { action: "deleted", entity: { agentId: id } });
          return sendJson(response, 200, { ok: true });
        }
      }

      // ---- Skill 维护中心 ----
      if (path === "/skills" || path.startsWith("/skills/")) {
        if (!skillRegistryService) {
          throw apiError("INTERNAL", "skillRegistryService is not configured.", 500);
        }
        if (request.method === "GET" && path === "/skills") {
          return sendJson(response, 200, { skills: skillRegistryService.list() });
        }
        if (request.method === "POST" && path === "/skills/discover") {
          const input = await readJson(request);
          try {
            return sendJson(response, 200, await skillRegistryService.discover({
              sourceType: input.sourceType,
              source: input.source
            }));
          } catch (error) {
            const wrapped = apiError(error?.code ?? "SKILL_DISCOVERY_FAILED", error?.message ?? "Skill 发现失败。", 400);
            wrapped.candidates = error?.candidates;
            throw wrapped;
          }
        }
        if (request.method === "POST" && path === "/skills") {
          const input = await readJson(request);
          const sourceType = input.sourceType === "git" ? "git" : "local";
          const source = String(input.source ?? "").trim();
          if (!source) throw apiError("INVALID_INPUT", "source is required.", 400);
          try {
            const skill = await skillRegistryService.register({
              name: input.name ?? "",
              description: input.description ?? "",
              sourceType,
              source,
              sourceSubpath: input.sourceSubpath ?? ""
            });
            return sendJson(response, 201, { skill });
          } catch (error) {
            throw apiError(error?.code ?? "SKILL_REGISTER_FAILED", error?.message ?? "Skill 登记失败。", 400);
          }
        }

        const skillMatch = path.match(/^\/skills\/([^/]+)$/);
        if (skillMatch) {
          const id = decodeURIComponent(skillMatch[1]);
          if (request.method === "GET") {
            const skill = skillRegistryService.get(id);
            if (!skill) throw apiError("SKILL_NOT_FOUND", "Skill not found.", 404);
            return sendJson(response, 200, { skill });
          }
          if (request.method === "PATCH") {
            const input = await readJson(request);
            try {
              const skill = await skillRegistryService.update(id, input);
              return sendJson(response, 200, { skill });
            } catch (error) {
              throw apiError(error?.code ?? "SKILL_UPDATE_FAILED", error?.message ?? "Skill 更新失败。", 400);
            }
          }
          if (request.method === "DELETE") {
            await skillRegistryService.remove(id);
            return sendJson(response, 200, { ok: true });
          }
        }
      }

      // ---- Objective ----
      if (request.method === "GET" && path === "/repositories") {
        return sendJson(response, 200, { repositories: objectiveService.store.listGitRepositories() });
      }
      // 手动注册一个 Git 仓库（用户在文件浏览器里选目录后调用）
      if (request.method === "POST" && path === "/repositories/detect") {
        const input = await readJson(request);
        const dirPath = String(input.dirPath ?? "").trim();
        if (!dirPath) throw apiError("INVALID_INPUT", "dirPath is required.", 400);
        let snapshot;
        try {
          snapshot = await createGitWorkspaceSnapshot(dirPath);
        } catch {
          throw apiError("NOT_A_GIT_REPOSITORY", "所选目录不是有效的 Git 仓库。", 400);
        }
        objectiveService.store.upsertGitWorkspaceSnapshot(snapshot);
        const repository = objectiveService.store.listGitRepositories().find((r) => r.id === snapshot.repository.id);
        return sendJson(response, 201, { repository });
      }
      if (request.method === "GET" && path === "/objectives") {
        return sendJson(response, 200, { objectives: objectiveService.listObjectives() });
      }
      if (request.method === "POST" && path === "/objectives") {
        const input = await readJson(request);
        return sendJson(response, 201, objectiveService.createObjective(input));
      }

      const objectiveSessionsMatch = path.match(/^\/objectives\/([^/]+)\/sessions$/);
      if (objectiveSessionsMatch) {
        const id = decodeURIComponent(objectiveSessionsMatch[1]);
        const objective = objectiveService.getObjective(id);
        if (request.method === "GET") {
          return sendJson(response, 200, { sessions: objectiveService.store.listSessionsByObjective(id) });
        }
        if (request.method === "POST") {
          if (typeof launchObjectiveChatSession !== "function") {
            throw apiError("INTERNAL", "launchObjectiveChatSession is not configured.", 500);
          }
          const input = await readJson(request);
          rejectSessionAvatarInput(input);
          const agentId = String(input.agentId ?? "").trim();
          if (!agentId) throw apiError("INVALID_INPUT", "agentId is required.", 400);
          const agent = objectiveService.store.getAgent(agentId);
          if (!agent) throw apiError("AGENT_NOT_FOUND", "Agent not found.", 404);
          if (!objective.contributorAgentIds.includes(agent.agentId)) {
            throw apiError("AGENT_OUTSIDE_OBJECTIVE", "只有挂载在当前 Objective 下的 Agent 才能创建 Objective Chat Session。", 403);
          }
          const providerId = requiredProviderId(input);
          const existingSession = objectiveService.store.getObjectiveChatSession(id);
          if (existingSession) {
            return sendJson(response, 200, { session: existingSession, created: false });
          }
          const session = await launchObjectiveChatSession({
            agent,
            objective,
            providerId,
            title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined,
            prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt.trim() : undefined
          });
          return sendJson(response, 201, { session });
        }
      }

      const objectiveMatch = path.match(/^\/objectives\/([^/]+)$/);
      if (objectiveMatch) {
        const id = decodeURIComponent(objectiveMatch[1]);
        if (request.method === "GET") {
          return sendJson(response, 200, objectiveService.getObjective(id));
        }
        if (request.method === "PATCH") {
          return sendJson(response, 200, objectiveService.updateObjective(id, await readJson(request)));
        }
        if (request.method === "DELETE") {
          objectiveService.deleteObjective(id);
          return sendJson(response, 200, { ok: true });
        }
      }

      const objectiveWorkItemsMatch = path.match(/^\/objectives\/([^/]+)\/work-items$/);
      if (request.method === "GET" && objectiveWorkItemsMatch) {
        const id = decodeURIComponent(objectiveWorkItemsMatch[1]);
        return sendJson(response, 200, {
          workItems: objectiveService.listWorkItemsByObjective(id).map(presentWorkItemAcceptance)
        });
      }

      // ---- WorkItem ----
      if (request.method === "GET" && path === "/work-items") {
        return sendJson(response, 200, {
          workItems: objectiveService.listWorkItems().map(presentWorkItemAcceptance)
        });
      }
      if (request.method === "POST" && path === "/work-items") {
        const input = await readJson(request);
        return sendJson(response, 201, presentWorkItemAcceptance(objectiveService.createWorkItem(input)));
      }

      const workItemMatch = path.match(/^\/work-items\/([^/]+)$/);
      if (workItemMatch) {
        const id = decodeURIComponent(workItemMatch[1]);
        if (request.method === "GET") {
          return sendJson(response, 200, presentWorkItemAcceptance(objectiveService.getWorkItem(id)));
        }
        if (request.method === "PATCH") {
          return sendJson(
            response,
            200,
            presentWorkItemAcceptance(objectiveService.updateWorkItem(id, await readJson(request)))
          );
        }
        if (request.method === "DELETE") {
          objectiveService.deleteWorkItem(id);
          return sendJson(response, 200, { ok: true });
        }
      }

      const acceptanceAssessmentMatch = path.match(/^\/work-items\/([^/]+)\/acceptance-assessment$/);
      if (request.method === "PUT" && acceptanceAssessmentMatch) {
        const id = decodeURIComponent(acceptanceAssessmentMatch[1]);
        const input = await readJson(request);
        return sendJson(
          response,
          200,
          presentWorkItemAcceptance(objectiveService.recordAcceptanceAssessment(id, input))
        );
      }

      const completionConfirmationMatch = path.match(/^\/work-items\/([^/]+)\/confirm-completion$/);
      if (request.method === "POST" && completionConfirmationMatch) {
        const id = decodeURIComponent(completionConfirmationMatch[1]);
        return sendJson(
          response,
          200,
          presentWorkItemAcceptance(
            objectiveService.confirmWorkItemCompletion(id, await readJson(request))
          )
        );
      }

      const executionRestoreMatch = path.match(/^\/work-items\/([^/]+)\/actions\/restore$/);
      if (request.method === "POST" && executionRestoreMatch) {
        if (typeof restoreWorkItemExecution !== "function") {
          throw apiError("CAPABILITY_UNAVAILABLE", "WorkItem recovery is unavailable.", 503);
        }
        const id = decodeURIComponent(executionRestoreMatch[1]);
        const result = await restoreWorkItemExecution(id);
        return sendJson(response, 200, {
          ...result,
          workItem: presentWorkItemAcceptance(result.workItem)
        });
      }

      const workItemWorktreeMatch = path.match(/^\/work-items\/([^/]+)\/worktree$/);
      if (workItemWorktreeMatch) {
        const id = decodeURIComponent(workItemWorktreeMatch[1]);
        if (request.method === "GET") {
          if (typeof inspectWorkItemWorktree !== "function") {
            throw apiError("CAPABILITY_UNAVAILABLE", "Worktree inspection is unavailable.", 503);
          }
          return sendJson(response, 200, await inspectWorkItemWorktree(id));
        }
      }

      const reclaimWorktreeMatch = path.match(/^\/work-items\/([^/]+)\/worktree\/reclaim$/);
      if (request.method === "POST" && reclaimWorktreeMatch) {
        if (typeof reclaimWorkItemWorktree !== "function") {
          throw apiError("CAPABILITY_UNAVAILABLE", "Worktree reclamation is unavailable.", 503);
        }
        const id = decodeURIComponent(reclaimWorktreeMatch[1]);
        return sendJson(response, 200, await reclaimWorkItemWorktree(id));
      }

      const acceptanceRejectionMatch = path.match(/^\/work-items\/([^/]+)\/reject-acceptance$/);
      if (request.method === "POST" && acceptanceRejectionMatch) {
        const id = decodeURIComponent(acceptanceRejectionMatch[1]);
        return sendJson(
          response,
          200,
          presentWorkItemAcceptance(
            objectiveService.rejectWorkItemAcceptance(id, await readJson(request))
          )
        );
      }

      const workItemSessionsMatch = path.match(/^\/work-items\/([^/]+)\/sessions$/);
      if (request.method === "GET" && workItemSessionsMatch) {
        const id = decodeURIComponent(workItemSessionsMatch[1]);
        return sendJson(response, 200, { sessions: objectiveService.store.listSessionsByWorkItem(id) });
      }

      const dependencyMatch = path.match(/^\/work-items\/([^/]+)\/dependencies$/);
      if (dependencyMatch) {
        const id = decodeURIComponent(dependencyMatch[1]);
        if (request.method === "GET") {
          return sendJson(response, 200, { dependencies: objectiveService.listDependencies(id) });
        }
        if (request.method === "POST") {
          const input = await readJson(request);
          objectiveService.addDependency(id, input.targetWorkItemId, input.type);
          return sendJson(response, 201, { ok: true });
        }
      }

      // ---- Session（执行：真正启动模型 + 绑定 work_item + agent，1:1；换 Agent/重来时先提炼旧记忆）----
      if (request.method === "POST" && path === "/sessions") {
        const input = await readJson(request);
        rejectSessionAvatarInput(input);
        const workItemId = String(input.workItemId ?? "").trim();
        const agentId = String(input.agentId ?? "").trim();
        if (!workItemId && !agentId) {
          if (typeof createSession !== "function") {
            throw apiError("INTERNAL", "createSession is not configured.", 500);
          }
          const session = await createSession(input);
          return sendJson(response, 201, { session });
        }
        if (!workItemId) throw apiError("INVALID_INPUT", "workItemId is required.", 400);
        if (!agentId) throw apiError("INVALID_INPUT", "agentId is required.", 400);
        const workItem = objectiveService.getWorkItem(workItemId);
        if (!workItem) throw apiError("WORK_ITEM_NOT_FOUND", "WorkItem not found.", 404);
        const agent = objectiveService.store.getAgent(agentId);
        if (!agent) throw apiError("AGENT_NOT_FOUND", "Agent not found.", 404);
        if (agent.role !== "independentContributor") {
          throw apiError(
            "AGENT_NOT_INDEPENDENT_CONTRIBUTOR",
            "只有 Independent Contributor 才能创建 Worker Session。",
            400
          );
        }
        const providerId = requiredProviderId(input);
        const objective = objectiveService.getObjective(workItem.objective_id);
        objectiveService.store.assertWorkItemAssociations(
          {
            mainWorkspaceId: workItem.main_workspace_id,
            mainAgentId: agent.agentId
          },
          objective
        );
        if (typeof launchSession !== "function") {
          throw apiError("INTERNAL", "launchSession is not configured.", 500);
        }

        // 已有当前 session → 换 Agent / 重来：先提炼旧 session 记忆，再关闭旧 session。
        const previousSessionId = workItem.current_session_id ?? null;
        if (previousSessionId) {
          await memoryExtractor.extractFromSession(previousSessionId, {
            objectiveId: workItem.objective_id,
            workItemId: workItem.id,
            agentId: workItem.main_agent_id
          });
          objectiveService.store.closeSession(previousSessionId);
        }

        // 真正启动模型执行（provider 映射 / cwd 解析 / prompt 拼装均在 launchSession 内完成）。
        const session = await launchSession({
          agent,
          workItem,
          providerId,
          title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined
        });
        // 1:1 归属：把启动后的 session 绑定到 work_item（更新 current_session_id），并把状态推进到「进行中」，
        // 同时记录实际执行 Agent（main_agent_id），让看板卡片能显示执行主体。
        const boundSession = objectiveService.store.bindSessionToWorkItem(
          session.id,
          workItemId,
          workItem.objective_id
        );
        const executionPatch = {
          executionStatus: "running",
          acceptanceAssessment: null
        };
        if (workItem.status !== "in_progress") executionPatch.status = "in_progress";
        if (workItem.main_agent_id !== agent.agentId) executionPatch.mainAgentId = agent.agentId;
        if (Object.keys(executionPatch).length > 0) {
          objectiveService.store.updateWorkItem(workItemId, executionPatch);
        }
        onEntityChanged?.("WorkItemChanged", {
          action: "session-bound",
          entity: objectiveService.store.getWorkItem(workItemId)
        });
        return sendJson(response, 201, { session: boundSession ?? session });
      }

      // ---- Memory ----
      if (request.method === "GET" && path === "/memories") {
        const { ownerType, ownerId } = url.searchParams;
        const memories = ownerType && ownerId
          ? hubService.store.listMemoriesByOwner(ownerType, ownerId)
          : hubService.store.listAllMemories();
        return sendJson(response, 200, { memories });
      }
      // 手动记录记忆（source_type=user）：走字段校验，防 owner_id=null 撞 NOT NULL。
      // 注：记忆写入本身 = 乐观应用（safe，不需审批卡）；晋升 Skill 另走 guard high（见 03 §15.3）。
      if (request.method === "POST" && path === "/memories") {
        const input = await readJson(request);
        validateMemoryInput(input);
        return sendJson(response, 201, hubService.store.createMemory({ ...input, sourceType: input.sourceType ?? "user" }));
      }
      // 从 Session 事件流提炼记忆（13 主路径）：MemoryExtractor 提取 + kind→owner 分流 + 乐观应用。
      if (request.method === "POST" && path === "/memories/extract") {
        const input = await readJson(request);
        const sessionId = String(input.sessionId ?? "").trim();
        if (!sessionId) throw apiError("INVALID_INPUT", "sessionId is required.", 400);
        const memories = await memoryExtractor.extractFromSession(sessionId, {
          objectiveId: input.objectiveId,
          workItemId: input.workItemId,
          agentId: input.agentId
        });
        return sendJson(response, 201, { memories });
      }

      // ---- hub search ----
      if (request.method === "GET" && path === "/hub/search") {
        const intent = url.searchParams.get("intent") ?? "";
        const scope = {
          objectiveId: url.searchParams.get("objectiveId") ?? undefined,
          workItemId: url.searchParams.get("workItemId") ?? undefined,
          agentId: url.searchParams.get("agentId") ?? undefined,
          sessionId: url.searchParams.get("sessionId") ?? undefined
        };
        return sendJson(response, 200, hubService.search(intent, scope));
      }

      // ---- 协作路由 ----
      if (request.method === "GET" && path === "/collaboration/route") {
        const capabilities = (url.searchParams.get("capabilities") ?? "").split(",").filter(Boolean);
        const objectiveTags = (url.searchParams.get("objectiveTags") ?? "").split(",").filter(Boolean);
        const ranked = router.route({ requiredCapabilities: capabilities, objectiveTags });
        return sendJson(response, 200, { candidates: ranked });
      }

      throw apiError("NOT_FOUND", "Entity endpoint not found.", 404);
    })
    .catch((error) => {
      const code = error.code ?? "INTERNAL";
      sendJson(response, error.statusCode ?? statusForCode(code), {
        error: error.code ? error.message : "Entity operation failed.",
        code,
        ...(typeof error.field === "string" ? { field: error.field } : {}),
        ...(typeof error.expected === "string" ? { expected: error.expected } : {}),
        ...(error.received && typeof error.received === "object" ? { received: error.received } : {}),
        ...(Array.isArray(error.candidates) ? { candidates: error.candidates } : {})
      });
    });

  return true;
}

function requiredProviderId(input = {}) {
  const providerId = String(input.providerId ?? "").trim();
  if (!providerId) throw apiError("INVALID_INPUT", "providerId is required.", 400);
  return providerId;
}

function rejectSessionAvatarInput(input) {
  if (!Object.prototype.hasOwnProperty.call(input ?? {}, "avatarPath")) return;
  throw apiError(
    "SESSION_AVATAR_UNSUPPORTED",
    "Session 不支持独立头像；会话统一继承绑定 Agent 的头像。",
    400
  );
}

function statusForCode(code) {
  if (["OBJECTIVE_NOT_FOUND", "WORK_ITEM_NOT_FOUND", "SESSION_NOT_FOUND", "AGENT_NOT_FOUND"].includes(code)) return 404;
  if (code === "INTERNAL") return 500;
  if ([
    "CYCLE_DETECTED", "AGENT_HAS_RUNNING_SESSIONS", "ASSISTANT_WORKSPACE_CONFLICT",
    "ASSOCIATION_OUT_OF_SCOPE", "OBJECTIVE_SCOPE_CONFLICT", "ASSOCIATION_INTEGRITY_ERROR"
  ].includes(code)) return 409;
  if (["SYSTEM_AGENT_PROTECTED", "PLATFORM_ADMIN_REQUIRED", "AGENT_TOOL_FORBIDDEN"].includes(code)) return 403;
  return 400;
}

// 记忆字段校验：ownerType/ownerId/kind/content 必填，缺失即 400（防 owner_id=null 撞 NOT NULL）。
function validateMemoryInput(input = {}) {
  const required = [
    ["ownerType", input.ownerType],
    ["ownerId", input.ownerId],
    ["kind", input.kind],
    ["content", input.content]
  ];
  for (const [field, value] of required) {
    if (value == null || String(value).trim() === "") {
      throw apiError("INVALID_INPUT", `Field "${field}" is required.`, 400);
    }
  }
}

function apiError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// 辅助填写：限制 Agent 只输出文本、只读、不写文件、不产生会话。
function draftInstructions(fieldLabel) {
  return [
    "You are Corptie's one-time form drafting helper, not the user's ordinary development Agent.",
    `You are helping fill a form field labelled "${fieldLabel}".`,
    "Return ONLY the text that should go into that field — no headings, no commentary, no markdown fences.",
    "Do not write files, modify Git, start services, or use collaboration, subagents, skills, or external uploads.",
    "You may read files in the working directory to gather context, but do not modify anything."
  ].join(" ");
}

function draftPrompt(fieldLabel, prompt) {
  return [
    `Fill in the form field "${fieldLabel}" based on the user's intent below.`,
    "Write concise, specific, production-quality content in the language the user used.",
    "If the field is an acceptance-criteria list, produce bullet points (one per line, leading dash).",
    "",
    "User intent:",
    prompt
  ].join("\n");
}

const FORM_DRAFT_SCHEMAS = Object.freeze({
  agent: Object.freeze({
    name: "Short Agent name",
    description: "Concise responsibility description",
    role: 'Exactly "independentContributor" or "assistant"',
    systemPrompt: "Detailed operating instructions for the Agent",
    capabilities: "Comma-separated capability tags"
  }),
  objective: Object.freeze({
    name: "Short objective name",
    description: "Objective scope and desired outcome",
    idealState: "Evolving description of the ideal state this Objective continuously moves toward",
    priority: 'Empty, or exactly one of "low", "medium", "high", "urgent"',
    targetDate: "Empty, or an ISO calendar date in YYYY-MM-DD format",
    tags: "Comma-separated tags"
  }),
  workItem: Object.freeze({
    title: "Short work-item title",
    description: "Concrete implementation requirements and scope",
    acceptanceCriteria: "Markdown bullet list of verifiable acceptance criteria",
    priority: 'Exactly one of "low", "medium", "high"'
  })
});

function validateCurrentFormValues(value, schema) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw apiError("INVALID_INPUT", "currentValues must be an object of strings.", 400);
  }
  const allowed = new Set(Object.keys(schema));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw apiError("INVALID_INPUT", `Unknown currentValues fields: ${unknown.join(", ")}.`, 400);
  }
  const normalized = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue !== "string") {
      throw apiError("INVALID_INPUT", `currentValues.${key} must be a string.`, 400);
    }
    normalized[key] = fieldValue;
  }
  return normalized;
}

function formDraftInstructions(formType, schema) {
  return [
    "You are Corptie's one-time structured form drafting helper, not the user's ordinary development Agent.",
    `You are filling a ${formType} creation form with exactly these JSON string fields: ${Object.keys(schema).join(", ")}.`,
    "Return ONLY one valid JSON object. Include every listed field exactly once, even when its value is an empty string.",
    "Do not add fields, markdown fences, headings, commentary, or trailing text.",
    "Do not write files, modify Git, start services, or use collaboration, subagents, skills, or external uploads.",
    "You may read files in the working directory for context, but do not modify anything."
  ].join(" ");
}

function formDraftPrompt(formType, intent, currentValues, schema) {
  const fieldGuide = Object.entries(schema).map(([key, description]) => `- ${key}: ${description}`).join("\n");
  return [
    `Draft all fields for the Corptie ${formType} creation form.`,
    "Preserve useful non-empty current values unless the user's request clearly replaces or improves them.",
    formType === "objective"
      ? "Use the language of the user's request. Keep names concise and describe the ideal state as an evolving direction, not a completion checklist."
      : "Use the language of the user's request. Keep names concise and acceptance criteria objectively verifiable.",
    "",
    "Field contract:",
    fieldGuide,
    "",
    "Current form values:",
    JSON.stringify(currentValues),
    "",
    "User request:",
    intent
  ].join("\n");
}

function parseGeneratedFormDraft(text, schema) {
  const raw = typeof text === "string" ? text.trim() : "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw apiError("INVALID_GENERATED_DRAFT", "The Agent returned malformed structured form data.", 502);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw apiError("INVALID_GENERATED_DRAFT", "The Agent must return a JSON object.", 502);
  }
  const expected = Object.keys(schema);
  const actual = Object.keys(parsed);
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(parsed, key));
  const unknown = actual.filter((key) => !Object.prototype.hasOwnProperty.call(schema, key));
  if (missing.length > 0 || unknown.length > 0) {
    throw apiError(
      "INVALID_GENERATED_DRAFT",
      `Generated fields do not match the form contract (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}).`,
      502
    );
  }
  for (const key of expected) {
    if (typeof parsed[key] !== "string") {
      throw apiError("INVALID_GENERATED_DRAFT", `Generated field ${key} must be a string.`, 502);
    }
  }
  validateGeneratedFormEnums(parsed, schema);
  if (Object.hasOwn(schema, "name") && !parsed.name.trim()) {
    throw apiError("INVALID_GENERATED_DRAFT", "Generated name must not be empty.", 502);
  }
  if (Object.hasOwn(schema, "title") && !parsed.title.trim()) {
    throw apiError("INVALID_GENERATED_DRAFT", "Generated title must not be empty.", 502);
  }
  if (Object.hasOwn(schema, "title") && !parsed.description.trim()) {
    throw apiError("INVALID_GENERATED_DRAFT", "Generated work-item description must not be empty.", 502);
  }
  return Object.fromEntries(expected.map((key) => [key, parsed[key].trim()]));
}

function validateGeneratedFormEnums(fields, schema) {
  if (Object.hasOwn(schema, "role") && !["independentContributor", "assistant"].includes(fields.role)) {
    throw apiError("INVALID_GENERATED_DRAFT", "Generated role is invalid.", 502);
  }
  if (Object.hasOwn(schema, "priority")) {
    const allowed = Object.hasOwn(schema, "targetDate")
      ? ["", "low", "medium", "high", "urgent"]
      : ["low", "medium", "high"];
    if (!allowed.includes(fields.priority)) {
      throw apiError("INVALID_GENERATED_DRAFT", "Generated priority is invalid.", 502);
    }
  }
  if (Object.hasOwn(schema, "targetDate") && fields.targetDate && !isValidISODate(fields.targetDate)) {
    throw apiError("INVALID_GENERATED_DRAFT", "Generated targetDate must use YYYY-MM-DD.", 502);
  }
}

function isValidISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw apiError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }
}

function sendJson(response, status, payload) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
