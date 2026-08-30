import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";

import {
  ARTIFACT_CONTEXT_DEFAULT_LIMITS,
  ArtifactContextBudgetPolicy,
  boundArtifactSummary,
  serializedUtf8Bytes
} from "../src/application/artifactContextBudgetPolicy.mjs";
import { ArtifactReadCoordinator } from "../src/application/artifactReadCoordinator.mjs";
import { ObjectiveChatContextService } from "../src/application/objectiveChatContextService.mjs";

test("Artifact summaries and indexes enforce code-point, token, byte, item, and stable omission limits", () => {
  const summary = boundArtifactSummary("😀中a".repeat(600));
  assert.ok(Buffer.byteLength(summary.summary) <= 1_024);
  assert.ok(Array.from(summary.summary).length <= 256);
  assert.equal(Buffer.from(summary.summary).toString("utf8"), summary.summary);
  assert.equal(summary.summaryTruncated, true);
  assert.equal(summary.summaryOriginalBytes, Buffer.byteLength("😀中a".repeat(600)));

  const candidates = Array.from({ length: 120 }, (_, index) => ({
    artifactId: `artifact:${String(index).padStart(3, "0")}`,
    summary: "证据😀".repeat(30)
  }));
  const policy = new ArtifactContextBudgetPolicy();
  const first = policy.measureAndPack({
    section: "workerArtifactIndex",
    candidates,
    limits: ARTIFACT_CONTEXT_DEFAULT_LIMITS.workerArtifactIndex,
    stableOrder: (left, right) => left.artifactId.localeCompare(right.artifactId)
  });
  const second = policy.measureAndPack({
    section: "workerArtifactIndex",
    candidates: [...candidates].reverse(),
    limits: ARTIFACT_CONTEXT_DEFAULT_LIMITS.workerArtifactIndex,
    stableOrder: (left, right) => left.artifactId.localeCompare(right.artifactId)
  });
  assert.deepEqual(first.items, second.items);
  assert.ok(first.items.length <= 80);
  assert.ok(first.usage.estimatedTokens <= first.limits.maxEstimatedTokens);
  assert.ok(first.usage.serializedUtf8Bytes <= first.limits.maxUtf8Bytes);
  assert.equal(first.omittedCount, candidates.length - first.items.length);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify({ items: first.items, omissions: first.omissionReasons })));
});

test("Artifact index packing remains bounded and fast for the 80-item worst case", () => {
  const candidates = Array.from({ length: 80 }, (_, index) => ({
    artifactId: `artifact:${index}`,
    title: "T".repeat(128),
    summary: "😀".repeat(256),
    contentHash: "a".repeat(64)
  }));
  const policy = new ArtifactContextBudgetPolicy();
  const samples = [];
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const started = performance.now();
    const packed = policy.measureAndPack({
      section: "workerArtifactIndex", candidates,
      limits: ARTIFACT_CONTEXT_DEFAULT_LIMITS.workerArtifactIndex
    });
    samples.push(performance.now() - started);
    assert.ok(serializedUtf8Bytes(packed.items) <= ARTIFACT_CONTEXT_DEFAULT_LIMITS.workerArtifactIndex.maxUtf8Bytes + 2);
  }
  samples.sort((left, right) => left - right);
  assert.ok(samples[Math.floor(samples.length * 0.95)] < 10, `p95=${samples[Math.floor(samples.length * 0.95)]}ms`);
});

