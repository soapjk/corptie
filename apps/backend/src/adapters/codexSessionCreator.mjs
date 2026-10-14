import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { SerializedOperationQueue } from "../application/serializedOperationQueue.mjs";
import { mapCodexThreadToSession } from "./codexThreadProjection.mjs";
import {
  normalizeCodexSandbox, normalizeCodexApprovalPolicy, withCodexSessionPermissions
} from "../utils/codexPermissions.mjs";

export function createCodexSessionCreator({
  collaborationCore, codexRuntime, resolvedNewCodexRuntimeConfig,
  collaborationThreadOptionsWithAgentContext, withPersistedCodexToolConfirmation,
  codexAppServerSessionCapabilities
}) {
  const queue = new SerializedOperationQueue();
  let activeCodexThreadCreation = null;

async function createCodexProviderSessionNow(input = {}, forkSource = null) {
  const creationId = randomUUID();
  activeCodexThreadCreation = { creationId, title: input.title, startedAt: Date.now() };
  try {
    // Session 必须绑定已有 Agent（用户手动创建）；不静默创建、不注册/覆盖 agent。
    const collaborationAgentId = input.toolHost?.actorId;
    if (!collaborationAgentId) {
      const error = new Error("A session must be bound to an existing Agent; toolHost.actorId is required.");
      error.code = "AGENT_REQUIRED";
      throw error;
    }
    if (!collaborationCore.getAgent(collaborationAgentId)) {
      const error = new Error(`Agent not found: ${collaborationAgentId}`);
      error.code = "AGENT_NOT_FOUND";
      throw error;
    }
    const runtime = await resolvedNewCodexRuntimeConfig(input);
    const permissions = {
      sandbox: normalizeCodexSandbox(input.sandbox),
      approvalPolicy: normalizeCodexApprovalPolicy(input.approvalPolicy)
    };
    const providerThreadOptions = input.toolHost?.providerAttachment ?? await collaborationThreadOptionsWithAgentContext(
      collaborationAgentId,
      input.toolHost?.metadata
    );
    const threadOptions = {
      cwd: input.cwd,
      ...permissions,
      runtimeWorkspaceRoots: input.runtimeWorkspaceRoots,
      model: runtime.model,
      modelProvider: input.modelProvider,
      ...providerThreadOptions,
      developerInstructions: [providerThreadOptions.developerInstructions, input.recoveryContext]
        .filter(Boolean).join("\n\n") || undefined
    };
    let started;
    try {
      started = forkSource
        ? await codexRuntime.forkThread(forkSource.reference.providerSessionId, {
            ...withPersistedCodexToolConfirmation(forkSource.reference, threadOptions),
            lastTurnId: forkSource.point.turnId, deferGoalContinuation: true,
            excludeTurns: true
          })
        : await codexRuntime.startThread(threadOptions);
    } catch (error) {
      if (forkSource && error.code === "PROVIDER_RPC_TIMEOUT" && error.remoteDisposition === "unknown") {
        const seconds = Number.isFinite(error.timeoutMs) ? `（${Math.ceil(error.timeoutMs / 1000)} 秒）` : "";
        error.message = `复制会话历史等待超时${seconds}，Codex 可能仍在创建分支，远端结果尚未确认；未自动重试。`;
      }
      throw error;
    }
    if (forkSource) {
      try {
        const actualCwd = started.cwd ?? started.thread?.cwd;
        if (!actualCwd || resolve(actualCwd) !== resolve(input.cwd)) {
          throw Object.assign(new Error("Codex 分支未绑定到新工作区。"), { code: "FORK_CWD_MISMATCH" });
        }
        if (!started.thread?.id) {
          throw Object.assign(new Error("Codex 分支返回的会话标识无效。"), { code: "FORK_IDENTITY_UNVERIFIED" });
        }
        const lastTurn = await codexRuntime.readLastThreadTurn(started.thread.id);
        if (lastTurn.id !== forkSource.point.turnId) {
          throw Object.assign(new Error("Codex 分支历史未截止到选中的轮次。"), { code: "FORK_HISTORY_MISMATCH" });
        }
        await codexRuntime.clearThreadGoal(started.thread.id);
      }
      catch (error) {
        if (started.thread?.id) await codexRuntime.archiveThread(started.thread.id).catch(() => {});
        throw error;
      }
    }
    const session = withCodexSessionPermissions({
      ...mapCodexThreadToSession({
        ...started.thread,
        preview: input.title,
        name: input.title,
        cwd: input.cwd,
        updatedAt: Date.now() / 1000,
        status: "complete",
        source: "corptie",
        currentModel: runtime.model ?? started.model ?? null,
        currentReasoningLevel: runtime.reasoningLevel ?? started.reasoningEffort ?? null,
        activeTurnId: null
      }),
      title: input.title,
      status: "complete",
      progress: 1,
      summary: "Codex is ready.",
      activityStatus: null,
      capabilities: {
        ...codexAppServerSessionCapabilities(),
        canInterrupt: false
      }
    }, permissions);
    return session;
  } finally {
    if (activeCodexThreadCreation?.creationId === creationId) activeCodexThreadCreation = null;
  }
}

  return {
    create: (input = {}, forkSource = null) => queue.run(() => createCodexProviderSessionNow(input, forkSource))
  };
}
