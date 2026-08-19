import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkItemExecutionOrchestrator,
  WorkItemExecutionOrchestratorError
} from "../src/application/workItemExecutionOrchestrator.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const workItem = {
    id: "work_item:one",
    status: "done",
    current_session_id: "session:one",
    acceptance_assessment: { status: "passed" }
  };
  const route = {
    activeWorkspaceId: "worktree:one",
    activeBinding: { boundCwd: "/repo-workitem-one" }
  };
  const orchestrator = new WorkItemExecutionOrchestrator({
    getWorkItem: () => workItem,
    getSession: () => ({ id: "session:one", status: "complete" }),
    getSessionRoute: () => route,
    ensureWorkspace: async () => ({
      worktreeId: "worktree:one",
      path: "/repo-workitem-one",
      reused: true,
      requiresSessionTransition: false
    }),
    switchWorkspace: async (...args) => {
      calls.push(["switch", ...args]);
      return { status: "committed" };
    },
    restoreSessionRoute: async (sessionId) => calls.push(["unarchive", sessionId]),
    resumeSession: async (sessionId) => {
      calls.push(["resume", sessionId]);
      return { id: sessionId, status: "complete" };
    },
    updateWorkItem: (workItemId, patch) => {
      calls.push(["update", workItemId, patch]);
      return { ...workItem, ...patch };
    },
    onChanged: (type, payload) => calls.push(["event", type, payload.action]),
    ...overrides
  });
  return { orchestrator, calls, workItem, route };
}

test("restoring a completed WorkItem reuses its available Worktree and restores state after the Session", async () => {
  const { orchestrator, calls } = fixture();
  const result = await orchestrator.restore("work_item:one");

  assert.equal(result.workItem.status, "in_progress");
  assert.equal(result.workItem.executionStatus, "idle");
  assert.equal(result.workItem.acceptanceAssessment, null);
  assert.equal(result.transition, null);
  assert.deepEqual(calls, [
    ["unarchive", "session:one"],
    ["resume", "session:one"],
    ["update", "work_item:one", {
      status: "in_progress",
      executionStatus: "idle",
      acceptanceAssessment: null
    }],
    ["event", "WorkItemChanged", "execution-restored"]
  ]);
});

test("restoring recreates a missing Worktree and switches the Session before resuming", async () => {
  const { orchestrator, calls } = fixture({
    ensureWorkspace: async () => ({
      worktreeId: "worktree:replacement",
      path: "/repo-workitem-one",
      reused: false,
      requiresSessionTransition: true
    })
  });
  const result = await orchestrator.restore("work_item:one");

  assert.equal(result.workspace.reused, false);
  assert.equal(result.transition.status, "committed");
  assert.deepEqual(calls.slice(0, 3), [
    ["switch", "session:one", "worktree:replacement"],
    ["unarchive", "session:one"],
    ["resume", "session:one"]
  ]);
});

test("a failed Workspace recovery never writes a false in-progress state", async () => {
  let updated = false;
  const { orchestrator } = fixture({
    ensureWorkspace: async () => ({
      worktreeId: "worktree:replacement",
      path: "/repo-workitem-one",
      requiresSessionTransition: true
    }),
    switchWorkspace: async () => {
      throw new Error("transition failed");
    },
    updateWorkItem: () => {
      updated = true;
    }
  });

  await assert.rejects(() => orchestrator.restore("work_item:one"), /transition failed/);
  assert.equal(updated, false);
});

test("a completed WorkItem without a bound Session reports a stable recovery error", async () => {
  const { orchestrator } = fixture({ getSession: () => null });
  await assert.rejects(
    () => orchestrator.restore("work_item:one"),
    (error) => error instanceof WorkItemExecutionOrchestratorError
      && error.code === "WORK_ITEM_SESSION_REQUIRED"
  );
});
