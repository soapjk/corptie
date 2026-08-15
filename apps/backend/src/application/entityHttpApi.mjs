// 实体层 + hub 的 HTTP API（15 Phase 1-3 落地：objective/work_item/memory/hub 路由）。
// 自包含（sendJson/readJson/apiError 本地定义，不依赖 server.mjs），与 collaborationHttpApi 同风格。

import { createGitWorkspaceSnapshot } from "../utils/gitWorktreeInventory.mjs";

export function handleEntityHttpRequest({
  request,
  response,
  url,
  objectiveService,
  hubService,
  router,
  memoryExtractor,
  assistantService,
  launchSession
}) {
  const path = url.pathname;

  const isEntityApi =
    path === "/objectives" || path.startsWith("/objectives/") ||
    path === "/work-items" || path.startsWith("/work-items/") ||
    path === "/repositories" || path === "/repositories/detect" ||
    path === "/memories" || path === "/memories/extract" ||
    path === "/agents" || path.startsWith("/agents/") ||
    path === "/assistant/chat" ||
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

      // ---- Agent ----
      if (request.method === "GET" && path === "/agents") {
        return sendJson(response, 200, { agents: objectiveService.store.listAgents() });
      }
      if (request.method === "POST" && path === "/agents") {
        const input = await readJson(request);
        const name = String(input.name ?? "").trim();
        if (!name) throw apiError("INVALID_INPUT", "name is required.", 400);
        const agent = objectiveService.store.createAgent({
          name,
          description: input.description ?? "",
          role: input.role === "assistant" ? "assistant" : "independentContributor",
          provider: input.provider ?? null,
          systemPrompt: input.systemPrompt ?? "",
          capabilities: Array.isArray(input.capabilities) ? input.capabilities : []
        });
        return sendJson(response, 201, { agent });
      }

      const agentSessionsMatch = path.match(/^\/agents\/([^/]+)\/sessions$/);
      if (request.method === "GET" && agentSessionsMatch) {
        const id = decodeURIComponent(agentSessionsMatch[1]);
        return sendJson(response, 200, { sessions: objectiveService.store.listSessionsByAgent(id) });
      }

      const agentMatch = path.match(/^\/agents\/([^/]+)$/);
      if (agentMatch) {
        const id = decodeURIComponent(agentMatch[1]);
        if (request.method === "GET") {
          return sendJson(response, 200, { agent: objectiveService.store.getAgent(id) });
        }
        if (request.method === "PATCH") {
          const input = await readJson(request);
          const agent = objectiveService.store.updateAgent(id, input);
          if (!agent) throw apiError("AGENT_NOT_FOUND", "Agent not found.", 404);
          return sendJson(response, 200, { agent });
        }
        if (request.method === "DELETE") {
          objectiveService.store.deleteAgent(id);
          return sendJson(response, 200, { ok: true });
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
        return sendJson(response, 200, { workItems: objectiveService.listWorkItemsByObjective(id) });
      }

      // ---- WorkItem ----
      if (request.method === "GET" && path === "/work-items") {
        return sendJson(response, 200, { workItems: objectiveService.listWorkItems() });
      }
      if (request.method === "POST" && path === "/work-items") {
        const input = await readJson(request);
        return sendJson(response, 201, objectiveService.createWorkItem(input));
      }

      const workItemMatch = path.match(/^\/work-items\/([^/]+)$/);
      if (workItemMatch) {
        const id = decodeURIComponent(workItemMatch[1]);
        if (request.method === "GET") {
          return sendJson(response, 200, objectiveService.getWorkItem(id));
        }
        if (request.method === "PATCH") {
          return sendJson(response, 200, objectiveService.updateWorkItem(id, await readJson(request)));
        }
        if (request.method === "DELETE") {
          objectiveService.deleteWorkItem(id);
          return sendJson(response, 200, { ok: true });
        }
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
        const workItemId = String(input.workItemId ?? "").trim();
        const agentId = String(input.agentId ?? "").trim();
        if (!workItemId) throw apiError("INVALID_INPUT", "workItemId is required.", 400);
        if (!agentId) throw apiError("INVALID_INPUT", "agentId is required.", 400);
        const workItem = objectiveService.getWorkItem(workItemId);
        if (!workItem) throw apiError("WORK_ITEM_NOT_FOUND", "WorkItem not found.", 404);
        const agent = objectiveService.store.getAgent(agentId);
        if (!agent) throw apiError("AGENT_NOT_FOUND", "Agent not found.", 404);
        if (typeof launchSession !== "function") {
          throw apiError("INTERNAL", "launchSession is not configured.", 500);
        }

        // 已有当前 session → 换 Agent / 重来：先提炼旧 session 记忆，再关闭旧 session。
        const previousSessionId = workItem.current_session_id ?? null;
        if (previousSessionId) {
          memoryExtractor.extractFromSession(previousSessionId, {
            objectiveId: workItem.objective_id,
            workItemId: workItem.id,
            agentId: workItem.main_agent_id
          });
          objectiveService.store.closeSession(previousSessionId);
        }

        // 真正启动模型执行（provider 映射 / cwd 解析 / prompt 拼装均在 launchSession 内完成）。
        const session = await launchSession({ agent, workItem });
        // 1:1 归属：把启动后的 session 绑定到 work_item（更新 current_session_id），并把状态推进到「进行中」，
        // 同时记录实际执行 Agent（main_agent_id），让看板卡片能显示执行主体。
        objectiveService.store.bindSessionToWorkItem(session.id, workItemId, workItem.objective_id);
        const executionPatch = {};
        if (workItem.status !== "in_progress") executionPatch.status = "in_progress";
        if (workItem.main_agent_id !== agent.agentId) executionPatch.mainAgentId = agent.agentId;
        if (Object.keys(executionPatch).length > 0) {
          objectiveService.store.updateWorkItem(workItemId, executionPatch);
        }
        return sendJson(response, 201, { session });
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
        const memories = memoryExtractor.extractFromSession(sessionId, {
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
      sendJson(response, error.statusCode ?? statusForCode(error.code), {
        error: error.message,
        code: error.code ?? null
      });
    });

  return true;
}

function statusForCode(code) {
  if (["OBJECTIVE_NOT_FOUND", "WORK_ITEM_NOT_FOUND", "SESSION_NOT_FOUND", "AGENT_NOT_FOUND"].includes(code)) return 404;
  if (["CYCLE_DETECTED", "AGENT_HAS_RUNNING_SESSIONS"].includes(code)) return 409;
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
