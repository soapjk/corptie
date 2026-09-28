import test from "node:test";
import assert from "node:assert/strict";
import { createProviderStartupMaintenance } from "../src/agent-provider/bootstrap/providerStartupMaintenance.mjs";

function fixture(overrides = {}) {
  const events = [];
  const record = (name, result) => () => { events.push(name); return result; };
  const runner = createProviderStartupMaintenance({
    workSessionStartupCoordinator: { recoverInterruptedStarts: record("interrupted", 0) },
    projectToolsetInitializer: { recoverAll: record("toolset", []) },
    environmentName: "test",
    codexRuntime: { initialize: record("codex-initialize") },
    openClackyManager: { start: record("openclacky-start") },
    emptyCodexBindingPreflight: { prepare: record("empty-prepare", { candidates: 0 }), run: record("empty-run") },
    toolBootstrapBindingPreflight: { run: record("tool-run") },
    setProviderRuntimeReadiness: (id, state) => events.push({ id, ...state }),
    collaborationCore: {}, store: {},
    codexResetForecastMonitor: { start: record("monitor") },
    resumeSessionRecoveryAttemptsAtStartup: record("session-recovery"),
    deleteHistoricalUnusableTaskSessionsAtStartup: record("cleanup", 0),
    recoverPendingWorkspaceTransitions: record("transitions"),
    reconcileMovedWorkspaceRoutes: (worktrees, options) => events.push({ worktrees, options }),
    sessionRuntimeReleaseService: { reconcileArchivedSessions: record("release", 0) },
    ensureCorptieCodexRuntime: record("codex", { rolloutPathRepair: { repairedCount: 0, backups: [] } }),
    ensureCorptieClaudeRuntime: record("claude", {}),
    ensureCorptieOpenClackyRuntime: record("openclacky", {}),
    recoverCollaborationDeliveriesAfterCodexRolloutRepair: record("rollout-recovery", []),
    ...overrides
  });
  return { ...runner, events };
}

test("construction is inert and startup preserves initialization and cleanup barriers", async () => {
  const { runProviderStartupMaintenance, events } = fixture();
  assert.deepEqual(events, []);
  const worktrees = [{ path: "/workspace" }];
  await runProviderStartupMaintenance(worktrees);
  const before = (a, b) => {
    assert.notEqual(events.indexOf(a), -1);
    assert.notEqual(events.indexOf(b), -1);
    assert.ok(events.indexOf(a) < events.indexOf(b), `${a} must precede ${b}`);
  };
  before("interrupted", "toolset");
  before("toolset", "codex");
  before("codex-initialize", "empty-prepare");
  for (const prerequisite of ["codex-initialize", "claude", "openclacky-start"]) {
    before(prerequisite, "empty-run");
    before(prerequisite, "session-recovery");
  }
  before("empty-run", "tool-run");
  before("tool-run", "release");
  before("transitions", "release");
  assert.equal(events.at(-1), "release");
  assert.deepEqual(events.filter((entry) => entry?.state === "ready").map((entry) => entry.id).sort(),
    ["claude-sdk", "codex-app-server", "openclacky"]);
  assert.deepEqual(events.find((entry) => entry?.worktrees), { worktrees, options: { verifyProviderIdle: true } });
});

test("a failed Provider is marked not ready without suppressing other maintenance", async () => {
  const { runProviderStartupMaintenance, events } = fixture({
    ensureCorptieCodexRuntime: async () => { throw new Error("unavailable"); }
  });
  await runProviderStartupMaintenance([]);
  assert.deepEqual(events.find((entry) => entry?.id === "codex-app-server"), {
    id: "codex-app-server", state: "not_ready", reasonCode: "PROVIDER_INITIALIZATION_FAILED",
    message: "unavailable", retryable: true
  });
  assert.equal(events.includes("codex-initialize"), false);
  assert.equal(events.includes("rollout-recovery"), false);
  assert.ok(events.includes("openclacky-start"));
  assert.ok(events.includes("session-recovery"));
  assert.equal(events.at(-1), "release");
});

test("non-Provider maintenance failure remains isolated", async () => {
  const { runProviderStartupMaintenance, events } = fixture({
    resumeSessionRecoveryAttemptsAtStartup: async () => { throw new Error("recovery failed"); }
  });
  await runProviderStartupMaintenance([]);
  assert.ok(events.includes("transitions"));
  assert.equal(events.at(-1), "release");
  assert.equal(events.some((entry) => entry?.state === "not_ready"), false);
});