test("Objective snapshot remains valid JSON within dual hard budgets at 80 WorkItems and Artifacts", () => {
  const objective = {
    id: "objective:1", name: "目标".repeat(600), description: "😀说明".repeat(2_000),
    idealState: "理想状态".repeat(1_000), status: "active", priority: "high",
    targetDate: null, tags: Array.from({ length: 100 }, (_, index) => `tag-${index}`),
    workspaceIds: Array.from({ length: 100 }, (_, index) => `repository:${index}`),
    contributorAgentIds: Array.from({ length: 100 }, (_, index) => `agent:${index}`)
  };
  const workItems = Array.from({ length: 80 }, (_, index) => ({
    id: `work_item:${String(index).padStart(3, "0")}`, title: "工作".repeat(100),
    description: "描述😀".repeat(500), acceptance_criteria: "标准".repeat(500),
    priority: "medium", status: "in_progress", main_workspace_id: null,
    main_agent_id: null, current_session_id: null
  }));
  const agents = new Map(objective.contributorAgentIds.map((agentId) => [agentId, {
    agentId, name: "Agent", role: "Worker", description: "description".repeat(200)
  }]));
  const artifacts = Array.from({ length: 80 }, (_, index) => ({
    artifactId: `artifact:${index}`, title: "Artifact", summary: "摘要😀".repeat(100),
    summaryTruncated: true, summaryOriginalBytes: 10_000, visibility: "objective_private",
    pinnedVersion: 1, contentHash: "a".repeat(64), byteLength: 100_000,
    mimeType: "text/markdown", required: index < 4, relations: ["implementation_spec"],
    referenceIds: [`artifact_reference:${index}`], pendingUpdate: null
  }));
  const store = {
    getObjective: () => objective,
    listWorkItemsByObjective: () => workItems,
    resolveWorkspacePath: (id) => `/Volumes/T9/${id}/${"p".repeat(2_000)}`,
    getAgent: (id) => agents.get(id),
    getObjectiveChatSession: () => ({ id: "session:objective", sessionKind: "objectiveChat", objectiveId: objective.id })
  };
  const service = new ObjectiveChatContextService({
    store,
    artifactService: { indexForSession: () => ({ items: artifacts, omittedArtifactCount: 0, omissionReasons: {} }) }
  });
  const samples = [];
  let result;
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now();
    result = service.build(objective.id);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  assert.ok(result.utf8Bytes <= 32_768);
  assert.ok(result.estimatedTokens <= 8_192);
  assert.ok(result.counts.workItems <= 80);
  assert.ok(result.counts.artifacts <= 80);
  assert.doesNotThrow(() => JSON.parse(result.prompt.split("Objective snapshot:\n")[1]));
  assert.ok(samples[Math.ceil(samples.length * 0.95) - 1] < 20, `p95=${samples[Math.ceil(samples.length * 0.95) - 1]}ms`);
});

test("Artifact read coordinator single-flights pages, persists one receipt, and exhausts both Turn budgets", async () => {
  const store = new MemoryReadStore();
  const coordinator = new ArtifactReadCoordinator({ store });
  let loads = 0;
  const input = readInput({
    turnExecutionId: "turn:single-flight",
    load: async () => {
      loads += 1;
      await Promise.resolve();
      return { encoding: "base64", content: "eA==", byteLength: 1, nextOffset: null };
    }
  });
  const [first, second] = await Promise.all([coordinator.read(input), coordinator.read(input)]);
  assert.equal(loads, 1);
  assert.equal(store.receipts.size, 1);
  assert.equal(first.readReceiptId, second.readReceiptId);
  assert.deepEqual([first.deduplicated, second.deduplicated].sort(), [false, true]);
  const replaySamples = [];
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now();
    const replay = await coordinator.read(input);
    replaySamples.push(performance.now() - started);
    assert.equal(replay.deduplicated, true);
  }
  replaySamples.sort((left, right) => left - right);
  assert.ok(replaySamples[Math.ceil(replaySamples.length * 0.95) - 1] < 2);

  const bytesTurn = "turn:bytes";
  await coordinator.read(readInput({ turnExecutionId: bytesTurn, artifactId: "artifact:a", anticipatedBytes: 65_536, byteLength: 65_536 }));
  await coordinator.read(readInput({ turnExecutionId: bytesTurn, artifactId: "artifact:b", anticipatedBytes: 65_536, byteLength: 65_536 }));
  await assert.rejects(
    coordinator.read(readInput({ turnExecutionId: bytesTurn, artifactId: "artifact:c", anticipatedBytes: 1, byteLength: 1 })),
    { code: "ARTIFACT_TURN_READ_BUDGET_EXCEEDED" }
  );

  const pagesTurn = "turn:pages";
  for (let index = 0; index < 16; index += 1) {
    await coordinator.read(readInput({ turnExecutionId: pagesTurn, artifactId: `artifact:p${index}`, anticipatedBytes: 0, byteLength: 0 }));
  }
  await assert.rejects(
    coordinator.read(readInput({ turnExecutionId: pagesTurn, artifactId: "artifact:p16", anticipatedBytes: 0, byteLength: 0 })),
    { code: "ARTIFACT_TURN_READ_BUDGET_EXCEEDED" }
  );
});

