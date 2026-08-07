import { sanitizeSessionCommitMessage } from "../utils/sessionCommitMessage.mjs";

export async function resolveProjectWorktreeCommitMessage(input) {
  const provided = sanitizeSessionCommitMessage(input.requestedMessage);
  if (provided) return provided;
  if (!input.worktree?.dirty) return null;

  const plan = {
    sourceBranch: input.worktree.branchName,
    sourcePath: input.worktree.path,
    statusSummary: input.worktree.statusSummary,
    diffStat: input.worktree.diffStat
  };
  const sourceSessionId = input.worktree.sessions?.find((item) => item.sessionId)?.sessionId;
  if (sourceSessionId) {
    return input.generateForSession(sourceSessionId, plan);
  }
  if (!input.requestingSessionId) {
    throw new Error("A requesting Session is required to generate a commit message for an unowned Worktree.");
  }
  return input.generateForUnownedWorktree(input.requestingSessionId, input.worktree.path, plan);
}
