import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ProviderSessionRecoveryPort,
  SessionRecoveryCoordinator,
  canonicalRecoveryJson,
  normalizeReplayManifest,
  planReplay,
  replayManifestHash,
  stableRecoveryHash
} from "../src/application/sessionRecovery.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { createCodexAppServerProvider } from "../src/agent-provider/providers/codexAppServerProvider.mjs";
import { createClaudeAgentSdkProvider } from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";
import { createOpenClackyProvider } from "../src/agent-provider/providers/openClackyProvider.mjs";
import { ProviderEventIngestionService } from "../src/application/providerEventIngestionService.mjs";
import {
  buildSessionRecoveryHandoffSource,
  parseSessionRecoveryHandoff,
  sessionRecoveryHandoffPrompt
} from "../src/application/sessionRecoveryHandoff.mjs";

const capabilityDescriptor = {
  id: "test-provider",
  metadata: {
    sessionRecovery: {
      revision: "test-provider:recovery:1",
      capabilities: [
        "explicit_replay", "system_context_injection", "tool_result_history",
        "replay_acknowledgement", "max_context_estimation"
      ],
      maxContextTokens: 100_000
    }
  }
};

test("Codex, Claude, and OpenClacky advertise an explicit Provider-neutral recovery capability matrix", () => {
  const codex = createCodexAppServerProvider({}, { capabilities: [] });
  const claude = createClaudeAgentSdkProvider({});
  const openClacky = createOpenClackyProvider({ probe: { protocolVersion: "test", capabilities: {} } });
  assert.deepEqual(codex.descriptor.metadata.sessionRecovery.capabilities, [
    "explicit_replay", "system_context_injection", "tool_result_history", "max_context_estimation"
  ]);
  assert.deepEqual(claude.descriptor.metadata.sessionRecovery.capabilities, [
    "explicit_replay", "system_context_injection", "tool_result_history", "max_context_estimation"
  ]);
  assert.deepEqual(openClacky.descriptor.metadata.sessionRecovery.capabilities, [
    "system_context_injection", "max_context_estimation"
  ]);
  for (const provider of [codex, claude, openClacky]) {
    assert.match(provider.descriptor.metadata.sessionRecovery.revision, /session-recovery/);
  }
});

test("ReplayManifest canonicalization is stable, closed, and rejects executable tool history", () => {
  const base = manifestFixture();
  const reordered = {
    limitations: base.limitations,
    entries: base.entries,
    artifactReferencesHash: base.artifactReferencesHash,
    toolCatalogHash: base.toolCatalogHash,
    permissionSnapshotHash: base.permissionSnapshotHash,
    instructionSourcesHash: base.instructionSourcesHash,
    checkpointHash: base.checkpointHash,
    strategy: base.strategy,
    boundaryTurnId: base.boundaryTurnId,
    boundarySequence: base.boundarySequence,
    sourceBindingGeneration: base.sourceBindingGeneration,
    sourceRoutingVersion: base.sourceRoutingVersion,
    sourceBindingId: base.sourceBindingId,
    logicalSessionId: base.logicalSessionId,
    schemaVersion: base.schemaVersion
  };
  assert.equal(replayManifestHash(base), replayManifestHash(reordered));
  assert.equal(canonicalRecoveryJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.throws(() => normalizeReplayManifest({ ...base, unexpected: true }), { code: "RECOVERY_UNKNOWN_FIELD" });
  assert.throws(() => normalizeReplayManifest({
    ...base,
    entries: [{ kind: "tool_result_summary", sequence: 1, content: "ran shell", metadata: { executable: true } }]
  }), { code: "REPLAY_SIDE_EFFECT_REQUEST_REJECTED" });
});

test("an untraceable checkpoint fails closed as manual_required", () => {
  const plan = planReplay({
    attempt: attemptFixture({ boundarySequence: 201 }),
    timelineEvents: [
      ...eventHistory(200),
      { sequence: 201, type: "session/checkpoint", payload: { content: "unverifiable" } }
    ],
    capabilities: recoveryCapabilities()
  });
  assert.equal(plan.strategy, "manual_required");
  assert.deepEqual(plan.manifest.entries, []);
});

test("planner selects full replay, checkpoint tail, restricted handoff, and manual_required by capability", () => {
  const attempt = attemptFixture({ boundarySequence: 550 });
  const short = eventHistory(12);
  const full = planReplay({ attempt: { ...attempt, boundarySequence: 12 }, timelineEvents: short, capabilities: recoveryCapabilities() });
  assert.equal(full.strategy, "full_replay");
  assert.equal(full.manifest.entries.length, 12);

  const long = eventHistory(550);
  long[399] = {
    sequence: 400, type: "session/checkpoint",
    payload: { content: "checkpoint summary", sourceSequence: 400, sourceContentHash: stableRecoveryHash("checkpoint summary") }
  };
  const checkpoint = planReplay({ attempt, timelineEvents: long, capabilities: recoveryCapabilities() });
  assert.equal(checkpoint.strategy, "checkpoint_tail");
  assert.equal(checkpoint.manifest.entries[0].kind, "checkpoint");
  assert.ok(checkpoint.manifest.checkpointHash);

  const handoff = planReplay({
    attempt: { ...attempt, boundarySequence: 12 }, timelineEvents: short,
    capabilities: recoveryCapabilities(["system_context_injection"])
  });
  assert.equal(handoff.strategy, "handoff_only");
  assert.equal(handoff.manifest.entries[0].kind, "checkpoint");
  assert.equal(handoff.manifest.entries[0].metadata.compressionMode, "extractive_fallback");
  assert.match(handoff.manifest.entries[0].content, /Session Recovery Handoff/);
  const manual = planReplay({
    attempt: { ...attempt, boundarySequence: 12 }, timelineEvents: short,
    capabilities: recoveryCapabilities([])
  });
  assert.equal(manual.strategy, "manual_required");
});

test("handoff sampling spans long history and validates structured Background Agent output", () => {
  const entries = Array.from({ length: 400 }, (_, index) => ({
    kind: index % 2 === 0 ? "user_message" : "assistant_message",
    role: index % 2 === 0 ? "user" : "assistant",
    sequence: index + 1,
    content: `historical record ${index + 1} with enough detail`
  }));
  const source = buildSessionRecoveryHandoffSource(entries, { characterBudget: 12_000 });
  assert.ok(source.selectedEntryCount < source.totalEntryCount);
  assert.equal(source.entries[0].sequence, 1);
  assert.equal(source.entries.at(-1).sequence, 400);
  assert.match(sessionRecoveryHandoffPrompt(source), /inert historical records/);
  const handoff = parseSessionRecoveryHandoff(JSON.stringify({
    schemaVersion: 1,
    objective: "Preserve the recovery design",
    currentState: "Compression is being implemented",
    completed: ["Root cause identified"],
    decisions: ["Use Provider-neutral background work"],
    openItems: ["Verify injection"],
    constraints: ["No historical side effects"],
    importantReferences: ["sessionRecovery.mjs"],
    recentIntent: "Continue implementation"
  }));
  assert.equal(handoff.openItems[0], "Verify injection");
});

test("handoff-only recovery replaces truncation with a structured compressed checkpoint", async () => {
  const fixture = await storeFixture();
  try {
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      appendEvent(fixture.store, {
        sequence,
        type: sequence % 2 === 1 ? "user/message" : "assistant/message",
        payload: { text: `message ${sequence} contains meaningful project context` }
      });
    }
    let compressionSource = null;
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort([], fixture.store),
      resolveProviderDescriptor: () => ({
        id: "test-provider",
        metadata: { sessionRecovery: { revision: "test-provider:handoff:1", capabilities: ["system_context_injection"] } }
      }),
      compressHandoff: async ({ source }) => {
        compressionSource = source;
        return {
          schemaVersion: 1,
          objective: "Continue the project context recovery work",
          currentState: "The old Session route requires replacement",
          completed: ["Historical Timeline was frozen"],
          decisions: ["Use a structured handoff checkpoint"],
          openItems: ["Validate the replacement"],
          constraints: ["Historical records are inert"],
          importantReferences: ["logical:recovery"],
          recentIntent: "Finish recovery"
        };
      }
    });
    const committed = await coordinator.recover({
      logicalSessionId: "logical:recovery", providerId: "test-provider", idempotencyKey: "compressed-handoff"
    });
    assert.equal(compressionSource.totalEntryCount, 40);
    assert.equal(committed.strategy, "handoff_only");
    assert.equal(committed.manifest.entries[0].kind, "checkpoint");
    assert.equal(committed.manifest.entries[0].metadata.compressionMode, "background_agent");
    assert.match(committed.manifest.entries[0].content, /Continue the project context recovery work/);
    assert.ok(committed.manifest.entries.length <= 9);
  } finally {
    await fixture.close();
  }
});

