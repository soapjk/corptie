import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientInspectorAPI } from "../src/application/clientInspectorAPI.mjs";
import { SessionContextReferenceService } from "../src/application/sessionContextReferenceService.mjs";
import { createDetailBusinessActionPorts } from "../src/application/detailBusinessActionPorts.mjs";
import { createDetailActionRegistry } from "../src/application/detailActionService.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "corptie-detail-business-action-"));
  const store = new CorptieStore({ dbPath: join(dir, "db.sqlite"), configPath: join(dir, "config.json") }); await store.initialize();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  store.createAgent({ id: "agent:test", name: "Test" });
  store.createWork({ id: "work:test", name: "Test", contributorAgentIds: ["agent:test"] });
  store.createSession({ id: "session", workId: "work:test", title: "Test" });
  const row = store.createMemory({ ownerType: "work", ownerId: "work:test", kind: "fact", content: "Before",
    sourceType: "user", trustLevel: "trusted", promotionStatus: "active" });
  const references = new SessionContextReferenceService({ store });
  const inspector = new ClientInspectorAPI({ store, references, resolveSession: sessionId => ({ sessionId, logicalSessionId: sessionId }) });
  const ports = createDetailBusinessActionPorts({ inspector }), registry = createDetailActionRegistry(ports);
  let revoked = false;
  const scope = { sessionId: "session", identity: { kind: "local_user", principalId: "owner" },
    revalidateSync: () => { if (revoked) throw Object.assign(new Error("revoked"), { code: "AUTH_REVOKED", status: 403 }); } };
  const prepare = async (operation, target, fields) => {
    const port = ports[operation], resource = await port.resource(scope, target);
    const expectedResourceRevision = port.revision(resource);
    const action = { id: "business-action", kind: "command", operation, available: true, target, expectedResourceRevision };
    return registry.prepare({ action, fields, expectedResourceRevision, scope });
  };
  return { store, row, scope, ports, prepare, references, revoke: () => { revoked = true; } };
}
test("memory update and delete use real product service, version and audit; delete is soft revoke", async t => {
  const f = await fixture(t), target = { resourceType: "memory", id: f.row.id };
  const fields = { content: "After", tags: ["verified"] }, prepared = await f.prepare("memory.update", target, fields);
  await prepared.port.execute(f.scope, target, fields, { resource: prepared.resource, fingerprint: "request" });
  assert.equal(f.store.getMemory(f.row.id).content, "After"); assert.equal(f.store.getMemory(f.row.id).version, 2);
  assert.equal(f.store.listMemoryAudit({ memoryId: f.row.id })[0].actorId, "user:local-macos");
  const removal = await f.prepare("memory.delete", target, { confirmed: true });
  await removal.port.execute(f.scope, target, { confirmed: true }, { resource: removal.resource, fingerprint: "delete" });
  assert.ok(f.store.getMemory(f.row.id).revoked_at); assert.equal(f.store.getMemory(f.row.id).version, 3);
});
test("resource change or final synchronous credential revoke prevents actual memory mutation", async t => {
  for (const mode of ["revision", "revoke", "retired"]) {
    const f = await fixture(t), target = { resourceType: "memory", id: f.row.id }, fields = { content: "Attempt" };
    const prepared = await f.prepare("memory.update", target, fields);
    if (mode === "revision") f.store.updateMemory(f.row.id, { content: "External", version: 2 });
    else if (mode === "revoke") f.revoke();
    else f.scope.readGuard = () => { throw Object.assign(new Error("retired"), { code: "DETAIL_READ_INVALIDATED" }); };
    assert.throws(() => prepared.port.execute(f.scope, target, fields, { resource: prepared.resource }),
      { code: mode === "revision" ? "DETAIL_REVISION_CONFLICT" : mode === "revoke" ? "AUTH_REVOKED" : "DETAIL_READ_INVALIDATED" });
    assert.notEqual(f.store.getMemory(f.row.id).content, "Attempt");
  }
});
test("reference removal is owner-bound, confirmation/revision checked and uses existing delete service", async t => {
  const f = await fixture(t);
  const row = await f.references.create("session", { targetType: "work", targetId: "work:test" });
  const target = { resourceType: "reference", id: row.referenceId }, fields = { confirmed: true };
  const prepared = await f.prepare("reference.remove", target, fields);
  assert.equal(f.references.list("session").length, 1);
  assert.deepEqual(await prepared.port.execute(f.scope, target, fields, { resource: prepared.resource }), { removed: true });
  assert.equal(f.references.list("session").length, 0);
  await assert.rejects(f.prepare("memory.delete", { resourceType: "memory", id: "foreign" }, fields));
});
test("schedule port passes actual expected resourceVersion and trusted local actor, never client boolean authority", async () => {
  let call;
  const row = { logicalSessionId: "session", resourceVersion: 7 };
  const inspector = { store: { getScheduledSessionTask: () => row }, scope: () => ({ sessionId: "session", logicalSessionId: "session", context: {} }) };
  const port = createDetailBusinessActionPorts({ inspector, schedules: { cancel: (...args) => { call = args; return row; } } })["schedule.cancel"];
  const scope = { sessionId: "session", identity: { kind: "local_user", principalId: "owner" } }, target = { resourceType: "schedule", id: "schedule" };
  assert.equal(port.authorize(scope, target, row), true);
  port.execute(scope, target, { confirmed: true }, { resource: row });
  assert.deepEqual(call, ["schedule", { type: "user", id: "user:local-macos" }, { expectedResourceVersion: 7 }]);
  assert.equal(port.authorize(scope, target, { ...row, logicalSessionId: "other" }), false);
});
test("reference add uses existing async normalization and rechecks owner revision/auth before actual insertion", async t => {
  for (const mode of ["success", "revoke", "changed", "retired"]) {
    const f = await fixture(t); let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    f.references.fetch = async () => { entered(); await gate; return { ok: true, headers: { get: () => "text/plain" }, text: async () => "Fixture" }; };
    const target = { resourceType: "session", id: "session" }, fields = { locator: "https://fixture.invalid/resource" };
    const prepared = await f.prepare("reference.add", target, fields);
    const pending = prepared.port.execute(f.scope, target, fields, { resource: prepared.resource }); await started;
    if (mode === "revoke") f.revoke();
    if (mode === "changed") await f.references.create("session", { targetType: "work", targetId: "work:test" });
    if (mode === "retired") f.scope.readGuard = () => { throw Object.assign(new Error("retired"), { code: "DETAIL_READ_INVALIDATED" }); };
    release();
    if (mode === "success") { await pending; assert.equal(f.references.list("session").length, 1); }
    else {
      await assert.rejects(pending, { code: mode === "revoke" ? "AUTH_REVOKED" : mode === "retired" ? "DETAIL_READ_INVALIDATED" : "DETAIL_REVISION_CONFLICT" });
      assert.equal(f.references.list("session").filter(row => row.targetType === "webURL").length, 0);
    }
  }
});
