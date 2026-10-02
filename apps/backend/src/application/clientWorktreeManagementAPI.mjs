import { deviceError } from "./clientDeviceAuthority.mjs";

const WORKSPACE_ACTIONS = new Set([
  "commit", "commit-message", "commit-prepare", "merge", "push", "restart", "synchronize"
]);
const SERVICE_ACTIONS = new Set(["initialize", "update", "profile", "start", "restart", "stop"]);
const JOB_ACTIONS = new Set(["cancel", "confirm", "resolve-conflict", "retry", "commit-policy-decisions"]);

/**
 * Provider-neutral Worktree management facade for paired devices. It invokes the
 * same project services as the desktop routes but exposes only an explicit,
 * permission-gated action allowlist; it never forwards arbitrary HTTP paths.
 */
export class ClientWorktreeManagementAPI {
  constructor({ worktrees, projects, emit = () => {} }) {
    this.worktrees = worktrees;
    this.projects = projects;
    this.emit = emit;
  }

  repositories() {
    return { repositories: this.worktrees.repositories() };
  }

  async repository(repositoryId, { forceFresh = false } = {}) {
    return this.worktrees.repository(validId(repositoryId, "INVALID_REPOSITORY_ID"), { forceFresh });
  }

  async gitHubPushStatus(repositoryId, worktreeId) {
    return this.worktrees.worktreeGitHubPushStatus(
      validId(repositoryId, "INVALID_REPOSITORY_ID"),
      validId(worktreeId, "INVALID_WORKTREE_ID")
    );
  }

  async developmentService(repositoryId) {
    return this.projects.readDevelopmentService(validId(repositoryId, "INVALID_REPOSITORY_ID"));
  }

  job(jobId) {
    return { job: this.worktrees.get(validId(jobId, "INVALID_JOB_ID")) };
  }

  async createPlan(repositoryId, input) {
    return { job: await this.worktrees.preflight(validId(repositoryId, "INVALID_REPOSITORY_ID"), input) };
  }

  async createCandidate(repositoryId, input) {
    return { candidate: await this.worktrees.createCandidate(validId(repositoryId, "INVALID_REPOSITORY_ID"), input) };
  }

  async startCandidate(repositoryId, input) {
    return { job: await this.worktrees.startCandidate(validId(repositoryId, "INVALID_REPOSITORY_ID"), input) };
  }

  async deleteWorktree(repositoryId, worktreeId) {
    repositoryId = validId(repositoryId, "INVALID_REPOSITORY_ID");
    worktreeId = validId(worktreeId, "INVALID_WORKTREE_ID");
    const result = await this.worktrees.deleteWorktree(repositoryId, worktreeId);
    this.emit("WorktreeDeleted", { repositoryId, worktreeId, result });
    return { result };
  }

  async workspaceAction(repositoryId, worktreeId, action, input) {
    repositoryId = validId(repositoryId, "INVALID_REPOSITORY_ID");
    worktreeId = validId(worktreeId, "INVALID_WORKTREE_ID");
    if (!WORKSPACE_ACTIONS.has(action)) throw deviceError("ROUTE_NOT_AVAILABLE", 404);
    const result = await this.projects.runWorkspaceAction(repositoryId, worktreeId, action, input);
    this.emit("ProjectWorkspaceChanged", { projectId: repositoryId, workspaceId: worktreeId, action, result });
    return result;
  }

  async developmentServiceAction(repositoryId, action, input) {
    repositoryId = validId(repositoryId, "INVALID_REPOSITORY_ID");
    if (!SERVICE_ACTIONS.has(action)) throw deviceError("ROUTE_NOT_AVAILABLE", 404);
    const result = await this.projects.runDevelopmentServiceAction(repositoryId, action, input);
    this.emit("ProjectDevelopmentServiceChanged", { projectId: repositoryId, action, result });
    return result;
  }

  async jobAction(jobId, action, input) {
    jobId = validId(jobId, "INVALID_JOB_ID");
    if (!JOB_ACTIONS.has(action)) throw deviceError("ROUTE_NOT_AVAILABLE", 404);
    const job = action === "confirm"
      ? await this.worktrees.confirm(jobId, input)
      : action === "cancel"
        ? await this.worktrees.cancel(jobId, input)
        : action === "commit-policy-decisions"
          ? await this.worktrees.resolveCommitPolicy(jobId, input)
        : action === "resolve-conflict"
          ? await this.worktrees.resolveConflictWithAgent(jobId)
          : await this.worktrees.retry(jobId);
    return { job };
  }
}

function validId(value, code) {
  if (typeof value !== "string" || !value || value.length > 512) throw deviceError(code, 400);
  return value;
}
