import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";
import { ClientInspectorAPI } from "../src/application/clientInspectorAPI.mjs";
import { ClientDeviceGateway } from "../src/application/clientDeviceGateway.mjs";
import { detailServiceFor } from "../src/application/detailDocumentService.mjs";
import { createDetailBusinessActionService } from "../src/application/detailBusinessActionComposition.mjs";
import { routeBackendHttpRequest } from "../src/application/backendHttpRouter.mjs";
import { validateDetailV2 } from "../src/application/detailSyncV2.mjs";
import { createDetailBusinessReadPorts } from "../src/application/detailBusinessReadPorts.mjs";
import { SessionContextReferenceService } from "../src/application/sessionContextReferenceService.mjs";
import { DETAIL_COMPONENTS_CATALOG, DETAIL_COMPONENT_CAPABILITIES } from "../src/application/detailV2Catalog.mjs";

async function fixture(t, { rich = false, writes = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "corptie-detail-business-composition-"));
  const store = new CorptieStore({ dbPath: join(dir, "db.sqlite"), configPath: join(dir, "config.json") }); await store.initialize();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  store.createAgent({ id: "agent:test", name: "Test" });
  store.createWork({ id: "work:test", name: "Test", contributorAgentIds: ["agent:test"] });
  store.createSession({ id: "session", workId: "work:test", title: "Test" });
  const references = new SessionContextReferenceService({ store });
  const schedules = { list: () => [] };
  const inspector = new ClientInspectorAPI({ store, references, schedules, resolveSession: sessionId => ({ sessionId, logicalSessionId: sessionId }) });
  const api = new ClientSessionAPI({ store, inspector }), documents = detailServiceFor(store, { richReadEnabled: rich, richWritesEnabled: writes });
  if (rich) documents.configureBusinessPorts(createDetailBusinessReadPorts({ store, references, schedules,
    artifacts: { list: () => [], listForTask: () => [] }, providerRegistry: { descriptors: () => [], supports: () => false },
    observability: { latestSummary: () => null }, readWorktree: async () => ({ attached: false }) }));
  const actions = createDetailBusinessActionService({ commandAPI: api, inspector, documentService: documents });
  documents.configureBusinessActionRegistry(actions.registry);
  const input = { schemaVersion: 1, documentId: "detail:session", cardId: "session-info", actionId: "refresh", requestId: "read-refresh-001", fields: {} };
  return { store, api, actions, input, documents };
}
const response = resolve => ({ headersSent: false, destroyed: false,
  writeHead(status) { this.status = status; this.headersSent = true; }, end(body) { resolve({ status: this.status, value: JSON.parse(body) }); } });
