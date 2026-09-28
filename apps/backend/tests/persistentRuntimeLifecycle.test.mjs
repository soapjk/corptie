import test from "node:test";
import assert from "node:assert/strict";
import { createPersistentRuntimeLifecycle } from "../src/application/persistentRuntimeLifecycle.mjs";

test("migration blockers include durable work and transient background activity", () => {
  const counts = [2, 0, 3, 0, 1];
  const lifecycle = createPersistentRuntimeLifecycle({
    store: { selectOne: () => ({ count: counts.shift() }) },
    dshLivePublisher: { activeTurnCount: 1 },
    taskSessionProjection: { pendingMemoryCount: 0 },
    codexChoiceProjection: { pendingCount: 4 }
  });
  assert.deepEqual(lifecycle.inspectDataRootMigrationBlockers(), [
    { kind: "active_session_turns", count: 2 },
    { kind: "scheduled_tasks", count: 3 },
    { kind: "artifact_writes", count: 1 },
    { kind: "live_provider_turns", count: 1 },
    { kind: "background_choice_tasks", count: 4 }
  ]);
});

test("resume reads the current monitor and restarts services in the original order", async () => {
  const calls = [];
  let monitor = null;
  const lifecycle = createPersistentRuntimeLifecycle({
    activateStoredBackendLogging: () => calls.push("logging"),
    runtimeActivity: {
      startTimelinePublisher: () => calls.push("timeline"),
      startQueueTimer: () => calls.push("queue"),
      trackMaintenance: promise => { calls.push("maintenance"); return promise; }
    },
    scheduledSessionTaskService: { start: () => calls.push("scheduled") },
    getResetForecastMonitor: () => monitor,
    openClackyManager: { start: () => calls.push("provider") },
    feishuGateway: { initialize: async () => calls.push("gateway") }
  });
  monitor = { start: () => calls.push("monitor") };
  await lifecycle.resumePersistentRuntime();
  assert.deepEqual(calls, [
    "logging", "timeline", "scheduled", "monitor", "provider", "queue", "gateway", "maintenance"
  ]);
});
