import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-tool-store-"));
  const dbPath = join(directory, "db.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
  await store.initialize();
  store.createLogicalSessionRoute({
    logicalSessionId: "logical:one", providerThreadId: "thread:one", providerSessionId: "thread:one",
    bindingId: "binding:one", providerId: "fake", boundCwd: directory, sessionName: "Tool Store One"
  });
  return { directory, dbPath, store };
}

function exposurePlan() {
  return {
    capabilityRevision: "codex-app-server:tool-schema:test",
    exposurePlanHash: "plan:replacement",
    providerDefinitionsHash: "definitions:replacement",
    providerDefinitions: [{ name: "corptie_tool_call" }],
    refreshMode: "binding_replacement"
  };
}

function domainRecord(domainId = "artifacts") {
  return {
    domainId,
    domainVersion: `domain:${domainId}:1`,
    toolNames: [domainId === "artifacts" ? "corptie_tool_call" : "corptie_memory_search"]
  };
}

function toolConfirmation(threadId, count = 1) {
  return {
    providerRevision: `thread-start:${threadId}:confirmed`,
    providerDefinitionsHash: "definitions:replacement",
    providerDefinitionsCount: count,
    providerObservationKind: "thread_start_accepted"
  };
}

function appliedReplacement({ logicalSessionId = "logical:one", bindingId, threadId, count = 1 } = {}) {
  const domains = [domainRecord()];
  const plan = exposurePlan();
  const appliedAt = "2026-08-31T01:02:03.000Z";
  return {
    logicalSessionId,
    providerBindingId: bindingId,
    desiredVersion: "desired:replacement",
    appliedVersion: "desired:replacement",
    desiredCatalogVersion: "catalog:replacement",
    appliedCatalogVersion: "catalog:replacement",
    desiredDomains: domains,
    appliedDomains: domains,
    exposurePlan: plan,
    providerReceipt: {
      providerBindingId: bindingId,
      providerCapabilityRevision: plan.capabilityRevision,
      requestedVersion: "desired:replacement",
      appliedVersion: "desired:replacement",
      appliedCatalogVersion: "catalog:replacement",
      appliedDomains: domains,
      appliedExposurePlanHash: plan.exposurePlanHash,
      providerDefinitionsHash: toolConfirmation(threadId, count).providerDefinitionsHash,
      providerDefinitionsCount: toolConfirmation(threadId, count).providerDefinitionsCount,
      providerObservationKind: toolConfirmation(threadId, count).providerObservationKind,
      refreshMode: plan.refreshMode,
      providerRevision: toolConfirmation(threadId, count).providerRevision,
      receiptId: `receipt:${bindingId}`,
      appliedAt
    },
    status: "applied",
    attempt: 1,
    appliedAt
  };
}

function desiredReplacement({ logicalSessionId = "logical:one", bindingId } = {}) {
  return {
    logicalSessionId,
    providerBindingId: bindingId,
    desiredVersion: `desired:${bindingId}`,
    appliedVersion: null,
    desiredCatalogVersion: "catalog:replacement",
    appliedCatalogVersion: null,
    desiredDomains: [domainRecord("artifacts"), domainRecord("memory")],
    appliedDomains: [],
    exposurePlan: exposurePlan(),
    providerReceipt: null,
    status: "stale",
    attempt: 0,
    updatedAt: "2026-08-31T01:02:03.000Z"
  };
}

function applySourceMaterialization(store) {
  const desired = store.writeSessionToolCatalogDesired({
    logicalSessionId: "logical:one",
    providerBindingId: "binding:one",
    desiredVersion: "desired:source",
    desiredCatalogVersion: "catalog:source",
    desiredDomains: [domainRecord()],
    exposurePlan: exposurePlan()
  });
  const refreshing = store.beginSessionToolCatalogRefresh(
    "logical:one",
    "binding:one",
    desired.resourceVersion,
    "2026-08-31T00:00:00.000Z"
  );
  return store.applySessionToolCatalogReceipt({
    logicalSessionId: "logical:one",
    providerBindingId: "binding:one",
    appliedVersion: "desired:source",
    appliedCatalogVersion: "catalog:source",
    appliedDomains: [domainRecord()],
    providerReceipt: { receiptId: "receipt:source" },
    appliedAt: "2026-08-31T00:00:01.000Z"
  }, refreshing.resourceVersion);
}

