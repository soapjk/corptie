import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ProviderEventProjector } from "../src/application/providerEventProjector.mjs";
import { SessionProviderSwitchCoordinator } from "../src/application/sessionProviderSwitchCoordinator.mjs";
import { SessionApplicationService } from "../src/agent-provider/sessionApplicationService.mjs";
import { SessionBindingRepository } from "../src/agent-provider/sessionBindingRepository.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { withSessionActions } from "../src/agent-provider/sessionActions.mjs";

function providerSession(store, options = {}) {
  const providerId = options.providerId ?? "codex-app-server";
  const providerThreadId = options.providerThreadId ?? "thread:codex-a";
  store.upsertSession({
    id: "codex:provider-switch",
    title: "Corptie开发工程师_Session",
    agent: options.agent ?? "Codex",
    provider: providerId,
    status: "complete",
    external: {
      provider: providerId,
      threadId: providerThreadId,
      sessionId: providerThreadId,
      currentModel: "source-provider-model",
      currentReasoningLevel: "high"
    }
  });
  store.createLogicalSessionRoute({
    logicalSessionId: "logical:provider-switch",
    legacySessionId: "codex:provider-switch",
    providerThreadId,
    providerSessionId: providerThreadId,
    providerId,
    boundCwd: "/repo/main",
    title: "Corptie开发工程师_Session"
  });
  return store.getLogicalSession("logical:provider-switch");
}

const PROVIDER_SWITCH_TOOLS = Object.freeze([
  {
    name: "corptie_tool_catalog_search",
    description: "Search the authoritative Corptie Tool catalog.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "corptie_tool_call",
    description: "Call one authorized Tool through the restricted gateway.",
    inputSchema: {
      type: "object",
      properties: { tool: { type: "string" } },
      required: ["tool"],
      additionalProperties: false
    }
  }
]);

function codexRegistry(...providerIds) {
  const ids = new Set(["codex-app-server", ...providerIds]);
  return {
    resolveId(providerId) {
      return ids.has(providerId) ? providerId : null;
    },
    get(providerId) {
      if (!ids.has(providerId)) throw new Error(`Unknown Provider ${providerId}`);
      return {
        descriptor: {
          id: providerId,
          metadata: {
            toolSchemaCapabilities: {
              bindingReplacement: providerId === "codex-app-server"
            }
          }
        }
      };
    }
  };
}

