import { resolve } from "node:path";
import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";
import { taskExecutionPrompt } from "./taskAcceptance.mjs";
import { defaultSessionTitleForAgent, defaultSessionTitleForTask } from "../utils/sessionTitles.mjs";
import { ensureAgentWorkDir } from "../runtime/agentWorkDir.mjs";
import { isPlatformAssistant } from "../utils/platformAssistantIdentity.mjs";

// Application launch workflows; Provider selection stays in the shared registry.
export function createEntitySessionLaunchers({
  store, workService, collaborationCore, workChatContextService, workDiscussionService,
  agentProviderRegistry, environmentName, resolveSessionProviderId, createSessionThroughApplication
}) {
  async function createProviderWorkSession({
    assigneeAgentId,
    assigneeName,
    taskId,
    taskTitle,
    workId,
    providerId: requestedProviderId,
    title,
    model,
    reasoningLevel,
    prompt: requestedPrompt,
    workingDirectory = null,
    autoUniqueTitle = false,
    sandbox = null,
    approvalPolicy = null,
    runtimeWorkspaceRoots = null,
    deferInitialPromptUntilBound = false,
    deferToolHostFinalization = false,
    forkSource = null,
    observePerformance = () => {}
  }) {
    const providerId = resolveSessionProviderId(requestedProviderId);
    if (!providerId) {
      const error = new Error(`Session Provider（${requestedProviderId ?? "未设置"}）暂不支持执行。`);
      error.code = "PROVIDER_UNSUPPORTED";
      throw error;
    }
    const cwd = typeof workingDirectory === "string" && workingDirectory.trim()
      ? resolve(workingDirectory.trim())
      : null;
    if (!cwd) {
      const error = new Error("Worker Session creation requires an authoritative prepared ExecutionSpace binding.");
      error.code = "START_EXECUTION_SPACE_BINDING_REQUIRED";
      throw error;
    }
    const task = workService.getTask(taskId);
    const prompt = typeof requestedPrompt === "string" && requestedPrompt.trim()
      ? requestedPrompt.trim()
      : taskExecutionPrompt(task);

    const phaseStartedAt = performance.now();
    const session = await createSessionThroughApplication(
      providerId,
      {
        cwd,
        title,
        defaultTitle: defaultSessionTitleForTask(taskTitle, assigneeName),
        prompt: deferInitialPromptUntilBound ? "" : prompt,
        agent: assigneeName,
        sessionKind: "worker",
        autoUniqueTitle,
        ...(model ? { model } : {}),
        ...(reasoningLevel ? { reasoningLevel } : {}),
        ...(sandbox ? { sandbox } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(Array.isArray(runtimeWorkspaceRoots) ? { runtimeWorkspaceRoots } : {})
      },
      {
        source: "entity",
        actorId: assigneeAgentId,
        workId,
        taskId,
        sessionKind: "worker",
        deferToolHostFinalization,
        forkSource
      }
    );
    observePerformance("providerSessionCreateMs", performance.now() - phaseStartedAt);
    return session;
  }

  // 实体层自由对话入口：任意 Agent 均可创建，不绑定具体 Work 或 Task。
  // 与 startup coordinator 的低层 Session 构造端口复用 createSessionThroughApplication。
  // cwd 不再由客户端提供，而是取自该 Agent 独占的 work_dir；Task Worker 仍走权威
  // Work Session startup coordinator，并使用 Task ExecutionSpace。
  async function launchAgentSession({ agent, providerId: requestedProviderId, title, prompt, model }) {
    const providerId = resolveSessionProviderId(requestedProviderId);
    if (!providerId) {
      const error = new Error(`Session Provider（${requestedProviderId ?? "未设置"}）暂不支持执行。`);
      error.code = "PROVIDER_UNSUPPORTED";
      throw error;
    }
    const cwd = await ensureAgentWorkDir(agent, { environmentName });
    const session = await createSessionThroughApplication(
      providerId,
      {
        cwd,
        title,
        defaultTitle: defaultSessionTitleForAgent(agent.name),
        prompt,
        model,
        agent: agent.name,
        sessionKind: "assistantChat"
      },
      { source: "agent", actorId: agent.agentId }
    );
    // 把自由会话归属到该 Agent，使 GET /agents/:id/sessions 与前端按 Agent 分组能定位到它。
    collaborationCore.bindSession({ agentId: agent.agentId, sessionId: session.id });
    if (isPlatformAssistant(agent)) {
      store.grantSessionCapability(session.id, "platform.manage");
    }
    return store.getSession(session.id) ?? session;
  }

  async function launchWorkChatSession({ agent, work, providerId: requestedProviderId, title, prompt: requestedPrompt }) {
    if (!work.contributorAgentIds.includes(agent.agentId)) {
      const error = new Error("只有挂载在当前 Work 下的 Agent 才能创建 Work Chat Session。");
      error.code = "AGENT_OUTSIDE_WORK";
      throw error;
    }
    const providerId = resolveSessionProviderId(requestedProviderId);
    if (!providerId) {
      const error = new Error(`Session Provider（${requestedProviderId ?? "未设置"}）暂不支持执行。`);
      error.code = "PROVIDER_UNSUPPORTED";
      throw error;
    }
    const workspacePath = store.resolveWorkspaceRoot(work.workspaceId);
    const workspacePaths = workspacePath ? [workspacePath] : [];
    const cwd = workspacePath ?? await ensureAgentWorkDir(agent, { environmentName });
    const openingPrompt = typeof requestedPrompt === "string" ? requestedPrompt.trim() : "";
    const prompt = openingPrompt
      ? (agentProviderRegistry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH)
          ? openingPrompt
          : `${workChatContextService.build(work.id).prompt}\n\nUser opening message:\n${openingPrompt}`)
      : undefined;
    const session = await createSessionThroughApplication(
      providerId,
      {
        cwd,
        title,
        defaultTitle: `${work.name}_Chat`,
        prompt,
        agent: agent.name,
        sessionKind: "workChat",
        runtimeWorkspaceRoots: workspacePaths.length > 0 ? workspacePaths : [cwd]
      },
      { source: "work", actorId: agent.agentId, workId: work.id, sessionKind: "workChat" }
    );
    collaborationCore.bindSession({ agentId: agent.agentId, sessionId: session.id });
    return store.bindSessionToWork(session.id, work.id);
  }

  async function ensureWorkChatSession(work) {
    return workDiscussionService.ensure(work.id, agentProviderRegistry.defaultProviderId);
  }

  async function reconcileWorkChatsAtStartup() {
    for (const work of workService.listWorks()) {
      if (store.getWorkChatSession(work.id)) continue;
      try {
        const session = await ensureWorkChatSession(work);
        console.log(`[work-chat] backfilled work=${work.id} session=${session.id}`);
      } catch (error) {
        console.warn(`[work-chat] backfill skipped work=${work.id} code=${error.code ?? "WORK_CHAT_CREATE_FAILED"} error=${error.message}`);
      }
    }
  }

  return {
    createProviderWorkSession, launchAgentSession, launchWorkChatSession,
    ensureWorkChatSession, reconcileWorkChatsAtStartup
  };
}
