// Project and repository operations are independent of Agent Provider adapters.
export function handleProjectWorkspaceHttpRequest({
  request, response, url, projectApplicationService,
  projectWorktreeIntegrationService, worktreeIntegrationJobService,
  readJson, sendJson, emitEvent, errorStatus, unifiedErrorStatus
}) {
  const projectWorkspacesMatch = url.pathname.match(/^\/projects\/([^/]+)\/workspaces$/);
  const worktreeManagementRepositoryMatch = url.pathname.match(
    /^\/worktree-management\/repositories\/([^/]+)$/
  );
  const worktreeManagementGitHubPushStatusMatch = url.pathname.match(
    /^\/worktree-management\/repositories\/([^/]+)\/worktrees\/([^/]+)\/github-push-status$/
  );
  const worktreeManagementGitOperationMatch = url.pathname.match(
    /^\/worktree-management\/repositories\/([^/]+)\/worktrees\/([^/]+)\/git-operation$/
  );
  const worktreeManagementPreflightMatch = url.pathname.match(
    /^\/worktree-management\/repositories\/([^/]+)\/integration-plans$/
  );
  const worktreeManagementCandidatesMatch = url.pathname.match(
    /^\/worktree-management\/repositories\/([^/]+)\/integration-candidates$/
  );
  const worktreeManagementRepositoryJobsMatch = url.pathname.match(
    /^\/worktree-management\/repositories\/([^/]+)\/integration-jobs$/
  );
  const worktreeManagementCleanupMatch = url.pathname.match(
    /^\/worktree-management\/repositories\/([^/]+)\/cleanup$/
  );
  const worktreeManagementDeleteMatch = url.pathname.match(
    /^\/worktree-management\/repositories\/([^/]+)\/worktrees\/([^/]+)\/delete$/
  );
  const worktreeManagementJobMatch = url.pathname.match(
    /^\/worktree-management\/jobs\/([^/]+)$/
  );
  const worktreeManagementJobActionMatch = url.pathname.match(
    /^\/worktree-management\/jobs\/([^/]+)\/(confirm|retry|cancel|resolve-conflict|commit-policy-prepare|commit-policy-decisions)$/
  );
  const projectWorkspaceActionMatch = url.pathname.match(
    /^\/projects\/([^/]+)\/workspaces\/([^/]+)\/actions\/([^/]+)$/
  );
  const projectDevelopmentServiceMatch = url.pathname.match(/^\/projects\/([^/]+)\/development-service$/);
  const projectDevelopmentServiceActionMatch = url.pathname.match(
    /^\/projects\/([^/]+)\/development-service\/actions\/([^/]+)$/
  );
  const projectWorkIntegrationsMatch = url.pathname.match(
    /^\/projects\/([^/]+)\/works\/([^/]+)\/integrations$/
  );
  const projectWorkIntegrationConflictMatch = url.pathname.match(
    /^\/projects\/([^/]+)\/works\/([^/]+)\/integrations\/([^/]+)\/conflict-task$/
  );
  const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
  if (request.method === "GET" && url.pathname === "/worktree-management/repositories") {
    sendJson(response, 200, { repositories: worktreeIntegrationJobService.repositories() });
    return true;
  }
  if (request.method === "GET" && worktreeManagementRepositoryMatch) {
    const repositoryId = decodeURIComponent(worktreeManagementRepositoryMatch[1]);
    worktreeIntegrationJobService.repository(repositoryId, {
      forceFresh: url.searchParams.get("forceFresh") === "true"
    })
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, error.statusCode ?? unifiedErrorStatus(error), {
        error: error.message, code: error.code
      }));
    return true;
  }
  if (request.method === "GET" && worktreeManagementGitHubPushStatusMatch) {
    const repositoryId = decodeURIComponent(worktreeManagementGitHubPushStatusMatch[1]);
    const worktreeId = decodeURIComponent(worktreeManagementGitHubPushStatusMatch[2]);
    worktreeIntegrationJobService.worktreeGitHubPushStatus(repositoryId, worktreeId)
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, error.statusCode ?? unifiedErrorStatus(error), {
        error: error.message, code: error.code
      }));
    return true;
  }
  if (request.method === "POST" && worktreeManagementGitOperationMatch) {
    const repositoryId = decodeURIComponent(worktreeManagementGitOperationMatch[1]);
    const worktreeId = decodeURIComponent(worktreeManagementGitOperationMatch[2]);
    readJson(request)
      .then((input) => worktreeIntegrationJobService.handleWorktreeGitOperation(repositoryId, worktreeId, input))
      .then((result) => {
        emitEvent("WorktreeGitOperationChanged", { repositoryId, worktreeId, result });
        sendJson(response, 200, { result });
      })
      .catch((error) => sendJson(response, error.statusCode ?? unifiedErrorStatus(error), {
        error: error.message, code: error.code, conflictFiles: error.conflictFiles
      }));
    return true;
  }
  if (request.method === "POST" && worktreeManagementCandidatesMatch) {
    Promise.resolve()
      .then(() => decodeRouteId(worktreeManagementCandidatesMatch[1], "INVALID_REPOSITORY_ID"))
      .then((repositoryId) => readJson(request)
        .then((input) => worktreeIntegrationJobService.createCandidate(repositoryId, input)))
      .then((candidate) => sendJson(response, 200, { candidate }))
      .catch((error) => sendJson(response, error.statusCode ?? unifiedErrorStatus(error), worktreeErrorBody(error)));
    return true;
  }
  if (request.method === "POST" && worktreeManagementRepositoryJobsMatch) {
    Promise.resolve()
      .then(() => decodeRouteId(worktreeManagementRepositoryJobsMatch[1], "INVALID_REPOSITORY_ID"))
      .then((repositoryId) => readJson(request)
        .then((input) => worktreeIntegrationJobService.startCandidate(repositoryId, input)))
      .then((job) => sendJson(response, 202, { job }))
      .catch((error) => sendJson(response, error.statusCode ?? unifiedErrorStatus(error), worktreeErrorBody(error)));
    return true;
  }
  if (request.method === "POST" && worktreeManagementPreflightMatch) {
    const repositoryId = decodeURIComponent(worktreeManagementPreflightMatch[1]);
    readJson(request)
      .then((input) => worktreeIntegrationJobService.preflight(repositoryId, input))
      .then((result) => sendJson(response, 201, { job: result }))
      .catch((error) => sendJson(response, error.statusCode ?? unifiedErrorStatus(error), {
        error: error.message, code: error.code
      }));
    return true;
  }
  if (request.method === "POST" && worktreeManagementCleanupMatch) {
    const repositoryId = decodeURIComponent(worktreeManagementCleanupMatch[1]);
    readJson(request)
      .then((input) => worktreeIntegrationJobService.cleanupMergedWorktrees(repositoryId, input))
      .then((result) => {
        emitEvent("WorktreeCleanupCompleted", { repositoryId, result });
        sendJson(response, 200, { result });
      })
      .catch((error) => sendJson(response, error.statusCode ?? unifiedErrorStatus(error), {
        error: error.message, code: error.code
      }));
    return true;
  }
  if (request.method === "POST" && worktreeManagementDeleteMatch) {
    const repositoryId = decodeURIComponent(worktreeManagementDeleteMatch[1]);
    const worktreeId = decodeURIComponent(worktreeManagementDeleteMatch[2]);
    readJson(request)
      .then(() => worktreeIntegrationJobService.deleteWorktree(repositoryId, worktreeId))
      .then((result) => {
        emitEvent("WorktreeDeleted", { repositoryId, worktreeId, result });
        sendJson(response, 200, { result });
      })
      .catch((error) => sendJson(response, error.statusCode ?? unifiedErrorStatus(error), {
        error: error.message, code: error.code
      }));
    return true;
  }
  if (request.method === "GET" && worktreeManagementJobMatch) {
    try {
      sendJson(response, 200, { job: worktreeIntegrationJobService.get(
        decodeURIComponent(worktreeManagementJobMatch[1])
      ) });
    } catch (error) {
      sendJson(response, error.statusCode ?? unifiedErrorStatus(error), { error: error.message, code: error.code });
    }
    return true;
  }
  if (request.method === "POST" && worktreeManagementJobActionMatch) {
    const jobId = decodeURIComponent(worktreeManagementJobActionMatch[1]);
    const action = worktreeManagementJobActionMatch[2];
    const knownActions = new Set([
      "confirm", "cancel", "commit-policy-prepare", "commit-policy-decisions",
      "resolve-conflict", "retry"
    ]);
    if (!knownActions.has(action)) {
      sendJson(response, 404, { error: `Unknown integration job action: ${action}`, code: "JOB_ACTION_NOT_FOUND" });
      return true;
    }
    readJson(request)
      .then((input) => action === "confirm"
        ? worktreeIntegrationJobService.confirm(jobId, input)
        : action === "cancel"
          ? worktreeIntegrationJobService.cancel(jobId, input)
          : action === "commit-policy-prepare"
            ? worktreeIntegrationJobService.prepareCommitPolicyResolution(jobId)
          : action === "commit-policy-decisions"
            ? worktreeIntegrationJobService.resolveCommitPolicy(jobId, input)
          : action === "resolve-conflict"
            ? worktreeIntegrationJobService.resolveConflictWithAgent(jobId)
            : worktreeIntegrationJobService.retry(jobId))
      .then((result) => sendJson(response, 202, { job: result }))
      .catch((error) => sendJson(response, error.statusCode ?? unifiedErrorStatus(error), {
        error: error.message, code: error.code
      }));
    return true;
  }
  if (request.method === "GET" && projectWorkIntegrationsMatch) {
    const projectId = decodeURIComponent(projectWorkIntegrationsMatch[1]);
    const workId = decodeURIComponent(projectWorkIntegrationsMatch[2]);
    projectWorktreeIntegrationService.status(projectId, workId)
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, error.statusCode ?? unifiedErrorStatus(error), {
        error: error.message,
        code: error.code
      }));
    return true;
  }
  if (request.method === "POST" && projectWorkIntegrationsMatch) {
    const projectId = decodeURIComponent(projectWorkIntegrationsMatch[1]);
    const workId = decodeURIComponent(projectWorkIntegrationsMatch[2]);
    projectWorktreeIntegrationService.integrateCompleted(projectId, workId)
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, error.statusCode ?? unifiedErrorStatus(error), {
        error: error.message,
        code: error.code
      }));
    return true;
  }
  if (request.method === "POST" && projectWorkIntegrationConflictMatch) {
    const projectId = decodeURIComponent(projectWorkIntegrationConflictMatch[1]);
    const workId = decodeURIComponent(projectWorkIntegrationConflictMatch[2]);
    const runId = decodeURIComponent(projectWorkIntegrationConflictMatch[3]);
    readJson(request)
      .then((input) => projectWorktreeIntegrationService.createConflictTask(
        projectId,
        workId,
        runId,
        input
      ))
      .then((result) => sendJson(response, result.reused ? 200 : 201, result))
      .catch((error) => sendJson(response, error.statusCode ?? unifiedErrorStatus(error), {
        error: error.message,
        code: error.code
      }));
    return true;
  }
  if (request.method === "GET" && projectWorkspacesMatch) {
    const projectId = decodeURIComponent(projectWorkspacesMatch[1]);
    projectApplicationService.listWorkspaces(projectId, {
      activeWorkspaceId: url.searchParams.get("activeWorkspaceId")
    })
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code }));
    return true;
  }
  if (request.method === "POST" && projectWorkspaceActionMatch) {
    const projectId = decodeURIComponent(projectWorkspaceActionMatch[1]);
    const workspaceId = decodeURIComponent(projectWorkspaceActionMatch[2]);
    const action = decodeURIComponent(projectWorkspaceActionMatch[3]);
    readJson(request)
      .then((input) => projectApplicationService.runWorkspaceAction(projectId, workspaceId, action, input))
      .then((result) => {
        emitEvent("ProjectWorkspaceChanged", { projectId, workspaceId, action, result });
        sendJson(response, 200, result);
      })
      .catch((error) => sendJson(response, errorStatus(error, unifiedErrorStatus(error)), {
        error: error.message,
        code: error.code,
        unmergedCommitCount: error.unmergedCommitCount,
        branchName: error.branchName
      }));
    return true;
  }
  if (request.method === "GET" && projectDevelopmentServiceMatch) {
    const projectId = decodeURIComponent(projectDevelopmentServiceMatch[1]);
    projectApplicationService.readDevelopmentService(projectId)
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code }));
    return true;
  }
  if (request.method === "POST" && projectDevelopmentServiceActionMatch) {
    const projectId = decodeURIComponent(projectDevelopmentServiceActionMatch[1]);
    const action = decodeURIComponent(projectDevelopmentServiceActionMatch[2]);
    readJson(request)
      .then((input) => projectApplicationService.runDevelopmentServiceAction(projectId, action, input))
      .then((result) => {
        emitEvent("ProjectDevelopmentServiceChanged", { projectId, action, result });
        sendJson(response, action === "initialize" || action === "update" ? 202 : 200, result);
      })
      .catch((error) => sendJson(response, errorStatus(error, unifiedErrorStatus(error)), {
        error: error.message,
        code: error.code
      }));
    return true;
  }
  if (request.method === "GET" && projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]);
    projectApplicationService.readProject(projectId)
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code }));
    return true;
  }

  return false;
}

function decodeRouteId(value, code) {
  try {
    return decodeURIComponent(value);
  } catch {
    const error = new Error("The repository identifier is malformed.");
    error.code = code;
    error.statusCode = 400;
    throw error;
  }
}

function worktreeErrorBody(error) {
  return {
    error: error.message,
    code: error.code,
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(error.candidate ? { candidate: error.candidate } : {}),
    ...(error.diff ? { diff: error.diff } : {})
  };
}
