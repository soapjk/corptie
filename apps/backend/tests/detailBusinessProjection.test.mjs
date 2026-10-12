import test from "node:test";
import assert from "node:assert/strict";
import { DetailDocumentService, detailPatch, projectDetailDocument, detailServiceFor } from "../src/application/detailDocumentService.mjs";
import { ClientDeviceGateway } from "../src/application/clientDeviceGateway.mjs";
import { validateDetailContract } from "../src/application/detailDocumentContract.mjs";
import { validateDetailV2Envelope } from "../src/application/detailV2Contract.mjs";
import { projectBusinessModules } from "../src/application/detailBusinessProjection.mjs";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

function setup(kind = "worker") {
  const session = { id: "legacy", sessionKind: kind, taskId: kind === "worker" ? "task" : null, workId: "work" };
  const task = { id: "task", work_id: "work", title: "Task", description: "Description", acceptance_criteria: "Acceptance",
    verification_criteria: "Verification", rawMetadata: "SECRET" };
  const work = { id: "work", name: "Work", description: "Overview", credentials: "SECRET" };
  const store = { getSession: id => id === "legacy" ? session : null,
    getLogicalSession: () => null, getLogicalSessionByLegacySessionId: () => ({ logicalSessionId: "logical:sample" }),
    getTask: () => task, getWork: () => work };
  const service = new DetailDocumentService(store, { modules: ["session", "summary", "task", "work"] });
  return { session, task, work, store, service };
}

test("Task definitions use existing components, preserve verification criteria and redact store metadata", () => {
  const { service } = setup(), document = service.snapshot("legacy");
  validateDetailContract(document, "Document");
  const task = document.cards.find(card => card.id === "task-information");
  assert.deepEqual(task.data, { taskId: "task", title: "Task", description: "Description", acceptance: "Acceptance", verification: "Verification" });
  assert.equal(task.nodes.find(node => node.id === "definition").kind, "disclosure");
  assert.doesNotMatch(JSON.stringify(document), /SECRET|rawMetadata|credentials/);
  validateDetailV2Envelope(service.v2Snapshot("legacy"), "State");
});

test("module rollout stays opt-in so native Task editors do not disappear or duplicate", () => {
  const document = projectDetailDocument({ session: { sessionKind: "worker" }, logicalSessionId: "logical:sample", task: { title: "Task" } });
  assert.deepEqual(document.order, ["session-info"]);
  assert.throws(() => projectDetailDocument({ session: {} }, ["unknown"]), { code: "DETAIL_MODULE_PROFILE_INVALID" });
});

test("business selection follows explicit Session kind across all Provider names", () => {
  const { service, session } = setup("workChat");
  const before = service.snapshot("legacy");
  assert.deepEqual(before.order, ["session-info", "work-overview"]);
  for (const provider of ["codex", "claudeCode", "future-provider"]) {
    session.external = { provider, credentials: "SECRET" };
    assert.strictEqual(service.snapshot("legacy"), before);
  }
  session.sessionKind = "assistantChat"; session.taskId = "task"; session.summary = "Chat summary";
  assert.deepEqual(service.snapshot("legacy").order, ["session-info", "session-summary"]);
});

test("Task updates replace only Task data; unrelated token events reuse module/card instances", () => {
  const { service, session, task } = setup(), before = service.snapshot("legacy");
  session.updatedAt = "new token"; session.status = "running";
  service.invalidate({ resourceType: "session", sessionId: "logical:sample" });
  assert.strictEqual(service.snapshot("legacy"), before);
  task.description = "New description";
  service.invalidate({ resourceType: "task", taskId: "task" });
  const next = service.snapshot("legacy");
  assert.deepEqual(detailPatch(before, next).upsertCards.map(card => card.id), ["task-information"]);
  assert.strictEqual(next.cards[0], before.cards[0]);
  assert.equal(next.cards[1].templateRevision, before.cards[1].templateRevision);
});

test("optional Work bindings advance template revisions and do not regress on later data changes", () => {
  const { service, session, work } = setup("workChat"), before = service.snapshot("legacy");
  work.description = "";
  const removed = service.snapshot("legacy");
  assert.deepEqual(detailPatch(before, removed).removeCardIds, ["work-overview"]);
  session.workId = null;
  const noWork = service.snapshot("legacy");
  assert.equal(noWork.cards[0].templateRevision, 2);
  session.workId = "work";
  const restored = service.snapshot("legacy");
  assert.equal(restored.cards[0].templateRevision, 3);
  work.name = "Renamed";
  assert.equal(service.snapshot("legacy").cards[0].templateRevision, 3);
});

test("module input comparison is bounded and retains trees when non-display facts change", () => {
  const scope = { session: { sessionKind: "worker" }, logicalSessionId: "logical:sample",
    task: { id: "task", description: "x".repeat(100000) } };
  const first = projectBusinessModules(scope, ["task"]);
  assert.equal(first.get("task").cards[0].data.description.length, 16000);
  scope.task.revision = 99; scope.task.description += "invisible suffix";
  const second = projectBusinessModules(scope, ["task"], first);
  assert.strictEqual(second.get("task"), first.get("task"));
});

