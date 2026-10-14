import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDetailBusinessReadPorts } from "../src/application/detailBusinessReadPorts.mjs";
import { DetailBusinessReadCache } from "../src/application/detailBusinessReadCache.mjs";
import { projectDetailBusinessRich } from "../src/application/detailBusinessRichProjection.mjs";
import { DETAIL_COMPONENTS_CATALOG, DETAIL_COMPONENT_CAPABILITIES } from "../src/application/detailV2Catalog.mjs";
import { validateDetailV2 } from "../src/application/detailSyncV2.mjs";

const contract = JSON.parse(readFileSync(new URL("./fixtures/detail-business-legacy-module-contract.json", import.meta.url)));
const scope = { session: { id: "session", sessionKind: "worker", agentId: "agent", external: {
  provider: "provider-0", currentModel: "model", currentReasoningLevel: "medium", cwd: "/do-not-export" } },
  logicalSessionId: "logical:session", task: { id: "task", title: "Task" }, work: { id: "work" } };
const identity = { principalId: "principal", deviceId: "device", sessionId: scope.logicalSessionId,
  serverId: "server", accountId: "account", catalogProfile: DETAIL_COMPONENTS_CATALOG };
const profile = { catalog: DETAIL_COMPONENTS_CATALOG, clientCapabilities: [...DETAIL_COMPONENT_CAPABILITIES] };
const project = results => projectDetailBusinessRich(scope, results, { profile, generation: "contract" });

test("Provider contract stays capability-based, bounded and read-only; name never grants behavior", () => {
  const ports = createDetailBusinessReadPorts({ providerRegistry: {
    descriptors: () => Array.from({ length: 25 }, (_, i) => ({ id: `provider-${i}`, displayName: i === 0 ? "Codex" : "Another Provider", private: "do-not-export" })),
    supports: (id, capability) => id !== "provider-0" || capability === "session.create"
  } });
  const data = ports.provider.read(scope), spec = contract.modules.provider;
  assert.equal(ports.provider.cacheable, spec.cacheable);
  assert.equal(data.providers.length, spec.maximumRows); assert.equal(data.hasMore, true);
  assert.equal(data.providers[0].available, false); assert.equal(data.providers[1].available, true);
  assert.deepEqual(data.providers[0].capabilities, ["session.create"]);
  assert.doesNotMatch(JSON.stringify(data), /do-not-export|cwd|private/);
  const state = project({ provider: { state: "ready", data } }); validateDetailV2(state, profile);
  const card = state.instances["business-provider"];
  assert.deepEqual(card.actions, {}); assert.equal(card.collections.resources.nextCursor, null);
  assert.match(card.fields.state, /更多内容尚未接线/);
  // Availability describes Provider behavior, not registration of a native editor.
  assert.equal(spec.nativeBehaviorPending, true);
});

test("Worktree read facts strip host paths/plans and do not silently grow a stale cache", async () => {
  let reads = 0;
  const ports = createDetailBusinessReadPorts({ readWorktree: async () => ({ attached: true, repositoryId: "repo",
    worktree: { worktreeId: "tree", branchName: `branch-${++reads}`, path: "/do-not-export", changedFiles: ["do-not-export"], changedFileCount: 3 },
    job: { id: "job", status: "running", phase: "checking", plan: "do-not-export" }, autoFollow: { enabled: true, status: "following" } }) });
  assert.equal(ports.worktree.cacheable, contract.modules.worktree.cacheable);
  const cache = new DetailBusinessReadCache(ports);
  const first = await cache.read(scope, "worktree", identity, { force: false });
  cache.invalidate({ resourceType: "session", sessionId: scope.logicalSessionId });
  assert.equal([...cache.scopes.values()][0].modules.get("worktree").dirty, false);
  const second = await cache.read(scope, "worktree", identity, { force: false });
  assert.equal(reads, 2); assert.notEqual(first.data.tree.branchName, second.data.tree.branchName);
  assert.doesNotMatch(JSON.stringify(second), /do-not-export|"path"|changedFiles|"plan"/);
  const state = project({ worktree: second }); validateDetailV2(state, profile);
  assert.deepEqual(state.instances["business-worktree"].actions, {});
  // Re-reading is conservative correctness, not proof that per-token Git work is cheap.
  assert.equal(contract.boundary.nodeTestsAreNotDevicePerformance, true);
});

