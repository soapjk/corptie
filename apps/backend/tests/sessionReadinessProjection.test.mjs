import test from "node:test";
import assert from "node:assert/strict";
import { createSessionReadinessProjection } from "../src/application/sessionReadinessProjection.mjs";

function fixture(sessions = []) {
  const calls = [];
  const projection = createSessionReadinessProjection({
    store: {
      listSessions: (options) => { assert.deepEqual(options, { archived: false }); return sessions; },
      touchSessionProjectionDependency: (id) => calls.push(["touch", id])
    },
    agentProviderRegistry: {
      descriptors: () => [{ id: "provider", displayName: "Provider" }],
      resolveId: (id) => id === "alias" ? "provider" : id
    },
    scheduleStateSyncPublish: () => calls.push(["publish"]),
    readBindingProbe: () => ({ invalidateProvider: (id) => calls.push(["invalidate", id]) }),
    readFallbackBindingReadiness: () => null
  });
  return { ...projection, calls };
}

test("readiness changes touch only affected Session projections, resolving aliases", () => {
  const { setProviderRuntimeReadiness, calls } = fixture([
    { id: "a", external: { provider: "alias" } },
    { id: "b", provider: "provider" },
    { id: "c", provider: "other" }
  ]);
  setProviderRuntimeReadiness("alias", { state: "ready" });
  assert.deepEqual(calls, [["touch", "a"], ["touch", "b"]]);
  setProviderRuntimeReadiness("provider", { state: "ready" });
  assert.equal(calls.length, 2, "unchanged readiness must not invalidate revisions");
});

test("not-ready transitions invalidate the binding probe before publishing", () => {
  const { setProviderRuntimeReadiness, calls } = fixture([{ id: "a", provider: "provider" }]);
  setProviderRuntimeReadiness("alias", { state: "not_ready", reasonCode: "FAILED" });
  assert.deepEqual(calls, [["invalidate", "provider"], ["touch", "a"]]);
});

test("a Provider with no Sessions still schedules a state publication", () => {
  const { setProviderRuntimeReadiness, decorateSessionForClient, calls } = fixture();
  assert.equal(decorateSessionForClient(null), null);
  setProviderRuntimeReadiness("provider", { state: "ready" });
  assert.deepEqual(calls, [["publish"]]);
});

test("execution waits explain the queue without disabling admission or mutating stored Session state", () => {
  const logical = { repositoryId: "repo", activeWorkspaceId: "tree", logicalSessionId: "logical", activeBinding: { bindingId: "binding" } };
  const job = { id: "job", status: "running", details: { plan: { orchestration: {}, reservedWorktreeIds: ["tree"] } } };
  const store = { listSessions: () => [], getLogicalSessionByLegacySessionId: () => logical,
    getLatestWorktreeIntegrationJob: () => job, getSessionToolCatalogMaterialization: () => null };
  const { decorateSessionForClient } = createSessionReadinessProjection({ store,
    agentProviderRegistry: { descriptors: () => [], resolveId: () => null },
    readBindingProbe: () => null, readFallbackBindingReadiness: () => null });
  const session = { id: "session", status: "complete", deliveryStatus: "queued", activityStatus: null };
  const waiting = decorateSessionForClient(session);
  assert.equal(waiting.executionWait.jobId, "job");
  assert.equal(waiting.activityStatus, waiting.executionWait.message);
  assert.equal(waiting.canSend, true);
  assert.equal(session.activityStatus, null);
  job.status = "completed";
  assert.equal(decorateSessionForClient(session).executionWait, null);
  assert.equal(decorateSessionForClient(session).activityStatus, null);
});
