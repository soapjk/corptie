import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { WorkSessionStartupCoordinator } from "./workSessionStartupCoordinator.mjs";
import { ManagedSandboxStartupCoordinator } from "./managedSandboxStartupCoordinator.mjs";
import { WorkSessionStartApplicationService } from "./workSessionStartApplicationService.mjs";
import { WorktreeStartupPreparer } from "./worktreeStartupPreparer.mjs";
import { ProviderWorkspaceBindingService } from "../agent-provider/providerWorkspaceBindingService.mjs";
import { ProviderWorkSessionPort } from "../agent-provider/providerWorkSessionPort.mjs";
import { taskExecutionPrompt } from "./taskAcceptance.mjs";

// One startup composition for managed Worktree and sandbox execution. The
// Provider port returns proofs; only the coordinator commits readiness.
export function createWorkSessionStartupComposition({
  store, workService, agentProviderRegistry, sessionApplicationService,
  forkContextForTask, prepareConversationForkWorkspace, ensureTaskWorkspace,
  createProviderWorkSession, requiredWorkspaceInstructionSources, knownGlobalInstructionSources,
  sendUnifiedSessionMessage, projectApplicationService, gitWorkspaces,
  projectCodeApplicationService, resolveSessionProviderId, emitEvent
}) {
  const startupWorktreePreparer = new WorktreeStartupPreparer({
    store,
    ensureWorkspace: async (input) => {
      const source = await forkContextForTask(input.task.id);
      return source ? prepareConversationForkWorkspace(source, input.task.id) : ensureTaskWorkspace(input);
    }
  });
  const providerWorkspaceBindingService = new ProviderWorkspaceBindingService({
    registry: agentProviderRegistry
  });
  const providerWorkSessionPort = new ProviderWorkSessionPort({
    workspaceBinding: providerWorkspaceBindingService,
    createSession: async ({ taskId, assigneeAgentId, providerId, title, model, reasoningLevel, workspace }) => {
      const task = workService.getTask(taskId);
      const agent = store.getAgent(assigneeAgentId);
      return createProviderWorkSession({
        assigneeAgentId,
        assigneeName: agent?.name,
        taskId,
        taskTitle: task.title,
        workId: task.work_id,
        providerId,
        title,
        model,
        reasoningLevel,
        forkSource: await forkContextForTask(taskId),
        workingDirectory: workspace.canonicalExecutionPath ?? workspace.canonicalWorktreePath,
        autoUniqueTitle: true,
        deferInitialPromptUntilBound: true,
        deferToolHostFinalization: true
      });
    },
    activateSession: async ({ session, taskId, assigneeAgentId, workingDirectory, dispatchInitialTurn }) => {
      const task = workService.getTask(taskId);
      try {
        if (dispatchInitialTurn !== true) {
          await sessionApplicationService.resumeSession(session.id, {
            source: "task-start",
            purpose: "session-create-finalization",
            actorId: assigneeAgentId,
            workId: task.work_id,
            taskId,
            sessionKind: "worker"
          });
          const current = store.getSession(session.id);
          const logical = store.getLogicalSessionByLegacySessionId(session.id);
          const activeBinding = logical?.activeBinding;
          const materialization = activeBinding?.bindingId
            ? store.getSessionToolCatalogMaterialization(logical.logicalSessionId, activeBinding.bindingId)
            : null;
          const toolContractHash = materialization?.status === "applied"
            ? materialization.providerReceipt?.providerDefinitionsHash
            : null;
          const actualCwdValue = current?.external?.cwd ?? activeBinding?.boundCwd;
          if (typeof actualCwdValue !== "string" || !actualCwdValue.trim()
            || typeof workingDirectory !== "string" || !workingDirectory.trim()) {
            const error = new Error("Provider Session activation omitted its working-directory proof.");
            error.code = "START_PROVIDER_BINDING_FAILED";
            throw error;
          }
          const actualCwd = resolve(actualCwdValue);
          const expectedCwd = resolve(workingDirectory);
          if (!toolContractHash || actualCwd !== expectedCwd) {
            const error = new Error("Provider Session activation did not apply the required Tool contract in the bound ExecutionSpace.");
            error.code = "START_PROVIDER_BINDING_FAILED";
            throw error;
          }
          const instructionSources = [
            ...await requiredWorkspaceInstructionSources(expectedCwd),
            ...await knownGlobalInstructionSources()
          ].sort();
          return {
            providerResourceId: activeBinding.providerSessionId,
            canonicalWorkingDirectory: actualCwd,
            toolContractHash,
            instructionSourcesHash: createHash("sha256").update(JSON.stringify(instructionSources)).digest("hex")
          };
        }
        return await sendUnifiedSessionMessage(session.id, taskExecutionPrompt(task), {
          type: "session-initialization",
          origin: "task-start"
        });
      } catch (error) {
        const initialTurn = dispatchInitialTurn === true;
        error.code = initialTurn ? "START_INITIAL_TURN_FAILED" : "START_PROVIDER_BINDING_FAILED";
        error.stage = initialTurn ? "initial_turn" : "provider_activation";
        console.error(`[task-start] ${initialTurn ? "initial prompt enqueue" : "provider activation"} failed session=${session.id}: ${error.message}`);
        throw error;
      }
    },
    compensateSession: async ({ sessionId, errorCode }) => {
      try {
        await sessionApplicationService.deleteSession(sessionId, {
          source: "work-session-start-compensation",
          reason: errorCode
        });
      } catch (error) {
        store.db.run(
          "UPDATE sessions SET status='failed', updated_at=? WHERE id=? AND status NOT IN ('completed','deleted')",
          [new Date().toISOString(), sessionId]
        );
        store.scheduleSave();
        throw error;
      }
    }
  });
  const workSessionStartupCoordinator = new WorkSessionStartupCoordinator({
    store,
    authorizeStart: (command) => workSessionStartApplicationService.authorize(command),
    prepareWorktree: (input) => startupWorktreePreparer.prepare(input),
    inspectWorktree: (input) => startupWorktreePreparer.inspect(input),
    providerWorkSessionPort,
    compensateWorktree: async ({ operation, allocation }) => {
      const inventory = store.getGitWorktree(allocation.worktreeId);
      if (!inventory || inventory.repositoryId !== allocation.repositoryId
        || resolve(inventory.canonicalPath || inventory.path) !== resolve(allocation.canonicalWorktreePath)) {
        return { manualRequired: true, removed: false };
      }
      const project = await projectApplicationService.requireProject(allocation.repositoryId);
      try {
        await gitWorkspaces.removeWorktreeForProject({
          repositoryId: allocation.repositoryId,
          workingDirectory: project.mainPath,
          sourceWorktreeId: allocation.worktreeId,
          ignoreLogicalSessionIds: operation.logical_session_id ? [operation.logical_session_id] : [],
          safeOnly: true,
          deleteBranch: true
        });
        return { removed: true, manualRequired: false };
      } catch (error) {
        if (["UNCOMMITTED_CHANGES", "UNMERGED_WORKTREE_CONFIRMATION_REQUIRED"].includes(error?.code)) {
          return { removed: false, dirty: error.code === "UNCOMMITTED_CHANGES", manualRequired: true };
        }
        throw error;
      }
    },
    onChanged: (type, payload) => emitEvent(type, payload),
    onReady: ({ receipt }) => projectCodeApplicationService.prewarm({ logicalSessionId: receipt.logicalSessionId })
      .then((result) => {
        emitEvent("ProjectCodeIndexPrewarmChanged", { status: result.status, worktreeId: result.worktreeId,
          logicalSessionId: result.logicalSessionId, durationMs: result.durationMs, indexHit: result.indexHit });
        console.info(`[project-code-prewarm] ${JSON.stringify({ status: result.status, worktreeId: result.worktreeId,
          durationMs: result.durationMs, snapshotMs: result.snapshotMs, indexMs: result.indexMs, indexHit: result.indexHit })}`);
      })
      .catch((error) => {
        emitEvent("ProjectCodeIndexPrewarmChanged", { status: "failed", worktreeId: receipt.worktreeId,
          logicalSessionId: receipt.logicalSessionId, errorCode: error?.code ?? "PROJECT_CODE_PREWARM_FAILED" });
        console.warn(`[project-code-prewarm] ${JSON.stringify({ status: "failed", worktreeId: receipt.worktreeId,
          errorCode: error?.code ?? "PROJECT_CODE_PREWARM_FAILED" })}`);
      })
  });
  const managedSandboxStartupCoordinator = new ManagedSandboxStartupCoordinator({
    store,
    providerWorkSessionPort,
    root: join(store.dataRoot, "execution-spaces"),
    onChanged: (type, payload) => emitEvent(type, payload)
  });
  const workSessionStartApplicationService = new WorkSessionStartApplicationService({
    store,
    coordinator: workSessionStartupCoordinator,
    managedSandboxCoordinator: managedSandboxStartupCoordinator,
    providerRegistry: agentProviderRegistry,
    resolveProviderId: resolveSessionProviderId
  });
  return { workSessionStartupCoordinator, workSessionStartApplicationService };
}
