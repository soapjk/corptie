export class ProjectNotFoundError extends Error {
  constructor(projectId) {
    super(`Project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
    this.code = "PROJECT_NOT_FOUND";
    this.projectId = projectId;
  }
}

// Product-level project orchestration. Agent Sessions may link to a Project,
// but none of these operations require a Session or Agent Provider.
export class ProjectApplicationService {
  constructor(options = {}) {
    this.resolveProject = options.resolveProject;
    this.inspectWorkspaces = options.inspectWorkspaces;
    this.inspectDevelopmentService = options.inspectDevelopmentService;
    this.performDevelopmentServiceAction = options.performDevelopmentServiceAction;
    this.performWorkspaceAction = options.performWorkspaceAction;
    for (const method of [
      "resolveProject",
      "inspectWorkspaces",
      "inspectDevelopmentService",
      "performDevelopmentServiceAction",
      "performWorkspaceAction"
    ]) {
      if (typeof this[method] !== "function") {
        throw new TypeError(`ProjectApplicationService requires ${method}().`);
      }
    }
  }

  async readProject(projectId) {
    const project = await this.requireProject(projectId);
    const workspaces = await this.inspectWorkspaces(project);
    return {
      project: {
        id: project.id,
        mainWorkspaceId: workspaces.mainWorktreeId ?? project.mainWorkspaceId ?? null,
        mainPath: workspaces.mainPath ?? project.mainPath,
        mainBranch: workspaces.mainBranch ?? null,
        workspaceCount: workspaces.worktrees?.length ?? 0,
        pendingWorkspaceCount: workspaces.pendingWorktreeCount ?? 0
      }
    };
  }

  async listWorkspaces(projectId) {
    const project = await this.requireProject(projectId);
    const status = await this.inspectWorkspaces(project);
    const development = await this.inspectDevelopmentService(project);
    return { projectId: project.id, project: status, ...development };
  }

  async readDevelopmentService(projectId) {
    const project = await this.requireProject(projectId);
    return {
      projectId: project.id,
      ...(await this.inspectDevelopmentService(project))
    };
  }

  async runWorkspaceAction(projectId, workspaceId, action, input = {}) {
    const project = await this.requireProject(projectId);
    const normalizedWorkspaceId = typeof workspaceId === "string" ? workspaceId.trim() : "";
    if (!normalizedWorkspaceId) throw new TypeError("A workspaceId is required.");
    const result = await this.performWorkspaceAction(project, normalizedWorkspaceId, action, input);
    return {
      projectId: project.id,
      workspaceId: normalizedWorkspaceId,
      action,
      result,
      project: await this.inspectWorkspaces(project)
    };
  }

  async runDevelopmentServiceAction(projectId, action, input = {}) {
    const project = await this.requireProject(projectId);
    const result = await this.performDevelopmentServiceAction(project, action, input);
    return {
      projectId: project.id,
      action,
      result,
      ...(await this.inspectDevelopmentService(project))
    };
  }

  async requireProject(projectId) {
    const normalized = typeof projectId === "string" ? projectId.trim() : "";
    const project = normalized ? await this.resolveProject(normalized) : null;
    if (!project?.id || !project?.mainPath) throw new ProjectNotFoundError(normalized);
    return Object.freeze({ ...project });
  }
}
