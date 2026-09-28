import assert from "node:assert/strict";
import test from "node:test";
import { handleBackendRestartHttpRequest, handleBackendHealthHttpRequest } from "../src/application/backendLifecycleHttpApi.mjs";

function fixture() {
  const calls = [];
  let phase = "restartRequired";
  const timers = [];
  const dependencies = {
    dataRootMigrationCoordinator: {
      status: () => ({ phase, operationId: "operation" }),
      transition: async (...args) => { calls.push(["transition", ...args]); }
    },
    shutdown: () => calls.push(["shutdown"]),
    scheduleShutdown: (callback, delay) => {
      const timer = { callback, delay, unreferenced: false, unref() { this.unreferenced = true; } };
      timers.push(timer);
      return timer;
    },
    sendJson: (response, status, body) => { calls.push(["response", status]); response.resolve({ status, body }); },
    developmentPreview: false, now: () => "time", backendStoreReady: true,
    store: { migrationInProgress: false },
    projectCodeIndexStore: { getReadiness: () => ({ status: "ready" }) },
    projectCodeRunIsolationPort: {},
    projectCodeApplicationService: { prewarmSummary: () => ({ ready: 1 }) },
    projectCodeFreshnessMonitor: { summary: () => ({ monitors: 0 }) }
  };
  function dispatch(path, method = "POST") {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const context = { ...dependencies, request: { method }, response: { resolve }, url: new URL(path, "http://localhost") };
    const handled = handleBackendRestartHttpRequest(context) || handleBackendHealthHttpRequest(context);
    return { handled, result };
  }
  return { calls, timers, dependencies, dispatch, setPhase: (value) => { phase = value; } };
}

test("restart handoff must be persisted before response and delayed shutdown", async () => {
  const f = fixture();
  let commit;
  f.dependencies.dataRootMigrationCoordinator.transition = (...args) => {
    f.calls.push(["transition", ...args]);
    return new Promise((resolve) => { commit = resolve; });
  };
  const request = f.dispatch("/internal/backend/data-root-restart");
  assert.equal(request.handled, true);
  assert.deepEqual(f.calls, [["transition", "reconnecting", { restartRequired: false }]]);
  assert.deepEqual(f.timers, []);
  commit();
  assert.deepEqual(await request.result, { status: 202, body: { operationId: "operation", accepted: true } });
  assert.equal(f.timers[0].delay, 500);
  assert.equal(f.timers[0].unreferenced, true);
  assert.deepEqual(f.calls.at(-1), ["response", 202]);
  f.timers[0].callback();
  assert.deepEqual(f.calls.at(-1), ["shutdown"]);
});

test("invalid phase or failed handoff cannot schedule shutdown", async () => {
  const f = fixture();
  f.setPhase("copying");
  assert.equal((await f.dispatch("/internal/backend/data-root-restart").result).body.code, "DATA_ROOT_RESTART_NOT_READY");
  assert.ok(!f.calls.some(([name]) => name === "transition"));
  f.setPhase("restartRequired");
  f.dependencies.dataRootMigrationCoordinator.transition = async () => { throw new Error("disk"); };
  assert.equal((await f.dispatch("/internal/backend/data-root-restart").result).body.code, "DATA_ROOT_RESTART_HANDOFF_FAILED");
  assert.deepEqual(f.timers, []);
});

test("health distinguishes Store, maintenance and indexing readiness", async () => {
  const f = fixture();
  const healthy = (await f.dispatch("/health", "GET").result).body;
  assert.equal(healthy.storeReady, true);
  assert.equal(healthy.projectCode.l1Catalog, "ready");
  assert.equal(healthy.projectCode.semantic, "ready");
  f.dependencies.backendStoreReady = false;
  f.dependencies.store.migrationInProgress = true;
  f.dependencies.projectCodeIndexStore.getReadiness = () => ({ status: "unavailable", code: "INDEX_UNAVAILABLE" });
  f.dependencies.projectCodeRunIsolationPort = null;
  const degraded = (await f.dispatch("/health", "GET").result).body;
  assert.equal(degraded.storeReady, false);
  assert.equal(degraded.maintenance, true);
  assert.equal(degraded.projectCode.l2Symbols, "degraded");
  assert.equal(degraded.projectCode.semantic, "unsupported");
  assert.equal(degraded.projectCode.reasonCode, "INDEX_UNAVAILABLE");
  assert.equal(f.dispatch("/health", "POST").handled, false);
});
