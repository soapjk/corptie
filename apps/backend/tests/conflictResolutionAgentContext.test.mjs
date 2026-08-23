import assert from "node:assert/strict";
import test from "node:test";
import { resolveConflictResolutionAgentContext } from "../src/application/conflictResolutionAgentContext.mjs";

function fixture({ associations = [], logicalSessions = [] } = {}) {
  const workItems = new Map([
    ["work_item:active", { id: "work_item:active", objective_id: "objective:one", main_agent_id: "agent:one" }],
    ["work_item:completed", { id: "work_item:completed", objective_id: "objective:one", main_agent_id: "agent:one" }]
  ]);
  return {
    item: { worktreeId: "worktree:integration", associations },
    store: {
      listLogicalSessionsByWorkspaceId: () => logicalSessions,
      getSession: (id) => id === "session:completed" ? { workItemId: "work_item:completed" } : null,
      getWorkItem: (id) => workItems.get(id) ?? null,
      getObjective: (id) => id === "objective:one" ? { id } : null,
      getAgent: (id) => id === "agent:one" ? { agentId: id, role: "independentContributor" } : null
    }
  };
}

test("conflict Agent context uses the current WorkItem association first", () => {
  const { item, store } = fixture({ associations: [{ workItemId: "work_item:active" }] });
  assert.equal(resolveConflictResolutionAgentContext(item, store)?.sourceWorkItem.id, "work_item:active");
});

test("conflict Agent context recovers a completed WorkItem from the Worktree Session route", () => {
  const { item, store } = fixture({
    logicalSessions: [{ legacySessionId: "session:completed" }]
  });
  assert.equal(resolveConflictResolutionAgentContext(item, store)?.sourceWorkItem.id, "work_item:completed");
});
