import assert from "node:assert/strict";
import test from "node:test";
import {
  registerGitRepository,
  registerWorkspace
} from "../src/application/gitRepositoryRegistrationService.mjs";

test("a non-Git directory registers as a usable Workspace without initializing Git", async () => {
  const workspaces = [];
  const store = {
    listWorkspaces: () => workspaces,
    createWorkspace(input) {
      const workspace = { workspaceId: "workspace:plain", ...input };
      workspaces.push(workspace);
      return workspace;
    }
  };

  const result = await registerWorkspace({
    dirPath: "/selected/plain-folder",
    store,
    inspectPath: async () => ({ isDirectory: () => true }),
    resolveRealPath: async () => "/selected/plain-folder",
    registerRepository: async () => {
      const error = new Error("not a repository");
      error.code = "NOT_A_GIT_REPOSITORY";
      throw error;
    }
  });

  assert.equal(result.gitCapability, "absent");
  assert.equal(result.repository, null);
  assert.equal(result.workspace.workspaceId, "workspace:plain");
  assert.equal(result.workspace.rootPath, "/selected/plain-folder");
});

test("a Git directory registers the repository capability on its Workspace", async () => {
  const repository = { id: "repository:git", workspaceId: "workspace:git" };
  const workspace = { workspaceId: "workspace:git", rootPath: "/selected/repo" };
  const result = await registerWorkspace({
    dirPath: "/selected/repo",
    store: { getWorkspace: () => workspace },
    inspectPath: async () => ({ isDirectory: () => true }),
    resolveRealPath: async () => "/selected/repo",
    registerRepository: async ({ initializeIfNeeded }) => {
      assert.equal(initializeIfNeeded, false);
      return repository;
    }
  });

  assert.equal(result.gitCapability, "ready");
  assert.equal(result.workspace, workspace);
  assert.equal(result.repository, repository);
});

test("initializing Git is explicitly forwarded and returns a Git-capable Workspace", async () => {
  const repository = { id: "repository:new", workspaceId: "workspace:plain" };
  const workspace = { workspaceId: "workspace:plain", rootPath: "/selected/plain-folder" };
  const result = await registerWorkspace({
    dirPath: "/selected/plain-folder",
    initializeGit: true,
    store: { getWorkspace: () => workspace },
    inspectPath: async () => ({ isDirectory: () => true }),
    resolveRealPath: async () => "/selected/plain-folder",
    registerRepository: async ({ initializeIfNeeded }) => {
      assert.equal(initializeIfNeeded, true);
      return repository;
    }
  });

  assert.equal(result.gitCapability, "ready");
  assert.equal(result.workspace.workspaceId, "workspace:plain");
});

test("Git initialization failure is explicit and never registers a repository", async () => {
  let upsertCount = 0;
  let snapshotAttempts = 0;
  const store = {
    upsertGitWorkspaceSnapshot() { upsertCount += 1; },
    listGitRepositories() { return []; }
  };

  await assert.rejects(
    registerGitRepository({
      dirPath: "/selected/plain-folder",
      initializeIfNeeded: true,
      store,
      inspectPath: async () => ({ isDirectory: () => true }),
      createSnapshot: async () => {
        snapshotAttempts += 1;
        throw new Error("not a repository");
      },
      run: async () => {
        const error = new Error("git init failed");
        error.stderr = "permission denied";
        throw error;
      }
    }),
    (error) => {
      assert.equal(error.code, "GIT_INITIALIZATION_FAILED");
      assert.equal(error.statusCode, 500);
      assert.match(error.message, /permission denied/);
      return true;
    }
  );
  assert.equal(snapshotAttempts, 1);
  assert.equal(upsertCount, 0);
});
