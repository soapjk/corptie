// The manager owns confirmation tokens; this adapter preserves the Session scope
// and only publishes completion after a confirmed operation succeeds.
export function createSessionGitHubPushOperations({
  sessionApplicationService, gitHubPushes, projectWorkingDirectoryForSession,
  generateSessionCommitMessage, emitEvent
}) {
  async function prepareGitHubPush(sessionId) {
    await sessionApplicationService.referenceFor(sessionId);
    return gitHubPushes.prepare({
      sessionId,
      workingDirectory: projectWorkingDirectoryForSession(sessionId)
    });
  }

  async function generateGitHubPushCommitMessage(sessionId, input = {}) {
    const confirmationToken = String(input.confirmationToken ?? "").trim();
    if (!confirmationToken) throw new Error("A GitHub push confirmation token is required.");
    const commitMessage = await gitHubPushes.generateCommitMessage({
      sessionId,
      confirmationToken,
      generateCommitMessage: (plan) => generateSessionCommitMessage(sessionId, plan)
    });
    return { commitMessage };
  }

  async function confirmGitHubPush(sessionId, input = {}) {
    const confirmationToken = String(input.confirmationToken ?? "").trim();
    if (!confirmationToken) throw new Error("A GitHub push confirmation token is required.");
    const result = await gitHubPushes.confirm({
      sessionId,
      confirmationToken,
      privateFilesDecision: input.privateFilesDecision,
      neverRemindPrivateFiles: input.neverRemindPrivateFiles === true,
      commitMessage: input.commitMessage,
      generateCommitMessage: (plan) => generateSessionCommitMessage(sessionId, plan)
    });
    emitEvent("GitHubPushCompleted", {
      sessionId,
      branch: result.branch,
      destinationUrl: result.destinationUrl,
      headOid: result.headOid,
      committed: result.committed
    }, { sessionId });
    return result;
  }

  return { prepareGitHubPush, generateGitHubPushCommitMessage, confirmGitHubPush };
}
