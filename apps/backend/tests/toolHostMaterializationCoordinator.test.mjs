import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import test from "node:test";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import {
  RegistryToolMaterializationPort,
  ToolHostMaterializationCoordinator
} from "../src/application/toolHostMaterializationCoordinator.mjs";
import { appliedToolMaterializationReceipt } from "../src/agent-provider/toolSchemaCapabilities.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-tool-coordinator-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  store.createLogicalSessionRoute({
    logicalSessionId: "logical:worker", providerThreadId: "thread:worker", providerSessionId: "thread:worker",
    bindingId: "binding:worker", providerId: "fake", boundCwd: directory, sessionName: "Tool Worker"
  });
  const catalog = new HostToolCatalog([
    {
      id: "artifacts",
      tools: [
        { name: "corptie_artifact_create", inputSchema: { type: "object" } },
        { name: "corptie_artifact_get", inputSchema: { type: "object" } }
      ],
      execute: () => null
    },
    {
      id: "memory",
      tools: [{ name: "corptie_memory_search", inputSchema: { type: "object" } }],
      execute: () => null
    }
  ]);
  const binding = {
    logicalSessionId: "logical:worker", providerBindingId: "binding:worker",
    providerId: "fake", routingVersion: 1, state: "active", isCurrent: true,
    sessionId: "session:worker", sessionKind: "worker", objectiveId: "objective:one",
    taskId: "task:one", currentTaskSessionId: "session:worker",
    agentId: "agent:shared", authorizationRevision: 1
  };
  let applyCount = 0;
  const port = {
    probeToolSchemaCapabilities: async () => overrides.capability ?? ({
      bootstrapAttach: true, appendInPlace: true, replaceAtTurnBoundary: false,
      generatedMcpRefresh: false, restrictedGateway: true, bindingReplacement: false,
      capabilityRevision: "fake:capability:1"
    }),
    applyToolPlanAtTurnBoundary: async (input) => {
      applyCount += 1;
      if (overrides.apply) return overrides.apply(input, applyCount);
      await new Promise((resolve) => setImmediate(resolve));
      return receipt(input);
    },
    reconcileToolReceipt: overrides.reconcile ?? (async () => ({ status: "unknown" }))
  };
  const events = [];
  const coordinator = new ToolHostMaterializationCoordinator({
    store, catalog, providerPort: port,
    resolveBinding: async () => ({ ...binding }),
    onEvent: (type, details) => events.push({ type, details })
  });
  return { directory, store, catalog, binding, coordinator, events, get applyCount() { return applyCount; } };
}

function receipt(input, patch = {}) {
  return appliedToolMaterializationReceipt({
    providerBindingId: input.binding.providerBindingId,
    providerCapabilityRevision: input.capability.capabilityRevision,
    requestedVersion: input.requestedVersion,
    appliedCatalogVersion: input.catalogVersion,
    appliedDomains: input.appliedDomains,
    appliedExposurePlanHash: input.plan.exposurePlanHash,
    refreshMode: input.plan.refreshMode,
    providerRevision: "provider:1",
    ...patch
  });
}

