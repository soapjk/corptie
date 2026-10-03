import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function prepareCodexProviderSessionInput(input = {}, {
  defaults, normalizeSandbox, normalizeApprovalPolicy
}) {
  return {
    ...input,
    sandbox: normalizeSandbox(input.sandbox ?? defaults.sandbox),
    approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy ?? defaults.approvalPolicy)
  };
}

export function prepareClaudeProviderSessionInput(input = {}, {
  defaults, normalizeSandbox, normalizeApprovalPolicy
}) {
  return {
    ...input,
    sandbox: normalizeSandbox(input.sandbox ?? defaults.sandbox),
    approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy ?? defaults.approvalPolicy),
    model: typeof input.model === "string" && input.model.trim()
      ? input.model.trim()
      : defaults.claudeModel,
    reasoningLevel: typeof input.reasoningLevel === "string" && input.reasoningLevel.trim()
      ? input.reasoningLevel.trim().toLowerCase()
      : null,
    prompt: typeof input.prompt === "string" ? input.prompt.trim() : ""
  };
}

// The startup coordinator supplies an already verified ExecutionSpace.
// This port checks inventory ownership; it does not create or switch a Workspace.
export async function startPreparedWorkSession({
  taskId, assigneeAgentId, providerId, title, workspace, idempotencyKey, sourceSessionId,
  dispatchInitialTurn = true
}, { store, workService, workSessionStartApplicationService }) {
  const task = workService.getTask(taskId);
  const taskRepositoryId = store.getTaskWorkspaceContext(task)?.repository?.id;
  const inventory = workspace?.worktreeId ? store.getGitWorktree(workspace.worktreeId) : null;
  const canonicalPath = resolve(workspace?.path ?? "");
  if (!inventory || inventory.repositoryId !== taskRepositoryId
    || inventory.isMain === true || inventory.availability !== "available"
    || resolve(inventory.canonicalPath || inventory.path) !== canonicalPath) {
    const error = new Error("Prepared Integration Worktree does not match the Task Repository inventory.");
    error.code = "START_WORKTREE_INVENTORY_MISMATCH";
    error.statusCode = 409;
    throw error;
  }
  const startupOperationId = `startup:${createHash("sha256")
    .update(`${task.id}\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)}`;
  store.db.run(
    `UPDATE git_worktrees SET dedicated=1, created_by_startup_operation_id=?
     WHERE worktree_id=? AND repository_id=?
       AND (created_by_startup_operation_id IS NULL OR created_by_startup_operation_id=?)`,
    [startupOperationId, inventory.worktreeId, taskRepositoryId, startupOperationId]
  );
  if (store.db.getRowsModified() !== 1
    || store.getGitWorktree(inventory.worktreeId)?.createdByStartupOperationId !== startupOperationId) {
    const error = new Error("Prepared Integration Worktree is already owned by another startup operation.");
    error.code = "START_WORKTREE_COLLISION";
    error.statusCode = 409;
    throw error;
  }
  store.scheduleSave();
  const started = await workSessionStartApplicationService.start({
    taskId: task.id,
    assigneeAgentId,
    expectedTaskVersion: Number(task.resource_version ?? 1),
    providerId,
    title,
    idempotencyKey,
    sourceSessionId,
    dispatchInitialTurn
  });
  return started.session;
}
