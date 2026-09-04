import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import test from "node:test";
import { appliedToolMaterializationReceipt } from "../src/agent-provider/toolSchemaCapabilities.mjs";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import { ToolHostMaterializationCoordinator } from "../src/application/toolHostMaterializationCoordinator.mjs";
import { ToolHostService } from "../src/application/toolHostService.mjs";
import { ToolMaterializationPort } from "../src/application/toolMaterializationPort.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture(options = {}) {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-public-tool-port-"));
  const store = new CorptieStore({
    dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json")
  });
  await store.initialize();
  store.createLogicalSessionRoute({
    logicalSessionId: "logical:one", providerThreadId: "thread:one",
    providerSessionId: "thread:one", bindingId: "binding:one",
    providerId: "fake", boundCwd: directory, sessionName: "Port Session"
  });
  const catalog = new HostToolCatalog([
    {
      id: "artifacts",
      tools: [{ name: "corptie_artifact_get", inputSchema: { type: "object" } }],
      execute: () => null
    },
    {
      id: "memory",
      tools: [{ name: "corptie_memory_search", inputSchema: { type: "object" } }],
      execute: () => null
    }
  ]);
  let binding = {
    logicalSessionId: "logical:one", providerBindingId: "binding:one",
    providerId: "fake", providerSessionId: "thread:one", routingVersion: 1,
    state: "active", isCurrent: true, tombstoned: false,
    sessionId: "session:one", sessionKind: "workChat", workId: "work:one",
    taskId: null, currentTaskSessionId: null, authorizationRevision: 1
  };
  let applyCount = 0;
  const capability = options.capability ?? {
    bootstrapAttach: true, appendInPlace: true, replaceAtTurnBoundary: false,
    generatedMcpRefresh: false, restrictedGateway: false, bindingReplacement: false,
    capabilityRevision: "fake:native:1"
  };
  const providerPort = {
    probeToolSchemaCapabilities: async () => capability,
    applyToolPlanAtTurnBoundary: async (input) => {
      applyCount += 1;
      if (options.apply) return options.apply(input, {
        setBinding(next) { binding = next; }
      });
      return receipt(input);
    },
    reconcileToolReceipt: async () => ({ status: "unknown" })
  };
  const coordinator = new ToolHostMaterializationCoordinator({
    store, catalog, providerPort,
    resolveBinding: async (logicalSessionId, providerBindingId) => (
      binding.logicalSessionId === logicalSessionId && binding.providerBindingId === providerBindingId
        ? { ...binding } : null
    )
  });
  const port = new ToolMaterializationPort({
    coordinator,
    resolveCurrentBinding: async (logicalSessionId) => (
      binding.logicalSessionId === logicalSessionId ? { ...binding } : null
    )
  });
  return {
    directory, store, coordinator, port,
    get binding() { return binding; },
    get applyCount() { return applyCount; }
  };
}

function receipt(input) {
  return appliedToolMaterializationReceipt({
    providerBindingId: input.binding.providerBindingId,
    providerCapabilityRevision: input.capability.capabilityRevision,
    requestedVersion: input.requestedVersion,
    appliedCatalogVersion: input.catalogVersion,
    appliedDomains: input.appliedDomains,
    appliedExposurePlanHash: input.plan.exposurePlanHash,
    refreshMode: input.plan.refreshMode,
    providerRevision: "fake-provider:confirmed"
  });
}

