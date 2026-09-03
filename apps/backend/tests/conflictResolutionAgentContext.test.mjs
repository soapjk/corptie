import assert from "node:assert/strict";
import test from "node:test";
import { resolveConflictResolutionAgentContext } from "../src/application/conflictResolutionAgentContext.mjs";

function fixture({ associations = [], logicalSessions = [] } = {}) {
  const tasks = new Map([
    ["task:active", { id: "task:active", work_id: "work:one", main_agent_id: "agent:one" }],
    ["task:completed", { id: "task:completed", work_id: "work:one", main_agent_id: "agent:one" }]
  ]);
  return {
    item: { worktreeId: "worktree:integration", associations },
    store: {
      listLogicalSessionsByWorkspaceId: () => logicalSessions,
      getSession: (id) => id === "session:completed" ? { taskId: "task:completed" } : null,
      getTask: (id) => tasks.get(id) ?? null,
      getWork: (id) => id === "work:one" ? { id } : null,
      getAgent: (id) => id === "agent:one" ? { agentId: id, role: "independentContributor" } : null
    }
  };
}

test("conflict Agent context uses the current Task association first", () => {
  const { item, store } = fixture({ associations: [{ taskId: "task:active" }] });
  assert.equal(resolveConflictResolutionAgentContext(item, store)?.sourceTask.id, "task:active");
});

test("conflict Agent context recovers a completed Task from the Worktree Session route", () => {
  const { item, store } = fixture({
    logicalSessions: [{ legacySessionId: "session:completed" }]
  });
  assert.equal(resolveConflictResolutionAgentContext(item, store)?.sourceTask.id, "task:completed");
});