test("Turn summary enforces canonical scope and only bounded finite numeric facts survive", () => {
  let logicalSessionId = scope.logicalSessionId;
  const ports = createDetailBusinessReadPorts({ observability: { latestSummary: () => ({ identity: { logicalSessionId, turnExecutionId: "turn" },
    wall: { totalMs: 12, negative: -1, invalid: Infinity, privateText: "do-not-export" },
    wallPartition: { activeMs: 8 }, inclusive: { toolsMs: 5 }, completeness: { state: "partial", providerMetadata: "do-not-export" } }) } });
  const data = ports.turn.read(scope); assert.equal(ports.turn.cacheable, false);
  assert.deepEqual(data.wall, { totalMs: "12" }); assert.equal(data.completeness, "partial");
  assert.doesNotMatch(JSON.stringify(data), /do-not-export|providerMetadata/);
  const state = project({ turn: { state: "ready", data } }); validateDetailV2(state, profile);
  assert.deepEqual(state.instances["business-turn"].actions, {});
  logicalSessionId = "foreign"; assert.throws(() => ports.turn.read(scope), { status: 403 });
});

test("Recall port is explicitly an eight-entry recent preview, not a complete history or paginated UI", () => {
  let query;
  const all = Array.from({ length: 12 }, (_, i) => ({ id: `recall-${i}`, phase: "planning", mode: "automatic", reason: "eligible",
    createdAt: "2026-10-11T12:00:00+08:00", selectedIds: [], candidateIds: [], privateMetadata: "do-not-export" }));
  const ports = createDetailBusinessReadPorts({ store: { listMemoryRecallAudit: options => { query = options; return all.slice(0, options.limit); } } });
  const data = ports.recalls.read(scope);
  assert.equal(query.limit, contract.modules.recalls.sourceLimit); assert.equal(data.items.length, 8);
  assert.equal(data.hasMore, false); assert.doesNotMatch(JSON.stringify(data), /do-not-export|privateMetadata/);
  assert.equal(contract.modules.recalls.recentPreviewNotCompleteHistory, true);
  const state = project({ recalls: { state: "ready", data } }); validateDetailV2(state, profile);
  assert.equal(state.instances["business-recalls"].collections.resources.nextCursor, null);
  assert.deepEqual(state.instances["business-recalls"].actions, {});
});

test("Schedule read display preserves timezone and bounded truncation; it does not imply command availability", () => {
  let actor;
  const ports = createDetailBusinessReadPorts({ schedules: { list: (_, who) => { actor = who; return Array.from({ length: 45 }, (_, i) => ({
    taskId: `schedule-${i}`, name: "Schedule", status: "active", scheduleType: "once", nextRunAt: "2026-11-01T01:30:00-08:00",
    timezone: "America/Los_Angeles", message: "do-not-export", resourceVersion: 2 })); } } });
  const data = ports.schedules.read(scope, identity);
  assert.equal(data.items.length, contract.modules.schedules.maximumRows); assert.equal(data.hasMore, true);
  assert.equal(actor.id, "user:paired-device:device");
  assert.equal(data.items[0].nextRunAt, "2026-11-01T01:30:00-08:00"); assert.doesNotMatch(JSON.stringify(data), /do-not-export/);
  const state = project({ schedules: { state: "ready", data } }); validateDetailV2(state, profile);
  assert.deepEqual(state.instances["business-schedules"].actions, {});
  assert.equal(state.instances["business-schedules"].collections.resources.nextCursor, null);
  assert.match(state.instances["business-schedules"].fields.state, /更多内容尚未接线/);
  // Root supports genuine opaque page and cancel ports; this is default read-only mode.
  assert.ok(contract.boundary.opaqueServerPagingSupportedInRoot.includes("schedules"));
});
