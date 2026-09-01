import assert from "node:assert/strict";
import test from "node:test";
import {
  TaskExecutionOrchestrator,
  TaskExecutionOrchestratorError
} from "../src/application/taskExecutionOrchestrator.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const task = {
    id: "task:one",
    lifecycle_state: "done",
    current_session_id: "session:one",
    acceptance_assessment: { status: "passed" }
  };
  const route = {
    activeWorkspaceId: "worktree:one",
    activeBinding: { boundCwd: "/repo-task-one" }
  };
  const orchestrator = new TaskExecutionOrchestrator({
    getTask: () => task,
    getSession: () => ({ id: "session:one", status: "complete" }),
    getSessionRoute: () => route,
    ensureWorkspace: async () => ({
      worktreeId: "worktree:one",
      path: "/repo-task-one",
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
    updateTask: (taskId, patch) => {
      calls.push(["update", taskId, patch]);
      return { ...task, ...patch };
    },
    onChanged: (type, payload) => calls.push(["event", type, payload.action]),
    ...overrides
  });
  return { orchestrator, calls, task, route };
}

test("restoring a completed Task reuses its available Worktree and restores state after the Session", async () => {
  const { orchestrator, calls } = fixture();
  const result = await orchestrator.restore("task:one");

  assert.equal(result.task.lifecycleState, "in_progress");
  assert.equal(result.task.executionStatus, "idle");
  assert.equal(result.task.acceptanceAssessment, null);
  assert.equal(result.transition, null);
  assert.deepEqual(calls, [
    ["unarchive", "session:one"],
    ["resume", "session:one"],
    ["update", "task:one", {
      lifecycleState: "in_progress",
      executionStatus: "idle",
      acceptanceAssessment: null
    }],
    ["event", "TaskChanged", "execution-restored"]
  ]);
});

test("restoring recreates a missing Worktree and switches the Session before resuming", async () => {
  const { orchestrator, calls, route } = fixture({
    ensureWorkspace: async () => ({
      worktreeId: "worktree:replacement",
      path: "/repo-task-one",
      reused: false,
      requiresSessionTransition: true
    }),
    switchWorkspace: async (sessionId, worktreeId) => {
      calls.push(["switch", sessionId, worktreeId]);
      route.activeWorkspaceId = worktreeId;
      route.activeBinding.boundCwd = "/repo-task-one";
      return { status: "committed" };
    },
    restoreSessionRoute: async (sessionId) => {
      assert.equal(route.activeWorkspaceId, "worktree:replacement");
      calls.push(["unarchive", sessionId]);
    },
    resumeSession: async (sessionId) => {
      assert.equal(route.activeWorkspaceId, "worktree:replacement");
      calls.push(["resume", sessionId]);
      return { id: sessionId, status: "complete" };
    }
  });
  const result = await orchestrator.restore("task:one");

  assert.equal(result.workspace.reused, false);
  assert.equal(result.transition.status, "committed");
  assert.deepEqual(calls.slice(0, 3), [
    ["switch", "session:one", "worktree:replacement"],
    ["unarchive", "session:one"],
    ["resume", "session:one"]
  ]);
});

test("a clear Worktree rebuild error prevents Session resume and in-progress publication", async () => {
  let updated = false;
  const { orchestrator, calls } = fixture({
    ensureWorkspace: async () => {
      const error = new Error("无法基于任务分支重建 Worktree：磁盘已卸载");
      error.code = "WORKTREE_REBUILD_FAILED";
      error.statusCode = 409;
      throw error;
    },
    updateTask: () => {
      updated = true;
    }
  });

  await assert.rejects(
    () => orchestrator.restore("task:one"),
    (error) => error.code === "WORKTREE_REBUILD_FAILED" && /磁盘已卸载/.test(error.message)
  );
  assert.equal(updated, false);
  assert.deepEqual(calls, []);
});

test("a failed Workspace recovery never writes a false in-progress state", async () => {
  let updated = false;
  const { orchestrator } = fixture({
    ensureWorkspace: async () => ({
      worktreeId: "worktree:replacement",
      path: "/repo-task-one",
      requiresSessionTransition: true
    }),
    switchWorkspace: async () => {
      throw new Error("transition failed");
    },
    updateTask: () => {
      updated = true;
    }
  });

  await assert.rejects(() => orchestrator.restore("task:one"), /transition failed/);
  assert.equal(updated, false);
});

test("a completed Task without a bound Session reports a stable recovery error", async () => {
  const { orchestrator } = fixture({ getSession: () => null });
  await assert.rejects(
    () => orchestrator.restore("task:one"),
    (error) => error instanceof TaskExecutionOrchestratorError
      && error.code === "TASK_SESSION_REQUIRED"
  );
});
