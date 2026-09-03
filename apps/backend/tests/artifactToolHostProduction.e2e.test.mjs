import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import { SessionApplicationService } from "../src/agent-provider/sessionApplicationService.mjs";
import { appliedToolMaterializationReceipt } from "../src/agent-provider/toolSchemaCapabilities.mjs";
import { ArtifactDomainRequirements } from "../src/application/artifactDomainRequirements.mjs";
import {
  artifactDynamicTools,
  authorizeArtifactDynamicTool,
  callArtifactDynamicTool
} from "../src/application/artifactDynamicTools.mjs";
import { ArtifactService } from "../src/application/artifactService.mjs";
import {
  HostToolCatalog,
  TOOL_CATALOG_SEARCH,
  TOOL_DOMAIN_LOAD,
  TOOL_RESTRICTED_GATEWAY
} from "../src/application/hostToolCatalog.mjs";
import {
  RegistryToolMaterializationPort,
  ToolHostMaterializationCoordinator
} from "../src/application/toolHostMaterializationCoordinator.mjs";
import { ToolHostService } from "../src/application/toolHostService.mjs";
import { ToolMaterializationPort } from "../src/application/toolMaterializationPort.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-artifact-tool-host-e2e-"));
  const store = new CorptieStore({
    dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json")
  });
  await store.initialize();
  const agent = store.createAgent({ name: "Artifact E2E", provider: "receipt-provider" });
  store.createWork({ id: "work:e2e", name: "Artifact E2E", contributorAgentIds: [agent.agentId] });
  store.createTask({
    id: "task:e2e", workId: "work:e2e", title: "Worker E2E", mainAgentId: agent.agentId
  });
  const sessions = [
    { id: "session:worker-e2e", kind: "worker", taskId: "task:e2e" },
    { id: "session:work-e2e", kind: "workChat", taskId: null }
  ];
  for (const session of sessions) {
    store.upsertSession({
      id: session.id, title: session.id, provider: "receipt-provider", status: "running",
      sessionKind: session.kind, agentId: agent.agentId, workId: "work:e2e",
      taskId: session.taskId
    });
    if (session.kind === "worker") {
      store.bindSessionToTask(session.id, session.taskId, "work:e2e");
    } else {
      store.bindSessionToWork(session.id, "work:e2e");
    }
    store.createLogicalSessionRoute({
      logicalSessionId: `logical:${session.kind}-e2e`, legacySessionId: session.id,
      providerThreadId: `thread:${session.kind}-e2e`, providerSessionId: `native:${session.kind}-e2e`,
      bindingId: `binding:${session.kind}-e2e`, providerId: "receipt-provider",
      boundCwd: directory, sessionName: `${session.kind} e2e`
    });
  }

  const artifactService = new ArtifactService({ store, contentRoot: join(directory, "artifacts") });
  await artifactService.initialize();
  let publicPort;
  const catalog = new HostToolCatalog([{
    id: "artifacts",
    tools: artifactDynamicTools,
    authorize: authorizeArtifactDynamicTool,
    execute: (input) => callArtifactDynamicTool(artifactService, input, {
      toolMaterializationPort: publicPort
    })
  }]);
  const providerReceipts = [];
  const providerAttachments = [];
  const provider = new CallbackAgentProvider({
    id: "receipt-provider", displayName: "Receipt Provider", transport: "test",
    capabilities: [
      AGENT_PROVIDER_CAPABILITIES.SESSION_EXECUTION_PREPARE,
      AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH
    ]
  }, {
    prepareExecution: async (_reference, context) => ({ prepared: true, context }),
    attachTools: async (attachment) => {
      providerAttachments.push(attachment);
      return { attached: true, exposurePlanHash: attachment.metadata.exposurePlanHash };
    },
    probeToolSchemaCapabilities: async () => ({
      bootstrapAttach: true, appendInPlace: false, replaceAtTurnBoundary: false,
      generatedMcpRefresh: false, restrictedGateway: true, bindingReplacement: false,
      capabilityRevision: "receipt-provider:gateway:1"
    }),
    applyToolPlanAtTurnBoundary: async (binding, plan, request) => {
      const receipt = appliedToolMaterializationReceipt({
        providerBindingId: binding.providerBindingId,
        providerCapabilityRevision: request.capabilityRevision,
        requestedVersion: request.requestedVersion,
        appliedCatalogVersion: request.catalogVersion,
        appliedDomains: request.appliedDomains,
        appliedExposurePlanHash: plan.exposurePlanHash,
        refreshMode: plan.refreshMode,
        providerRevision: `provider-confirmed:${providerReceipts.length + 1}`,
        receiptId: `provider-receipt:${providerReceipts.length + 1}`
      });
      providerReceipts.push(receipt);
      return receipt;
    }
  });
  const registry = new AgentProviderRegistry([provider]);
  const currentBinding = (logicalSessionId) => {
    const logical = store.getLogicalSession(logicalSessionId);
    const active = logical?.activeBinding;
    const session = logical?.legacySessionId ? store.getSession(logical.legacySessionId) : null;
    const task = session?.taskId ? store.getTask(session.taskId) : null;
    if (!active || !session) return null;
    return {
      logicalSessionId, providerBindingId: active.bindingId, providerId: active.providerId,
      providerSessionId: active.providerSessionId, routingVersion: active.routingVersion,
      state: active.state, isCurrent: logical.activeThreadId === active.providerThreadId,
      tombstoned: false, sessionId: session.id, sessionKind: session.sessionKind,
      workId: session.workId, taskId: session.taskId,
      currentTaskSessionId: task?.current_session_id ?? null,
      agentId: session.agentId, authorizationRevision: task?.resource_version ?? 1
    };
  };
  const coordinator = new ToolHostMaterializationCoordinator({
    store, catalog, providerPort: new RegistryToolMaterializationPort({ registry }),
    resolveBinding: async (logicalSessionId, providerBindingId) => {
      const binding = currentBinding(logicalSessionId);
      return binding?.providerBindingId === providerBindingId ? binding : null;
    }
  });
  publicPort = new ToolMaterializationPort({
    coordinator, resolveCurrentBinding: async (logicalSessionId) => currentBinding(logicalSessionId)
  });
  const toolHost = new ToolHostService({
    registry, catalog, coordinator, materializationPort: publicPort
  });
  return {
    directory, store, agent, artifactService, registry, catalog, coordinator, publicPort, toolHost,
    providerReceipts, providerAttachments, currentBinding
  };
}

