import test from "node:test";
import assert from "node:assert/strict";
import { projectDetailBusinessRich } from "../src/application/detailBusinessRichProjection.mjs";
import { DETAIL_COMPONENTS_CATALOG, DETAIL_COMPONENT_CAPABILITIES } from "../src/application/detailV2Catalog.mjs";
import { validateDetailV2, diffDetailV2, applyDetailV2, canonicalDetailV2 } from "../src/application/detailSyncV2.mjs";
import { createDetailBusinessReadPorts } from "../src/application/detailBusinessReadPorts.mjs";
import { DetailBusinessReadCache } from "../src/application/detailBusinessReadCache.mjs";
import { detailBusinessDate } from "../src/application/detailBusinessDate.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
const profile = { catalog: DETAIL_COMPONENTS_CATALOG, clientCapabilities: [...DETAIL_COMPONENT_CAPABILITIES] };
const scope = { session: { id: "legacy", sessionKind: "worker" }, logicalSessionId: "logical:sample",
  task: { id: "task", title: "Task", description: "Definition", acceptance_criteria: "Acceptance", verification_criteria: "Verification" } };
const options = { profile, generation: "generation" };
const result = name => ({ state: "ready", data: { items: [{ resource: { resourceType: name, id: `${name}:1` },
  title: "Artifact", displayName: "Reference", status: "available", contentHash: "a".repeat(64), version: 2,
  references: [{ required: true, pendingVersion: 3, pendingHash: "b".repeat(64) }], locator: "/private/secret", metadata: { hidden: "secret" } }] } });
test("offline producer requires explicit capabilities and does not enable actions or legacy rich catalog", () => {
  const state = projectDetailBusinessRich(scope, { artifacts: result("artifact") }, options);
  assert.doesNotThrow(() => validateDetailV2(state, profile)); assert.throws(() => validateDetailV2(state));
  assert.throws(() => projectDetailBusinessRich(scope));
  assert.throws(() => projectDetailBusinessRich(scope, {}, { ...options, profile: { ...profile, clientCapabilities: [] } }));
  assert.deepEqual(state.instances["business-artifacts"].actions, {});
  assert.doesNotMatch(JSON.stringify(state), /private|secret|locator|hidden/);
  assert.match(state.instances["task-information"].fields.body, /Acceptance[\s\S]*Verification/);
});
test("native Task editor uses the existing navigation token only behind host editor gate and actual button capability", () => {
  const input = { ...scope, task: { ...scope.task, revision: 14 } };
  const closed = projectDetailBusinessRich(input, {}, options);
  assert.deepEqual(closed.instances["task-information"].actions, {});
  const enabled = projectDetailBusinessRich(input, {}, { ...options, editors: true });
  validateDetailV2(enabled, profile);
  assert.deepEqual(enabled.instances["task-information"].actions.edit.target, { resourceType: "task", id: "task" });
  assert.equal(enabled.instances["task-information"].actions.edit.operation, "editor.open");
  assert.equal(enabled.instances["task-information"].actions.edit.expectedResourceRevision, "14");
  assert.equal(Object.values(enabled.templates).some(template => template.card.nodes.some(node => node.id === "edit")), true);
  const reduced = { ...profile, clientCapabilities: profile.clientCapabilities.filter(token => token !== "detail.button") };
  const unavailable = projectDetailBusinessRich(input, {}, { ...options, profile: reduced, editors: true });
  assert.deepEqual(unavailable.instances["task-information"].actions, {});
  assert.equal(unavailable.manifest.cards["task-information"].templateHash, closed.manifest.cards["task-information"].templateHash);
});
test("list templates share structure across resources and collection updates preserve unrelated cards", () => {
  const reads = { artifacts: result("artifact"), references: result("reference") };
  const before = projectDetailBusinessRich(scope, reads, options);
  assert.equal(before.manifest.cards["business-artifacts"].templateHash, before.manifest.cards["business-references"].templateHash);
  assert.strictEqual(projectDetailBusinessRich(scope, reads, { ...options, previous: before }), before);
  reads.artifacts.data.items[0].title = "Changed";
  const after = projectDetailBusinessRich(scope, reads, { ...options, previous: before });
  assert.equal(after.instances["business-artifacts"].collections.resources.revision, 2);
  assert.strictEqual(after.instances["business-references"], before.instances["business-references"]);
  assert.equal(canonicalDetailV2(applyDetailV2(before, diffDetailV2(before, after, profile), profile)), canonicalDetailV2(after));
});
test("read failures stay distinct from empty and fixed/pending Artifact facts survive", () => {
  const state = projectDetailBusinessRich(scope, { artifacts: result("artifact"), references: { state: "error", code: "raw-secret" } }, options);
  assert.match(state.instances["business-artifacts"].fields.body, /固定版本：2[\s\S]*required[\s\S]*待确认版本：3/);
  assert.equal(state.instances["business-references"].fields.state, "读取失败");
  const empty = projectDetailBusinessRich(scope, { references: { state: "empty", data: { items: [] } } }, options);
  assert.equal(empty.instances["business-references"].fields.state, "暂无内容");
  assert.doesNotMatch(JSON.stringify(state), /raw-secret/);
});
test("pages are bounded, stable IDs unique, and unsupported modules are not silently dropped", () => {
  assert.throws(() => projectDetailBusinessRich(scope, { unknown: result("automation") }, options));
  const reads = result("reference"); reads.data.items.push(reads.data.items[0]);
  assert.throws(() => projectDetailBusinessRich(scope, { references: reads }, options));
  reads.data.items = Array.from({ length: 21 }, (_, i) => ({ resource: { resourceType: "reference", id: String(i) } }));
  assert.throws(() => projectDetailBusinessRich(scope, { references: reads }, options));
});
test("Work projection uses the same immutable content structure; identity changes reset revisions", () => {
  const worker = projectDetailBusinessRich(scope, {}, options);
  const workScope = { session: { sessionKind: "workChat" }, logicalSessionId: "logical:work",
    work: { id: "work", name: "Work title", description: "Work body", path: "/private" } };
  const work = projectDetailBusinessRich(workScope, {}, { ...options, previous: worker });
  assert.equal(work.revision, 1);
  assert.equal(work.manifest.cards["work-overview"].templateHash, worker.manifest.cards["task-information"].templateHash);
  assert.equal(work.instances["work-overview"].fields.body, "Work body");
  assert.doesNotMatch(JSON.stringify(work), /private/);
  assert.throws(() => { Object.values(work.templates)[0].card.title.fallback = "mutated"; });
  const bad = structuredClone(work); bad.stateHash = "sha256:" + "0".repeat(64);
  assert.throws(() => projectDetailBusinessRich(workScope, {}, { ...options, previous: bad }));
});

