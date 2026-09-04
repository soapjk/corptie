import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_HOST_BOOTSTRAP_SCHEMA_HASH } from "../src/application/hostToolCatalog.mjs";
import {
  ToolBootstrapBindingPreflight,
  safeToReplace
} from "../src/application/toolBootstrapBindingPreflight.mjs";

function fixture(options = {}) {
  const sessions = [
    { id: "session:old", status: "idle" },
    { id: "session:current", status: "idle" },
    { id: "session:busy", status: "running" },
    { id: "session:archived", status: "idle" }
  ];
  const logical = Object.fromEntries(sessions.map((session, index) => [session.id, {
    logicalSessionId: `logical:${index}`,
    archived: session.id === "session:archived",
    activeBinding: {
      bindingId: `binding:${index}`,
      providerId: "fake",
      state: "active"
    }
  }]));
  const records = new Map([
    ["logical:0\0binding:0", {
      status: "applied", appliedVersion: "old", desiredVersion: "old",
      resourceVersion: 41,
      desiredDomains: [{ domainId: "artifacts" }],
      exposurePlan: {}
    }],
    ["logical:1\0binding:1", {
      status: "applied", appliedVersion: "current", desiredVersion: "current",
      resourceVersion: 42,
      desiredDomains: [],
      exposurePlan: { bootstrapSchemaHash: TOOL_HOST_BOOTSTRAP_SCHEMA_HASH }
    }]
  ]);
  const calls = [];
  const invalidations = [];
  const recoveryMarkers = [];
  const service = new ToolBootstrapBindingPreflight({
    store: {
      listSessions: ({ archived }) => sessions.filter((session) => archived
        ? session.id === "session:archived"
        : session.id !== "session:archived"),
      getLogicalSessionByLegacySessionId: (id) => logical[id] ?? null,
      getSessionToolCatalogMaterialization: (logicalSessionId, bindingId) => (
        records.get(`${logicalSessionId}\0${bindingId}`) ?? null
      )
    },
    coordinator: {
      ensureApplied: async (input) => {
        calls.push(input);
        if (options.ensureApplied) return options.ensureApplied(input);
        return { status: "applied" };
      },
      invalidateAppliedProof: async (...args) => {
        invalidations.push(args);
        return { status: "error", lastErrorCode: args[2] };
      },
      markBindingRecoveryRequired: async (...args) => {
        recoveryMarkers.push(args);
        return { status: "error", lastErrorCode: args[2] };
      }
    },
    isSessionBusy: (session) => session.status === "running",
    isAppliedProofCurrent: options.isAppliedProofCurrent,
  });
  return { service, calls, invalidations, recoveryMarkers };
}

test("startup preflight hot-applies only stale idle bindings and preserves desired domains", async () => {
  const value = fixture();
  const result = await value.service.run();
  assert.deepEqual({
    scanned: result.scanned,
    hotApplied: result.hotApplied,
    recoveryRequired: result.recoveryRequired,
    failed: result.failed
  }, { scanned: 1, hotApplied: 1, recoveryRequired: 0, failed: 0 });
  assert.equal(value.calls.length, 1);
  assert.deepEqual(value.calls[0], {
    logicalSessionId: "logical:0",
    providerBindingId: "binding:0",
    desiredDomains: ["artifacts"],
    activeTurn: false,
    phase: "refresh"
  });
  assert.equal(value.invalidations.length, 0);
});

test("startup preflight does not skip a claimed applied record with obsolete Provider proof", async () => {
  const value = fixture({
    isAppliedProofCurrent: ({ record }) => !String(record.providerReceipt?.providerRevision ?? "")
      .startsWith("thread-fork:")
  });
  const current = value.service.store.getSessionToolCatalogMaterialization("logical:1", "binding:1");
  current.providerReceipt = { providerRevision: "thread-fork:provider-thread:claimed" };

  const result = await value.service.run();
  assert.equal(result.scanned, 2);
  assert.equal(result.hotApplied, 1);
  assert.equal(result.recoveryRequired, 1);
  assert.equal(value.calls.length, 1);
  assert.deepEqual(value.recoveryMarkers[0].slice(0, 3), [
    "logical:1", "binding:1", "PROVIDER_TOOL_RECOVERY_REQUIRED"
  ]);
});

test("startup preflight never replaces a binding when explicit Recovery is required", async () => {
  const replacementError = Object.assign(new Error("unconfirmed"), {
    code: "SESSION_TOOL_CATALOG_REFRESH_FAILED",
    dispatchState: "not_sent",
    recoveryAction: "replace_provider_binding",
    replacementReason: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED"
  });
  assert.equal(safeToReplace(replacementError), true);
  assert.equal(safeToReplace({ ...replacementError, dispatchState: "delivery_unknown" }), false);

  const value = fixture({ ensureApplied: async () => { throw replacementError; } });
  const result = await value.service.run();
  assert.equal(result.recoveryRequired, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(value.recoveryMarkers[0].slice(0, 3), [
    "logical:0", "binding:0", "PROVIDER_TOOL_RECOVERY_REQUIRED"
  ]);

  const ambiguous = fixture({ ensureApplied: async () => {
    throw Object.assign(new Error("unknown"), {
      code: "SESSION_TOOL_CATALOG_REFRESH_FAILED",
      dispatchState: "delivery_unknown",
      recoveryAction: "replace_provider_binding",
      replacementReason: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED"
    });
  } });
  const ambiguousResult = await ambiguous.service.run();
  assert.equal(ambiguousResult.recoveryRequired, 0);
  assert.equal(ambiguousResult.failed, 1);
  assert.equal(ambiguous.invalidations.length, 0);
});
