import { visibleStoredSessionProjections } from "./providerSessionProjection.mjs";
import { deduplicateSessionTitles } from "../utils/sessionTitles.mjs";

export function loadStartupSessionInventory(store, normalizeSessionId) {
  // Physical Provider rows remain available for route audit, but product
  // Sessions alone populate the startup inventory.
  const allStoredSessions = store.listSessions({ archived: false });
  const visibleSessions = visibleStoredSessionProjections(store, allStoredSessions);
  const hiddenCount = allStoredSessions.length - visibleSessions.length;
  if (hiddenCount > 0) {
    console.log(`[session-projection] hid ${hiddenCount} bound physical Provider session(s) at startup`);
  }

  const storedSessions = deduplicateSessionTitles(visibleSessions);
  for (let index = 0; index < visibleSessions.length; index += 1) {
    const previous = visibleSessions[index];
    const unique = storedSessions[index];
    if (previous.title === unique.title) continue;
    store.renameSession(normalizeSessionId(previous.id), unique.title);
    console.log(`[session-title] renamed historical duplicate session=${previous.id} from=${JSON.stringify(previous.title)} to=${JSON.stringify(unique.title)}`);
  }

  const knownActiveWorktrees = new Map();
  for (const session of storedSessions) {
    const logical = store.getLogicalSessionByLegacySessionId(session.id);
    const worktree = logical?.activeWorkspaceId
      ? store.getGitWorktree(logical.activeWorkspaceId)
      : null;
    if (worktree) knownActiveWorktrees.set(worktree.worktreeId, worktree);
  }
  return { storedSessions, knownActiveWorktrees };
}
