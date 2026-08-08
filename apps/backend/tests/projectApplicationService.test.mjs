import assert from "node:assert/strict";
import test from "node:test";

import { ProjectApplicationService, ProjectNotFoundError } from "../src/application/projectApplicationService.mjs";

function fixture() {
  const calls = [];
  const service = new ProjectApplicationService({
    resolveProject: (projectId) => projectId === "project:one"
      ? { id: projectId, mainPath: "/repo/main", mainWorkspaceId: "worktree:main" }
      : null,
    inspectWorkspaces: async (project) => {
      calls.push(["workspaces", project.id]);
      return {
        mainWorktreeId: "worktree:main",
        mainPath: project.mainPath,
        mainBranch: "main",
        pendingWorktreeCount: 1,
        worktrees: [
          { worktreeId: "worktree:main", availability: "available" },
          { worktreeId: "worktree:feature", availability: "available" }
        ]
      };
    },
    inspectWorkspacePushStatus: async (_project, workspace) => {
      calls.push(["pushStatus", workspace.worktreeId]);
      return {
        available: true,
        pending: workspace.worktreeId === "worktree:main",
        unpushedCommitCount: workspace.worktreeId === "worktree:main" ? 2 : 0
      };
    },
    inspectDevelopmentService: async (project) => {
      calls.push(["service", project.id]);
      return { service: { state: "running" } };
    },
    performDevelopmentServiceAction: async (project, action, input) => {
      calls.push(["action", project.id, action, input]);
      return { ok: true };
    },
    performWorkspaceAction: async (project, workspaceId, action, input) => {
      calls.push(["workspaceAction", project.id, workspaceId, action, input]);
      return { committed: true };
    }
  });
  return { calls, service };
}

test("Project APIs operate without constructing an Agent Session", async () => {
  const { calls, service } = fixture();
  const project = await service.readProject("project:one");
  const workspaces = await service.listWorkspaces("project:one", {
    activeWorkspaceId: "worktree:feature"
  });
  const development = await service.runDevelopmentServiceAction("project:one", "restart", { profileId: "dev" });
  const workspace = await service.runWorkspaceAction("project:one", "worktree:feature", "commit", { commitMessage: "Save" });

  assert.equal(project.project.pendingWorkspaceCount, 1);
  assert.equal(workspaces.project.worktrees.length, 2);
  assert.equal(workspaces.project.worktrees[0].gitHubPush.pending, true);
  assert.equal(workspaces.project.worktrees[1].gitHubPush.pending, false);
  assert.equal(development.service.state, "running");
  assert.equal(workspace.result.committed, true);
  assert.deepEqual(calls, [
    ["workspaces", "project:one"],
    ["workspaces", "project:one"],
    ["service", "project:one"],
    ["pushStatus", "worktree:main"],
    ["pushStatus", "worktree:feature"],
    ["action", "project:one", "restart", { profileId: "dev" }],
    ["service", "project:one"],
    ["workspaceAction", "project:one", "worktree:feature", "commit", { commitMessage: "Save" }],
    ["workspaces", "project:one"]
  ]);
});

test("unknown Project ids fail before a product operation runs", async () => {
  const { service } = fixture();
  await assert.rejects(
    () => service.readProject("missing"),
    (error) => error instanceof ProjectNotFoundError && error.code === "PROJECT_NOT_FOUND"
  );
});

test("workspace listing inspects only main and the active workspace for push status", async () => {
  const { calls, service } = fixture();
  const workspaces = await service.listWorkspaces("project:one");

  assert.equal(workspaces.project.worktrees[0].gitHubPush.pending, true);
  assert.equal(workspaces.project.worktrees[1].gitHubPush, null);
  assert.deepEqual(
    calls.filter(([kind]) => kind === "pushStatus"),
    [["pushStatus", "worktree:main"]]
  );
});