test("Artifact page cache is capped by page count and memory and failed loads release reservations", async () => {
  const store = new MemoryReadStore();
  const coordinator = new ArtifactReadCoordinator({
    store,
    limits: { maxCachePages: 4, maxCacheBytes: 10, maxUniquePagesPerTurn: 100, maxUniqueBytesPerTurn: 1_000 }
  });
  for (let index = 0; index < 12; index += 1) {
    await coordinator.read(readInput({
      turnExecutionId: `turn:cache:${index}`, artifactId: `artifact:${index}`,
      anticipatedBytes: 3, byteLength: 3
    }));
  }
  assert.ok(coordinator.snapshot().cachedPages <= 4);
  assert.ok(coordinator.snapshot().cachedBytes <= 10);
  await assert.rejects(coordinator.read(readInput({
    turnExecutionId: "turn:failure", artifactId: "artifact:failure", anticipatedBytes: 8,
    load: async () => { throw Object.assign(new Error("disk failed"), { code: "EIO" }); }
  })), { code: "EIO" });
  assert.deepEqual(store.usage.get(store.key("turn:failure")), { uniqueBytes: 0, uniquePages: 0 });
});

test("Artifact read cancellation and authorization failure release reservations without canceling joined readers", async () => {
  const store = new MemoryReadStore();
  const coordinator = new ArtifactReadCoordinator({ store });
  let releaseCanceled;
  const canceledLoad = new Promise((resolve) => { releaseCanceled = resolve; });
  const canceled = new AbortController();
  const canceledRead = coordinator.read(readInput({
    turnExecutionId: "turn:canceled",
    anticipatedBytes: 8,
    signal: canceled.signal,
    load: () => canceledLoad
  }));
  await Promise.resolve();
  canceled.abort("caller disconnected");
  await assert.rejects(canceledRead, { code: "ARTIFACT_READ_CANCELED", statusCode: 499 });
  releaseCanceled({ encoding: "base64", content: "eA==", byteLength: 1, nextOffset: null });
  assert.deepEqual(store.usage.get(store.key("turn:canceled")), { uniqueBytes: 0, uniquePages: 0 });

  let releaseShared;
  const sharedLoad = new Promise((resolve) => { releaseShared = resolve; });
  const sharedInput = readInput({ turnExecutionId: "turn:joined-cancel", load: () => sharedLoad });
  const primary = coordinator.read(sharedInput);
  const joinedAbort = new AbortController();
  const joined = coordinator.read({ ...sharedInput, signal: joinedAbort.signal });
  joinedAbort.abort();
  await assert.rejects(joined, { code: "ARTIFACT_READ_CANCELED" });
  releaseShared({ encoding: "base64", content: "eA==", byteLength: 1, nextOffset: null });
  assert.equal((await primary).deduplicated, false);
  assert.deepEqual(store.usage.get(store.key("turn:joined-cancel")), { uniqueBytes: 1, uniquePages: 1 });

  await assert.rejects(coordinator.read(readInput({
    turnExecutionId: "turn:authorization-failure",
    anticipatedBytes: 7,
    reauthorize: async () => { throw Object.assign(new Error("revoked"), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" }); }
  })), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
  assert.deepEqual(store.usage.get(store.key("turn:authorization-failure")), { uniqueBytes: 0, uniquePages: 0 });
  for (const usage of store.usage.values()) {
    assert.ok(usage.uniqueBytes >= 0);
    assert.ok(usage.uniquePages >= 0);
  }
});

test("durable fixed-page replay reauthorizes and never reserves or charges twice", async () => {
  const store = new MemoryReadStore();
  const input = readInput({ turnExecutionId: "turn:durable", anticipatedBytes: 4, byteLength: 4 });
  const first = await new ArtifactReadCoordinator({ store }).read(input);
  const usageAfterFirst = { ...store.usage.get(store.key("turn:durable")) };
  let authorizations = 0;
  const replay = await new ArtifactReadCoordinator({ store }).read({
    ...input,
    reauthorize: async () => { authorizations += 1; return true; }
  });
  assert.equal(replay.readReceiptId, first.readReceiptId);
  assert.equal(replay.deduplicated, true);
  assert.equal(authorizations, 2);
  assert.equal(store.receipts.size, 1);
  assert.deepEqual(store.usage.get(store.key("turn:durable")), usageAfterFirst);
});

function readInput(overrides = {}) {
  const byteLength = overrides.byteLength ?? overrides.anticipatedBytes ?? 1;
  return {
    logicalSessionId: "session:logical",
    providerBindingId: "binding:1",
    turnExecutionId: overrides.turnExecutionId ?? "turn:1",
    artifactId: overrides.artifactId ?? "artifact:1",
    version: 1,
    contentHash: "a".repeat(64),
    offset: 0,
    limit: overrides.anticipatedBytes ?? 1,
    format: "base64",
    referenceId: "artifact_reference:1",
    authorizationRevision: "auth:1",
    anticipatedBytes: overrides.anticipatedBytes ?? byteLength,
    signal: overrides.signal,
    reauthorize: overrides.reauthorize ?? (async () => true),
    load: overrides.load ?? (async () => ({
      encoding: "base64", content: Buffer.alloc(byteLength).toString("base64"), byteLength, nextOffset: null
    }))
  };
}

class MemoryReadStore {
  constructor() { this.usage = new Map(); this.receipts = new Map(); }
  key(turnExecutionId) { return `session:logical\0binding:1\0${turnExecutionId}`; }
  reserveArtifactTurnRead(input) {
    const key = this.key(input.turnExecutionId);
    const current = this.usage.get(key) ?? { uniqueBytes: 0, uniquePages: 0 };
    if (current.uniqueBytes + input.byteLength > input.uniqueBytesLimit
      || current.uniquePages + 1 > input.uniquePagesLimit) return null;
    const next = { uniqueBytes: current.uniqueBytes + input.byteLength, uniquePages: current.uniquePages + 1 };
    this.usage.set(key, next);
    return next;
  }
  adjustArtifactTurnReadReservation(input) {
    const key = this.key(input.turnExecutionId);
    const current = this.usage.get(key) ?? { uniqueBytes: 0, uniquePages: 0 };
    const next = {
      uniqueBytes: Math.max(0, current.uniqueBytes + input.byteDelta),
      uniquePages: Math.max(0, current.uniquePages + input.pageDelta)
    };
    this.usage.set(key, next);
    return next;
  }
  createArtifactReadReceipt(input) {
    const existing = this.receipts.get(input.readReceiptId);
    if (existing) return existing;
    const receipt = { ...input };
    this.receipts.set(input.readReceiptId, receipt);
    return receipt;
  }
  getArtifactReadReceipt(readReceiptId) { return this.receipts.get(readReceiptId) ?? null; }
  getArtifactTurnReadUsage(_logicalSessionId, _providerBindingId, turnExecutionId) {
    return this.usage.get(this.key(turnExecutionId)) ?? { uniqueBytes: 0, uniquePages: 0 };
  }
}