test("startup recovery can select the bounded deterministic handoff without model compression", async () => {
  const fixture = await storeFixture();
  try {
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      appendEvent(fixture.store, {
        sequence,
        type: sequence % 2 === 1 ? "user/message" : "assistant/message",
        payload: { text: `message ${sequence} contains meaningful project context` }
      });
    }
    let compressionCalls = 0;
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort([], fixture.store),
      resolveProviderDescriptor: () => ({
        id: "test-provider",
        metadata: { sessionRecovery: { revision: "test-provider:handoff:1", capabilities: ["system_context_injection"] } }
      }),
      compressHandoff: async () => {
        compressionCalls += 1;
        throw new Error("startup must not invoke the Background Agent");
      }
    });

    const committed = await coordinator.recover({
      logicalSessionId: "logical:recovery",
      providerId: "test-provider",
      idempotencyKey: "deterministic-startup-handoff",
      compressHandoff: false
    });

    assert.equal(compressionCalls, 0);
    assert.equal(committed.strategy, "handoff_only");
    assert.equal(committed.manifest.entries[0].metadata.compressionMode, "extractive_fallback");
  } finally {
    await fixture.close();
  }
});

test("planner maps real persisted Timeline payloads without duplicating Provider user echoes", () => {
  const plan = planReplay({
    attempt: attemptFixture({ boundarySequence: 4 }),
    timelineEvents: [
      { sequence: 1, type: "SessionUserMessageCreated", payload: { message: { text: "persisted user text" } } },
      { sequence: 2, type: "user.message.accepted", payload: { item: { text: "persisted user text" }, turnId: "turn:1" } },
      { sequence: 3, type: "assistant.message.completed", payload: { item: { text: "persisted assistant text", turnId: "turn:1" }, turnId: "turn:1" } },
      { sequence: 4, type: "turn.completed", payload: { items: [] } }
    ],
    capabilities: recoveryCapabilities()
  });
  assert.deepEqual(plan.manifest.entries.map((entry) => ({ kind: entry.kind, content: entry.content })), [
    { kind: "user_message", content: "persisted user text" },
    { kind: "assistant_message", content: "persisted assistant text" }
  ]);
});

