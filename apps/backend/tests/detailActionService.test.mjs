import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";
import { DetailActionService, createDetailActionRegistry } from "../src/application/detailActionService.mjs";
import { DETAIL_ACTION_OPERATIONS } from "../src/application/detailActionRegistry.mjs";
import { handleDetailActionHttp } from "../src/application/detailActionHttpAdapter.mjs";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { validateDetailContract } from "../src/application/detailDocumentContract.mjs";
import { detailV2Hash, detailV2StateHash } from "../src/application/detailSyncV2.mjs";

const identity = { kind: "local_user", principalId: "authenticated-desktop-owner" };
async function fixture({ legacyJournal = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-detail-actions-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  if (legacyJournal) store.db.run(`CREATE TABLE client_command_receipts (
    device_id TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL,
    kind TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL,
    error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(device_id,request_id))`);
  const commandAPI = new ClientSessionAPI({ store });
  let version = "7", calls = 0, allowed = true, capable = true, failure = null;
  let action = { id: "cancel", kind: "command", operation: "schedule.cancel", available: true,
    target: { resourceType: "schedule", id: "schedule:ours" }, expectedResourceRevision: "7", confirmation: "none" };
  let document = { documentId: "detail:ours", sessionId: "logical:ours", cards: [{ id: "schedules", actions: [action] }] };
  const ports = { "schedule.cancel": {
    resource: async () => ({ version }), revision: resource => resource.version,
    authorize: async (scope, target) => allowed && target.id === "schedule:ours" && scope.sessionId === "logical:ours",
    capability: () => capable,
    validateFields: () => true,
    execute: async () => { calls++; if (failure) throw failure; version = "8"; return { cancelled: true }; }
  } };
  const registry = createDetailActionRegistry(ports);
  const service = new DetailActionService({ commandAPI, registry,
    authorizeScope: async (_, sessionId) => ({ sessionId }), documentFor: async () => document });
  const input = { schemaVersion: 1, documentId: "detail:ours", cardId: "schedules", actionId: "cancel",
    requestId: "detail-cancel-001", expectedResourceRevision: "7", fields: { confirmed: true } };
  return { store, service, registry, input, ports, commandAPI, action,
    calls: () => calls, setVersion: value => { version = value; }, setAllowed: value => { allowed = value; },
    setCapability: value => { capable = value; }, setFailure: value => { failure = value; }, setDocument: value => { document = value; },
    close: async () => { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const command = (f, input = f.input, session = "logical:ours", auth = async () => identity) => f.service.command(identity, session, input, auth);

test("strict rich action resolution uses only a host-scoped instance action, not client operation or target", async () => {
  const f = await fixture();
  try {
    const data = JSON.parse(await readFile(new URL("./fixtures/detail-v2-business-dates.json", import.meta.url), "utf8"));
    const state = data.snapshot, cardId = state.manifest.order[0];
    state.instances[cardId].actions = { cancel: { ...f.action, label: { fallback: "Cancel" } } };
    const { fields, collections, actions } = state.instances[cardId];
    state.instances[cardId].hash = detailV2Hash({ fields, collections, actions });
    state.stateHash = detailV2StateHash(state);
    f.service.authorizeScope = async () => ({ sessionId: state.sessionId, catalog: data.catalog, clientCapabilities: data.clientCapabilities });
    f.ports["schedule.cancel"].authorize = async scope => scope.sessionId === state.sessionId;
    f.setDocument(state);
    const request = { ...f.input, documentId: state.documentId, cardId };
    assert.equal((await command(f, request, state.sessionId)).status, "completed"); assert.equal(f.calls(), 1);
    await assert.rejects(command(f, { ...request, requestId: "unknown-card-001", cardId: "not-present" }, state.sessionId), { code: "DETAIL_ACTION_NOT_FOUND" });
    await assert.rejects(command(f, { ...request, requestId: "forged-target-001", target: { id: "foreign" } }, state.sessionId), { code: "DETAIL_CONTRACT_INVALID" });
  } finally { await f.close(); }
});
test("same device with changed account authority cannot dispatch", async () => {
  const f = await fixture();
  try {
    const owner = { deviceId: "device", accountId: "account" };
    await assert.rejects(f.service.command(owner, "logical:ours", f.input, () => ({ ...owner, accountId: "other" })), { code: "INVALID_CREDENTIAL" });
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("shared native action fixture matches closed operation schemas and target mappings", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../../packages/CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures/detail-actions-v1.json", import.meta.url), "utf8"));
  const registry = createDetailActionRegistry();
  assert.deepEqual(fixture.operations.map(item => item.action.operation).sort(), Object.keys(DETAIL_ACTION_OPERATIONS).sort());
  for (const { action, fields } of fixture.operations) {
    const definition = registry.operation(action.operation, action.kind);
    assert.ok(definition.targetTypes.includes(action.target.resourceType));
    assert.ok(registry.validateFields(action.operation, fields));
    assert.equal(registry.validateFields(action.operation, { ...fields, target: "injected" }), false);
    validateDetailContract({ schemaVersion: 1, requestId: "fixture-request-001", documentId: "doc", cardId: "card", actionId: action.id, fields,
      ...(action.expectedResourceRevision ? { expectedResourceRevision: action.expectedResourceRevision } : {}) }, "ActionRequest");
  }
  assert.equal(registry.validateFields("detail.collection.page", { collectionName: "artifacts", cursor: "x".repeat(513) }), false);
  assert.equal(fixture.policies.read["detail.collection.page"].cursorMaxLength, DETAIL_ACTION_OPERATIONS["detail.collection.page"].fields.properties.cursor.maxLength);
  assert.deepEqual(fixture.policies.command["reference.add"].requiredFields, DETAIL_ACTION_OPERATIONS["reference.add"].fields.required);
  assert.equal(registry.validateFields("reference.add", {}), false);
  assert.equal(registry.validateFields("reference.add", { displayName: "empty reference" }), false);
  assert.equal(registry.validateFields("reference.add", { locator: "" }), false);
  assert.equal(registry.validateFields("memory.update", { content: "ok", confirmed: true }), false);
});

test("existing journal nullable-column migration is repeatable and legacy receipt remains compatible", async () => {
  const f = await fixture({ legacyJournal: true });
  try {
    const columns = f.store.selectAll("PRAGMA table_info(client_command_receipts)").map(column => column.name);
    assert.ok(columns.includes("result_json")); assert.ok(columns.includes("detail_request_hash"));
    f.store.db.run(`INSERT INTO client_command_receipts(device_id,request_id,session_id,kind,payload_hash,status,created_at,updated_at)
      VALUES('legacy-device','legacy-request-001','','task_update','legacy-hash','completed','now','now')`);
    const restarted = new ClientSessionAPI({ store: f.store });
    assert.equal(f.store.selectAll("PRAGMA table_info(client_command_receipts)").length, columns.length);
    assert.equal(restarted.receipt({ deviceId: "legacy-device" }, "legacy-request-001").status, "completed");
    assert.equal(f.store.selectOne("SELECT detail_request_hash FROM client_command_receipts WHERE request_id='legacy-request-001'").detail_request_hash, null);
    await assert.rejects(f.service.receipt({ deviceId: "legacy-device" }, "logical:ours", "legacy-request-001", async () => ({ deviceId: "legacy-device" })), { code: "COMMAND_NOT_FOUND" });
  } finally { await f.close(); }
});

test("trusted catalog scope reaches action view and client cannot submit fingerprint/operation", async () => {
  const f = await fixture();
  try {
    let seen;
    f.service.authorizeScope = async (current, sessionId, hint) => ({ sessionId, catalog: "native-v2-components-1", capabilityDigest: "trusted-capabilities", documentHint: hint.documentId });
    f.service.documentFor = async scope => { seen = scope; return { documentId: "detail:ours", sessionId: scope.sessionId, cards: [{ id: "schedules", actions: [f.action] }] }; };
    await assert.rejects(command(f, { ...f.input, requestHash: "forged", operation: "memory.delete" }), { code: "DETAIL_CONTRACT_INVALID" });
    assert.equal((await command(f)).status, "completed");
    assert.equal(seen.identity, identity);
    assert.equal(seen.catalog, "native-v2-components-1");
    assert.equal(seen.capabilityDigest, "trusted-capabilities");
    assert.equal(seen.documentHint, "detail:ours");
  } finally { await f.close(); }
});

test("existing service field/locator constraints reject before journal and execute", async () => {
  const f = await fixture();
  try {
    f.ports["schedule.cancel"].validateFields = () => false;
    await assert.rejects(command(f), { code: "DETAIL_FIELDS_INVALID" });
    assert.equal(f.calls(), 0);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM client_command_receipts").count, 0);
  } finally { await f.close(); }
});

test("Detail writes reuse durable receipt journal, canonical identity and deleted-action recovery", async () => {
  const f = await fixture();
  try {
    const first = await command(f);
    assert.equal(first.status, "completed");
    assert.equal(first.sessionId, "logical:ours");
    assert.equal(first.kind, "inspector:detail:schedule.cancel");
    assert.deepEqual(first.inspectorResult, { cancelled: true });
    f.setDocument({ documentId: "new", sessionId: "logical:ours", cards: [] });
    const reordered = Object.fromEntries(Object.entries(f.input).reverse());
    assert.deepEqual(await command(f, reordered), first);
    assert.equal(f.calls(), 1);
    assert.deepEqual(await f.service.receipt(identity, "logical:ours", f.input.requestId, async () => identity), first);
    await assert.rejects(command(f, { ...f.input, expectedResourceRevision: "8" }), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(command(f, f.input, "logical:other"), { code: "COMMAND_NOT_FOUND" });
    await assert.rejects(command(f, f.input, "logical:ours", async () => { throw Object.assign(new Error(), { code: "INVALID_CREDENTIAL" }); }), { code: "INVALID_CREDENTIAL" });
    await assert.rejects(f.service.receipt({ deviceId: "different" }, "logical:ours", f.input.requestId, async () => ({ deviceId: "different" })), { code: "COMMAND_NOT_FOUND" });
  } finally { await f.close(); }
});

test("scope/revision/capability/closed fields/confirmation reject before journal insertion", async () => {
  const f = await fixture();
  try {
    for (const fields of [{}, { confirmed: false }, { confirmed: "true" }, { confirmed: true, target: "other" }, { confirmed: true, operation: "other" }]) {
      await assert.rejects(command(f, { ...f.input, fields }));
    }
    f.setVersion("8"); await assert.rejects(command(f), { code: "DETAIL_REVISION_CONFLICT" }); f.setVersion("7");
    f.setAllowed(false); await assert.rejects(command(f), { code: "DETAIL_RESOURCE_FORBIDDEN" }); f.setAllowed(true);
    f.setCapability(false); await assert.rejects(command(f), { code: "CAPABILITY_UNSUPPORTED" }); f.setCapability(true);
    f.action.target.id = "schedule:other"; await assert.rejects(command(f), { code: "DETAIL_RESOURCE_FORBIDDEN" });
    assert.equal(f.calls(), 0);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM client_command_receipts").count, 0);
    delete f.ports["schedule.cancel"];
    await assert.rejects(command(f), { code: "CAPABILITY_UNSUPPORTED" });
  } finally { await f.close(); }
});

test("exception after dispatch is unknown even for 4xx, and never dispatches twice", async () => {
  const f = await fixture();
  try {
    f.setFailure(Object.assign(new Error("partial operation failed"), { code: "RESOURCE_CHANGED", status: 409 }));
    const receipt = await command(f);
    assert.equal(receipt.status, "unknown");
    assert.equal((await command(f)).status, "unknown");
    assert.equal(f.calls(), 1);
    const api = new ClientSessionAPI({ store: f.store });
    assert.equal(api.receipt(identity, f.input.requestId).status, "unknown");
  } finally { await f.close(); }
});

test("second authorization and action revision are checked before execute", async () => {
  const f = await fixture();
  try {
    let validations = 0;
    const auth = async () => { if (++validations === 3) f.setVersion("8"); return identity; };
    const receipt = await command(f, f.input, "logical:ours", auth);
    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.errorCode, "DETAIL_REVISION_CONFLICT");
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("read/navigation/command kinds and tokens cannot cross the write boundary", async () => {
  const f = await fixture();
  try {
    f.setDocument({ documentId: "detail:ours", sessionId: "logical:ours", cards: [{ id: "schedules", actions: [
      { id: "cancel", kind: "read", operation: "detail.refresh", available: true }
    ] }] });
    const input = { ...f.input, fields: {} }; delete input.expectedResourceRevision;
    assert.equal((await f.service.read(identity, "logical:ours", input, async () => identity)).documentId, "detail:ours");
    await assert.rejects(command(f, input), { code: "DETAIL_ACTION_NOT_FOUND" });
    assert.throws(() => f.registry.operation("resource.open", "command"), { code: "DETAIL_OPERATION_UNSUPPORTED" });
    assert.throws(() => f.registry.operation("arbitrary.script", "read"), { code: "DETAIL_OPERATION_UNSUPPORTED" });
    assert.equal(Object.keys(DETAIL_ACTION_OPERATIONS).length, 9);
  } finally { await f.close(); }
});

test("collection read requires registered query validation and revision-bound cursor", async () => {
  const f = await fixture();
  try {
    f.setDocument({ documentId: "detail:ours", sessionId: "logical:ours", cards: [{ id: "schedules", actions: [
      { id: "cancel", kind: "read", operation: "detail.collection.page", available: true, target: { resourceType: "session", id: "logical:ours" } }
    ] }] });
    let reads = 0;
    f.ports["detail.collection.page"] = { authorize: () => true,
      validateQuery: (scope, target, fields) => scope.sessionId === target.id && fields.collectionName === "artifacts" && fields.cursor === "scope-revision:7",
      read: () => { reads++; return { items: [] }; } };
    const input = { ...f.input, fields: { collectionName: "artifacts", cursor: "scope-revision:7" } };
    await f.service.read(identity, "logical:ours", input, async () => identity);
    await assert.rejects(f.service.read(identity, "logical:ours", { ...input, fields: { collectionName: "artifacts", cursor: "other-scope:7" } }, async () => identity), { code: "DETAIL_CURSOR_INVALID" });
    await assert.rejects(f.service.read(identity, "logical:ours", { ...input, fields: { collectionName: "credentials", cursor: "scope-revision:7" } }, async () => identity), { code: "DETAIL_CURSOR_INVALID" });
    assert.equal(reads, 1);
  } finally { await f.close(); }
});

test("HTTP adapter enforces raw JSON, Accept, write guard and route method", async () => {
  async function request(path, raw, options = {}) {
    const stream = Readable.from([Buffer.from(raw)]);
    Object.assign(stream, { method: options.method ?? "POST", headers: { "content-type": "application/json", accept: "application/json; corptie-detail=native-v1", ...options.headers } });
    const result = new Promise(resolve => {
      assert.equal(handleDetailActionHttp({ request: stream, response: {}, url: new URL(path, "http://localhost"),
        service: { command: async () => ({ status: "completed" }) }, authenticate: async () => identity,
        writesAllowed: options.writesAllowed ?? true, sendJson: (_, status, value) => resolve({ status, value }) }), true);
    });
    return result;
  }
  assert.equal((await request("/sessions/s/detail/actions", '{"x":1,"x":2}')).status, 400);
  assert.equal((await request("/sessions/s/detail/actions", "{}", { writesAllowed: false })).status, 403);
  assert.equal((await request("/sessions/s/detail/actions", "{}", { method: "GET" })).status, 405);
  assert.equal((await request("/sessions/s/detail/actions", "{}", { headers: { accept: "application/json" } })).status, 409);
  assert.equal((await request("/sessions/s/detail/actions", "{}", { headers: { "content-encoding": "gzip" } })).status, 415);
  assert.equal((await request("/sessions/s/detail/actions", " ".repeat(65537))).status, 413);
});
