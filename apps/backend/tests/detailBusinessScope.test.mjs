import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { DetailDocumentService, detailDocumentCacheScope } from "../src/application/detailDocumentService.mjs";
import { DETAIL_COMPONENTS_CATALOG, DETAIL_COMPONENT_CAPABILITIES } from "../src/application/detailV2Catalog.mjs";
import { detailV2Hash } from "../src/application/detailSyncV2.mjs";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/detail-v2-components-sync.json", import.meta.url)));
const rich = { catalog: DETAIL_COMPONENTS_CATALOG, clientCapabilities: [...DETAIL_COMPONENT_CAPABILITIES] };
const identity = { principalId: "principal", accountId: "account", serverId: "server", deviceId: "device", accessToken: "secret" };
const setup = () => new DetailDocumentService({ getLogicalSession: () => null,
  getSession: id => ({ id, sessionKind: "assistantChat", summary: "Summary" }), getTask: () => null, getWork: () => null });
function publish(journal, sessionId = "session") {
  const state = structuredClone(fixture.snapshot);
  state.sessionId = sessionId; state.documentId = `detail:${sessionId}`; state.generation = journal.detailGeneration;
  journal.publish(state); return state;
}
class Response extends EventEmitter {
  frames = []; destroyed = false; writableLength = 0; writableNeedDrain = false;
  writeHead() { this.headersSent = true; }
  write(frame) { this.frames.push(frame); return true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}
const request = { protocolVersion: 2, catalog: "native-v2", cachedTemplateHashes: [], resume: null };
test("strict capability digest scopes every trusted authority dimension and retains no credentials", () => {
  const scope = detailDocumentCacheScope(identity, "session", rich);
  assert.equal(scope.capabilitiesHash, detailV2Hash(rich.clientCapabilities));
  assert.doesNotMatch(JSON.stringify(scope), /secret|accessToken/);
  for (const dimension of ["serverId", "accountId", "principalId", "deviceId"]) {
    assert.notDeepEqual(scope, detailDocumentCacheScope({ ...identity, [dimension]: "other" }, "session", rich));
  }
  assert.notDeepEqual(scope, detailDocumentCacheScope(identity, "other", rich));
  assert.notDeepEqual(scope, detailDocumentCacheScope(identity, "session", { ...rich, clientCapabilities: rich.clientCapabilities.slice(1) }));
  assert.throws(() => detailDocumentCacheScope(identity, "session", { ...rich, clientCapabilities: [...rich.clientCapabilities].reverse() }));
});
test("profile or capability changes cannot resume another scoped journal or publish another generation", () => {
  const service = setup(), full = service.v2Journal("session", { identity, ...rich }), state = publish(full);
  const cursor = { documentId: state.documentId, generation: state.generation, revision: state.revision, stateHash: state.stateHash };
  assert.equal(full.resume(cursor).kind, "ready");
  const reduced = service.v2Journal("session", { identity, ...rich, clientCapabilities: rich.clientCapabilities.slice(1) });
  assert.notEqual(reduced.detailGeneration, full.detailGeneration); assert.equal(reduced.entries.length, 0);
  assert.throws(() => reduced.publish(state), { code: "DETAIL_JOURNAL_SCOPE_MISMATCH" });
  const ownReducedState = { ...state, generation: reduced.detailGeneration };
  assert.throws(() => reduced.publish(ownReducedState)); assert.equal(reduced.entries.length, 0);
  const legacy = service.v2Snapshot("session", { identity, catalog: "native-v2" });
  assert.notEqual(legacy.generation, state.generation);
  assert.equal(service.v2Journal("session", { identity }).resume(cursor).kind, "snapshot");
  assert.throws(() => full.publish({ ...state, sessionId: "another" }), { code: "DETAIL_JOURNAL_SCOPE_MISMATCH" });
});
test("rich producer stays gated without poisoning native caches or journals", () => {
  const service = setup();
  for (const method of ["snapshot", "v2Snapshot"]) assert.throws(() => service[method]("session", { identity, ...rich }), { status: 409 });
  assert.equal(service.cache.size, 0); assert.equal(service.v2Journals.size, 0);
  assert.throws(() => service.snapshot("session", { catalog: "native-v2", catalogProfile: "native-v1" }), { code: "DETAIL_CATALOG_CONFLICT" });
  assert.throws(() => service.v2Snapshot("session", { clientCapabilities: rich.clientCapabilities }));
});
test("clear or revoke retires all profile journals for one principal without clearing another account", () => {
  const service = setup(), a = service.v2Journal("session", { identity, ...rich }); publish(a);
  service.v2Journal("session", { identity, ...rich, clientCapabilities: [] });
  service.v2Snapshot("session", { identity });
  const bIdentity = { ...identity, principalId: "other" }, b = service.v2Journal("session", { identity: bIdentity, ...rich }); publish(b);
  service.clearCache({ principalId: identity.principalId });
  assert.equal(a.entries.length, 0); assert.equal(a.bytes, 0);
  assert.throws(() => publish(a), { code: "DETAIL_JOURNAL_RETIRED" });
  assert.throws(() => a.resume(), { code: "DETAIL_JOURNAL_RETIRED" });
  assert.equal(service.cache.size, 0); assert.equal(service.v2Journals.size, 1);
  assert.strictEqual(service.v2Journal("session", { identity: bIdentity, ...rich }), b);
  const recreated = service.v2Journal("session", { identity, ...rich });
  assert.notEqual(recreated.detailGeneration, a.detailGeneration); assert.equal(recreated.entries.length, 0);
});
test("business port caches separate capabilities and clear only the selected capability profile", async () => {
  const service = setup(); let reads = 0;
  service.configureBusinessPorts({ sample: { dependencies: ["task"], read: () => ({ value: ++reads }) } });
  const full = { identity, ...rich, force: false }, reduced = { ...full, clientCapabilities: [] };
  assert.equal((await service.readBusinessModule("session", "sample", full)).data.value, 1);
  assert.equal((await service.readBusinessModule("session", "sample", reduced)).data.value, 2);
  assert.equal((await service.readBusinessModule("session", "sample", full)).data.value, 1);
  service.clearCache({ principalId: identity.principalId, catalogProfile: rich.catalog, capabilitiesHash: detailV2Hash([]) });
  assert.equal((await service.readBusinessModule("session", "sample", full)).data.value, 1);
  assert.equal((await service.readBusinessModule("session", "sample", reduced)).data.value, 3);
});
test("bounded journal eviction rejects late publication and reconnect starts a fresh generation", () => {
  const service = setup(), first = service.v2Snapshot("session", { identity }), journal = service.v2Journal("session", { identity });
  for (let i = 0; i < 64; i++) service.v2Snapshot(`session-${i}`, { identity });
  assert.equal(service.cache.size, 64); assert.equal(service.v2Journals.size, 64);
  assert.throws(() => journal.publish(first), { code: "DETAIL_JOURNAL_RETIRED" });
  const recreated = service.v2Snapshot("session", { identity });
  assert.notEqual(first.generation, recreated.generation);
  assert.equal(service.v2Journal("session", { identity }).resume({ documentId: first.documentId,
    generation: first.generation, revision: first.revision, stateHash: first.stateHash }).kind, "snapshot");
});
test("five-argument attach pins the very first authenticated authority before writing headers", () => {
  const service = setup(), response = new Response();
  const old = service.v2Snapshot("session", { identity });
  const other = { ...identity, accountId: "other" }, stable = service.v2Snapshot("session", { identity: other });
  let calls = 0;
  assert.throws(() => service.attachV2(response, () => ++calls === 1 ? identity : other, "session", null, request), { code: "DETAIL_IDENTITY_CHANGED" });
  assert.equal(response.headersSent, undefined); assert.equal(service.v2Events.clients.size, 0);
  assert.equal(service.cache.size, 1); assert.equal(service.v2Journals.size, 1);
  const unchanged = service.v2Snapshot("session", { identity: other });
  assert.equal(unchanged.generation, stable.generation);
  assert.equal(unchanged.revision, stable.revision);
  assert.equal(unchanged.stateHash, stable.stateHash);
  assert.notEqual(service.v2Snapshot("session", { identity }).generation, old.generation);
});
test("per-delivery reauthentication rejects changed account and a new stream cannot reuse old cursor", async () => {
  const service = setup(), response = new Response(); let current = identity;
  const old = service.v2Snapshot("session", { identity });
  service.attachV2(response, () => current, "session", null, request);
  await new Promise(resolve => setImmediate(resolve));
  const client = [...service.v2Events.clients][0]; assert.ok(client);
  current = { ...identity, accountId: "changed" };
  await service.v2Events.deliver(client);
  assert.equal(response.destroyed, true); assert.equal(service.cache.size, 0); assert.equal(service.v2Journals.size, 0);
  const next = new Response();
  service.attachV2(next, () => current, "session", null, { ...request, resume: { documentId: old.documentId,
    generation: old.generation, revision: old.revision, stateHash: old.stateHash } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(next.frames[0], /detail-snapshot/); assert.doesNotMatch(next.frames[0], /detail-ready/);
  next.destroy();
});
test("Promise or malformed authenticated identities are never silently treated as the legacy local user", () => {
  const service = setup();
  for (const value of [Promise.resolve(identity), null, [], { principalId: "" }, { serverId: 2 }]) {
    assert.throws(() => service.v2Snapshot("session", { identity: value }), { code: "DETAIL_IDENTITY_INVALID" });
  }
  const response = new Response();
  assert.throws(() => service.attachV2(response, async () => identity, "session", null, request), { code: "DETAIL_IDENTITY_INVALID" });
  assert.equal(response.headersSent, undefined); assert.equal(service.cache.size, 0);
  assert.doesNotThrow(() => service.snapshot("session"));
});

test("service injects the client's pinned canonical profile instead of the global stream snapshot", async () => {
  const service = setup(), response = new Response(), observed = [];
  const snapshot = service.v2Snapshot.bind(service);
  service.v2Events.snapshot = () => { throw new Error("global fallback must not be used"); };
  service.v2Snapshot = (id, options) => { observed.push(options); return snapshot(id, options); };
  const input = structuredClone(request);
  service.attachV2(response, () => identity, "session", null, input);
  input.catalog = DETAIL_COMPONENTS_CATALOG;
  input.clientCapabilities = [...DETAIL_COMPONENT_CAPABILITIES];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.length, 1);
  assert.equal(observed[0].catalog, "native-v2");
  assert.deepEqual(observed[0].clientCapabilities, []);
  assert.equal(observed[0].identity, identity);
  assert.match(response.frames[0], /detail-snapshot/);
  response.destroy();
});

test("service await-time revocation clears scoped journals and never advances a stream baseline", async () => {
  const service = setup(), response = new Response(); let current = identity, finish;
  const snapshot = service.v2Snapshot.bind(service);
  const ready = new Promise(resolve => { finish = resolve; });
  service.v2Snapshot = async (id, options) => { const state = snapshot(id, options); await ready; return state; };
  service.attachV2(response, () => current, "session", null, request);
  const client = [...service.v2Events.clients][0]; assert.ok(client);
  current = { ...identity, accountId: "changed" }; finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.destroyed, true);
  assert.equal(client.previous, undefined); assert.equal(client.hash, undefined);
  assert.equal(response.frames.length, 0); assert.equal(service.v2Journals.size, 0);
});