test("planner recovers legacy completion summaries and canonical Provider final messages without duplicates", () => {
  const plan = planReplay({
    attempt: attemptFixture({ boundarySequence: 6 }),
    timelineEvents: [
      { sequence: 1, type: "SessionUserMessageCreated", payload: { message: { text: "legacy prompt" } } },
      {
        sequence: 2,
        type: "CodexThreadCompleted",
        payload: {
          hasAgentMessage: true,
          session: { summary: "legacy persisted answer" }
        }
      },
      { sequence: 3, type: "SessionUserMessageCreated", payload: { message: { text: "canonical prompt" } } },
      {
        sequence: 4,
        type: "assistant.message.completed",
        payload: { turnId: "turn:canonical", item: { turnId: "turn:canonical", text: "canonical persisted answer" } }
      },
      {
        sequence: 5,
        type: "turn.completed",
        payload: {
          turnId: "turn:canonical",
          items: [{
            type: "agentMessage",
            turnId: "turn:canonical",
            presentationRole: "final_answer",
            text: "canonical persisted answer"
          }]
        }
      },
      {
        sequence: 6,
        type: "AgentTurnCompleted",
        payload: { hasAgentMessage: false, summary: "stale lifecycle summary" }
      }
    ],
    capabilities: recoveryCapabilities()
  });

  assert.deepEqual(plan.manifest.entries.map((entry) => ({
    kind: entry.kind,
    turnId: entry.turnId,
    content: entry.content
  })), [
    { kind: "user_message", turnId: null, content: "legacy prompt" },
    { kind: "assistant_message", turnId: null, content: "legacy persisted answer" },
    { kind: "user_message", turnId: null, content: "canonical prompt" },
    { kind: "assistant_message", turnId: "turn:canonical", content: "canonical persisted answer" }
  ]);
});

test("planner ignores message-free completion envelopes and explicit empty Provider placeholders", () => {
  const ignored = planReplay({
    attempt: attemptFixture({ boundarySequence: 1 }),
    timelineEvents: [{ sequence: 1, type: "turn.completed", payload: { items: [] } }],
    capabilities: recoveryCapabilities()
  });
  assert.deepEqual(ignored.manifest.entries, []);

  const explicitEmptyProviderPlaceholder = planReplay({
    attempt: attemptFixture({ boundarySequence: 1 }),
    timelineEvents: [{
      sequence: 1,
      type: "assistant.message.completed",
      payload: {
        item: {
          id: "message:empty",
          turnId: "turn:empty",
          type: "agentMessage",
          status: "completed",
          presentationRole: "final_answer",
          text: ""
        }
      }
    }],
    capabilities: recoveryCapabilities()
  });
  assert.deepEqual(explicitEmptyProviderPlaceholder.manifest.entries, []);

  assert.throws(() => planReplay({
    attempt: attemptFixture({ boundarySequence: 1 }),
    timelineEvents: [{ sequence: 1, type: "CodexThreadCompleted", payload: { hasAgentMessage: true, session: {} } }],
    capabilities: recoveryCapabilities()
  }), { code: "RECOVERY_TIMELINE_MESSAGE_INVALID" });

  assert.throws(() => planReplay({
    attempt: attemptFixture({ boundarySequence: 1 }),
    timelineEvents: [{ sequence: 1, type: "assistant.message.completed", payload: { item: {} } }],
    capabilities: recoveryCapabilities()
  }), { code: "RECOVERY_TIMELINE_MESSAGE_INVALID" });
});

test("planner fails closed instead of silently replaying a missing message body", () => {
  assert.throws(() => planReplay({
    attempt: attemptFixture({ boundarySequence: 1 }),
    timelineEvents: [{ sequence: 1, type: "SessionUserMessageCreated", payload: { message: {} } }],
    capabilities: recoveryCapabilities()
  }), { code: "RECOVERY_TIMELINE_MESSAGE_INVALID" });
});

test("recovery freezes Timeline, validates no-side-effect replay, commits binding by CAS, and is idempotent", async () => {
  const fixture = await storeFixture();
  const calls = [];
  try {
    for (const event of eventHistory(16)) appendEvent(fixture.store, event);
    const port = recoveryPort(calls, fixture.store);
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: port,
      resolveProviderDescriptor: () => capabilityDescriptor
    });
    const input = {
      logicalSessionId: "logical:recovery",
      providerId: "test-provider",
      idempotencyKey: "delivery:message-17"
    };
    const recovery = coordinator.recover(input);
    await new Promise((resolve) => setImmediate(resolve));
    appendEvent(fixture.store, { sequence: 17, type: "user/message", payload: { text: "concurrent message" } });
    const committed = await recovery;
    assert.equal(committed.state, "committed");
    assert.equal(committed.boundarySequence, 16);
    assert.equal(committed.manifest.entries.some((entry) => entry.content === "concurrent message"), false);
    assert.deepEqual(calls.filter((call) => call === "replay"), ["replay"]);
    assert.deepEqual(calls.filter((call) => call === "stabilize"), ["stabilize"]);
    assert.equal(calls.includes("execute-tool"), false);

    const logical = fixture.store.getLogicalSession("logical:recovery");
    assert.equal(logical.logicalSessionId, "logical:recovery");
    assert.equal(logical.routingVersion, 2);
    assert.equal(logical.activeBinding.bindingGeneration, 2);
    assert.equal(logical.activeBinding.parentBindingId, "binding:source");
    assert.equal(logical.transitionState, null);
    assert.equal(fixture.store.getSession("session:recovery").external.sessionId, "native:replacement");
    assert.equal(fixture.store.listProviderThreadBindings("logical:recovery")[0].state, "superseded");
    assert.equal(fixture.store.listSessionRecoveryBindingAudit("logical:recovery").length, 1);

    const replayed = await coordinator.recover(input);
    assert.equal(replayed.attemptId, committed.attemptId);
    assert.equal(calls.filter((call) => call === "create").length, 1);
  } finally {
    await fixture.close();
  }
});