async function deliver(f, paired, input, mutate, { command = false, rich = false, writes = false } = {}) {
  const path = `${paired ? "/client/v1" : ""}/sessions/session/detail/${command ? "actions" : "read"}`;
  const req = Readable.from([Buffer.from(JSON.stringify(input))]); req.method = "POST"; req.url = path;
  req.headers = { host: "localhost", accept: `application/json; corptie-detail=${rich ? DETAIL_COMPONENTS_CATALOG : "native-v1"}`,
    "content-type": "application/json", authorization: `Bearer ${"a".repeat(43)}` };
  if (rich) req.headers["x-corptie-detail-capabilities"] = DETAIL_COMPONENT_CAPABILITIES.join(",");
  req.socket = { remoteAddress: "127.0.0.1", encrypted: true };
  let identity = { deviceId: "device", accountId: "account" };
  if (mutate === "receipt") {
    const forProfile = f.actions.forProfile;
    f.actions.forProfile = profile => {
      const service = forProfile(profile), prepareReceipt = service.prepareReceipt.bind(service);
      service.prepareReceipt = async (...args) => {
        const prepared = await prepareReceipt(...args);
        queueMicrotask(() => { if (paired) identity = { ...identity, accountId: "other" }; else req.headers.origin = "https://foreign.invalid"; });
        return prepared;
      };
      return service;
    };
  }
  const original = f.actions.prepareRead.bind(f.actions);
  if (mutate === true) f.actions.prepareRead = async (...args) => {
    const prepared = await original(...args);
    queueMicrotask(() => { if (paired) identity = { ...identity, accountId: "other" }; else req.headers.origin = "https://foreign.invalid"; });
    return prepared;
  };
  return new Promise(resolve => {
    const res = response(resolve);
    if (paired) {
      const gateway = new ClientDeviceGateway({ authenticate: () => identity, checkAdmin: () => false },
        { sessionAPI: f.api, detailActionService: f.actions, detailWritesAllowed: writes });
      void gateway.handle(req, res);
    } else routeBackendHttpRequest(req, res, { store: f.store, detailActionService: f.actions, detailWritesAllowed: writes,
      sendJson: (res, status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); },
      rejectDevelopmentPreviewWrite: () => false, handleFoundationModelUpdateHttpRequest: () => false, rejectUnavailableStoreRequest: () => false });
  });
}
test("desktop/paired product read handlers use shared strict action resolution and return only State", async t => {
  for (const paired of [false, true]) {
    const f = await fixture(t), result = await deliver(f, paired, f.input);
    assert.equal(result.status, 200); validateDetailV2(result.value);
    assert.doesNotMatch(JSON.stringify(result.value), /revalidate|identity|principalId|accountId|deviceId/);
  }
});
test("completed mutations retain durable outcome but final HTTP guard hides receipts after credential revocation", async t => {
  for (const paired of [false, true]) {
    const f = await fixture(t, { rich: true, writes: true });
    const memory = f.store.createMemory({ ownerType: "work", ownerId: "work:test", kind: "fact", content: "Before",
      sourceType: "user", trustLevel: "trusted", promotionStatus: "active" });
    const who = paired ? { deviceId: "device", accountId: "account" } : { kind: "local_user", principalId: "local-user" };
    const prepared = await f.documents.prepareRichSnapshot("session", { authenticate: () => who,
      catalog: DETAIL_COMPONENTS_CATALOG, clientCapabilities: [...DETAIL_COMPONENT_CAPABILITIES] });
    const cardId = prepared.state.manifest.order.find(id => id.startsWith("memory-editor-"));
    const request = { schemaVersion: 1, documentId: prepared.state.documentId, cardId, actionId: "save",
      requestId: "completed-then-revoked-001", expectedResourceRevision: prepared.state.instances[cardId].actions.save.expectedResourceRevision,
      fields: { content: "After" } };
    const delivered = await deliver(f, paired, request, "receipt", { command: true, rich: true, writes: true });
    assert.ok([401, 403].includes(delivered.status), JSON.stringify(delivered));
    assert.equal(delivered.value.status, undefined); assert.equal(delivered.value.result, undefined);
    assert.equal(f.store.getMemory(memory.id).content, "After"); assert.equal(f.store.getMemory(memory.id).version, 2);
    assert.equal(f.store.selectOne("SELECT status FROM client_command_receipts WHERE request_id=?", [request.requestId]).status, "completed");
  }
});
test("final HTTP synchronous guard rejects auth changes queued after prepared read returns", async t => {
  for (const paired of [false, true]) {
    const f = await fixture(t), result = await deliver(f, paired, f.input, true);
    assert.ok([401, 403].includes(result.status));
    assert.equal(result.value.instances, undefined); assert.equal(result.value.templates, undefined);
  }
});
test("strict fields reject resource/operation injection before read service", async t => {
  const f = await fixture(t);
  const result = await deliver(f, true, { ...f.input, fields: { locator: "/private/foreign" } });
  assert.equal(result.status, 400); assert.equal(result.value.code, "DETAIL_FIELDS_INVALID");
});
test("host-enabled real memory editor publishes exact revision; both command routes preserve tags, journal and idempotency", async t => {
  for (const paired of [false, true]) {
    const f = await fixture(t, { rich: true, writes: true });
    const memory = f.store.createMemory({ ownerType: "work", ownerId: "work:test", kind: "fact", content: "Before",
      tags: ["keep"], sourceType: "user", trustLevel: "trusted", promotionStatus: "active" });
    const who = paired ? { deviceId: "device", accountId: "account", principalId: "principal" } : { kind: "local_user", principalId: "local-user" };
    // Deliver uses the actual route identity; the projection below shares that scope.
    if (paired) { delete who.principalId; }
    const profile = { catalog: DETAIL_COMPONENTS_CATALOG, clientCapabilities: [...DETAIL_COMPONENT_CAPABILITIES] };
    const prepared = await f.documents.prepareRichSnapshot("session", { authenticate: () => who, ...profile });
    validateDetailV2(prepared.state, profile);
    const cardId = prepared.state.manifest.order.find(id => id.startsWith("memory-editor-")); assert.ok(cardId);
    const action = prepared.state.instances[cardId].actions.save;
    assert.equal(action.operation, "memory.update"); assert.ok(action.expectedResourceRevision);
    const request = { schemaVersion: 1, documentId: prepared.state.documentId, cardId, actionId: "save",
      requestId: "real-memory-update-001", expectedResourceRevision: action.expectedResourceRevision, fields: { content: "After" } };
    const first = await deliver(f, paired, request, false, { command: true, rich: true, writes: true });
    assert.equal(first.status, 200, JSON.stringify(first.value)); assert.equal(first.value.status, "completed");
    const updated = f.store.getMemory(memory.id); assert.equal(updated.content, "After"); assert.equal(updated.version, 2);
    assert.deepEqual(JSON.parse(updated.tags_json), ["keep"]);
    const repeat = await deliver(f, paired, request, false, { command: true, rich: true, writes: true });
    assert.deepEqual(repeat, first); assert.equal(f.store.getMemory(memory.id).version, 2);
    const closed = await deliver(f, paired, { ...request, requestId: "closed-memory-001" }, false, { command: true, rich: true });
    assert.equal(closed.status, 403); assert.equal(f.store.getMemory(memory.id).version, 2);
  }
});
