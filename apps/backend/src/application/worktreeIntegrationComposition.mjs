import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { ProjectWorktreeIntegrationService } from "./projectWorktreeIntegrationService.mjs";
import { WorktreeIntegrationJobService } from "./worktreeIntegrationJobService.mjs";
import { resolveConflictResolutionAgentContext } from "./conflictResolutionAgentContext.mjs";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";

function commitPolicyArtifactBinding(store, item) {
  const taskIds = new Set();
  const workIds = new Set();
  for (const association of item.associations ?? []) {
    const session = association.sessionId ? store.getSession(association.sessionId) : null;
    const logical = association.logicalSessionId && store.getLogicalSession
      ? store.getLogicalSession(association.logicalSessionId)
      : null;
    const taskId = association.taskId ?? session?.taskId ?? session?.task_id
      ?? logical?.taskId ?? logical?.task_id ?? null;
    const task = taskId ? store.getTask(taskId) : null;
    const workId = task?.work_id ?? task?.workId ?? session?.workId ?? session?.work_id
      ?? logical?.workId ?? logical?.work_id ?? null;
    if (taskId && task) taskIds.add(taskId);
    if (workId) workIds.add(workId);
  }
  if (workIds.size !== 1) {
    const error = new Error(
      "The blocked Worktree must be associated with exactly one Work before its Markdown can become an Artifact."
    );
    error.code = "COMMIT_POLICY_ARTIFACT_OWNER_AMBIGUOUS";
    error.statusCode = 409;
    throw error;
  }
  const workId = [...workIds][0];
  const taskId = taskIds.size === 1
    ? [...taskIds].find((id) => {
      const task = store.getTask(id);
      return (task?.work_id ?? task?.workId) === workId;
    }) ?? null
    : null;
  return { workId, taskId };
}