test("explicit delivery-boundary Recovery freezes before the triggering unsent delivery", async () => {
  const fixture = await storeFixture();
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "remember me" } });
    fixture.store.appendSessionEvent({
      eventId: "event:trigger-message",
      sessionId: "session:recovery",
      type: "SessionUserMessageCreated",
      source: { type: "desktop", deliveryId: "delivery:trigger" },
      payload: { deliveryId: "delivery:trigger", message: { text: "send after recovery" } },
      surface: true
    });
    fixture.store.appendSessionEvent({
      eventId: "event:trigger-queued",
      sessionId: "session:recovery",
      type: "AgentWorkQueued",
      source: { type: "desktop", deliveryId: "delivery:trigger" },
      payload: { deliveryId: "delivery:trigger" },
      surface: true
    });
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort([], fixture.store),
      resolveProviderDescriptor: () => capabilityDescriptor
    });
    const committed = await coordinator.recover({
      logicalSessionId: "logical:recovery",
      providerId: "test-provider",
      idempotencyKey: "message-recovery:delivery:trigger",
      triggerDeliveryId: "delivery:trigger"
    });
    assert.equal(committed.boundarySequence, 1);
    assert.equal(committed.triggerDeliveryId, "delivery:trigger");
    assert.deepEqual(committed.manifest.entries.map((entry) => entry.content), ["remember me"]);
  } finally {
    await fixture.close();
  }
});

test("recovery fails closed on replay hash mismatch and preserves the old active binding", async () => {
  const fixture = await storeFixture();
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "hello" } });
    const port = recoveryPort([], fixture.store, { replayHashMismatch: true });
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: port,
      resolveProviderDescriptor: () => capabilityDescriptor
    });
    await assert.rejects(() => coordinator.recover({
      logicalSessionId: "logical:recovery", providerId: "test-provider", idempotencyKey: "hash-mismatch"
    }), { code: "RECOVERY_REPLAY_HASH_MISMATCH" });
    const logical = fixture.store.getLogicalSession("logical:recovery");
    assert.equal(logical.activeBinding.bindingId, "binding:source");
    assert.equal(logical.routingVersion, 1);
  } finally {
    await fixture.close();
  }
});

test("recovery refuses to commit a replacement without durable Provider proof", async () => {
  const fixture = await storeFixture();
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "hello" } });
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort([], fixture.store, { stabilizationDurable: false }),
      resolveProviderDescriptor: () => capabilityDescriptor
    });
    await assert.rejects(() => coordinator.recover({
      logicalSessionId: "logical:recovery",
      providerId: "test-provider",
      idempotencyKey: "durability-missing"
    }), { code: "RECOVERY_REPLACEMENT_NOT_DURABLE" });
    assert.equal(fixture.store.getLogicalSession("logical:recovery").activeBinding.bindingId, "binding:source");
  } finally {
    await fixture.close();
  }
});

test("recovery cancellation is durable and does not commit a replacement", async () => {
  const fixture = await storeFixture();
  let release;
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "hello" } });
    const calls = [];
    const port = recoveryPort(calls, fixture.store, {
      replayBarrier: new Promise((resolve) => { release = resolve; })
    });
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: port,
      resolveProviderDescriptor: () => capabilityDescriptor
    });
    const recovery = coordinator.recover({
      logicalSessionId: "logical:recovery", providerId: "test-provider", idempotencyKey: "cancel"
    });
    while (fixture.store.listSessionRecoveryAttempts("logical:recovery")[0]?.state !== "replacement_created") {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const recoveringSession = fixture.store.getSession("session:recovery");
    assert.equal(recoveringSession.transitionState, "sessionRecovery");
    assert.equal(recoveringSession.capabilities.canSend, false);
    assert.match(recoveringSession.sendUnavailableReason, /recovery is in progress/i);
    const attempt = fixture.store.listSessionRecoveryAttempts("logical:recovery")[0];
    const cancellation = coordinator.cancel(attempt.attemptId);
    release();
    await cancellation;
    await assert.rejects(recovery, { code: "SESSION_RECOVERY_CANCELLED" });
    assert.equal(fixture.store.getLogicalSession("logical:recovery").activeBinding.bindingId, "binding:source");
    assert.equal(fixture.store.getSessionRecoveryAttempt(attempt.attemptId).state, "cancelled");
    assert.equal(fixture.store.getLogicalSession("logical:recovery").transitionState, null);
    assert.equal(fixture.store.getSession("session:recovery").transitionState, null);
  } finally {
    release?.();
    await fixture.close();
  }
});

test("recovery fails closed for replacement creation, Tool Host, and Workspace validation faults", async () => {
  for (const [name, options, expectedCode] of [
    ["create", { createFailure: true }, "SESSION_RECOVERY_FAILED"],
    ["tool-host", { toolFailure: true }, "SESSION_RECOVERY_FAILED"],
    ["worktree", { worktreeMismatch: true }, "RECOVERY_WORKTREE_MISMATCH"]
  ]) {
    const fixture = await storeFixture();
    try {
      appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: name } });
      const coordinator = new SessionRecoveryCoordinator({
        store: fixture.store,
        providerPort: recoveryPort([], fixture.store, options),
        resolveProviderDescriptor: () => capabilityDescriptor
      });
      await assert.rejects(() => coordinator.recover({
        logicalSessionId: "logical:recovery", providerId: "test-provider", idempotencyKey: `fault:${name}`
      }), { code: expectedCode });
      assert.equal(fixture.store.getLogicalSession("logical:recovery").activeBinding.bindingId, "binding:source");
      assert.equal(fixture.store.listSessionRecoveryAttempts("logical:recovery")[0].state, "failed");
      assert.equal(fixture.store.getLogicalSession("logical:recovery").transitionState, null);
    } finally {
      await fixture.close();
    }
  }
});

