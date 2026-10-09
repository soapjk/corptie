import assert from "node:assert/strict";
import test from "node:test";
import { ClientWorktreeManagementAPI } from "../src/application/clientWorktreeManagementAPI.mjs";

test("paired Worktree facade uses project services and a closed action allowlist", async () => {
  const calls = [];
  const api = new ClientWorktreeManagementAPI({
    worktrees: {
      repositories: () => [{ id: "repo:one" }],
      repository: async (id, options) => ({ repository: { id }, options }),
      worktreeGitHubPushStatus: async (repositoryId, worktreeId) => ({ repositoryId, worktreeId }),
      get: id => ({ id }),
      preflight: async (repositoryId, input) => ({ id: "job:one", repositoryId, input }),
      createCandidate: async (repositoryId, input) => ({ id: "candidate:one", repositoryId, input }),
      startCandidate: async (repositoryId, input) => ({ id: "job:started", repositoryId, input }),
      deleteWorktree: async (repositoryId, worktreeId) => ({ repositoryId, worktreeId }),
      confirm: async (id, input) => ({ id, input }), cancel: async (id, input) => ({ id, input }),
      retry: async id => ({ id }), resolveConflictWithAgent: async id => ({ id }),
      prepareCommitPolicyResolution: async id => ({ id, phase: "prepared" }),
      resolveCommitPolicy: async (id, input) => ({ id, phase: "resolved", input }),
      resolveCommitPolicyResidue: async (id, input) => ({ id, phase: "residue-resolved", input })
    },
    projects: {
      readDevelopmentService: async projectId => ({ projectId }),
      runWorkspaceAction: async (projectId, workspaceId, action, input) => {
        calls.push({ projectId, workspaceId, action, input }); return { result: { ok: true } };
      },
      runDevelopmentServiceAction: async (projectId, action, input) => ({ projectId, action, input })
    }
  });

  assert.deepEqual(api.repositories(), { repositories: [{ id: "repo:one" }] });
  assert.equal((await api.repository("repo:one", { forceFresh: true })).options.forceFresh, true);
  assert.equal((await api.createPlan("repo:one", { operationType: "merge" })).job.id, "job:one");
  assert.equal((await api.createCandidate("repo:one", {})).candidate.id, "candidate:one");
  assert.equal((await api.startCandidate("repo:one", { idempotencyKey: "start:one" })).job.id, "job:started");
  assert.equal((await api.jobAction("job:one", "retry", {})).job.id, "job:one");
  assert.equal((await api.jobAction("job:one", "commit-policy-prepare", {})).job.phase, "prepared");
  assert.equal((await api.jobAction("job:one", "commit-policy-decisions", { decisions: [] })).job.phase, "resolved");
  assert.equal((await api.jobAction("job:one", "commit-policy-residue", { decisions: [] })).job.phase, "residue-resolved");
  assert.equal((await api.workspaceAction("repo:one", "tree:one", "synchronize", {})).result.ok, true);
  assert.deepEqual(calls, [{ projectId: "repo:one", workspaceId: "tree:one", action: "synchronize", input: {} }]);
  await assert.rejects(api.workspaceAction("repo:one", "tree:one", "arbitrary", {}), { code: "ROUTE_NOT_AVAILABLE" });
  await assert.rejects(api.developmentServiceAction("repo:one", "arbitrary", {}), { code: "ROUTE_NOT_AVAILABLE" });
  await assert.rejects(api.jobAction("job:one", "arbitrary", {}), { code: "ROUTE_NOT_AVAILABLE" });
});