const newModules = ["recalls", "schedules", "provider", "turn", "worktree"];
function newPorts() {
  const facts = { phase: "planning", schedule: "计划", branch: "feature", elapsed: 12, model: "model" };
  const ports = createDetailBusinessReadPorts({
    store: { listMemoryRecallAudit: () => [{ id: "recall", phase: facts.phase, mode: "automatic", reason: "eligible",
      createdAt: "2026-10-11T12:00:00+08:00", selectedIds: ["memory"], candidateIds: [], secret: "/private/secret",
      diagnostics: { injection: { status: "injected" }, selectedEntries: [{ id: "memory", kind: "preference", content: "偏好", snapshotAtRecall: true, secret: "secret" }] } }] },
    schedules: { list: () => Array.from({ length: 25 }, (_, i) => ({ taskId: `schedule:${i}`, name: `${facts.schedule}${i}`,
      nextRunAt: "2026-10-11T12:00:00+08:00", runAt: "2026-10-10T04:00:00Z", timezone: "Asia/Shanghai", scheduleType: "once", status: "active", message: "secret" })) },
    providerRegistry: { descriptors: () => Array.from({ length: 25 }, (_, i) => ({ id: `provider:${i}`, displayName: `Provider ${i}`, credentials: "secret" })),
      supports: (_, capability) => [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE, AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME, AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND].includes(capability) },
    observability: { latestSummary: () => ({ identity: { logicalSessionId: scope.logicalSessionId, turnExecutionId: "turn" },
      wall: { totalMs: facts.elapsed, private: "secret" }, wallPartition: { activeMs: 8 }, inclusive: { toolsMs: 5 }, completeness: { state: "partial", secret: true }, raw: "secret" }) },
    readWorktree: async () => ({ attached: true, repositoryId: "repository", mainBranch: "main", path: "/private/secret",
      worktree: { worktreeId: "tree", branchName: facts.branch, dirty: true, changedFileCount: 2, availability: "ready", changedFiles: ["secret"] },
      autoFollow: { enabled: true, status: "following" }, job: { id: "job", phase: "checking", status: "running", plan: "secret" } })
  });
  const input = { ...scope, session: { ...scope.session, external: { currentModel: facts.model, currentReasoningLevel: "medium", private: "secret" } } };
  const cache = new DetailBusinessReadCache(ports);
  const read = async () => Object.fromEntries(await Promise.all(newModules.map(async name => [name, await cache.read(input, name,
    { principalId: "principal", accountId: "account", serverId: "server", sessionId: scope.logicalSessionId, catalogProfile: profile.catalog })])));
  return { facts, read, input };
}