test("same-attempt recovery is single-flight and post-commit observer failures cannot cancel the active route", async () => {
  const fixture = await storeFixture();
  const calls = [];
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "single flight" } });
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort(calls, fixture.store),
      resolveProviderDescriptor: () => capabilityDescriptor,
      observe: ({ type }) => {
        if (type === "SessionRecoveryCommitted") throw new Error("observer unavailable");
      }
    });
    const input = {
      logicalSessionId: "logical:recovery",
      providerId: "test-provider",
      idempotencyKey: "single-flight"
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => coordinator.recover(input)));
    assert.equal(results.every((attempt) => attempt.state === "committed"), true);
    assert.equal(calls.filter((call) => call === "create").length, 1);
    assert.equal(calls.includes("cancel-replacement"), false);
    assert.equal(fixture.store.getLogicalSession("logical:recovery").activeBinding.bindingId, "binding:replacement");
  } finally {
    await fixture.close();
  }
});

test("different recovery triggers coalesce at the same logical Session route boundary", async () => {
  const fixture = await storeFixture();
  const calls = [];
  let releaseReplay;
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "coalesce" } });
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort(calls, fixture.store, {
        replayBarrier: new Promise((resolve) => { releaseReplay = resolve; })
      }),
      resolveProviderDescriptor: () => capabilityDescriptor
    });
    const bootstrap = coordinator.recover({
      logicalSessionId: "logical:recovery",
      providerId: "test-provider",
      idempotencyKey: "tool-bootstrap:schema-5"
    });
    while (fixture.store.listSessionRecoveryAttempts("logical:recovery")[0]?.state !== "replacement_created") {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const delivery = coordinator.recover({
      logicalSessionId: "logical:recovery",
      providerId: "test-provider",
      idempotencyKey: "message-recovery:delivery:1",
      triggerDeliveryId: "delivery:1"
    });
    releaseReplay();
    const [bootstrapAttempt, deliveryAttempt] = await Promise.all([bootstrap, delivery]);
    assert.equal(deliveryAttempt.attemptId, bootstrapAttempt.attemptId);
    assert.equal(calls.filter((call) => call === "create").length, 1);
    assert.equal(fixture.store.listSessionRecoveryAttempts("logical:recovery").length, 1);
  } finally {
    releaseReplay?.();
    await fixture.close();
  }
});

test("message recovery preserves not-sent dispatch state and the safe dependency cause", async () => {
  const fixture = await storeFixture();
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "retry safely" } });
    fixture.store.appendSessionEvent({
      eventId: "event:failed-trigger-message",
      sessionId: "session:recovery",
      type: "SessionUserMessageCreated",
      source: { type: "desktop", deliveryId: "delivery:failed" },
      payload: { deliveryId: "delivery:failed", message: { text: "send after recovery" } },
      surface: true
    });
    fixture.store.appendSessionEvent({
      eventId: "event:failed-trigger-queued",
      sessionId: "session:recovery",
      type: "AgentWorkQueued",
      source: { type: "desktop", deliveryId: "delivery:failed" },
      payload: { deliveryId: "delivery:failed" },
      surface: true
    });
    const cause = Object.assign(new Error("Another Codex thread is being created."), {
      code: "SESSION_CREATION_IN_PROGRESS"
    });
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort([], fixture.store, { createError: cause }),
      resolveProviderDescriptor: () => capabilityDescriptor
    });
    await assert.rejects(
      coordinator.recover({
        logicalSessionId: "logical:recovery",
        providerId: "test-provider",
        idempotencyKey: "message-recovery:delivery:failed",
        triggerDeliveryId: "delivery:failed"
      }),
      (error) => {
        assert.equal(error.code, "SESSION_RECOVERY_FAILED");
        assert.equal(error.dispatchState, "not_sent");
        assert.equal(error.details.causeCode, "SESSION_CREATION_IN_PROGRESS");
        return true;
      }
    );
    const attempt = fixture.store.listSessionRecoveryAttempts("logical:recovery")[0];
    assert.deepEqual(attempt.error, {
      code: "SESSION_CREATION_IN_PROGRESS",
      message: "Another Codex thread is being created."
    });
  } finally {
    await fixture.close();
  }
});

test("a pre-boundary busy attempt is resumable under the same Delivery idempotency key", async () => {
  const fixture = await storeFixture();
  const calls = [];
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "before retry" } });
    const frozen = fixture.store.freezeSessionRecoveryAttempt({
      attemptId: "attempt:busy-retry",
      idempotencyKey: "message-recovery:delivery:busy-retry",
      logicalSessionId: "logical:recovery",
      capabilityRevision: capabilityDescriptor.metadata.sessionRecovery.revision
    });
    fixture.store.failSessionRecoveryAttempt(
      frozen.attemptId,
      "SESSION_BUSY",
      "The route boundary was temporarily busy."
    );
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort(calls, fixture.store),
      resolveProviderDescriptor: () => capabilityDescriptor
    });

    const committed = await coordinator.recover({
      logicalSessionId: "logical:recovery",
      providerId: "test-provider",
      idempotencyKey: frozen.idempotencyKey
    });

    assert.equal(committed.state, "committed");
    assert.equal(committed.attemptId, frozen.attemptId);
    assert.equal(calls.filter((call) => call === "create").length, 1);
  } finally {
    await fixture.close();
  }
});