function toolDefinitionsHash(definitions) {
  return createHash("sha256").update(stableValue(definitions)).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableValue(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactToolProof(threadId, definitions = PROVIDER_SWITCH_TOOLS) {
  return {
    providerRevision: `thread-start:${threadId}:confirmed`,
    providerDefinitionsHash: toolDefinitionsHash(definitions),
    providerDefinitionsCount: definitions.length,
    providerObservationKind: "thread_start_accepted"
  };
}

function appliedToolMaterialization({ logicalSessionId, binding, confirmation }) {
  const domains = [{
    domainId: "tool-catalog",
    domainVersion: "domain:tool-catalog:1",
    toolNames: PROVIDER_SWITCH_TOOLS.map((tool) => tool.name)
  }];
  const exposurePlan = {
    capabilityRevision: "codex-app-server:tool-schema:5",
    exposurePlanHash: "plan:provider-switch",
    providerDefinitionsHash: confirmation.providerDefinitionsHash,
    providerDefinitions: PROVIDER_SWITCH_TOOLS,
    refreshMode: "binding_replacement"
  };
  const appliedAt = "2026-08-31T08:00:00.000Z";
  return {
    logicalSessionId,
    providerBindingId: binding.bindingId,
    desiredVersion: "desired:provider-switch",
    appliedVersion: "desired:provider-switch",
    desiredCatalogVersion: "catalog:provider-switch",
    appliedCatalogVersion: "catalog:provider-switch",
    desiredDomains: domains,
    appliedDomains: domains,
    exposurePlan,
    providerReceipt: {
      providerBindingId: binding.bindingId,
      providerCapabilityRevision: exposurePlan.capabilityRevision,
      requestedVersion: "desired:provider-switch",
      appliedVersion: "desired:provider-switch",
      appliedCatalogVersion: "catalog:provider-switch",
      appliedDomains: domains,
      appliedExposurePlanHash: exposurePlan.exposurePlanHash,
      providerDefinitionsHash: confirmation.providerDefinitionsHash,
      providerDefinitionsCount: confirmation.providerDefinitionsCount,
      providerObservationKind: confirmation.providerObservationKind,
      refreshMode: exposurePlan.refreshMode,
      providerRevision: confirmation.providerRevision,
      receiptId: `receipt:${binding.bindingId}`,
      appliedAt
    },
    status: "applied",
    attempt: 1,
    appliedAt
  };
}

function staleToolMaterialization({ logicalSessionId, binding, domains }) {
  return {
    logicalSessionId,
    providerBindingId: binding.bindingId,
    desiredVersion: "desired:openclacky-switch",
    appliedVersion: null,
    desiredCatalogVersion: "catalog:provider-switch",
    appliedCatalogVersion: null,
    desiredDomains: domains,
    appliedDomains: [],
    exposurePlan: {
      capabilityRevision: "openclacky:tool-schema:3:test:gateway",
      exposurePlanHash: "plan:openclacky-switch",
      providerDefinitionsHash: "definitions:openclacky-switch",
      providerDefinitions: [],
      refreshMode: "restricted_gateway"
    },
    providerReceipt: null,
    status: "stale",
    attempt: 0,
    updatedAt: "2026-08-31T08:00:00.000Z"
  };
}

test("workspace_transitions gains transition_kind during migration without rewriting rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-kind-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const initialStore = new CorptieStore({ dbPath, configPath });
  try {
    await initialStore.initialize();
    await initialStore.close();

    const legacy = new DatabaseSync(dbPath);
    // Simulate a pre-existing database created before the transition_kind column
    // existed. SQLite lacks ALTER TABLE DROP COLUMN support before 3.35, so we
    // rebuild the table without the column, preserving its data shape.
    legacy.exec(`
      ALTER TABLE workspace_transitions RENAME TO workspace_transitions_old;
      CREATE TABLE workspace_transitions (
        transition_id TEXT PRIMARY KEY,
        logical_session_id TEXT NOT NULL,
        source_thread_id TEXT NOT NULL,
        target_worktree_id TEXT,
        target_cwd TEXT NOT NULL,
        source_routing_version INTEGER NOT NULL,
        last_completed_turn_id TEXT,
        resume_goal_after_transition INTEGER NOT NULL DEFAULT 0,
        continuation_prompt TEXT,
        continuation_state TEXT NOT NULL DEFAULT 'none',
        phase TEXT NOT NULL,
        strategy TEXT NOT NULL DEFAULT 'fork',
        new_thread_id TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO workspace_transitions SELECT
        transition_id, logical_session_id, source_thread_id, target_worktree_id,
        target_cwd, source_routing_version, last_completed_turn_id,
        resume_goal_after_transition, continuation_prompt, continuation_state,
        phase, strategy, new_thread_id, error_json, created_at, updated_at
      FROM workspace_transitions_old;
      DROP TABLE workspace_transitions_old;
    `);
    legacy.close();

    const migrated = new CorptieStore({ dbPath, configPath });
    await migrated.initialize();
    const migratedColumns = migrated.selectAll("PRAGMA table_info(workspace_transitions)");
    assert.equal(migratedColumns.some((c) => c.name === "transition_kind"), true);
    await migrated.close();
  } finally {
    await initialStore.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider switch forks the binding, preserves workspace identity, and bumps routing_version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const before = providerSession(store);
    assert.equal(before.activeBinding.providerId, "codex-app-server");
    assert.equal(before.routingVersion, 1);

    store.beginWorkspaceTransition({
      transitionId: "transition:provider-switch",
      logicalSessionId: "logical:provider-switch",
      transitionKind: "provider",
      targetProviderId: "claude-sdk",
      targetCwd: "/repo/main",
      sourceRoutingVersion: before.routingVersion,
      phase: "waitingForTurn",
      strategy: "fork"
    });

    const pending = store.getPendingWorkspaceTransition("logical:provider-switch");
    assert.equal(pending.transitionKind, "provider");
    assert.equal(pending.targetProviderId, "claude-sdk");
    assert.equal(pending.phase, "waitingForTurn");

    store.commitWorkspaceTransition("transition:provider-switch", {
      providerThreadId: "thread:claude-b",
      providerSessionId: "thread:claude-b",
      providerId: "claude-sdk",
      boundCwd: "/repo/main",
      instructionSources: [
        { kind: "sessionTitle", title: "Provider switch" },
        { kind: "instructionSummary", summary: "continue the work" }
      ],
      sessionProjection: {
        status: "running",
        progress: 0.5,
        summary: "Initializing target Provider session…",
        external: {
          provider: "claude-sdk",
          threadId: "thread:claude-b",
          sessionId: "thread:claude-b",
          currentModel: "target-provider-model",
          currentReasoningLevel: "medium",
          sandbox: "target-sandbox"
        }
      }
    });

    const after = store.getLogicalSession("logical:provider-switch");
    assert.equal(after.activeBinding.providerId, "claude-sdk");
    assert.equal(after.activeThreadId, "thread:claude-b");
    assert.equal(after.routingVersion, 2);
    const stored = store.getSession("codex:provider-switch");
    assert.equal(stored.external.provider, "claude-sdk");
    assert.equal(stored.external.threadId, "thread:claude-b");
    assert.equal(stored.external.currentModel, "target-provider-model");
    assert.equal(stored.external.currentReasoningLevel, "medium");
    assert.equal(stored.external.sandbox, "target-sandbox");
    assert.equal(stored.rawStatus.currentModel, "target-provider-model");
    assert.notEqual(stored.rawStatus.currentModel, "source-provider-model");
    // Workspace identity is preserved across a Provider switch (no worktree move).
    assert.equal(after.activeWorkspaceId, before.activeWorkspaceId);
    assert.equal(after.repositoryId, before.repositoryId);

    const bindings = store.listProviderThreadBindings("logical:provider-switch");
    const source = bindings.find((b) => b.providerThreadId === "thread:codex-a");
    const target = bindings.find((b) => b.providerThreadId === "thread:claude-b");
    assert.equal(source.state, "superseded");
    assert.equal(target.state, "active");
    assert.equal(target.routingVersion, 2);
    assert.equal(target.parentThreadId, "thread:codex-a");
    assert.equal(target.worktreeId, before.activeBinding.worktreeId);

    // Message ownership: the active binding now routes to the new Provider.
    assert.equal(store.getLogicalSessionByProviderSessionId("claude-sdk", "thread:claude-b").logicalSessionId, "logical:provider-switch");
    assert.equal(store.getLogicalSessionByProviderSessionId("codex-app-server", "thread:codex-a"), null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pending provider switch preserves its target Provider across a store restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-restart-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const initialStore = new CorptieStore({ dbPath, configPath });
  let reopenedStore = null;
  try {
    await initialStore.initialize();
    const before = providerSession(initialStore);
    initialStore.beginWorkspaceTransition({
      transitionId: "transition:restart",
      logicalSessionId: "logical:provider-switch",
      transitionKind: "provider",
      targetProviderId: "claude-sdk",
      targetCwd: "/repo/main",
      sourceRoutingVersion: before.routingVersion,
      phase: "waitingForTurn",
      strategy: "fork"
    });
    await initialStore.close();

    reopenedStore = new CorptieStore({ dbPath, configPath });
    await reopenedStore.initialize();
    const pending = reopenedStore.getPendingWorkspaceTransition("logical:provider-switch");
    assert.equal(pending.transitionKind, "provider");
    assert.equal(pending.targetProviderId, "claude-sdk");
    assert.equal(pending.phase, "waitingForTurn");
  } finally {
    await initialStore.close().catch(() => {});
    await reopenedStore?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider switch coordinator preserves Session kind and rejects a stale route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-coordinator-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const logical = providerSession(store);
    let createdInput = null;
    const reference = {
      sessionId: "codex:provider-switch",
      logicalSessionId: logical.logicalSessionId,
      providerId: "codex-app-server",
      providerSessionId: "thread:codex-a",
      metadata: { session: { sessionKind: "assistantChat" } }
    };
    const coordinator = new SessionProviderSwitchCoordinator({
      store,
      registry: { resolveId: (providerId) => ["codex-app-server", "claude-sdk"].includes(providerId) ? providerId : null },
      resolveSessionReference: async () => reference,
      resolveTargetContext: async () => ({ sessionKind: "assistantChat", agentId: "assistant" }),
      createTargetSession: async (input) => {
        createdInput = input;
        return {
          providerThreadId: "thread:claude-coordinator",
          sessionProjection: {
            external: {
              provider: "claude-sdk",
              threadId: "thread:claude-coordinator",
              sandbox: "target-sandbox",
              approvalPolicy: "target-approval"
            }
          }
        };
      }
    });

    await assert.rejects(
      () => coordinator.switchProvider(reference.sessionId, {
        providerId: "claude-sdk",
        expectedRoutingVersion: logical.routingVersion - 1
      }),
      (error) => error?.code === "STALE_SESSION_ROUTE"
    );
    assert.equal(store.getPendingWorkspaceTransition(logical.logicalSessionId), null);

    const result = await coordinator.switchProvider(reference.sessionId, {
      providerId: "claude-sdk",
      expectedRoutingVersion: logical.routingVersion,
      transitionId: "transition:coordinator"
    });
    assert.equal(result.status, "committed");
    assert.equal(createdInput.providerId, "claude-sdk");
    assert.equal(createdInput.sessionKind, "assistantChat");
    assert.equal(createdInput.agentId, "assistant");
    assert.equal(result.logicalSession.activeBinding.providerId, "claude-sdk");
    assert.deepEqual(result.logicalSession.activeBinding.permissionSnapshot, {
      sandbox: "target-sandbox",
      approvalPolicy: "target-approval"
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude to Codex provider switch commits the exact thread proof and applied Tool materialization atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-codex-tools-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const logical = providerSession(store, {
      providerId: "claude-sdk",
      providerThreadId: "thread:claude-source",
      agent: "Claude"
    });
    const reference = {
      sessionId: "codex:provider-switch",
      logicalSessionId: logical.logicalSessionId,
      providerId: "claude-sdk",
      providerSessionId: "thread:claude-source",
      metadata: { session: { sessionKind: "assistantChat" } }
    };
    let createdInput = null;
    let preparedInput = null;
    const coordinator = new SessionProviderSwitchCoordinator({
      store,
      registry: codexRegistry("claude-sdk"),
      resolveSessionReference: async () => reference,
      resolveTargetContext: async () => ({
        agentId: "agent:developer",
        sessionKind: "assistantChat",
        dynamicTools: PROVIDER_SWITCH_TOOLS,
        dynamicToolAgentId: "agent:developer",
        dynamicToolMetadata: { catalogVersion: "catalog:provider-switch" }
      }),
      createTargetSession: async (input) => {
        createdInput = input;
        return {
          providerThreadId: "thread:codex-target",
          providerSessionId: "thread:codex-target",
          sessionProjection: {
            status: "complete",
            external: {
              provider: "codex-app-server",
              threadId: "thread:codex-target",
              sessionId: "thread:codex-target"
            }
          }
        };
      },
      confirmToolSchema: async (input) => {
        assert.equal(input.providerThreadId, "thread:codex-target");
        assert.deepEqual(input.dynamicTools, PROVIDER_SWITCH_TOOLS);
        return exactToolProof(input.providerThreadId, input.dynamicTools);
      },
      prepareToolMaterialization: async (input) => {
        preparedInput = input;
        return appliedToolMaterialization({
          logicalSessionId: input.logicalSessionId,
          binding: input.binding,
          confirmation: input.dynamicToolConfirmation
        });
      }
    });

    const result = await coordinator.switchProvider(reference.sessionId, {
      providerId: "codex-app-server",
      expectedRoutingVersion: logical.routingVersion,
      transitionId: "transition:claude-to-codex-tools"
    });

    assert.equal(result.status, "committed");
    assert.equal(result.logicalSession.activeBinding.providerId, "codex-app-server");
    assert.equal(result.logicalSession.activeBinding.providerSessionId, "thread:codex-target");
    assert.deepEqual(createdInput.dynamicTools, PROVIDER_SWITCH_TOOLS);
    assert.equal(preparedInput.binding.providerSessionId, "thread:codex-target");
    assert.equal(preparedInput.binding.routingVersion, logical.routingVersion + 1);
    assert.equal(preparedInput.binding.bindingGeneration,
      Number(logical.activeBinding.bindingGeneration) + 1);
    assert.deepEqual(
      store.getWorkspaceTransition("transition:claude-to-codex-tools").toolConfirmation,
      exactToolProof("thread:codex-target")
    );
    const materialization = store.getSessionToolCatalogMaterialization(
      logical.logicalSessionId,
      result.logicalSession.activeBinding.bindingId
    );
    assert.equal(materialization.status, "applied");
    assert.equal(materialization.providerReceipt.providerRevision,
      "thread-start:thread:codex-target:confirmed");
    assert.equal(materialization.providerReceipt.providerDefinitionsHash,
      toolDefinitionsHash(PROVIDER_SWITCH_TOOLS));
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("crash recovery reuses the journaled Codex target and proof instead of creating another session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-codex-recovery-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const logical = providerSession(store, {
      providerId: "claude-sdk",
      providerThreadId: "thread:claude-source",
      agent: "Claude"
    });
    const transitionId = "transition:codex-crash-recovery";
    const targetThreadId = "thread:codex-journaled";
    const proof = exactToolProof(targetThreadId);
    store.beginWorkspaceTransition({
      transitionId,
      logicalSessionId: logical.logicalSessionId,
      transitionKind: "provider",
      targetProviderId: "codex-app-server",
      targetCwd: logical.activeBinding.boundCwd,
      sourceRoutingVersion: logical.routingVersion,
      phase: "forking",
      strategy: "fork"
    });
    store.updateWorkspaceTransition(transitionId, {
      phase: "committingRoute",
      newThreadId: targetThreadId,
      toolConfirmation: proof
    });
    const reference = {
      sessionId: "codex:provider-switch",
      logicalSessionId: logical.logicalSessionId,
      providerId: "claude-sdk",
      providerSessionId: "thread:claude-source",
      metadata: { session: { sessionKind: "assistantChat" } }
    };
    let createCalls = 0;
    let resumeCalls = 0;
    const coordinator = new SessionProviderSwitchCoordinator({
      store,
      registry: codexRegistry("claude-sdk"),
      resolveSessionReference: async () => reference,
      resolveTargetContext: async () => ({ dynamicTools: PROVIDER_SWITCH_TOOLS }),
      createTargetSession: async () => {
        createCalls += 1;
        throw new Error("must not create a second target");
      },
      resumeTargetSession: async (input) => {
        resumeCalls += 1;
        assert.equal(input.providerThreadId, targetThreadId);
        assert.deepEqual(input.dynamicToolConfirmation, proof);
        return {
          providerThreadId: targetThreadId,
          providerSessionId: targetThreadId,
          sessionProjection: {
            status: "complete",
            external: {
              provider: "codex-app-server",
              threadId: targetThreadId,
              sessionId: targetThreadId
            }
          }
        };
      },
      confirmToolSchema: async () => proof,
      prepareToolMaterialization: async (input) => appliedToolMaterialization({
        logicalSessionId: input.logicalSessionId,
        binding: input.binding,
        confirmation: input.dynamicToolConfirmation
      })
    });

    const result = await coordinator.completeProviderSwitch(
      transitionId,
      "codex-app-server",
      reference,
      logical
    );

    assert.equal(result.status, "committed");
    assert.equal(createCalls, 0);
    assert.equal(resumeCalls, 1);
    assert.equal(result.logicalSession.activeThreadId, targetThreadId);
    assert.equal(result.logicalSession.routingVersion, logical.routingVersion + 1);
    assert.equal(store.getWorkspaceTransition(transitionId).phase, "committed");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("crash recovery fails closed when a journaled target cannot be resumed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-codex-recovery-unavailable-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const logical = providerSession(store, {
      providerId: "openclacky",
      providerThreadId: "thread:clacky-source",
      agent: "OpenClacky"
    });
    const transitionId = "transition:codex-crash-recovery-unavailable";
    const targetThreadId = "thread:codex-journaled-unavailable";
    store.beginWorkspaceTransition({
      transitionId,
      logicalSessionId: logical.logicalSessionId,
      transitionKind: "provider",
      targetProviderId: "codex-app-server",
      targetCwd: logical.activeBinding.boundCwd,
      sourceRoutingVersion: logical.routingVersion,
      phase: "forking",
      strategy: "fork"
    });
    store.updateWorkspaceTransition(transitionId, {
      phase: "committingRoute",
      newThreadId: targetThreadId,
      toolConfirmation: exactToolProof(targetThreadId)
    });
    const reference = {
      sessionId: "codex:provider-switch",
      logicalSessionId: logical.logicalSessionId,
      providerId: "openclacky",
      providerSessionId: "thread:clacky-source",
      metadata: { session: { sessionKind: "assistantChat" } }
    };
    let createCalls = 0;
    const coordinator = new SessionProviderSwitchCoordinator({
      store,
      registry: codexRegistry("openclacky"),
      resolveSessionReference: async () => reference,
      resolveTargetContext: async () => ({ dynamicTools: PROVIDER_SWITCH_TOOLS }),
      createTargetSession: async () => {
        createCalls += 1;
        return null;
      }
    });

    await assert.rejects(
      () => coordinator.completeProviderSwitch(
        transitionId,
        "codex-app-server",
        reference,
        logical
      ),
      (error) => error?.code === "PROVIDER_SWITCH_TARGET_RECOVERY_UNAVAILABLE"
    );

    const after = store.getLogicalSession(logical.logicalSessionId);
    assert.equal(createCalls, 0);
    assert.equal(after.activeThreadId, "thread:clacky-source");
    assert.equal(after.routingVersion, logical.routingVersion);
    assert.equal(store.getWorkspaceTransition(transitionId).phase, "failed");
    assert.equal(
      store.listProviderThreadBindings(logical.logicalSessionId)
        .find((binding) => binding.providerThreadId === targetThreadId)?.state,
      "invalid"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenClacky to Codex provider switch fails closed when the exact Tool proof is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-codex-proof-missing-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const logical = providerSession(store, {
      providerId: "openclacky",
      providerThreadId: "thread:clacky-source",
      agent: "OpenClacky"
    });
    const reference = {
      sessionId: "codex:provider-switch",
      logicalSessionId: logical.logicalSessionId,
      providerId: "openclacky",
      providerSessionId: "thread:clacky-source",
      metadata: { session: { sessionKind: "assistantChat" } }
    };
    let prepareCalled = false;
    const coordinator = new SessionProviderSwitchCoordinator({
      store,
      registry: codexRegistry("openclacky"),
      resolveSessionReference: async () => reference,
      resolveTargetContext: async () => ({ dynamicTools: PROVIDER_SWITCH_TOOLS }),
      createTargetSession: async () => ({
        providerThreadId: "thread:codex-unconfirmed",
        providerSessionId: "thread:codex-unconfirmed",
        sessionProjection: { status: "complete" }
      }),
      confirmToolSchema: async () => null,
      prepareToolMaterialization: async () => {
        prepareCalled = true;
        return null;
      }
    });

    await assert.rejects(
      () => coordinator.switchProvider(reference.sessionId, {
        providerId: "codex-app-server",
        expectedRoutingVersion: logical.routingVersion,
        transitionId: "transition:codex-proof-missing"
      }),
      (error) => error?.code === "PROVIDER_TOOL_APPLICATION_UNCONFIRMED"
    );

    const after = store.getLogicalSession(logical.logicalSessionId);
    assert.equal(after.activeBinding.providerId, "openclacky");
    assert.equal(after.activeThreadId, "thread:clacky-source");
    assert.equal(after.routingVersion, logical.routingVersion);
    assert.equal(prepareCalled, false);
    assert.equal(store.getWorkspaceTransition("transition:codex-proof-missing").phase, "failed");
    assert.equal(
      store.listProviderThreadBindings(logical.logicalSessionId)
        .find((binding) => binding.providerSessionId === "thread:codex-unconfirmed")?.state,
      "invalid"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude to Codex provider switch fails closed when prospective Tool materialization is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-codex-materialization-missing-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const logical = providerSession(store, {
      providerId: "claude-sdk",
      providerThreadId: "thread:claude-source",
      agent: "Claude"
    });
    const reference = {
      sessionId: "codex:provider-switch",
      logicalSessionId: logical.logicalSessionId,
      providerId: "claude-sdk",
      providerSessionId: "thread:claude-source",
      metadata: { session: { sessionKind: "assistantChat" } }
    };
    const coordinator = new SessionProviderSwitchCoordinator({
      store,
      registry: codexRegistry("claude-sdk"),
      resolveSessionReference: async () => reference,
      resolveTargetContext: async () => ({ dynamicTools: PROVIDER_SWITCH_TOOLS }),
      createTargetSession: async () => ({
        providerThreadId: "thread:codex-without-materialization",
        providerSessionId: "thread:codex-without-materialization",
        sessionProjection: { status: "complete" }
      }),
      confirmToolSchema: async ({ providerThreadId, dynamicTools }) => (
        exactToolProof(providerThreadId, dynamicTools)
      ),
      prepareToolMaterialization: async () => null
    });

    await assert.rejects(
      () => coordinator.switchProvider(reference.sessionId, {
        providerId: "codex-app-server",
        expectedRoutingVersion: logical.routingVersion,
        transitionId: "transition:codex-materialization-missing"
      }),
      (error) => error?.code === "PROVIDER_TOOL_MATERIALIZATION_REQUIRED"
    );

    const after = store.getLogicalSession(logical.logicalSessionId);
    assert.equal(after.activeBinding.providerId, "claude-sdk");
    assert.equal(after.activeThreadId, "thread:claude-source");
    assert.equal(after.routingVersion, logical.routingVersion);
    assert.deepEqual(
      store.getWorkspaceTransition("transition:codex-materialization-missing").toolConfirmation,
      exactToolProof("thread:codex-without-materialization")
    );
    assert.equal(
      store.getSessionToolCatalogMaterialization(
        logical.logicalSessionId,
        after.activeBinding.bindingId
      ),
      null
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider switch rejects a failed OpenClacky initialization and keeps the Codex route active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-init-failure-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const logical = providerSession(store);
    const reference = {
      sessionId: "codex:provider-switch",
      logicalSessionId: logical.logicalSessionId,
      providerId: "codex-app-server",
      providerSessionId: "thread:codex-a",
      metadata: { session: { sessionKind: "assistantChat" } }
    };
    const coordinator = new SessionProviderSwitchCoordinator({
      store,
      registry: { resolveId: (providerId) => providerId === "openclacky" ? providerId : null },
      resolveSessionReference: async () => reference,
      createTargetSession: async () => ({
        providerThreadId: "clacky-failed",
        providerSessionId: "clacky-failed",
        sessionProjection: {
          status: "failed",
          summary: "Operation not permitted @ rb_sysopen - /repo/AGENTS.md",
          external: { provider: "openclacky", sessionId: "clacky-failed" }
        }
      })
    });

    await assert.rejects(
      () => coordinator.switchProvider(reference.sessionId, {
        providerId: "openclacky",
        expectedRoutingVersion: logical.routingVersion,
        transitionId: "transition:init-failed"
      }),
      (error) => error?.code === "PROVIDER_SESSION_INITIALIZATION_FAILED"
        && /Operation not permitted.*AGENTS\.md/.test(error.message)
    );
    const after = store.getLogicalSession(logical.logicalSessionId);
    assert.equal(after.activeBinding.providerId, "codex-app-server");
    assert.equal(after.activeBinding.providerSessionId, "thread:codex-a");
    assert.equal(after.routingVersion, logical.routingVersion);
    assert.equal(store.getWorkspaceTransition("transition:init-failed").phase, "failed");
    assert.equal(
      store.listProviderThreadBindings(logical.logicalSessionId)
        .find((binding) => binding.providerSessionId === "clacky-failed")?.state,
      "invalid"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Corptie开发工程师_Session switches from CodeX to OpenClacky, routes the next message, and preserves history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-send-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const logical = providerSession(store);
    store.upsertTimelineItemProjection("codex:provider-switch", {
      id: "history:codex-answer",
      turnId: "turn:codex-before-switch",
      type: "agentMessage",
      title: "Codex",
      text: "Historical answer remains available.",
      presentationRole: "final_answer",
      status: "completed"
    });
    const bindings = new SessionBindingRepository({ store });
    const invocations = [];
    const registry = {
      resolveId: (providerId) => ["codex-app-server", "openclacky"].includes(providerId) ? providerId : null,
      invoke: async (providerId, capability, reference, message) => {
        invocations.push({ providerId, capability, reference, message });
        return { turn: { id: "openclacky:turn:after-switch" }, turnId: "openclacky:turn:after-switch" };
      }
    };
    const coordinator = new SessionProviderSwitchCoordinator({
      store,
      registry,
      resolveSessionReference: (sessionId) => bindings.resolve(sessionId),
      resolveTargetContext: async () => ({ sessionKind: "assistantChat", agentId: "agent:one" }),
      createTargetSession: async () => ({
        providerThreadId: "clacky-after-switch",
        providerSessionId: "clacky-after-switch",
        sessionProjection: {
          status: "complete",
          summary: "OpenClacky is ready.",
          capabilities: { canSend: true },
          external: {
            provider: "openclacky",
            threadId: "clacky-after-switch",
            sessionId: "clacky-after-switch",
            cwd: "/repo/main"
          }
        }
      })
    });
    const service = new SessionApplicationService({
      registry,
      resolveSessionReference: (sessionId) => bindings.resolve(sessionId)
    });

    const switched = await coordinator.switchProvider("codex:provider-switch", {
      providerId: "openclacky",
      expectedRoutingVersion: logical.routingVersion,
      transitionId: "transition:send-regression"
    });
    const sent = await service.sendMessage("codex:provider-switch", "Continue with OpenClacky");
    const activeReference = bindings.resolve("codex:provider-switch");
    const activeBinding = { ...activeReference, isCurrentRoute: true };
    const projector = new ProviderEventProjector({ store });
    const providerEvent = (type, overrides = {}) => ({
      providerId: "openclacky",
      providerSessionId: activeReference.providerSessionId,
      bindingId: activeReference.bindingId,
      logicalSessionId: activeReference.logicalSessionId,
      routingVersion: activeReference.routingVersion,
      providerEventId: `event:${type}`,
      providerSequence: null,
      turnId: sent.turn.id,
      itemId: null,
      type,
      occurredAt: "2026-08-29T09:00:00.000Z",
      receivedAt: "2026-08-29T09:00:00.010Z",
      payload: {},
      ...overrides
    });
    const reply = {
      id: "openclacky:item:after-switch",
      turnId: sent.turn.id,
      turnStatus: "completed",
      type: "agentMessage",
      title: "OpenClacky",
      text: "OpenClacky processed the new message.",
      presentationRole: "final_answer",
      status: "completed"
    };
    projector.project({ event: providerEvent("turn.started"), binding: activeBinding });
    projector.project({
      event: providerEvent("assistant.message.completed", {
        itemId: reply.id,
        payload: { item: { ...reply, turnStatus: "inProgress" } }
      }),
      binding: activeBinding
    });
    projector.project({
      event: providerEvent("turn.completed", { payload: { items: [reply] } }),
      binding: activeBinding
    });

    assert.equal(switched.logicalSession.activeBinding.providerId, "openclacky");
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].providerId, "openclacky");
    assert.equal(invocations[0].reference.providerSessionId, "clacky-after-switch");
    assert.equal(invocations[0].message, "Continue with OpenClacky");
    assert.equal(sent.turn.id, "openclacky:turn:after-switch");
    assert.equal(store.getSession("codex:provider-switch").status, "complete");
    assert.equal(
      store.getSessionItem("codex:provider-switch", reply.id).text,
      "OpenClacky processed the new message."
    );
    assert.equal(
      store.getSessionItem("codex:provider-switch", "history:codex-answer").text,
      "Historical answer remains available."
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex to OpenClacky switch atomically preserves every source desired Tool domain as stale target state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-domain-union-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const logical = providerSession(store);
    const sourceDomains = [
      { domainId: "artifacts", domainRevision: "artifacts:1", canonicalToolNames: ["corptie_artifact_get"] },
      { domainId: "collaboration", domainRevision: "collaboration:1", canonicalToolNames: ["corptie_collaboration_request"] }
    ];
    store.writeSessionToolCatalogDesired({
      logicalSessionId: logical.logicalSessionId,
      providerBindingId: logical.activeBinding.bindingId,
      desiredVersion: "desired:source-union",
      desiredCatalogVersion: "catalog:source",
      desiredDomains: sourceDomains,
      exposurePlan: {
        capabilityRevision: "codex-app-server:tool-schema:5",
        exposurePlanHash: "plan:source",
        providerDefinitionsHash: "definitions:source",
        providerDefinitions: [],
        refreshMode: "binding_replacement"
      }
    });
    const bindings = new SessionBindingRepository({ store });
    let prepared = null;
    const coordinator = new SessionProviderSwitchCoordinator({
      store,
      registry: codexRegistry("openclacky"),
      resolveSessionReference: (sessionId) => bindings.resolve(sessionId),
      resolveTargetContext: async () => ({
        sessionKind: "assistantChat",
        agentId: "agent:one",
        desiredToolDomains: ["artifacts", "collaboration"]
      }),
      createTargetSession: async () => ({
        providerThreadId: "clacky-with-union",
        providerSessionId: "clacky-with-union",
        sessionProjection: { status: "complete" }
      }),
      prepareToolMaterialization: async (input) => {
        prepared = input;
        return staleToolMaterialization({
          logicalSessionId: input.logicalSessionId,
          binding: input.binding,
          domains: sourceDomains
        });
      }
    });

    const result = await coordinator.switchProvider("codex:provider-switch", {
      providerId: "openclacky",
      expectedRoutingVersion: logical.routingVersion,
      transitionId: "transition:preserve-domain-union"
    });

    assert.equal(prepared.requiresApplied, false);
    const target = store.getSessionToolCatalogMaterialization(
      logical.logicalSessionId,
      result.logicalSession.activeBinding.bindingId
    );
    assert.equal(target.status, "stale");
    assert.deepEqual(target.desiredDomains.map((domain) => domain.domainId).sort(), [
      "artifacts", "collaboration"
    ]);
    assert.deepEqual(target.appliedDomains, []);
    assert.equal(target.providerReceipt, null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed active OpenClacky binding is replaced without changing the logical Session or history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-recovery-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const original = providerSession(store);
    store.upsertTimelineItemProjection("codex:provider-switch", {
      id: "history:before-recovery",
      turnId: "turn:before-recovery",
      type: "agentMessage",
      title: "Codex",
      text: "Keep this history.",
      status: "completed"
    });
    const bindings = new SessionBindingRepository({ store });
    let createdCount = 0;
    const coordinator = new SessionProviderSwitchCoordinator({
      store,
      registry: { resolveId: (providerId) => providerId },
      resolveSessionReference: (sessionId) => bindings.resolve(sessionId),
      createTargetSession: async () => {
        createdCount += 1;
        const id = createdCount === 1 ? "clacky:failed-active" : "clacky:recovered";
        return {
          providerThreadId: id,
          providerSessionId: id,
          sessionProjection: {
            status: "complete",
            summary: "OpenClacky is ready.",
            external: { provider: "openclacky", threadId: id, sessionId: id, cwd: "/repo/main" }
          }
        };
      }
    });
    await coordinator.switchProvider("codex:provider-switch", {
      providerId: "openclacky",
      expectedRoutingVersion: original.routingVersion,
      transitionId: "transition:to-failed-openclacky"
    });
    const failedProjection = store.getSession("codex:provider-switch");
    store.upsertSession({
      ...failedProjection,
      status: "failed",
      summary: "Operation not permitted @ rb_sysopen - /repo/AGENTS.md",
      sendUnavailableReason: "Operation not permitted @ rb_sysopen - /repo/AGENTS.md"
    });

    const recovered = await coordinator.recoverFailedProviderSession("codex:provider-switch", {
      transitionId: "transition:recover-openclacky"
    });

    assert.equal(recovered.logicalSession.logicalSessionId, original.logicalSessionId);
    assert.equal(recovered.logicalSession.activeBinding.providerId, "openclacky");
    assert.equal(recovered.logicalSession.activeBinding.providerSessionId, "clacky:recovered");
    assert.equal(recovered.logicalSession.routingVersion, original.routingVersion + 2);
    assert.equal(store.getSessionItem("codex:provider-switch", "history:before-recovery").text, "Keep this history.");
    const allBindings = store.listProviderThreadBindings(original.logicalSessionId);
    assert.equal(allBindings.find((item) => item.providerSessionId === "clacky:failed-active").state, "superseded");
    assert.equal(allBindings.find((item) => item.providerSessionId === "clacky:recovered").state, "active");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("beginWorkspaceTransition rejects a concurrent unfinished provider transition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-switch-mutex-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const before = providerSession(store);
    store.beginWorkspaceTransition({
      transitionId: "transition:first",
      logicalSessionId: "logical:provider-switch",
      transitionKind: "provider",
      targetProviderId: "claude-sdk",
      sourceRoutingVersion: before.routingVersion,
      phase: "waitingForTurn"
    });
    assert.throws(
      () => store.beginWorkspaceTransition({
        transitionId: "transition:second",
        logicalSessionId: "logical:provider-switch",
        transitionKind: "provider",
        targetProviderId: "openclacky",
        sourceRoutingVersion: before.routingVersion,
        phase: "waitingForTurn"
      }),
      /already has transition/
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("switchProvider action is unavailable while a provider switch is in flight", () => {
  const session = {
    id: "codex:provider-switch",
    external: { provider: "codex-app-server", providerSwitchInFlight: true }
  };
  const actions = withSessionActions(session, { id: "codex-app-server" }).actions;
  assert.equal(actions.switchProvider.available, false);
  assert.equal(actions.switchProvider.reason, "PROVIDER_SWITCH_IN_FLIGHT");

  const idle = withSessionActions(
    { id: "codex:provider-switch", external: { provider: "codex-app-server" } },
    { id: "codex-app-server" }
  ).actions;
  assert.equal(idle.switchProvider.available, true);
});
