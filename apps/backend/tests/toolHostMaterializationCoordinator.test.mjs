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
    },
    {
      id: "project-code",
      discoveryTerms: ["source code", "repository search", "源码", "代码导航"],
      tools: [
        {
          name: "corptie_project_code_find",
          description: "Create a fresh authoritative source Snapshot and search it in one call.",
          inputSchema: { type: "object" }
        },
        {
          name: "corptie_project_code_read",
          description: "Read a bounded source file window.",
          inputSchema: { type: "object" }
        }
      ],
      execute: () => null
    }
  ]);
  const binding = {
    logicalSessionId: "logical:worker", providerBindingId: "binding:worker",
    providerId: "fake", routingVersion: 1, state: "active", isCurrent: true,
    sessionId: "session:worker", sessionKind: "worker", objectiveId: "objective:one",
    workItemId: "work_item:one", currentWorkItemSessionId: "session:worker",
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
    assert.deepEqual(record.appliedDomains.map((domain) => domain.domainId), ["artifacts"]);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("catalog search ranks natural-language and Chinese source-navigation intents", async () => {
  const value = await fixture();
  try {
    const english = await value.coordinator.search({
      logicalSessionId: value.binding.logicalSessionId,
      providerBindingId: value.binding.providerBindingId,
      intent: "Find where the repository implements provider session recovery"
    });
    assert.equal(english.domains[0].domainId, "project-code");
    assert.equal(english.domains[0].tools[0].canonicalName, "corptie_project_code_find");

    const chinese = await value.coordinator.search({
      logicalSessionId: value.binding.logicalSessionId,
      providerBindingId: value.binding.providerBindingId,
      intent: "帮我在项目源码中定位会话恢复实现"
    });
    assert.equal(chinese.domains[0].domainId, "project-code");
    assert.ok(chinese.domains[0].tools.some((tool) => tool.canonicalName === "corptie_project_code_find"));

    const hinted = await value.coordinator.search({
      logicalSessionId: value.binding.logicalSessionId,
      providerBindingId: value.binding.providerBindingId,
      intent: "locate implementation",
      domainHint: "project-code"
    });
    assert.deepEqual(hinted.domains.map((domain) => domain.domainId), ["project-code"]);
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
