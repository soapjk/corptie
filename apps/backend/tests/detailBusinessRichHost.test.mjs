import test from "node:test";
import assert from "node:assert/strict";
import { DetailDocumentService } from "../src/application/detailDocumentService.mjs";
import { DETAIL_COMPONENTS_CATALOG, DETAIL_COMPONENT_CAPABILITIES } from "../src/application/detailV2Catalog.mjs";
import { validateDetailV2, detailV2Hash } from "../src/application/detailSyncV2.mjs";
import { DETAIL_RICH_BUSINESS_MODULES } from "../src/application/detailBusinessRichProjection.mjs";
const names = DETAIL_RICH_BUSINESS_MODULES;
const identity = { principalId: "principal", accountId: "account", serverId: "server", deviceId: "device" };
const profile = { catalog: DETAIL_COMPONENTS_CATALOG, clientCapabilities: [...DETAIL_COMPONENT_CAPABILITIES] };
const options = { authenticate: () => identity, ...profile };
const setup = () => {
  const task = { id: "task", title: "Task", description: "Definition", work_id: "work" };
  const service = new DetailDocumentService({ getLogicalSession: () => null,
    getSession: id => ({ id, sessionKind: "worker", taskId: "task" }), getTask: () => task, getWork: () => null });
  return { service, task };
};
const ports = read => Object.fromEntries(names.map(name => [name, { dependencies: ["task"], read: (...args) => read(name, ...args) }]));
const empty = () => ({ items: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("internal rich host binds strict profile baseline and preserves unchanged instances; HTTP remains gated", async () => {
  const { service } = setup(); let reads = 0;
  service.configureBusinessPorts(ports(() => { reads++; return empty(); }));
  const first = await service.richBusinessSnapshot("session", options);
  validateDetailV2(first, profile);
  assert.equal(first.manifest.order.length, 10);
  assert.equal(reads, 9);
  assert.strictEqual(await service.richBusinessSnapshot("session", { ...options, invalidatedOnly: true }), first);
  assert.equal(reads, 9);
  assert.strictEqual(await service.richBusinessSnapshot("session", options), first);
  assert.equal(reads, 18); // explicit refresh checks current facts despite unchanged result
  service.markDirty({ resourceType: "task", sessionId: "session" });
  await service.richBusinessSnapshot("session", { ...options, invalidatedOnly: true });
  assert.equal(reads, 27);
  assert.throws(() => service.v2Snapshot("session", { identity, ...profile }), { status: 409 });
  assert.equal(service.v2Events.clients.size, 0);
  assert.equal(service.v2Journal("session", { identity, ...profile }).detailGeneration, first.generation);
});

test("missing modules, partial module selection, missing capabilities and malformed authority reject before reads", async () => {
  const { service } = setup(); let reads = 0;
  service.configureBusinessPorts(ports(() => { reads++; return empty(); }));
  for (const config of [{ ...options, modules: ["references"] }, { ...options, modules: [...names, "schedules"] },
    { ...options, clientCapabilities: [] }, { ...options, clientCapabilities: [...profile.clientCapabilities].reverse() },
    { ...options, catalog: "native-v2" }, { ...options, authenticate: async () => identity }, { ...options, authenticate: () => ({}) }]) {
    await assert.rejects(service.richBusinessSnapshot("session", config));
  }
  service.configureBusinessPorts({ references: ports(empty).references });
  await assert.rejects(service.richBusinessSnapshot("session", options), { code: "DETAIL_BUSINESS_RICH_MODULE_UNAVAILABLE" });
  assert.equal(reads, 0); assert.equal(service.v2Journals.size, 0);
});

test("complete nine-module host rejects each missing port and new required/unknown capabilities", async () => {
  for (const name of names) {
    const { service } = setup(), available = ports(empty); delete available[name];
    service.configureBusinessPorts(available);
    await assert.rejects(service.richBusinessSnapshot("session", options), { code: "DETAIL_BUSINESS_RICH_MODULE_UNAVAILABLE" });
    assert.equal(service.v2Journals.size, 0);
  }
  const { service } = setup(); service.configureBusinessPorts(ports(empty));
  for (const capability of ["detail.dateTime", "detail.keyValue"]) await assert.rejects(service.richBusinessSnapshot("session",
    { ...options, clientCapabilities: profile.clientCapabilities.filter(c => c !== capability) }), { code: "DETAIL_CAPABILITY_UNAVAILABLE" });
  await assert.rejects(service.richBusinessSnapshot("session", { ...options, clientCapabilities: [...profile.clientCapabilities, "detail.unknown"] }));
  assert.equal(service.v2Journals.size, 0);
});

test("concurrent same-scope refreshes single-flight; read concurrency remains two", async () => {
  const { service } = setup(), gate = deferred(); let active = 0, peak = 0, reads = 0;
  service.configureBusinessPorts(ports(async () => { reads++; active++; peak = Math.max(peak, active); await gate.promise; active--; return empty(); }));
  const a = service.richBusinessSnapshot("session", options), b = service.richBusinessSnapshot("session", options);
  await tick(); assert.equal(reads, 2); assert.equal(service.richHostPending.size, 1);
  await assert.rejects(service.richBusinessSnapshot("session", { ...options, invalidatedOnly: true }), { code: "DETAIL_READ_BUSY" });
  gate.resolve(); const [first, second] = await Promise.all([a, b]);
  assert.strictEqual(first, second); assert.equal(reads, 9); assert.equal(peak, 2); assert.equal(service.richHostPending.size, 0);
});

test("revoke/clear during await retires late result without publishing and isolates another principal", async () => {
  const { service } = setup(), gate = deferred();
  service.configureBusinessPorts(ports(async () => { await gate.promise; return empty(); }));
  const a = service.richBusinessSnapshot("session", options);
  const other = { ...identity, principalId: "other" };
  const b = service.richBusinessSnapshot("session", { ...options, authenticate: () => other });
  const rejected = assert.rejects(a, { code: "DETAIL_READ_INVALIDATED" });
  await tick(); service.clearCache({ principalId: identity.principalId }); gate.resolve();
  await rejected; const state = await b;
  assert.equal(service.v2Journals.size, 1); assert.equal(state.sessionId, "session");
  assert.equal(service.v2Journal("session", { identity: other, ...profile }).entries.length, 1);
});

test("authority change or revoked authenticate after await cannot publish", async () => {
  for (const revoked of [false, true]) {
    const { service } = setup(), gate = deferred(); let current = identity;
    service.configureBusinessPorts(ports(async () => { await gate.promise; return empty(); }));
    const pending = service.richBusinessSnapshot("session", { ...options, authenticate: () => {
      if (!current) throw Object.assign(new Error("revoked"), { status: 403 }); return current;
    } });
    const rejected = assert.rejects(pending);
    await tick(); current = revoked ? null : { ...identity, accountId: "changed" }; gate.resolve(); await rejected;
    assert.equal(service.v2Journals.size, 0);
  }
});

test("ports replacement and changed Task binding invalidate late snapshots; replacement gets new generation", async () => {
  const { service, task } = setup(), gate = deferred();
  service.configureBusinessPorts(ports(async () => { await gate.promise; return empty(); }));
  const oldJournal = service.v2Journal("session", { identity, ...profile });
  const pending = service.richBusinessSnapshot("session", options), rejected = assert.rejects(pending, { code: "DETAIL_READ_INVALIDATED" });
  await tick(); service.configureBusinessPorts(ports(empty)); gate.resolve(); await rejected;
  const next = await service.richBusinessSnapshot("session", options);
  assert.notEqual(next.generation, oldJournal.detailGeneration);
  const secondGate = deferred(); service.configureBusinessPorts(ports(async () => { await secondGate.promise; return empty(); }));
  const second = service.richBusinessSnapshot("session", options), secondRejected = assert.rejects(second, { code: "DETAIL_READ_INVALIDATED" });
  await tick(); task.description = "Changed while awaiting"; secondGate.resolve(); await secondRejected;
});

test("catalog/capability and account scopes never reuse a foreign previous state or generation", async () => {
  const { service } = setup(); service.configureBusinessPorts(ports(empty));
  const a = await service.richBusinessSnapshot("session", options);
  const reduced = { ...options, clientCapabilities: profile.clientCapabilities.filter(x => x !== "detail.chart") };
  const b = await service.richBusinessSnapshot("session", reduced);
  const c = await service.richBusinessSnapshot("session", { ...options, authenticate: () => ({ ...identity, accountId: "other" }) });
  const legacy = service.v2Snapshot("session", { identity });
  assert.equal(new Set([a.generation, b.generation, c.generation, legacy.generation]).size, 4);
  assert.equal(service.v2Journal("session", { identity, catalog: reduced.catalog, clientCapabilities: reduced.clientCapabilities }).detailCacheScope.capabilitiesHash,
    detailV2Hash(reduced.clientCapabilities));
});

test("host admission bounds pending scopes to eight without unbounded module queue", async () => {
  const { service } = setup(), gate = deferred(); service.configureBusinessPorts(ports(async () => { await gate.promise; return empty(); }));
  const pending = Array.from({ length: 8 }, (_, i) => service.richBusinessSnapshot(`session-${i}`, options));
  await tick(); assert.equal(service.richHostPending.size, 8); assert.equal(service.businessReader.active, 2);
  assert.ok(service.businessReader.queue.length <= 32);
  await assert.rejects(service.richBusinessSnapshot("overflow", options), { code: "DETAIL_READ_BUSY", status: 429 });
  gate.resolve(); const states = await Promise.all(pending); assert.equal(service.richHostPending.size, 0);
  for (const state of states) for (const instance of Object.values(state.instances)) assert.notEqual(instance.fields.state, "读取失败");
});