test("outer recovery reporting never overwrites the first persisted failure cause", async () => {
  const fixture = await storeFixture();
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "preserve cause" } });
    const frozen = fixture.store.freezeSessionRecoveryAttempt({
      attemptId: "attempt:preserve-cause",
      idempotencyKey: "preserve-cause",
      logicalSessionId: "logical:recovery",
      capabilityRevision: capabilityDescriptor.metadata.sessionRecovery.revision
    });
    fixture.store.saveSessionRecoveryManifest(frozen.attemptId, manifestFixture(), stableRecoveryHash(manifestFixture()));
    fixture.store.failSessionRecoveryAttempt(
      frozen.attemptId,
      "PROVIDER_TOOL_APPLICATION_UNCONFIRMED",
      "The Provider did not confirm the replacement Tool schema."
    );
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort([], fixture.store),
      resolveProviderDescriptor: () => capabilityDescriptor
    });

    await assert.rejects(() => coordinator.recover({
      logicalSessionId: "logical:recovery",
      providerId: "test-provider",
      idempotencyKey: frozen.idempotencyKey
    }), { code: "RECOVERY_ATTEMPT_STATE_INVALID" });
    assert.deepEqual(fixture.store.getSessionRecoveryAttempt(frozen.attemptId).error, {
      code: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED",
      message: "The Provider did not confirm the replacement Tool schema."
    });
  } finally {
    await fixture.close();
  }
});

test("binding commit rejects a replacement superseded in the recovery journal", async () => {
  const fixture = await storeFixture();
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "replacement CAS" } });
    const attempt = fixture.store.freezeSessionRecoveryAttempt({
      attemptId: "attempt:replacement-cas",
      idempotencyKey: "replacement-cas",
      logicalSessionId: "logical:recovery",
      capabilityRevision: capabilityDescriptor.metadata.sessionRecovery.revision
    });
    fixture.store.claimSessionRecoveryBoundary(attempt.attemptId);
    const plan = planReplay({
      attempt,
      timelineEvents: fixture.store.listSessionEventsThrough(attempt.sessionId, attempt.boundarySequence),
      capabilities: recoveryCapabilities()
    });
    fixture.store.saveSessionRecoveryManifest(attempt.attemptId, plan.manifest, plan.manifestHash);
    const replacementA = {
      providerThreadId: "thread:replacement-a",
      providerSessionId: "native:replacement-a",
      bindingId: "binding:replacement-a"
    };
    const replacementB = {
      providerThreadId: "thread:replacement-b",
      providerSessionId: "native:replacement-b",
      bindingId: "binding:replacement-b"
    };
    fixture.store.recordSessionRecoveryReplacement(attempt.attemptId, replacementA);
    fixture.store.replaceSessionRecoveryReplacement(attempt.attemptId, replacementA, replacementB);
    assert.throws(() => fixture.store.commitSessionRecoveryBinding({
      attemptId: attempt.attemptId,
      replacement: replacementA,
      manifestHash: plan.manifestHash,
      capabilityRevision: capabilityDescriptor.metadata.sessionRecovery.revision,
      expectedSourceBindingId: attempt.sourceBindingId,
      expectedRoutingVersion: attempt.sourceRoutingVersion,
      expectedBindingGeneration: attempt.sourceBindingGeneration
    }), { code: "RECOVERY_REPLACEMENT_CAS_CONFLICT" });
    assert.equal(fixture.store.getLogicalSession("logical:recovery").activeBinding.bindingId, "binding:source");
  } finally {
    await fixture.close();
  }
});

test("recovery detects stale capability revisions and compare-and-swap route conflicts", async () => {
  const stale = await storeFixture();
  try {
    appendEvent(stale.store, { sequence: 1, type: "user/message", payload: { text: "stale" } });
    stale.store.freezeSessionRecoveryAttempt({
      attemptId: "attempt:stale", idempotencyKey: "stale", logicalSessionId: "logical:recovery",
      capabilityRevision: "test-provider:recovery:old"
    });
    const coordinator = new SessionRecoveryCoordinator({
      store: stale.store,
      providerPort: recoveryPort([], stale.store),
      resolveProviderDescriptor: () => capabilityDescriptor
    });
    await assert.rejects(() => coordinator.recover({
      logicalSessionId: "logical:recovery", providerId: "test-provider", idempotencyKey: "stale"
    }), { code: "RECOVERY_CAPABILITY_STALE" });
  } finally {
    await stale.close();
  }

  const raced = await storeFixture();
  try {
    appendEvent(raced.store, { sequence: 1, type: "user/message", payload: { text: "race" } });
    const coordinator = new SessionRecoveryCoordinator({
      store: raced.store,
      providerPort: recoveryPort([], raced.store, { mutateRouteBeforeValidation: true }),
      resolveProviderDescriptor: () => capabilityDescriptor
    });
    await assert.rejects(() => coordinator.recover({
      logicalSessionId: "logical:recovery", providerId: "test-provider", idempotencyKey: "race"
    }), { code: "RECOVERY_CAS_CONFLICT" });
    assert.equal(raced.store.getLogicalSession("logical:recovery").activeBinding.bindingId, "binding:source");
  } finally {
    await raced.close();
  }
});

test("recovery rejects a Provider identity that does not match the frozen binding", async () => {
  const fixture = await storeFixture();
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "identity" } });
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort([], fixture.store),
      resolveProviderDescriptor: () => ({ ...capabilityDescriptor, id: "different-provider" })
    });
    await assert.rejects(() => coordinator.recover({
      logicalSessionId: "logical:recovery", providerId: "different-provider", idempotencyKey: "identity"
    }), { code: "RECOVERY_PROVIDER_IDENTITY_MISMATCH" });
    assert.equal(fixture.store.getLogicalSession("logical:recovery").activeBinding.bindingId, "binding:source");
  } finally {
    await fixture.close();
  }
});