test("100 concurrent desiredVersion requests single-flight into one Provider apply", async () => {
  const value = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: 100 }, () => value.coordinator.ensureApplied({
      logicalSessionId: value.binding.logicalSessionId,
      providerBindingId: value.binding.providerBindingId,
      phase: "refresh"
    })));
    assert.equal(value.applyCount, 1);
    assert.equal(results.every((result) => result.status === "applied"), true);
    assert.equal(results.filter((result) => result.joined).length, 99);
    const record = value.store.getSessionToolCatalogMaterialization("logical:worker", "binding:worker");
    assert.equal(record.appliedVersion, record.desiredVersion);
    assert.equal(record.appliedDomains[0].domainId, "artifacts");
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("invalidating an applied proof keeps the existing binding and fails readiness closed", async () => {
  const value = await fixture();
  try {
    await value.coordinator.ensureApplied({
      logicalSessionId: "logical:worker",
      providerBindingId: "binding:worker"
    });
    const invalidated = await value.coordinator.invalidateAppliedProof(
      "logical:worker",
      "binding:worker",
      "PROVIDER_TOOL_RECOVERY_REQUIRED",
      "Explicit Recovery is required."
    );
    assert.equal(invalidated.status, "error");
    assert.equal(invalidated.lastErrorCode, "PROVIDER_TOOL_RECOVERY_REQUIRED");
    assert.equal(invalidated.lastErrorSummary, "Explicit Recovery is required.");
    assert.equal(value.store.getLogicalSession("logical:worker").activeBinding.bindingId, "binding:worker");
    assert.equal(value.events.at(-1).type, "applied_proof_invalidated");
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("direct ensureApplied calls cannot shrink previously desired or applied Tool domains", async () => {
  const value = await fixture();
  try {
    await value.coordinator.ensureApplied({
      logicalSessionId: value.binding.logicalSessionId,
      providerBindingId: value.binding.providerBindingId,
      desiredDomains: ["memory"]
    });
    await value.coordinator.ensureApplied({
      logicalSessionId: value.binding.logicalSessionId,
      providerBindingId: value.binding.providerBindingId,
      desiredDomains: []
    });
    const record = value.store.getSessionToolCatalogMaterialization("logical:worker", "binding:worker");
    assert.deepEqual(record.desiredDomains.map((domain) => domain.domainId), ["artifacts", "memory"]);
    assert.deepEqual(record.appliedDomains.map((domain) => domain.domainId), ["artifacts", "memory"]);
    assert.equal(value.applyCount, 1);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("prospective replacement materialization is exact, applied, and remains unpersisted until route commit", async () => {
  const value = await fixture();
  try {
    const source = await value.coordinator.ensureApplied({
      logicalSessionId: value.binding.logicalSessionId,
      providerBindingId: value.binding.providerBindingId,
      desiredDomains: ["memory"]
    });
    const prospectiveBinding = {
      ...value.binding,
      providerBindingId: "binding:replacement",
      providerSessionId: "thread:replacement",
      routingVersion: 2,
      authorizationRevision: 2
    };
    const confirmation = {
      providerRevision: "thread-start:thread:replacement:confirmed",
      providerDefinitionsHash: source.plan.providerDefinitionsHash,
      providerDefinitionsCount: source.plan.providerDefinitions.length,
      providerObservationKind: "thread_start_accepted"
    };
    const prepared = await value.coordinator.prepareAppliedReplacement({
      binding: prospectiveBinding,
      desiredDomains: ["artifacts", "memory"],
      providerConfirmation: confirmation
    });

    assert.equal(prepared.status, "applied");
    assert.equal(prepared.providerBindingId, "binding:replacement");
    assert.equal(prepared.desiredVersion, prepared.appliedVersion);
    assert.equal(prepared.desiredCatalogVersion, prepared.appliedCatalogVersion);
    assert.deepEqual(prepared.appliedDomains.map((domain) => domain.domainId), ["artifacts", "memory"]);
    assert.equal(prepared.providerReceipt.providerDefinitionsHash, confirmation.providerDefinitionsHash);
    assert.equal(prepared.providerReceipt.providerDefinitionsCount, confirmation.providerDefinitionsCount);
    assert.equal(prepared.providerReceipt.providerObservationKind, confirmation.providerObservationKind);
    assert.equal(
      value.store.getSessionToolCatalogMaterialization("logical:worker", "binding:replacement"),
      null
    );

    await assert.rejects(() => value.coordinator.prepareAppliedReplacement({
      binding: { ...prospectiveBinding, providerBindingId: "binding:wrong-proof" },
      desiredDomains: ["artifacts", "memory"],
      providerConfirmation: { ...confirmation, providerDefinitionsHash: "0".repeat(64) }
    }), { code: "PROVIDER_TOOL_RECEIPT_INVALID" });
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

for (const providerId of ["claude-sdk", "openclacky"]) {
  test(`${providerId} prospective workspace replacement is desired-only and preserves the requested domain union`, async () => {
    const value = await fixture();
    try {
      const prepared = await value.coordinator.prepareDesiredReplacement({
        binding: {
          ...value.binding,
          providerBindingId: `binding:${providerId}:replacement`,
          providerId,
          providerSessionId: `${providerId}:session:replacement`,
          routingVersion: 2,
          authorizationRevision: 2
        },
        desiredDomains: ["artifacts", "memory"]
      });
      assert.equal(prepared.status, "stale");
      assert.equal(prepared.appliedVersion, null);
      assert.equal(prepared.appliedCatalogVersion, null);
      assert.deepEqual(prepared.appliedDomains, []);
      assert.equal(prepared.providerReceipt, null);
      assert.deepEqual(
        prepared.desiredDomains.map((domain) => domain.domainId),
        ["artifacts", "memory"]
      );
      assert.equal(
        value.store.getSessionToolCatalogMaterialization(
          "logical:worker",
          `binding:${providerId}:replacement`
        ),
        null,
        "preparation must remain side-effect free until the route transaction"
      );
    } finally {
      value.store.close();
      await rm(value.directory, { recursive: true, force: true });
    }
  });
}

test("a previously shrunk error record converges back to the union of its applied domains", async () => {
  const value = await fixture();
  try {
    await value.coordinator.ensureApplied({
      logicalSessionId: value.binding.logicalSessionId,
      providerBindingId: value.binding.providerBindingId,
      desiredDomains: ["memory"]
    });
    const applied = value.store.getSessionToolCatalogMaterialization("logical:worker", "binding:worker");
    const shrunk = value.store.writeSessionToolCatalogDesired({
      logicalSessionId: "logical:worker",
      providerBindingId: "binding:worker",
      desiredVersion: "incorrectly-shrunk-version",
      desiredCatalogVersion: applied.desiredCatalogVersion,
      desiredDomains: applied.desiredDomains.filter((domain) => domain.domainId === "artifacts"),
      exposurePlan: applied.exposurePlan
    }, applied.resourceVersion);
    const refreshing = value.store.beginSessionToolCatalogRefresh(
      "logical:worker", "binding:worker", shrunk.resourceVersion
    );
    value.store.failSessionToolCatalogRefresh({
      logicalSessionId: "logical:worker",
      providerBindingId: "binding:worker",
      errorCode: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED",
      errorSummary: "simulated process restart"
    }, refreshing.resourceVersion);

    const result = await value.coordinator.ensureApplied({
      logicalSessionId: value.binding.logicalSessionId,
      providerBindingId: value.binding.providerBindingId,
      desiredDomains: []
    });
    assert.equal(result.status, "applied");
    assert.deepEqual(result.record.desiredDomains.map((domain) => domain.domainId), ["artifacts", "memory"]);
    assert.deepEqual(result.record.appliedDomains.map((domain) => domain.domainId), ["artifacts", "memory"]);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("invalid receipt fails closed and preserves the last applied domains", async () => {
  const value = await fixture({ apply: async (input) => receipt(input, { appliedExposurePlanHash: "wrong" }) });
  try {
    await assert.rejects(() => value.coordinator.ensureApplied({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker"
    }), { code: "SESSION_TOOL_CATALOG_REFRESH_FAILED" });
    const record = value.store.getSessionToolCatalogMaterialization("logical:worker", "binding:worker");
    assert.equal(record.status, "error");
    assert.deepEqual(record.appliedDomains, []);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("desired change while refreshing drops the late receipt and applies the new version", async () => {
  let release;
  let firstInput;
  const value = await fixture({
    apply: async (input, count) => {
      if (count === 1) {
        firstInput = input;
        await new Promise((resolve) => { release = resolve; });
      }
      return receipt(input);
    }
  });
  try {
    const first = value.coordinator.ensureApplied({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker"
    });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    const second = value.coordinator.ensureApplied({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker",
      desiredDomains: ["artifacts", "memory"]
    });
    release();
    const firstResult = await first;
    const secondResult = await second;
    assert.equal(firstResult.status, "stale");
    assert.equal(secondResult.status, "applied");
    assert.notEqual(firstInput.requestedVersion, secondResult.record.desiredVersion);
    assert.equal(value.events.some((event) => event.type === "MATERIALIZATION_RECEIPT_STALE"), true);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("outcome unknown reconciles without resending Provider apply", async () => {
  let pendingReceipt;
  const value = await fixture({
    apply: async (input) => {
      pendingReceipt = receipt(input, { receiptId: "receipt:pending" });
      const error = new Error("Provider connection closed after apply.");
      error.code = "TOOL_MATERIALIZATION_OUTCOME_UNKNOWN";
      error.receipt = pendingReceipt;
      throw error;
    },
    reconcile: async () => ({ status: "applied", receipt: pendingReceipt })
  });
  try {
    await assert.rejects(() => value.coordinator.ensureApplied({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker"
    }), { code: "TOOL_MATERIALIZATION_OUTCOME_UNKNOWN" });
    assert.equal(value.applyCount, 1);
    const applied = await value.coordinator.reconcile("logical:worker", "binding:worker");
    assert.equal(applied.status, "applied");
    assert.equal(value.applyCount, 1);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("failed refresh retries from the persisted error state and applies without losing desired state", async () => {
  const value = await fixture({
    apply: async (input, count) => {
      if (count === 1) throw Object.assign(new Error("temporary provider failure"), { code: "PROVIDER_TEMPORARY" });
      return receipt(input);
    }
  });
  try {
    await assert.rejects(() => value.coordinator.ensureApplied({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker"
    }), { code: "SESSION_TOOL_CATALOG_REFRESH_FAILED" });
    const failed = value.store.getSessionToolCatalogMaterialization("logical:worker", "binding:worker");
    assert.equal(failed.status, "error");
    const recovered = await value.coordinator.ensureApplied({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker"
    });
    assert.equal(recovered.status, "applied");
    assert.equal(recovered.record.appliedVersion, failed.desiredVersion);
    assert.equal(value.applyCount, 2);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("an existing restricted-gateway binding hot-loads a newly registered deferred domain without Provider schema drift", async () => {
  const providerPlans = [];
  const value = await fixture({
    capability: {
      bootstrapAttach: true, appendInPlace: false, replaceAtTurnBoundary: false,
      generatedMcpRefresh: false, restrictedGateway: true, bindingReplacement: true,
      capabilityRevision: "fake:restricted-gateway:1"
    },
    apply: async (input) => {
      providerPlans.push(input.plan.providerDefinitions);
      return receipt(input);
    }
  });
  try {
    const initialBindingId = value.binding.providerBindingId;
    const initial = await value.coordinator.ensureApplied({
      logicalSessionId: "logical:worker",
      providerBindingId: initialBindingId,
      desiredDomains: ["artifacts"]
    });
    const initialCatalogVersion = initial.snapshot.catalogVersion;

    value.catalog.register({
      id: "project-code-next",
      domainId: "project-code-next",
      tools: [{
        name: "corptie_project_code_next_search",
        description: "A newly installed deferred project-code capability.",
        inputSchema: { type: "object" }
      }],
      execute: () => null
    });
    const search = await value.coordinator.search({
      logicalSessionId: "logical:worker",
      providerBindingId: initialBindingId,
      intent: "newly installed deferred project-code"
    });
    assert.notEqual(search.catalogVersion, initialCatalogVersion);
    assert.equal(search.domains.some((domain) => domain.domainId === "project-code-next"), true);

    const loaded = await value.coordinator.loadDomain({
      logicalSessionId: "logical:worker",
      providerBindingId: initialBindingId,
      domainId: "project-code-next",
      expectedCatalogVersion: search.catalogVersion,
      activeTurn: true
    });
    assert.equal(loaded.status, "applied");
    assert.equal(loaded.plan.refreshMode, "restricted_gateway");
    assert.deepEqual(providerPlans[1], providerPlans[0]);
    assert.equal(
      value.store.getLogicalSession("logical:worker").activeBinding.bindingId,
      initialBindingId
    );
    assert.equal(loaded.record.appliedDomains.some((domain) => domain.domainId === "project-code-next"), true);
    assert.equal(value.applyCount, 2);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("catalog search tokenizes natural-language intent and normalized domain hints", async () => {
  const value = await fixture();
  try {
    value.catalog.register({
      id: "task-acceptance",
      tools: [{
        name: "corptie_task_report_acceptance",
        description: "Report criterion-by-criterion acceptance evidence for the Task bound to this Session.",
        inputSchema: { type: "object" }
      }],
      execute: () => null
    });

    const materialized = await value.coordinator.ensureApplied({
      logicalSessionId: value.binding.logicalSessionId,
      providerBindingId: value.binding.providerBindingId,
      desiredDomains: ["work-item-acceptance"]
    });
    assert.equal(materialized.status, "applied");
    assert.equal(
      materialized.record.appliedDomains.some((domain) => domain.domainId === "task-acceptance"),
      true
    );
    assert.equal(
      materialized.record.appliedDomains.some((domain) => domain.domainId === "work-item-acceptance"),
      false
    );

    const result = await value.coordinator.search({
      logicalSessionId: value.binding.logicalSessionId,
      providerBindingId: value.binding.providerBindingId,
      intent: "Call the acceptance evidence reporting tool for the current Task binding",
      domainHint: "Task acceptance"
    });

    assert.deepEqual(result.domains.map((domain) => domain.domainId), ["task-acceptance"]);
    assert.deepEqual(result.domains[0].tools.map((tool) => tool.canonicalName), [
      "corptie_task_report_acceptance"
    ]);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("unconfirmed bootstrap-only Tool schema is marked safe for one binding replacement before dispatch", async () => {
  const value = await fixture({
    capability: {
      bootstrapAttach: true, appendInPlace: false, replaceAtTurnBoundary: false,
      generatedMcpRefresh: false, restrictedGateway: true, bindingReplacement: true,
      capabilityRevision: "fake:bootstrap-replacement:1"
    },
    apply: async () => {
      const error = new Error("Provider did not retain the thread/start Tool schema receipt.");
      error.code = "PROVIDER_TOOL_APPLICATION_UNCONFIRMED";
      throw error;
    }
  });
  try {
    await assert.rejects(
      () => value.coordinator.ensureApplied({
        logicalSessionId: "logical:worker", providerBindingId: "binding:worker"
      }),
      (error) => error?.code === "SESSION_TOOL_CATALOG_REFRESH_FAILED"
        && error.dispatchState === "not_sent"
        && error.recoveryAction === "replace_provider_binding"
        && error.replacementReason === "PROVIDER_TOOL_APPLICATION_UNCONFIRMED"
    );
    const failed = value.store.getSessionToolCatalogMaterialization("logical:worker", "binding:worker");
    assert.equal(failed.status, "error");
    assert.equal(failed.lastErrorCode, "PROVIDER_TOOL_APPLICATION_UNCONFIRMED");
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("all confirmed pre-dispatch Tool schema failures remain safely retryable", async () => {
  const value = await fixture({
    apply: async () => {
      const error = new Error("Provider rejected the materialized schema receipt.");
      error.code = "PROVIDER_TOOL_RECEIPT_INVALID";
      throw error;
    }
  });
  try {
    await assert.rejects(
      () => value.coordinator.ensureApplied({
        logicalSessionId: "logical:worker", providerBindingId: "binding:worker"
      }),
      (error) => error?.code === "SESSION_TOOL_CATALOG_REFRESH_FAILED"
        && error.dispatchState === "not_sent"
        && error.recoveryAction === undefined
    );
    const failed = value.store.getSessionToolCatalogMaterialization("logical:worker", "binding:worker");
    assert.equal(failed.status, "error");
    assert.equal(failed.lastErrorCode, "PROVIDER_TOOL_RECEIPT_INVALID");
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("an active Turn records desired state but never mutates Provider tool schemas", async () => {
  const value = await fixture();
  try {
    const result = await value.coordinator.ensureApplied({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker", activeTurn: true
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "active_turn");
    assert.equal(value.applyCount, 0);
    const record = value.store.getSessionToolCatalogMaterialization("logical:worker", "binding:worker");
    assert.equal(record.status, "stale");
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("generated MCP stays applying until the Provider performs tools/list for the exact generation", async () => {
  const value = await fixture({
    capability: {
      bootstrapAttach: false, appendInPlace: false, replaceAtTurnBoundary: false,
      generatedMcpRefresh: true, restrictedGateway: false, bindingReplacement: false,
      capabilityRevision: "fake:mcp:1"
    },
    apply: async () => ({
      status: "awaiting_provider_observation",
      observationKind: "mcp_tools_list"
    })
  });
  try {
    const pending = await value.coordinator.ensureApplied({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker", activeTurn: true
    });
    assert.equal(pending.status, "applying");
    assert.equal(pending.record.status, "refreshing");
    assert.equal(pending.record.appliedVersion, null);
    assert.equal(pending.record.providerReceipt.status, "awaiting_provider_observation");

    await assert.rejects(() => value.coordinator.observeGeneratedMcpToolsList({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker",
      desiredVersion: "old-generation", observationId: "observation:old"
    }), { code: "PROVIDER_TOOL_OBSERVATION_STALE" });
    assert.equal(
      value.store.getSessionToolCatalogMaterialization("logical:worker", "binding:worker").status,
      "refreshing"
    );

    const applied = await value.coordinator.observeGeneratedMcpToolsList({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker",
      desiredVersion: pending.record.desiredVersion, observationId: "observation:current"
    });
    assert.equal(applied.status, "applied");
    assert.equal(applied.appliedVersion, pending.record.desiredVersion);
    assert.match(applied.providerReceipt.providerRevision, /^mcp-tools-list:/);

    const duplicate = await value.coordinator.observeGeneratedMcpToolsList({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker",
      desiredVersion: pending.record.desiredVersion, observationId: "observation:duplicate"
    });
    assert.equal(duplicate.resourceVersion, applied.resourceVersion);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("unconfirmed generated MCP application fails closed without advancing applied state", async () => {
  const value = await fixture({
    capability: {
      bootstrapAttach: false, appendInPlace: false, replaceAtTurnBoundary: false,
      generatedMcpRefresh: true, restrictedGateway: false, bindingReplacement: false,
      capabilityRevision: "fake:mcp:1"
    },
    apply: async () => ({ status: "awaiting_provider_observation", observationKind: "mcp_tools_list" })
  });
  try {
    await value.coordinator.ensureApplied({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker"
    });
    const failed = await value.coordinator.failPendingApplication(
      "logical:worker", "binding:worker",
      "PROVIDER_TOOL_APPLICATION_UNCONFIRMED", "tools/list was not observed"
    );
    assert.equal(failed.status, "error");
    assert.equal(failed.appliedVersion, null);
    assert.equal(failed.lastErrorCode, "PROVIDER_TOOL_APPLICATION_UNCONFIRMED");
    await assert.rejects(() => value.coordinator.observeGeneratedMcpToolsList({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker",
      observationId: "observation:late"
    }), { code: "PROVIDER_TOOL_OBSERVATION_STALE" });
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Registry port never converts a local restricted gateway registration into applied", async () => {
  const value = await fixture();
  const provider = {
    probeToolSchemaCapabilities: async () => ({
      bootstrapAttach: true, appendInPlace: false, replaceAtTurnBoundary: false,
      generatedMcpRefresh: false, restrictedGateway: true, bindingReplacement: false,
      capabilityRevision: "fake:gateway:1"
    })
  };
  const coordinator = new ToolHostMaterializationCoordinator({
    store: value.store,
    catalog: value.catalog,
    providerPort: new RegistryToolMaterializationPort({ registry: { get: () => provider } }),
    resolveBinding: async () => ({ ...value.binding })
  });
  try {
    await assert.rejects(() => coordinator.ensureApplied({
      logicalSessionId: "logical:worker", providerBindingId: "binding:worker"
    }), { code: "SESSION_TOOL_CATALOG_REFRESH_FAILED" });
    const record = value.store.getSessionToolCatalogMaterialization("logical:worker", "binding:worker");
    assert.equal(record.status, "error");
    assert.equal(record.appliedVersion, null);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