test("five real read ports converge through strict projection/diff/apply without private fields or actions", async () => {
  const { facts, read, input } = newPorts();
  const before = projectDetailBusinessRich(input, await read(), options);
  validateDetailV2(before, profile);
  assert.equal(before.manifest.order.length, 6);
  assert.doesNotMatch(JSON.stringify(before), /private|secret|credentials|changedFiles|"path"|"raw"/);
  for (const name of newModules) assert.deepEqual(before.instances[`business-${name}`].actions, {});
  assert.equal(before.instances["business-schedules"].fields.date0, "2026-10-11T12:00:00+08:00");
  assert.equal(before.instances["business-schedules"].fields.scheduledDate0, "2026-10-10T04:00:00Z");
  assert.equal(before.instances["business-recalls"].fields.date0, "2026-10-11T12:00:00+08:00");
  assert.match(before.instances["business-recalls"].fields.body, /偏好[\s\S]*召回时快照/);
  assert.match(before.instances["business-turn"].fields.body, /totalMs: 12[\s\S]*partial|partial[\s\S]*totalMs: 12/);
  assert.match(before.instances["business-worktree"].fields.body, /feature[\s\S]*changedFileCount: 2/);
  assert.match(before.instances["business-provider"].fields.body, /model[\s\S]*可用/);
  for (const name of ["schedules", "provider"]) {
    const instance = before.instances[`business-${name}`];
    assert.equal(instance.collections.resources.order.length, 20);
    assert.equal(instance.collections.resources.nextCursor, null);
    assert.match(instance.fields.state, /更多内容尚未接线/);
  }
  assert.equal(before.manifest.cards["business-recalls"].templateHash, before.manifest.cards["business-schedules"].templateHash);
  const dateTemplate = before.templates[before.manifest.cards["business-schedules"].templateHash];
  assert.equal(dateTemplate.card.nodes.filter(n => n.kind === "detail.dateTime").length, 40);
  assert.equal(Object.keys(dateTemplate.fieldSchema).length, 63);
  assert.throws(() => { dateTemplate.fieldSchema.date0.required = true; });
  facts.phase = "finished"; facts.schedule = "更新"; facts.branch = "updated"; facts.elapsed = 20;
  const after = projectDetailBusinessRich(input, await read(), { ...options, previous: before });
  assert.strictEqual(after.instances["business-provider"], before.instances["business-provider"]);
  assert.equal(after.instances["business-schedules"].collections.resources.revision, 2);
  assert.equal(after.manifest.cards["business-schedules"].templateHash, before.manifest.cards["business-schedules"].templateHash);
  assert.equal(canonicalDetailV2(applyDetailV2(before, diffDetailV2(before, after, profile), profile)), canonicalDetailV2(after));
});

test("new modules distinguish unavailable/denied/error/empty and never publish raw failure details", () => {
  for (const name of newModules) {
    for (const [code, label] of [["DETAIL_MODULE_UNAVAILABLE", "模块不可用"], ["DETAIL_MODULE_ACCESS_DENIED", "无权读取"], ["/private/secret", "读取失败"]]) {
      const state = projectDetailBusinessRich(scope, { [name]: { state: "error", code, data: { secret: true } } }, options);
      assert.equal(state.instances[`business-${name}`].fields.state, label);
      assert.equal(state.instances[`business-${name}`].fields.body, "");
      assert.doesNotMatch(JSON.stringify(state), /private|secret/);
    }
    const empty = projectDetailBusinessRich(scope, { [name]: { state: "empty", data: null } }, options);
    assert.equal(empty.instances[`business-${name}`].fields.state, "暂无内容");
    assert.throws(() => projectDetailBusinessRich(scope, { [name]: null }, options));
  }
});

test("dates keep exact offset and reject absent timezone, rollover, malformed offsets or oversized values", () => {
  const valid = ["2024-02-29T23:59:59.123+08:00", "2026-10-11T00:00:00-07:00", "2026-10-11T00:00:00Z"];
  for (const value of valid) assert.equal(detailBusinessDate(value), value);
  const invalid = ["2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-11T24:00:00Z", "2026-10-11T00:00:00",
    "2026-10-11T00:00:00+24:00", "2026-10-11T00:00:00+08:60", "not a date", "x".repeat(65), 123];
  for (const value of invalid) {
    assert.equal(detailBusinessDate(value), null);
    assert.throws(() => projectDetailBusinessRich(scope, { schedules: { state: "ready", data: { items: [
      { resource: { resourceType: "automation", id: "schedule" }, name: "Name", nextRunAt: value }
    ] } } }, options), /DETAIL_BUSINESS_DATE_INVALID/);
  }
  const ports = createDetailBusinessReadPorts({ schedules: { list: () => invalid.map((runAt, i) => ({ taskId: String(i), runAt })) } });
  assert.ok(ports.schedules.read(scope, {}).items.every(row => row.runAt === null));
});

test("new dated templates require actual declared caps; collection size remains bounded", () => {
  const reads = { schedules: { state: "ready", data: { items: [] } } };
  for (const capability of ["detail.dateTime", "detail.keyValue"]) assert.throws(() => projectDetailBusinessRich(scope, reads,
    { ...options, profile: { ...profile, clientCapabilities: profile.clientCapabilities.filter(c => c !== capability) } }));
  assert.throws(() => projectDetailBusinessRich(scope, reads, { ...options, profile: { ...profile, clientCapabilities: [...profile.clientCapabilities, "detail.unknown"] } }));
  assert.throws(() => projectDetailBusinessRich(scope, { schedules: { state: "ready", data: { items: Array.from({ length: 21 }, (_, i) => ({ resource: { resourceType: "automation", id: String(i) } })) } } }, options));
});