test("a crash after replacement creation resumes the same replacement without duplication", async () => {
  const fixture = await storeFixture();
  const calls = [];
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "resume" } });
    const attempt = fixture.store.freezeSessionRecoveryAttempt({
      attemptId: "attempt:resume", idempotencyKey: "resume", logicalSessionId: "logical:recovery",
      capabilityRevision: capabilityDescriptor.metadata.sessionRecovery.revision
    });
    fixture.store.recordSessionRecoveryReplacement(attempt.attemptId, {
      providerThreadId: "thread:replacement", providerSessionId: "native:replacement",
      bindingId: "binding:replacement", sessionProjection: { capabilities: { canSend: true }, external: { cwd: attempt.boundCwd } }
    });
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort(calls, fixture.store),
      resolveProviderDescriptor: () => capabilityDescriptor
    });
    const committed = await coordinator.recover({
      logicalSessionId: "logical:recovery", providerId: "test-provider", idempotencyKey: "resume"
    });
    assert.equal(committed.state, "committed");
    assert.equal(calls.includes("create"), false);
  } finally {
    await fixture.close();
  }
});

test("a crash-safe recovery replaces only an explicitly unrecoverable empty target before route commit", async () => {
  const fixture = await storeFixture();
  const calls = [];
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "replace empty" } });
    const attempt = fixture.store.freezeSessionRecoveryAttempt({
      attemptId: "attempt:replace-empty", idempotencyKey: "replace-empty", logicalSessionId: "logical:recovery",
      capabilityRevision: capabilityDescriptor.metadata.sessionRecovery.revision
    });
    const oldReplacement = {
      providerThreadId: "thread:lost-empty", providerSessionId: "native:lost-empty",
      bindingId: "binding:lost-empty", sessionProjection: { capabilities: { canSend: true }, external: { cwd: attempt.boundCwd } }
    };
    const newReplacement = {
      providerThreadId: "thread:new-empty", providerSessionId: "native:new-empty",
      bindingId: "binding:new-empty", sessionProjection: { capabilities: { canSend: true }, external: { cwd: attempt.boundCwd } }
    };
    fixture.store.recordSessionRecoveryReplacement(attempt.attemptId, oldReplacement);
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort(calls, fixture.store, { resumedReplacement: newReplacement }),
      resolveProviderDescriptor: () => capabilityDescriptor
    });
    const committed = await coordinator.recover({
      logicalSessionId: "logical:recovery", providerId: "test-provider", idempotencyKey: "replace-empty"
    });
    assert.equal(committed.state, "committed");
    assert.equal(committed.replacement.providerThreadId, "thread:new-empty");
    assert.equal(fixture.store.getLogicalSession("logical:recovery").activeBinding.bindingId, "binding:new-empty");
    assert.equal(calls.includes("create"), false);
    assert.equal(calls.includes("resume"), true);
    assert.equal(calls.includes("cancel-replacement"), true);
  } finally {
    await fixture.close();
  }
});

test("late events from a superseded binding generation are quarantined", async () => {
  const fixture = await storeFixture();
  try {
    appendEvent(fixture.store, { sequence: 1, type: "user/message", payload: { text: "before" } });
    const coordinator = new SessionRecoveryCoordinator({
      store: fixture.store,
      providerPort: recoveryPort([], fixture.store),
      resolveProviderDescriptor: () => capabilityDescriptor
    });
    await coordinator.recover({
      logicalSessionId: "logical:recovery", providerId: "test-provider", idempotencyKey: "late-event"
    });
    const oldBinding = fixture.store.listProviderThreadBindings("logical:recovery")
      .find((binding) => binding.bindingId === "binding:source");
    const ingestion = new ProviderEventIngestionService({
      store: fixture.store,
      resolveBinding: () => ({ ...oldBinding, sessionId: "session:recovery", isCurrentRoute: false }),
      project: () => { throw new Error("superseded events must not project"); }
    });
    const result = ingestion.ingest({
      schemaVersion: 1,
      providerId: oldBinding.providerId,
      providerSessionId: oldBinding.providerSessionId,
      bindingId: oldBinding.bindingId,
      logicalSessionId: oldBinding.logicalSessionId,
      routingVersion: oldBinding.routingVersion,
      providerEventId: "late:1",
      providerSequence: 1,
      turnId: "turn:late",
      itemId: null,
      type: "assistant.message.completed",
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      payload: { item: { id: "late:item", type: "agentMessage", text: "late" } },
      rawPayload: {}
    });
    assert.equal(result.status, "quarantined");
    assert.equal(result.code, "PROVIDER_BINDING_GENERATION_STALE");
    assert.equal(fixture.store.listSessionEventsThrough("session:recovery", 100).some((event) => event.payload?.item?.id === "late:item"), false);
  } finally {
    await fixture.close();
  }
});

test("Store recovery reads a bounded head/checkpoint/tail sample and compacts completion payloads", async () => {
  const fixture = await storeFixture();
  try {
    for (let sequence = 1; sequence <= 600; sequence += 1) {
      appendEvent(fixture.store, {
        sequence,
        type: sequence % 2 === 1 ? "user/message" : "assistant/message",
        payload: { text: `bounded recovery message ${sequence}`, turnId: `turn:${sequence}` }
      });
    }
    appendEvent(fixture.store, {
      sequence: 601,
      type: "turn.completed",
      payload: {
        turnId: "turn:601",
        hasAgentMessage: true,
        summary: "compact final answer",
        items: Array.from({ length: 500 }, (_, index) => ({
          type: "commandExecution", text: "x".repeat(2_000), index
        }))
      }
    });

    const sample = fixture.store.listSessionRecoveryEventSample("session:recovery", 601);
    assert.equal(sample.truncated, true);
    assert.ok(sample.events.length <= 253);
    assert.equal(sample.events[0].sequence, 1);
    assert.equal(sample.events.at(-1).sequence, 601);
    assert.equal(sample.events.at(-1).payload.item.text, "compact final answer");
    assert.equal(Object.hasOwn(sample.events.at(-1).payload, "items"), false);
  } finally {
    await fixture.close();
  }
});