test("public ToolMaterializationPort resolves the current binding and returns only committed applied domains", async () => {
  const value = await fixture();
  try {
    const memory = await value.port.ensureDomainsApplied(
      "logical:one", ["memory"], { turnExecutionId: "turn:memory" }
    );
    assert.equal(memory.status, "Applied");
    assert.deepEqual(memory.appliedDomains, ["memory"]);
    assert.match(memory.receiptId, /^tool_receipt:/);

    const artifacts = await value.port.ensureDomainsApplied(
      "logical:one", ["artifacts"], { turnExecutionId: "turn:artifacts" }
    );
    assert.deepEqual(artifacts.appliedDomains, ["artifacts", "memory"]);
    assert.equal(await value.port.assertCanonicalToolApplied(
      "logical:one", "corptie_artifact_get"
    ), true);
    const cached = await value.port.ensureDomainsApplied(
      "logical:one", ["artifacts", "memory"], { turnExecutionId: "turn:cached" }
    );
    assert.deepEqual(cached.appliedDomains, ["artifacts", "memory"]);
    assert.equal(value.applyCount, 2);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("public Port never turns generated MCP registration into Applied", async () => {
  const value = await fixture({
    capability: {
      bootstrapAttach: false, appendInPlace: false, replaceAtTurnBoundary: false,
      generatedMcpRefresh: true, restrictedGateway: false, bindingReplacement: false,
      capabilityRevision: "fake:mcp:1"
    },
    apply: async () => ({ status: "awaiting_provider_observation", observationKind: "mcp_tools_list" })
  });
  try {
    await assert.rejects(() => value.port.ensureDomainsApplied(
      "logical:one", ["artifacts"], { turnExecutionId: "turn:mcp" }
    ), { code: "TOOL_MATERIALIZATION_OUTCOME_UNKNOWN", statusCode: 503 });
    const stored = value.store.getSessionToolCatalogMaterialization("logical:one", "binding:one");
    assert.equal(stored.status, "refreshing");
    assert.equal(stored.appliedVersion, null);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("public Port preserves Blocked and Provider Error outcomes as fail-closed errors", async () => {
  const blocked = await fixture();
  try {
    await assert.rejects(() => blocked.port.ensureDomainsApplied(
      "logical:one", ["artifacts"], { activeTurn: true, turnExecutionId: "turn:blocked" }
    ), { code: "SESSION_TOOL_CATALOG_REFRESH_FAILED", statusCode: 503 });
    assert.equal(blocked.applyCount, 0);
  } finally {
    blocked.store.close();
    await rm(blocked.directory, { recursive: true, force: true });
  }

  const failed = await fixture({
    apply: async () => {
      throw Object.assign(new Error("provider rejected materialization"), {
        code: "PROVIDER_TOOL_APPLICATION_FAILED"
      });
    }
  });
  try {
    await assert.rejects(() => failed.port.ensureDomainsApplied(
      "logical:one", ["artifacts"], { turnExecutionId: "turn:error" }
    ), { code: "SESSION_TOOL_CATALOG_REFRESH_FAILED", statusCode: 503 });
    assert.equal(failed.applyCount, 1);
  } finally {
    failed.store.close();
    await rm(failed.directory, { recursive: true, force: true });
  }
});

test("public Port generation fence rejects a binding change after a valid late receipt", async () => {
  const value = await fixture({
    apply: async (input, control) => {
      control.setBinding({
        ...input.binding,
        providerBindingId: "binding:replacement", providerSessionId: "thread:replacement",
        routingVersion: 2
      });
      return receipt(input);
    }
  });
  try {
    await assert.rejects(() => value.port.ensureDomainsApplied(
      "logical:one", ["artifacts"], { turnExecutionId: "turn:late" }
    ), { code: "SESSION_BINDING_CHANGED" });
    const old = value.store.getSessionToolCatalogMaterialization("logical:one", "binding:one");
    assert.equal(old.status, "applied");
    await assert.rejects(() => value.port.assertCanonicalToolApplied(
      "logical:one", "corptie_artifact_get"
    ), { code: "TOOL_DOMAIN_NOT_APPLIED" });
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("ToolHostService exposes the approved positional Port without signature translation", async () => {
  const calls = [];
  const materializationPort = {
    ensureDomainsApplied(...args) { calls.push(["ensure", ...args]); return { status: "Applied" }; },
    assertCanonicalToolApplied(...args) { calls.push(["assert", ...args]); return true; }
  };
  const service = new ToolHostService({
    registry: {}, catalog: {}, materializationPort
  });
  const boundary = { turnExecutionId: "turn:service" };
  await service.ensureDomainsApplied("logical:service", ["artifacts"], boundary);
  await service.assertCanonicalToolApplied("logical:service", "corptie_artifact_get");
  assert.deepEqual(calls, [
    ["ensure", "logical:service", ["artifacts"], boundary],
    ["assert", "logical:service", "corptie_artifact_get"]
  ]);
});

test("production composition root installs the public Port over the real coordinator", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(source, /new ToolMaterializationPort\(\{\s*coordinator: toolHostMaterializationCoordinator,/);
  assert.match(source, /materializationPort: publicToolMaterializationPort/);
  assert.doesNotMatch(source, /ensureDomainsApplied\([^)]*providerBindingId/);
});
