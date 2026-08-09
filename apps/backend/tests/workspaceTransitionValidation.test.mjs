import assert from "node:assert/strict";
import test from "node:test";
import {
  permissionSnapshotFromAppServerResponse,
  validateWorkspaceInstructionSources,
  workspaceTransitionContext
} from "../src/utils/workspaceTransitionValidation.mjs";

const identityRealpath = async (path) => path;

test("instruction validation accepts target and explicitly global sources", async () => {
  const validation = await validateWorkspaceInstructionSources({
    sourceCwd: "/repo/source",
    targetCwd: "/repo/feature worktree",
    instructionSources: [
      "/Users/person/.codex/AGENTS.md",
      "/repo/AGENTS.md",
      "/repo/feature worktree/AGENTS.md"
    ],
    requiredTargetSources: [
      "/repo/AGENTS.md",
      "/repo/feature worktree/AGENTS.md"
    ],
    globalInstructionSources: ["/Users/person/.codex/AGENTS.md"]
  }, { realpath: identityRealpath });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.missingTargetSources, []);
  assert.deepEqual(validation.staleSourceSources, []);
  assert.deepEqual(validation.unexpectedSources, []);
});

test("instruction validation rejects missing target and stale source worktree instructions", async () => {
  const validation = await validateWorkspaceInstructionSources({
    sourceCwd: "/repo/source",
    targetCwd: "/repo/feature",
    instructionSources: [
      "/repo/AGENTS.md",
      "/repo/source/AGENTS.md"
    ],
    requiredTargetSources: [
      "/repo/AGENTS.md",
      "/repo/feature/AGENTS.md"
    ]
  }, { realpath: identityRealpath });

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.missingTargetSources, ["/repo/feature/AGENTS.md"]);
  assert.deepEqual(validation.staleSourceSources, ["/repo/source/AGENTS.md"]);
});

test("instruction validation accepts target-required Agent config symlinked to the main worktree", async () => {
  const aliases = new Map([
    ["/repo/feature/AGENTS.md", "/repo/main/AGENTS.md"]
  ]);
  const validation = await validateWorkspaceInstructionSources({
    sourceCwd: "/repo/main",
    targetCwd: "/repo/feature",
    instructionSources: ["/repo/main/AGENTS.md"],
    requiredTargetSources: ["/repo/feature/AGENTS.md"]
  }, {
    realpath: async (path) => aliases.get(path) ?? path
  });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.requiredTargetSources, ["/repo/main/AGENTS.md"]);
  assert.deepEqual(validation.staleSourceSources, []);
});

test("instruction validation fails closed when a response source is outside known scopes", async () => {
  const validation = await validateWorkspaceInstructionSources({
    sourceCwd: "/repo/source",
    targetCwd: "/repo/feature",
    instructionSources: ["/tmp/unexpected/AGENTS.md"],
    requiredTargetSources: []
  }, { realpath: identityRealpath });

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.unexpectedSources, ["/tmp/unexpected/AGENTS.md"]);
});

test("permission snapshots retain runtime roots and active profile provenance", () => {
  assert.deepEqual(permissionSnapshotFromAppServerResponse({
    cwd: "/repo/feature",
    runtimeWorkspaceRoots: ["/repo/feature"],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", writableRoots: ["/repo/feature"] },
    activePermissionProfile: { id: "workspace-write" }
  }), {
    cwd: "/repo/feature",
    runtimeWorkspaceRoots: ["/repo/feature"],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/repo/feature"] },
    activePermissionProfile: { id: "workspace-write" }
  });
});

test("workspace transition context names the new workspace and loaded instructions", () => {
  const context = workspaceTransitionContext({
    sourceCwd: "/repo/source",
    targetCwd: "/repo/feature",
    instructionSources: ["/repo/feature/AGENTS.md"]
  });

  assert.match(context, /Active workspace: \/repo\/feature/);
  assert.match(context, /Previous workspace: \/repo\/source/);
  assert.match(context, /\/repo\/feature\/AGENTS\.md/);
});