function recoveryPort(calls, store, options = {}) {
  return new ProviderSessionRecoveryPort({
    createReplacement: async () => {
      calls.push("create");
      if (options.createError) throw options.createError;
      if (options.createFailure) throw new Error("native Provider storage is missing");
      return { providerThreadId: "thread:replacement", providerSessionId: "native:replacement", bindingId: "binding:replacement" };
    },
    resumeReplacement: async ({ replacement }) => {
      calls.push("resume");
      return options.resumedReplacement ?? replacement;
    },
    attachToolHost: async ({ attempt }) => {
      calls.push("tools");
      if (options.toolFailure) throw new Error("tool host unavailable");
      return { catalogHash: stableRecoveryHash(attempt.toolCatalog), domains: [] };
    },
    applyInstructions: async ({ attempt }) => {
      calls.push("instructions");
      return { sourcesHash: stableRecoveryHash(attempt.instructionSources) };
    },
    replayContext: async ({ manifestHash, executeTools, authorization }) => {
      calls.push("replay");
      await options.replayBarrier;
      assert.equal(executeTools, false);
      assert.equal(authorization, "historical_context_only");
      return {
        manifestHash: options.replayHashMismatch ? "0".repeat(64) : manifestHash,
        acknowledged: true,
        injectedAtCreation: true,
        sideEffectsObserved: false
      };
    },
    stabilizeReplacement: async () => {
      calls.push("stabilize");
      return {
        durable: options.stabilizationDurable !== false,
        providerObservationKind: "test_recovery_stabilized",
        toolAttempts: options.stabilizationToolAttempts ?? 0
      };
    },
    validateReplacement: async ({ attempt }) => ({
      ...(options.mutateRouteBeforeValidation ? (() => {
        store.db.run("UPDATE logical_sessions SET routing_version=routing_version+1 WHERE logical_session_id=?", [attempt.logicalSessionId]);
        return {};
      })() : {}),
      readable: true,
      writable: true,
      logicalSessionId: attempt.logicalSessionId,
      boundCwd: attempt.boundCwd,
      worktreeId: options.worktreeMismatch ? "worktree:other" : attempt.worktreeId,
      permissionSnapshotHash: stableRecoveryHash(attempt.permissionSnapshot),
      artifactReferencesHash: stableRecoveryHash(attempt.artifactReferences)
    }),
    cancelReplacement: async () => { calls.push("cancel-replacement"); }
  });
}

async function storeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-recovery-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json")
  });
  await store.initialize();
  store.upsertSession({
    id: "session:recovery", title: "Recovery", agent: "Test", provider: "test-provider",
    status: "running", sessionKind: "assistantChat", external: { provider: "test-provider", sessionId: "native:source", threadId: "thread:source" }
  });
  store.createLogicalSessionRoute({
    logicalSessionId: "logical:recovery", legacySessionId: "session:recovery",
    providerThreadId: "thread:source", providerSessionId: "native:source", providerId: "test-provider",
    bindingId: "binding:source", boundCwd: "/repo/worktree", title: "Recovery",
    instructionSources: [{ kind: "agent", hash: "instruction-v1" }],
    permissionSnapshot: { filesystem: "workspace-write", network: false }
  });
  return {
    store,
    close: async () => {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function appendEvent(store, event) {
  return store.appendSessionEvent({
    eventId: `event:${event.sequence}:${Math.random()}`,
    sessionId: "session:recovery", type: event.type, payload: event.payload,
    surface: true, createdAt: new Date(1_700_000_000_000 + event.sequence).toISOString()
  });
}

function eventHistory(count) {
  return Array.from({ length: count }, (_, index) => ({
    sequence: index + 1,
    type: index % 2 === 0 ? "user/message" : "assistant/message",
    payload: { text: `message-${index + 1}`, turnId: `turn:${Math.floor(index / 2) + 1}` }
  }));
}

function recoveryCapabilities(capabilities = capabilityDescriptor.metadata.sessionRecovery.capabilities) {
  return { revision: "test:1", capabilities, maxContextTokens: 100_000 };
}

function attemptFixture(overrides = {}) {
  return {
    attemptId: "attempt:1", idempotencyKey: "idem:1", logicalSessionId: "logical:1", sessionId: "session:1",
    providerId: "test", sourceBindingId: "binding:1", sourceProviderSessionId: "native:1",
    sourceRoutingVersion: 1, sourceBindingGeneration: 1, targetBindingGeneration: 2,
    capabilityRevision: "test:1", boundarySequence: 12, boundaryTurnId: "turn:6",
    repositoryId: null, workspaceId: null, worktreeId: null, boundCwd: "/repo",
    objectiveId: null, taskId: null, instructionSources: [], permissionSnapshot: {},
    toolCatalog: {}, artifactReferences: [], strategy: null, manifestHash: null, state: "frozen",
    contextReferences: [],
    cancelRequested: false, replacement: null, error: null, metrics: {},
    createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", completedAt: null,
    ...overrides
  };
}

function manifestFixture() {
  return {
    schemaVersion: 1, logicalSessionId: "logical:1", sourceBindingId: "binding:1",
    sourceRoutingVersion: 1, sourceBindingGeneration: 1, boundarySequence: 1, boundaryTurnId: "turn:1",
    strategy: "full_replay", instructionSourcesHash: stableRecoveryHash([]),
    permissionSnapshotHash: stableRecoveryHash({}), toolCatalogHash: stableRecoveryHash({}),
    artifactReferencesHash: stableRecoveryHash([]), checkpointHash: null,
    entries: [{ kind: "user_message", sequence: 1, role: "user", content: "hello", metadata: { executable: false } }],
    limitations: ["hidden state unavailable"]
  };
}