test("scoped dependency hints only project affected modules; explicit refresh reads current facts", () => {
  const { service, task, work } = setup(), before = service.snapshot("legacy");
  task.description = "Updated"; work.name = "Not invalidated yet";
  service.invalidate({ resourceType: "task", taskId: "different-task" });
  assert.strictEqual(service.snapshot("legacy", { invalidatedOnly: true }), before);
  service.invalidate({ resourceType: "task", taskId: "task" });
  const delivered = service.snapshot("legacy", { invalidatedOnly: true });
  assert.equal(delivered.cards[1].data.description, "Updated");
  assert.strictEqual(delivered.cards[0], before.cards[0]);
  const refreshed = service.snapshot("legacy");
  assert.equal(refreshed.cards[0].data.workName, "Not invalidated yet");
});

test("module caches isolate server/account/principal/catalog and clear only the revoked scope", () => {
  const { service } = setup();
  const identity = { serverId: "server-a", accountId: "account-a", principalId: "user-a" };
  const first = service.snapshot("legacy", { identity });
  for (const field of ["serverId", "accountId", "principalId"]) {
    const other = service.snapshot("legacy", { identity: { ...identity, [field]: "other" } });
    assert.notStrictEqual(other, first);
    assert.notEqual(other.generation, first.generation);
  }
  const v2 = service.v2Snapshot("legacy", { identity });
  assert.notEqual(v2.generation, first.generation);
  assert.equal(service.cache.size, 5);
  service.clearCache({ principalId: "user-a" });
  assert.equal(service.cache.size, 1);
  assert.equal(service.v2Journals.size, 0);
  assert.notEqual(service.snapshot("legacy", { identity }).generation, first.generation);
  service.clearCache();
  assert.equal(service.cache.size, 0);
});

test("provider invalidation preserves unrelated cards; binding metadata rechecks facts", () => {
  const { service, task } = setup(), before = service.snapshot("legacy");
  task.description = "Updated during binding change";
  service.invalidate({ resourceType: "provider", sessionId: "logical:sample" });
  assert.equal(service.snapshot("legacy", { invalidatedOnly: true }).cards[1].data.description, "Description");
  service.invalidate({ resourceType: "sessionMetadata", sessionId: "logical:sample" });
  const next = service.snapshot("legacy", { invalidatedOnly: true });
  assert.equal(next.cards[1].data.description, task.description);
  assert.strictEqual(next.cards[0], before.cards[0]);
});

class Response extends EventEmitter {
  frames = []; destroyed = false; writableLength = 0; writableNeedDrain = false;
  writeHead() {} write(frame) { this.frames.push(frame); return true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}

test("revocation closes only matching Detail consumers and releases both protocol caches", async () => {
  const { service } = setup(), a = new Response(), b = new Response();
  const identity = { serverId: "server", deviceId: "a" };
  service.events.attach(a, () => identity, "legacy");
  service.events.attach(b, () => ({ ...identity, deviceId: "b" }), "legacy");
  try {
    await delay(10);
    service.v2Snapshot("legacy", { identity });
    service.clearCache({ serverId: "server", principalId: "device:a" });
    assert.equal(a.destroyed, true);
    assert.equal(b.destroyed, false);
    assert.equal(service.cache.size, 1);
    assert.equal(service.v2Journals.size, 0);
  } finally { a.destroy(); b.destroy(); }
});

test("late authentication failure clears cached facts, and a new consumer reads fresh data", async () => {
  const { service, task } = setup(), response = new Response();
  let authorized = true;
  const identity = { serverId: "server", accountId: "account", deviceId: "a" };
  service.events.coalesceMs = 1;
  service.events.attach(response, () => {
    if (!authorized) throw Object.assign(new Error("revoked"), { status: 403 });
    return identity;
  }, "legacy");
  await delay(10);
  authorized = false; service.invalidate();
  await delay(10);
  assert.equal(response.destroyed, true);
  assert.equal(service.cache.size, 0);
  task.description = "Fresh after reconnect";
  const next = new Response();
  try {
    service.events.attach(next, () => identity, "legacy");
    await delay(10);
    assert.match(next.frames[0], /Fresh after reconnect/);
  } finally { next.destroy(); }
});

test("gateway revocation and shutdown clear the paired cache but retain desktop cache", async () => {
  const { store } = setup();
  const authority = { state: { serverId: "server" }, listeners: new Set() };
  const gateway = new ClientDeviceGateway(authority, { sessionAPI: { inspector: { store } } });
  const service = detailServiceFor(store);
  service.snapshot("legacy");
  service.v2Snapshot("legacy", { identity: { serverId: "server", deviceId: "a" } });
  service.snapshot("legacy", { identity: { serverId: "server", deviceId: "b" } });
  gateway.onRevoke("a");
  assert.equal(service.cache.size, 2);
  assert.equal(service.v2Journals.size, 0);
  await gateway.close();
  assert.equal(service.cache.size, 1);
});
