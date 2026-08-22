// Product-level Workspace preparation for WorkItem execution. A first execution
// has no Session route to recover, so it can go straight to the validating,
// idempotent Worktree ensure operation. Existing Sessions still require a full
// inventory because their previous logical route may be reusable or repairable.
export class WorkItemWorkspaceService {
  constructor(options = {}) {
    this.store = options.store;
    this.requireProject = options.requireProject;
    this.inspectProject = options.inspectProject;
    this.ensureWorktree = options.ensureWorktree;
    this.restoreMissingWorktree = options.restoreMissingWorktree;
    for (const method of ["requireProject", "inspectProject", "ensureWorktree", "restoreMissingWorktree"]) {
      if (typeof this[method] !== "function") {
        throw new TypeError(`WorkItemWorkspaceService requires ${method}().`);
      }
    }
    if (!this.store || typeof this.store.getLogicalSessionByLegacySessionId !== "function") {
      throw new TypeError("WorkItemWorkspaceService requires a Store with logical Session routes.");
    }
  }

  async ensure({ workItem, session = null }) {
    const repositoryId = typeof workItem?.main_workspace_id === "string"
      ? workItem.main_workspace_id.trim()
      : "";
    if (!repositoryId) throw workspaceRequiredError();

    const project = await this.requireProject(repositoryId);

    // The ensure operation independently validates repository identity, main
    // Worktree availability, deterministic branch/path collisions, and the
    // resulting Worktree. A management-grade status scan cannot affect the
    // first-execution decision and previously duplicated that Git work.
    if (!session?.id) {
      return {
        ...(await this.ensureWorktree({
          repositoryId,
          workingDirectory: project.mainPath,
          workItemId: workItem.id
        })),
        requiresSessionTransition: false
      };
    }

    const inspection = await this.inspectProject(project.mainPath, repositoryId);
    const route = this.store.getLogicalSessionByLegacySessionId(session.id);
    const previous = route?.activeWorkspaceId
      ? inspection.worktrees.find((candidate) => candidate.worktreeId === route.activeWorkspaceId)
      : null;
    if (previous?.availability === "available" && previous.isMain !== true) {
      return {
        worktreeId: previous.worktreeId,
        path: previous.canonicalPath || previous.path,
        branchName: previous.branchName,
        headOid: previous.headOid,
        reused: true,
        requiresSessionTransition: false
      };
    }
    if (previous && previous.isMain !== true && route?.logicalSessionId) {
      try {
        const rebuilt = await this.restoreMissingWorktree({ logicalSessionId: route.logicalSessionId });
        return {
          worktreeId: rebuilt.restored.worktreeId,
          path: rebuilt.restored.canonicalPath || rebuilt.restored.path,
          branchName: rebuilt.restored.branchName,
          headOid: rebuilt.restored.headOid,
          reused: false,
          rebuilt: true,
          requiresSessionTransition: true
        };
      } catch (error) {
        if (!String(error?.message ?? "").includes("no longer exists")) throw error;
      }
    }
    return {
      ...(await this.ensureWorktree({
        repositoryId,
        workingDirectory: project.mainPath,
        workItemId: workItem.id
      })),
      requiresSessionTransition: true
    };
  }
}

function workspaceRequiredError() {
  const error = new Error("该工作项尚未绑定 Git 仓库（Workspace），无法执行。");
  error.code = "WORKSPACE_REQUIRED";
  error.statusCode = 409;
  return error;
}