// Project-level integration wiring, including explicit conflict Session launch.
// Both services share the host's Store and Git services; no runtime is started here.
export function createWorktreeIntegrationServices({
  store, projectApplicationService, gitWorkspaces, gitHubPushes, gitCommitProtection,
  workService, artifactService, agentProviderRegistry, startPreparedWorkSession,
  sendUnifiedSessionMessage, emitEvent, presentTaskForClient
}) {
  const applyArtifactDecision = async (input, { removeSource, allowTracking }) => {
    const binding = commitPolicyArtifactBinding(store, input.item);
    const file = await gitWorkspaces.readIntegrationMarkdownFile({
      path: input.item.path,
      relativePath: input.relativePath,
      expectedContentHash: input.expectedContentHash
    });
    const identity = createHash("sha256").update([
      input.jobId, input.blockerId, input.relativePath, input.expectedContentHash,
      allowTracking ? "track" : "artifact"
    ].join("\0")).digest("hex");
    const artifact = await artifactService.create({
      kind: "local_user",
      actorId: "user:local-macos",
      workId: binding.workId
    }, {
      artifactId: `artifact:worktree-markdown:${identity}`,
      title: basename(input.relativePath),
      summary: `Captured from Worktree Markdown decision for ${input.relativePath}.`,
      content: file.content,
      mimeType: "text/markdown",
      visibility: binding.taskId ? "task_private" : "work_private",
      scope: binding.taskId ? "task" : "work",
      ...(binding.taskId ? { boundTaskId: binding.taskId } : {}),
      kind: "document",
      categoryPath: "worktree-markdown",
      tags: ["worktree", "markdown"],
      sourceEventId: input.decisionId
    });
    if (allowTracking) {
      await artifactService.promoteExistingRepositoryFileFromUserDecision({
        kind: "local_user",
        actorId: "user:local-macos",
        workId: binding.workId
      }, artifact.artifactId, {
        repositoryPath: file.repositoryRoot,
        path: file.relativePath,
        version: artifact.currentVersion,
        contentHash: file.contentHash,
        decisionId: input.decisionId
      });
    }
    if (removeSource) {
      await gitWorkspaces.deleteIntegrationMarkdownFile({
        repositoryId: input.repositoryId,
        path: input.item.path,
        relativePath: input.relativePath,
        expectedContentHash: input.expectedContentHash
      });
    }
    return { artifactId: artifact.artifactId, version: artifact.currentVersion };
  };
  const projectWorktreeIntegrationService = new ProjectWorktreeIntegrationService({
    store,
    inspectProject: async (projectId, options = {}) => {
      const project = await projectApplicationService.requireProject(projectId);
      return gitWorkspaces.projectStatusForPath(project.mainPath, project.id, {
        inspectionLevel: "integration",
        reason: "integration_status",
        ...options
      });
    },
    mergeWorktree: ({ projectId, mainPath, worktreeId }) => gitWorkspaces.mergeWorktreeIntoMainForProject({
      repositoryId: projectId,
      workingDirectory: mainPath,
      sourceWorktreeId: worktreeId,
      synchronizeSource: false
    }),
    createConflictWorkspace: async ({ projectId, runId }) => {
      const project = await projectApplicationService.requireProject(projectId);
      return gitWorkspaces.createIntegrationWorktreeForProject({
        repositoryId: project.id,
        workingDirectory: project.mainPath,
        runId
      });
    },
    createAndLaunchConflictTask: async ({
      work, projectId, agent, workspace, title, description, acceptanceCriteria, prompt,
      integrationRunId, sourceSessionId
    }) => {
      const task = workService.createTask({
        workId: work.id,
        title,
        description,
        acceptanceCriteria,
        priority: "high",
        mainAgentId: agent.agentId
      });
      let session;
      try {
        session = await startPreparedWorkSession({
          assigneeAgentId: agent.agentId,
          taskId: task.id,
          providerId: agentProviderRegistry.defaultProviderId,
          title,
          workspace,
          idempotencyKey: `integration-conflict:${integrationRunId}:start`,
          sourceSessionId
        });
      } catch (error) {
        workService.deleteTask(task.id);
        throw error;
      }
      const finalized = store.finalizeConflictResolutionLaunch({
        sessionId: session.id,
        taskId: task.id,
        workId: work.id,
        agentId: agent.agentId,
        integrationRunId
      });
      emitEvent("TaskChanged", {
        action: "integration-conflict-resolution-started",
        entity: store.getTask(task.id)
      });
      return {
        task: presentTaskForClient(finalized.task),
        session: finalized.session
      };
    },
    isSessionActive: sessionHasActiveRun,
    presentTask: presentTaskForClient,
    onEvent: (type, payload) => emitEvent(type, payload)
  });
  const worktreeIntegrationJobService = new WorktreeIntegrationJobService({
    store,
    inspectGitHubPushStatus: (input) => gitHubPushes.branchStatus(input),
    inspectRepositorySummary: async (repositoryId, options = {}) => {
      const path = store.resolveWorkspacePath(repositoryId);
      if (!path) {
        const error = new Error("The repository main checkout is unavailable.");
        error.code = "REPOSITORY_MAIN_UNAVAILABLE";
        throw error;
      }
      return gitWorkspaces.managementInspectionForProject(path, repositoryId, options);
    },
    inspectRepository: async (repositoryId, options = {}) => {
      const path = store.resolveWorkspacePath(repositoryId);
      if (!path) {
        const error = new Error("The repository main checkout is unavailable.");
        error.code = "REPOSITORY_MAIN_UNAVAILABLE";
        throw error;
      }
      return gitWorkspaces.integrationInspectionForProject(path, repositoryId, options);
    },
    inspectCommitProtection: (path) => gitCommitProtection.inspect(path),
    inspectCommitPolicyFiles: (input) => gitWorkspaces.inspectIntegrationMarkdownFiles(input),
    ignoreCommitPolicyFile: (input) => gitWorkspaces.ignoreIntegrationMarkdownFile(input),
    deleteCommitPolicyFile: (input) => gitWorkspaces.deleteIntegrationMarkdownFile(input),
    convertCommitPolicyFileToArtifact: (input) => applyArtifactDecision(input, {
      removeSource: true,
      allowTracking: false
    }),
    allowCommitPolicyFileTracking: (input) => applyArtifactDecision(input, {
      removeSource: false,
      allowTracking: true
    }),
    commitChanges: (input) => gitWorkspaces.commitIntegrationChanges({
      ...input,
      prepare: () => gitCommitProtection.resolve(input.path, {
        decision: input.protectionDecision,
        neverRemind: input.neverRemindPrivateFiles === true
      })
    }),
    mergeSource: (input) => gitWorkspaces.mergeIntegrationSource(input),
    abortMerge: (input) => gitWorkspaces.abortIntegrationMerge(input),
    rebaseSource: (input) => gitWorkspaces.rebaseIntegrationSource(input),
    fastForwardSource: (input) => gitWorkspaces.fastForwardIntegrationSource(input),
    prepareConvergence: (input) => gitWorkspaces.createConvergenceWorktreeForProject(input),
    cleanupConvergence: (input) => gitWorkspaces.removeConvergenceWorktreeForProject(input),
    prepareConflictResolution: (input) => gitWorkspaces.prepareIntegrationConflictResolutionForProject({
      repositoryId: input.repositoryId,
      workingDirectory: input.mainPath,
      sourceHead: input.sourceHead,
      expectedMainHead: input.expectedMainHead,
      jobId: input.jobId
    }),
    inspectConflictResolution: (input) => gitWorkspaces.inspectIntegrationConflictResolutionForProject(input),
    launchConflictResolution: async ({ job, item, workspace, sourceHead, expectedMainHead }) => {
      const planIdentity = job.id.replace(/^worktree_integration:/, "");
      const planLabel = planIdentity.slice(0, 8);
      const planTaskId = `task:integration_conflicts:${planIdentity}`;
      const existingAutomation = job.conflictAutomation ?? null;
      const legacyPlanTask = existingAutomation?.taskId ? null : store.listTasks()
        .filter((candidate) => String(candidate.description ?? "").includes(job.id))
        .sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")))[0] ?? null;
      const existingTask = existingAutomation?.taskId
        ? store.getTask(existingAutomation.taskId)
        : legacyPlanTask;
      const existingSessionId = existingAutomation?.sessionId ?? existingTask?.current_session_id ?? null;
      const existingSession = existingSessionId ? store.getSession(existingSessionId) : null;
      const existingAgent = existingAutomation?.agentId
        ? store.getAgent(existingAutomation.agentId)
        : (existingTask?.main_agent_id ? store.getAgent(existingTask.main_agent_id) : null);
      const hasRecordedPlanSession = Boolean(existingAutomation?.taskId
        || existingAutomation?.sessionId || legacyPlanTask);
      const hasExistingPlanSession = Boolean(existingTask && existingSession && existingAgent);
      if (hasRecordedPlanSession && !hasExistingPlanSession) {
        const error = new Error(
          "The integration plan's conflict Task or Session is no longer available. Restore that plan Session or generate a fresh plan; Corptie will not create a duplicate Task."
        );
        error.code = "CONFLICT_PLAN_SESSION_UNAVAILABLE";
        throw error;
      }
      const context = hasExistingPlanSession
        ? null
        : [item, ...(job.plan.items ?? []).filter((candidate) => candidate.worktreeId !== item.worktreeId)]
          .map((candidate) => resolveConflictResolutionAgentContext(candidate, store))
          .find(Boolean);
      if (!hasExistingPlanSession && !context) {
        const error = new Error(
          "No Independent Contributor Agent could be recovered from any Worktree in this integration plan. Bind one Agent-backed Task to the plan, then retry."
        );
        error.code = "CONFLICT_AGENT_UNAVAILABLE";
        throw error;
      }
      const sourceTask = existingTask ?? context.sourceTask;
      const work = hasExistingPlanSession
        ? store.getWork(existingTask.work_id)
        : context.work;
      const agent = existingAgent ?? context.agent;
      const branchLabel = item.branchName ?? item.worktreeId;
      const title = `解决 Worktree 合并计划 ${planLabel} 的全部冲突`;
      const conflictFiles = item.conflictFiles.length > 0 ? item.conflictFiles.join(", ") : "请通过 Git 状态确认";
      const description = [
        `持续处理 Worktree Integration Job ${job.id} 计划内的全部合并冲突。`,
        `Agent 上下文来源 Task：${sourceTask.title}`,
        `计划级专用 Integration Worktree：${workspace.path}`
      ].join("\n");
      const acceptanceCriteria = [
        "- 合并计划内所有来源分支的有效修改均已完整进入 main",
        "- 计划内所有冲突均按双方语义逐个解决，且不存在未合并文件或冲突标记",
        "- 相关测试通过，Development App 与后端重建及健康检查成功",
        "- 每轮解决结果均已提交，计划级 Integration Worktree 保持干净",
        "- 未直接修改 main，未推送远端，未删除任何来源分支或 Worktree"
      ].join("\n");
      const prompt = [
        `继续处理合并计划 ${job.id} 的下一个冲突。`,
        `当前来源 Worktree：${branchLabel}`,
        `当前来源提交：${sourceHead}`,
        `当前 main 基线：${expectedMainHead}`,
        `冲突文件：${conflictFiles}`,
        `计划级专用 Integration Worktree：${workspace.path}`,
        "",
        "固定执行流程：",
        `1. 确认仍在本计划的专用 Integration Worktree，基线 HEAD 应为 ${expectedMainHead}。`,
        `2. 在当前 Integration 分支合并来源提交 ${sourceHead}，逐文件分析并解决冲突；不得简单全选 ours 或 theirs。`,
        "3. 确认没有冲突标记或未合并文件后创建清晰的本地提交。",
        "4. 运行相关测试，并按 AGENTS.md 重建、启动 Development App 与后端并检查健康状态。",
        `5. 验证来源提交 ${sourceHead} 已成为当前 Integration HEAD 的祖先，并确认 Integration Worktree 干净。`,
        "6. 不得切换、提交、清理或合并 main；不得推送远端，不得删除来源分支或 Worktree。",
        "7. 完成本轮后正常结束当前执行；Corptie 会校验结果并在同一个 Task 和 Session 中投递下一个冲突，直至整个计划完成。"
      ].join("\n");
      if (hasExistingPlanSession) {
        const sessionCwd = existingSession.external?.cwd ?? existingSession.cwd ?? null;
        if (sessionCwd && resolve(sessionCwd) !== resolve(workspace.path)) {
          const error = new Error(
            `The plan Session is bound to ${sessionCwd}, but the Integration Worktree is ${workspace.path}.`
          );
          error.code = "CONFLICT_PLAN_SESSION_WORKSPACE_CHANGED";
          throw error;
        }
        workService.updateTask(existingTask.id, {
          title,
          description,
          acceptanceCriteria,
          lifecycleState: "in_progress",
          mainAgentId: agent.agentId
        });
        await sendUnifiedSessionMessage(
          existingSession.id,
          prompt,
          { type: "worktree-integration", localVisibility: "normal" },
          { fromAgentWorkQueue: true }
        );
        return {
          taskId: existingTask.id,
          sessionId: existingSession.id,
          sessionName: existingSession.title,
          agentId: agent.agentId,
          agentName: agent.name,
          reused: true
        };
      }
      const task = workService.createTask({
        id: planTaskId,
        workId: work.id,
        title,
        description,
        acceptanceCriteria,
        priority: "high",
        mainAgentId: agent.agentId
      });
      let session;
      try {
        const sourceLogical = sourceTask.current_session_id
          ? store.getLogicalSessionByLegacySessionId(sourceTask.current_session_id)
          : null;
        session = await startPreparedWorkSession({
          assigneeAgentId: agent.agentId,
          taskId: task.id,
          providerId: agentProviderRegistry.defaultProviderId,
          title,
          workspace,
          idempotencyKey: `integration-plan:${job.id}:start`,
          sourceSessionId: sourceLogical?.logicalSessionId,
          // The plan-specific prompt below is the single initial execution
          // message. Startup still activates the Provider and Tool contract.
          dispatchInitialTurn: false
        });
      } catch (error) {
        workService.deleteTask(task.id);
        throw error;
      }
      await sendUnifiedSessionMessage(session.id, prompt, {
        type: "session-initialization",
        origin: "worktree-integration"
      });
      return {
        taskId: task.id,
        sessionId: session.id,
        sessionName: session.title,
        agentId: agent.agentId,
        agentName: agent.name,
        reused: false
      };
    },
    removeWorktree: ({ repositoryId, mainPath, worktreeId, ignoreLogicalSessionIds }) => gitWorkspaces.removeWorktreeForProject({
      repositoryId,
      workingDirectory: mainPath,
      sourceWorktreeId: worktreeId,
      ignoreLogicalSessionIds,
      deleteBranch: true,
      safeOnly: true
    }),
    isSessionActive: sessionHasActiveRun,
    onDeletionFailure: (failure) => {
      console.error(`[worktree-delete] failed ${JSON.stringify(failure)}`);
    },
    onEvent: (type, payload) => emitEvent(type, payload)
  });
  return { projectWorktreeIntegrationService, worktreeIntegrationJobService };
}