function applySourceMaterializationWithDesiredUnion(store) {
  const desiredDomains = [domainRecord("artifacts"), domainRecord("memory")];
  const desired = store.writeSessionToolCatalogDesired({
    logicalSessionId: "logical:one",
    providerBindingId: "binding:one",
    desiredVersion: "desired:source-union",
    desiredCatalogVersion: "catalog:source",
    desiredDomains,
    exposurePlan: exposurePlan()
  });
  const refreshing = store.beginSessionToolCatalogRefresh(
    "logical:one",
    "binding:one",
    desired.resourceVersion,
    "2026-08-31T00:00:00.000Z"
  );
  return store.applySessionToolCatalogReceipt({
    logicalSessionId: "logical:one",
    providerBindingId: "binding:one",
    appliedVersion: "desired:source-union",
    appliedCatalogVersion: "catalog:source",
    appliedDomains: [domainRecord("artifacts")],
    providerReceipt: { receiptId: "receipt:source-union" },
    appliedAt: "2026-08-31T00:00:01.000Z"
  }, refreshing.resourceVersion);
}

test("Store has one authoritative table and CAS prevents false applied state", async () => {
  const value = await fixture();
  try {
    const tables = value.store.selectAll(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%tool%materialization%' ORDER BY name", []
    ).map((row) => row.name);
    assert.deepEqual(tables, ["session_tool_catalog_materializations"]);
    const desired = value.store.writeSessionToolCatalogDesired({
      logicalSessionId: "logical:one", providerBindingId: "binding:one",
      desiredVersion: "desired:1", desiredCatalogVersion: "th2:one",
      desiredDomains: [{ domainId: "artifacts" }], exposurePlan: { exposurePlanHash: "plan:one" }
    });
    assert.equal(desired.status, "stale");
    const refreshing = value.store.beginSessionToolCatalogRefresh(
      "logical:one", "binding:one", desired.resourceVersion
    );
    assert.equal(refreshing.status, "refreshing");
    assert.equal(value.store.applySessionToolCatalogReceipt({
      logicalSessionId: "logical:one", providerBindingId: "binding:one",
      appliedVersion: "wrong", appliedCatalogVersion: "th2:one",
      appliedDomains: [], providerReceipt: {}, appliedAt: new Date().toISOString()
    }, refreshing.resourceVersion), null);
    const applied = value.store.applySessionToolCatalogReceipt({
      logicalSessionId: "logical:one", providerBindingId: "binding:one",
      appliedVersion: "desired:1", appliedCatalogVersion: "th2:one",
      appliedDomains: [{ domainId: "artifacts" }], providerReceipt: { receiptId: "receipt:one" }
    }, refreshing.resourceVersion);
    assert.equal(applied.status, "applied");
    assert.equal(applied.appliedVersion, applied.desiredVersion);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Store state survives restart and old binding can be canceled", async () => {
  const value = await fixture();
  value.store.writeSessionToolCatalogDesired({
    logicalSessionId: "logical:one", providerBindingId: "binding:one",
    desiredVersion: "desired:1", desiredCatalogVersion: "th2:one",
    desiredDomains: [], exposurePlan: {}
  });
  value.store.close();
  const reopened = new CorptieStore({ dbPath: value.dbPath, configPath: join(value.directory, "config.json") });
  try {
    await reopened.initialize();
    assert.equal(reopened.getSessionToolCatalogMaterialization("logical:one", "binding:one").status, "stale");
    assert.equal(reopened.cancelSessionToolCatalogMaterialization("logical:one", "binding:one").status, "canceled");
  } finally {
    reopened.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("workspace route and exact applied Tool materialization commit atomically", async () => {
  const value = await fixture();
  try {
    value.store.db.run(
      "UPDATE provider_thread_bindings SET provider_id='codex-app-server' WHERE binding_id='binding:one'"
    );
    applySourceMaterialization(value.store);
    value.store.beginWorkspaceTransition({
      transitionId: "transition:tools",
      logicalSessionId: "logical:one",
      targetCwd: value.directory,
      sourceRoutingVersion: 1,
      phase: "forking"
    });
    value.store.updateWorkspaceTransition("transition:tools", {
      phase: "validatingInstructions",
      newThreadId: "thread:replacement",
      toolConfirmation: toolConfirmation("thread:replacement")
    });
    const result = value.store.commitWorkspaceTransition("transition:tools", {
      providerThreadId: "thread:replacement",
      providerSessionId: "thread:replacement",
      bindingId: "binding:replacement",
      providerId: "codex-app-server",
      boundCwd: value.directory,
      toolMaterialization: appliedReplacement({
        bindingId: "binding:replacement",
        threadId: "thread:replacement"
      })
    });
    assert.equal(result.activeBinding.bindingId, "binding:replacement");
    assert.equal(value.store.getWorkspaceTransition("transition:tools").toolConfirmation.providerRevision,
      "thread-start:thread:replacement:confirmed");
    const applied = value.store.getSessionToolCatalogMaterialization(
      "logical:one",
      "binding:replacement"
    );
    assert.equal(applied.status, "applied");
    assert.equal(applied.providerReceipt.providerDefinitionsCount, 1);
    assert.deepEqual(applied.appliedDomains, [domainRecord()]);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

for (const providerId of ["claude-sdk", "openclacky"]) {
  test(`${providerId} workspace route atomically preserves source desired and applied Tool domains as stale`, async () => {
    const value = await fixture();
    try {
      value.store.db.run(
        "UPDATE provider_thread_bindings SET provider_id=? WHERE binding_id='binding:one'",
        [providerId]
      );
      applySourceMaterializationWithDesiredUnion(value.store);
      const suffix = providerId.replace(/[^a-z]/g, "-");
      const threadId = `thread:${suffix}:replacement`;
      const bindingId = `binding:${suffix}:replacement`;
      const transitionId = `transition:${suffix}:tools`;
      value.store.beginWorkspaceTransition({
        transitionId,
        logicalSessionId: "logical:one",
        targetCwd: value.directory,
        sourceRoutingVersion: 1,
        phase: "forking"
      });
      const committed = value.store.commitWorkspaceTransition(transitionId, {
        providerThreadId: threadId,
        providerSessionId: `${providerId}:session:replacement`,
        bindingId,
        providerId,
        boundCwd: value.directory,
        toolMaterialization: desiredReplacement({ bindingId })
      });
      assert.equal(committed.activeBinding.bindingId, bindingId);
      const replacement = value.store.getSessionToolCatalogMaterialization(
        "logical:one",
        bindingId
      );
      assert.equal(replacement.status, "stale");
      assert.equal(replacement.appliedVersion, null);
      assert.equal(replacement.appliedCatalogVersion, null);
      assert.deepEqual(replacement.appliedDomains, []);
      assert.equal(replacement.providerReceipt, null);
      assert.deepEqual(
        replacement.desiredDomains.map((domain) => domain.domainId),
        ["artifacts", "memory"]
      );
    } finally {
      value.store.close();
      await rm(value.directory, { recursive: true, force: true });
    }
  });
}

test("invalid replacement Tool proof rolls back the entire workspace route", async () => {
  const value = await fixture();
  try {
    value.store.db.run(
      "UPDATE provider_thread_bindings SET provider_id='codex-app-server' WHERE binding_id='binding:one'"
    );
    applySourceMaterialization(value.store);
    value.store.beginWorkspaceTransition({
      transitionId: "transition:invalid-tools",
      logicalSessionId: "logical:one",
      targetCwd: value.directory,
      sourceRoutingVersion: 1,
      phase: "forking"
    });
    assert.throws(() => value.store.commitWorkspaceTransition("transition:invalid-tools", {
      providerThreadId: "thread:invalid",
      providerSessionId: "thread:invalid",
      bindingId: "binding:invalid",
      providerId: "codex-app-server",
      boundCwd: value.directory,
      toolMaterialization: appliedReplacement({
        bindingId: "binding:invalid",
        threadId: "thread:invalid",
        count: 2
      })
    }), { code: "PROVIDER_TOOL_MATERIALIZATION_INVALID" });
    assert.equal(value.store.getLogicalSession("logical:one").activeBinding.bindingId, "binding:one");
    assert.equal(value.store.getProviderThreadBinding("thread:invalid"), null);
    assert.equal(value.store.getSessionToolCatalogMaterialization("logical:one", "binding:invalid"), null);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Session recovery binding and applied Tool materialization share one transaction", async () => {
  const value = await fixture();
  try {
    value.store.upsertSession({
      id: "session:one",
      title: "Recovery Store",
      agent: "Codex",
      provider: "codex-app-server",
      status: "running",
      sessionKind: "assistantChat",
      external: {
        provider: "codex-app-server",
        threadId: "thread:one",
        sessionId: "thread:one"
      }
    });
    value.store.db.run(
      "UPDATE logical_sessions SET legacy_session_id='session:one' WHERE logical_session_id='logical:one'"
    );
    value.store.db.run(
      "UPDATE provider_thread_bindings SET provider_id='codex-app-server' WHERE binding_id='binding:one'"
    );
    applySourceMaterialization(value.store);
    const attempt = value.store.freezeSessionRecoveryAttempt({
      attemptId: "attempt:one",
      idempotencyKey: "recovery:one",
      logicalSessionId: "logical:one",
      capabilityRevision: "codex-app-server:session-recovery:test"
    });
    value.store.claimSessionRecoveryBoundary(attempt.attemptId);
    value.store.saveSessionRecoveryManifest(attempt.attemptId, { schemaVersion: 1 }, "manifest:one");
    const replacement = {
      providerThreadId: "thread:recovered",
      providerSessionId: "thread:recovered",
      bindingId: "binding:recovered",
      toolConfirmation: toolConfirmation("thread:recovered")
    };
    value.store.recordSessionRecoveryReplacement(attempt.attemptId, replacement);
    const committed = value.store.commitSessionRecoveryBinding({
      attemptId: attempt.attemptId,
      manifestHash: "manifest:one",
      capabilityRevision: attempt.capabilityRevision,
      expectedRoutingVersion: attempt.sourceRoutingVersion,
      expectedBindingGeneration: attempt.sourceBindingGeneration,
      expectedSourceBindingId: attempt.sourceBindingId,
      replacement,
      toolMaterialization: appliedReplacement({
        bindingId: "binding:recovered",
        threadId: "thread:recovered"
      })
    });
    assert.equal(committed.state, "committed");
    assert.equal(value.store.getLogicalSession("logical:one").activeBinding.bindingId, "binding:recovered");
    assert.equal(value.store.getSessionToolCatalogMaterialization(
      "logical:one",
      "binding:recovered"
    ).status, "applied");
    assert.throws(() => value.store.recordSessionRecoveryReplacement(attempt.attemptId, {
      ...replacement,
      toolConfirmation: {
        ...toolConfirmation("thread:recovered"),
        providerRevision: "thread-start:thread:recovered:different"
      }
    }), { code: "RECOVERY_REPLACEMENT_CONFLICT" });
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("non-Codex Session recovery atomically preserves desired Tool domains without claiming Provider application", async () => {
  const value = await fixture();
  try {
    value.store.upsertSession({
      id: "session:one",
      title: "Restricted Provider Recovery",
      agent: "OpenClacky",
      provider: "fake",
      status: "running",
      sessionKind: "assistantChat",
      external: { provider: "fake", threadId: "thread:one", sessionId: "thread:one" }
    });
    value.store.db.run(
      "UPDATE logical_sessions SET legacy_session_id='session:one' WHERE logical_session_id='logical:one'"
    );
    applySourceMaterializationWithDesiredUnion(value.store);
    const attempt = value.store.freezeSessionRecoveryAttempt({
      attemptId: "attempt:restricted",
      idempotencyKey: "recovery:restricted",
      logicalSessionId: "logical:one",
      capabilityRevision: "fake:session-recovery:test"
    });
    value.store.claimSessionRecoveryBoundary(attempt.attemptId);
    value.store.saveSessionRecoveryManifest(attempt.attemptId, { schemaVersion: 1 }, "manifest:restricted");
    const replacement = {
      providerThreadId: "thread:restricted",
      providerSessionId: "thread:restricted",
      bindingId: "binding:restricted"
    };
    value.store.recordSessionRecoveryReplacement(attempt.attemptId, replacement);
    const committed = value.store.commitSessionRecoveryBinding({
      attemptId: attempt.attemptId,
      manifestHash: "manifest:restricted",
      capabilityRevision: attempt.capabilityRevision,
      expectedRoutingVersion: attempt.sourceRoutingVersion,
      expectedBindingGeneration: attempt.sourceBindingGeneration,
      expectedSourceBindingId: attempt.sourceBindingId,
      replacement,
      toolMaterialization: desiredReplacement({ bindingId: "binding:restricted" })
    });
    assert.equal(committed.state, "committed");
    const materialization = value.store.getSessionToolCatalogMaterialization(
      "logical:one",
      "binding:restricted"
    );
    assert.equal(materialization.status, "stale");
    assert.deepEqual(materialization.desiredDomains, [domainRecord("artifacts"), domainRecord("memory")]);
    assert.deepEqual(materialization.appliedDomains, []);
    assert.equal(materialization.providerReceipt, null);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
