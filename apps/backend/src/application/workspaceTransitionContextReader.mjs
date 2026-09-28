import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../utils/localPathAccess.mjs";

export function createWorkspaceTransitionContextReader({
  store, bundledAgentMemoryPath, corptieCodexRuntimePaths,
  corptieClaudeRuntimePaths
}) {
  async function requiredWorkspaceInstructionSources(cwd) {
    const candidate = join(cwd, "AGENTS.md");
    return pathExists(candidate) ? [await realpath(candidate)] : [];
  }

  async function knownGlobalInstructionSources() {
    const candidates = [
      bundledAgentMemoryPath,
      join(corptieCodexRuntimePaths.codexHome, "AGENTS.md"),
      corptieClaudeRuntimePaths.claudeMemoryPath
    ];
    const paths = [];
    for (const candidate of candidates) {
      if (!pathExists(candidate)) continue;
      paths.push(await realpath(candidate));
    }
    return [...new Set(paths)];
  }

  function sessionTransitionCheckpoint(sessionId, bindingId = null) {
    const unsettled = store.listUnsettledSessionTurns(sessionId);
    const active = [...unsettled].reverse().find((turn) => !bindingId || turn.binding_id === bindingId)
      ?? unsettled.at(-1)
      ?? null;
    const completed = store.latestCompletedSessionTurn(sessionId, bindingId)
      ?? store.latestCompletedSessionTurn(sessionId);
    return {
      activeTurnId: active?.turn_id ?? null,
      lastCompletedTurnId: completed?.turn_id ?? null
    };
  }

  async function storedTransitionTimelineItems({ sessionId, lastCompletedTurnId }) {
    if (!sessionId) return [];
    const items = store.getItems(sessionId, 500);
    if (!lastCompletedTurnId) return items;
    const lastIndex = items.findLastIndex((item) => item.turnId === lastCompletedTurnId);
    return lastIndex >= 0 ? items.slice(0, lastIndex + 1) : items;
  }

  return {
    requiredWorkspaceInstructionSources, knownGlobalInstructionSources,
    sessionTransitionCheckpoint, storedTransitionTimelineItems
  };
}
