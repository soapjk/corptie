export function handleSessionGitHttpRequest({
  request, response, url, prepareGitHubPush, generateGitHubPushCommitMessage,
  confirmGitHubPush, projectWorktreeStatus, mergeProjectWorktree, prepareProjectWorktreeCommit,
  generateProjectWorktreeCommitMessage, commitProjectWorktree, completeProjectWorktree,
  operateProjectWorktree, restartProjectWorktree, readJson, sendJson, errorStatus
}) {
  const sessionGitHubPushMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/github-push\/(prepare|commit-message|confirm)$/
  );
  const sessionProjectWorktreesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/project-worktrees$/);
  const sessionProjectWorktreeActionMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/project-worktrees\/([^/]+)\/(merge|complete|restart|operate|commit|commit-prepare|commit-message)$/
  );
  if (request.method === "POST" && sessionGitHubPushMatch) {
    const sessionId = decodeURIComponent(sessionGitHubPushMatch[1]);
    const action = sessionGitHubPushMatch[2];
    readJson(request)
      .then((input) => action === "prepare"
        ? prepareGitHubPush(sessionId)
        : action === "commit-message"
          ? generateGitHubPushCommitMessage(sessionId, input)
          : confirmGitHubPush(sessionId, input))
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, errorStatus(error, 400), { error: error.message }));
    return true;
  }
  if (request.method === "GET" && sessionProjectWorktreesMatch) {
    const sessionId = decodeURIComponent(sessionProjectWorktreesMatch[1]);
    projectWorktreeStatus(sessionId)
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, errorStatus(error, 400), { error: error.message }));
    return true;
  }
  if (request.method === "POST" && sessionProjectWorktreeActionMatch) {
    const sessionId = decodeURIComponent(sessionProjectWorktreeActionMatch[1]);
    const sourceWorktreeId = decodeURIComponent(sessionProjectWorktreeActionMatch[2]);
    const action = sessionProjectWorktreeActionMatch[3];
    readJson(request)
      .then((input) => action === "merge"
        ? mergeProjectWorktree(sessionId, sourceWorktreeId, input)
        : action === "commit-prepare"
          ? prepareProjectWorktreeCommit(sessionId, sourceWorktreeId)
        : action === "commit-message"
          ? generateProjectWorktreeCommitMessage(sessionId, sourceWorktreeId)
        : action === "commit"
          ? commitProjectWorktree(sessionId, sourceWorktreeId, input)
        : action === "complete"
          ? completeProjectWorktree(sessionId, sourceWorktreeId, input)
          : action === "operate"
            ? operateProjectWorktree(sessionId, sourceWorktreeId, input)
            : restartProjectWorktree(sessionId, sourceWorktreeId))
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, errorStatus(error, 400), {
        error: error.message,
        code: error.code ?? null,
        ...(error.violations ? { details: { violations: error.violations } } : {})
      }));
    return true;
  }
  return false;
}