test("Worker first Turn eagerly applies artifacts through a Provider-confirmed production receipt", async () => {
  const value = await fixture();
  try {
    const logicalSessionId = "logical:worker-e2e";
    const binding = value.currentBinding(logicalSessionId);
    const service = new SessionApplicationService({
      registry: value.registry,
      toolHostService: value.toolHost,
      toolMaterializationPort: value.publicPort,
      resolveRequiredToolDomains: (context) => ArtifactDomainRequirements
        .forSessionRole({ sessionKind: context.sessionKind }).requiredBeforeFirstTurn
        .map((requirement) => requirement.domainId),
      resolveSessionReference: async () => ({
        sessionId: "session:worker-e2e", logicalSessionId,
        bindingId: binding.providerBindingId, providerId: binding.providerId,
        providerSessionId: binding.providerSessionId,
        metadata: { session: value.store.getSession("session:worker-e2e") }
      })
    });

    const prepared = await service.prepareExecution("session:worker-e2e", {
      turnExecutionId: "turn:worker-first"
    });
    assert.equal(prepared.prepared, true);
    assert.equal(value.providerReceipts.length, 1);
    assert.deepEqual(value.providerReceipts[0].appliedDomains.map((domain) => domain.domainId), ["artifacts"]);
    assert.equal(value.providerAttachments.length, 1);
    const record = value.store.getSessionToolCatalogMaterialization(
      logicalSessionId, binding.providerBindingId
    );
    assert.equal(record.status, "applied");
    assert.equal(record.providerReceipt.receiptId, "provider-receipt:1");
    assert.equal(await value.publicPort.assertCanonicalToolApplied(
      logicalSessionId, "corptie_artifact_get"
    ), true);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Work Chat search/load applies on demand and gateway dispatch reasserts the canonical Artifact tool", async () => {
  const value = await fixture();
  try {
    const logicalSessionId = "logical:workChat-e2e";
    const binding = value.currentBinding(logicalSessionId);
    const metadata = {
      logicalSessionId, providerBindingId: binding.providerBindingId,
      sessionId: binding.sessionId, sessionKind: binding.sessionKind,
      workId: binding.workId, taskId: null
    };
    const search = await value.toolHost.execute({
      tool: TOOL_CATALOG_SEARCH, actorId: value.agent.agentId, metadata,
      arguments: { intent: "artifact", domain_hint: "artifacts" }
    });
    assert.deepEqual(search.domains.map((domain) => domain.domainId), ["artifacts"]);
    const loaded = await value.toolHost.execute({
      tool: TOOL_DOMAIN_LOAD, actorId: value.agent.agentId, metadata,
      arguments: { domain_id: "artifacts", expected_catalog_version: search.catalogVersion }
    });
    assert.equal(loaded.status, "applied");
    assert.equal(value.providerReceipts.length, 1);
    assert.equal(value.providerReceipts[0].providerRevision, "provider-confirmed:1");

    let assertions = 0;
    const originalAssert = value.publicPort.assertCanonicalToolApplied.bind(value.publicPort);
    value.publicPort.assertCanonicalToolApplied = async (...args) => {
      assertions += 1;
      return originalAssert(...args);
    };
    const result = await value.toolHost.execute({
      tool: TOOL_RESTRICTED_GATEWAY, actorId: value.agent.agentId, metadata,
      arguments: {
        tool: "corptie_artifact_list", expected_catalog_version: search.catalogVersion,
        arguments: {}
      }
    });
    assert.deepEqual(result, { artifacts: [] });
    assert.equal(assertions, 1);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
