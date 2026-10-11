import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { parseDetailV2JSON, readDetailV2Request } from "../src/application/detailV2JSON.mjs";
import { validateDetailV2Envelope } from "../src/application/detailV2Contract.mjs";
import { DetailDocumentService, handleDesktopDetailSync, handleDesktopDetail } from "../src/application/detailDocumentService.mjs";
import { validateDetailV2 } from "../src/application/detailSyncV2.mjs";
import { applyDetailV2 } from "../src/application/detailSyncV2.mjs";
import { rejectDevelopmentPreviewWrite } from "../src/application/backendHttpGuards.mjs";
import { ClientDeviceGateway } from "../src/application/clientDeviceGateway.mjs";
const requestBody = { protocolVersion: 2, catalog: "native-v2", resume: null, cachedTemplateHashes: [] };
class Response extends EventEmitter {
  frames = []; destroyed = false; writableLength = 0; writableNeedDrain = false;
  writeHead(status) { this.status = status; this.headersSent = true; }
  flushHeaders() {} write(frame) { this.frames.push(frame); return true; }
  end(value) { this.body = value; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}
function setup() {
  const session = { id: "legacy", sessionKind: "assistantChat", summary: "Summary", workId: "work" };
  const store = { getSession: id => id === "legacy" ? session : null, getLogicalSession: () => null,
    getLogicalSessionByLegacySessionId: () => null, getWork: () => ({ name: "Work" }) };
  const service = new DetailDocumentService(store); service.v2Events.coalesceMs = 1;
  return { session, store, service };
}
const frame = response => JSON.parse(response.frames.at(-1).split("\ndata: ")[1]);
test("raw decode refuses duplicates, aliases, invalid UTF8, surrogate and numeric hazards", () => {
  for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"é":1}', '{"":1}',
    '{"a":0.5}', '{"a":9007199254740992}', '{"a":"\\ud800"}', '[1,]', '\ufeff{}', '{"a":1} trailing']) {
    assert.throws(() => parseDetailV2JSON(Buffer.from(input)), input);
  }
  assert.throws(() => parseDetailV2JSON(Buffer.from([0xff])));
  assert.deepEqual(parseDetailV2JSON(Buffer.from('{"text":"中文😀","nested":{"value":null}}')), { text: "中文😀", nested: { value: null } });
});
test("request schema excludes authority/action injection and bounds raw bodies", async () => {
  assert.doesNotThrow(() => validateDetailV2Envelope(requestBody, "Request"));
  for (const extra of [{ endpoint: "bad" }, { fields: {} }, { catalog: "native-v1" }, { cachedTemplateHashes: ["bad"] }]) {
    assert.throws(() => validateDetailV2Envelope({ ...requestBody, ...extra }, "Request"));
  }
  const stream = Readable.from([Buffer.alloc(16385, 32)]); stream.headers = { "content-type": "application/json" };
  await assert.rejects(readDetailV2Request(stream), { status: 413 });
});
test("v2 authenticated stream emits snapshot, small field commit, and ready on resume", async () => {
  const { service, session } = setup(), response = new Response(), auth = () => ({ deviceId: "test" });
  try {
    service.attachV2(response, auth, "legacy", null, requestBody); await delay(10);
    assert.match(response.frames[0], /event: detail-snapshot/); const before = frame(response);
    session.summary = "Updated"; service.invalidate(); await delay(20);
    assert.match(response.frames[1], /event: detail-commit/); const commit = frame(response);
    assert.deepEqual(commit.templates, {}); assert.equal(commit.manifestChange, null);
    const next = applyDetailV2(before, commit); response.destroy();
    const resumed = new Response();
    try {
      service.attachV2(resumed, auth, "legacy", null, { ...requestBody, resume: {
        documentId: next.documentId, generation: next.generation, revision: next.revision, stateHash: next.stateHash } });
      await delay(10); assert.match(resumed.frames[0], /event: detail-ready/);
    } finally { resumed.destroy(); }
  } finally { response.destroy(); }
});
test("initial snapshot omits declared cached templates and authentication is rechecked", async () => {
  const { service } = setup(), snapshot = service.v2Snapshot("legacy"), response = new Response(); let allowed = true;
  try {
    service.attachV2(response, () => { if (!allowed) throw new Error("revoked"); return { deviceId: "test" }; }, "legacy", null,
      { ...requestBody, cachedTemplateHashes: Object.keys(snapshot.templates) });
    await delay(10); assert.deepEqual(frame(response).templates, {});
    allowed = false; service.invalidate(); await delay(20); assert.equal(response.destroyed, true);
  } finally { response.destroy(); }
});
test("desktop sync remains loopback user-only and preview exception is exactly read sync", async () => {
  const { store } = setup();
  const req = Readable.from([Buffer.from(JSON.stringify(requestBody))]);
  req.method = "POST"; req.headers = { accept: "text/event-stream; corptie-detail=native-v2", "content-type": "application/json", origin: "https://evil.invalid" };
  req.socket = { remoteAddress: "127.0.0.1" };
  let status; const response = new Response();
  assert.equal(handleDesktopDetailSync({ request: req, response, url: new URL("http://localhost/sessions/legacy/detail/sync"), store,
    sendJson: (_, code) => { status = code; } }), true);
  await delay(10); assert.equal(status, 403);
  for (const [path, method, blocked] of [["/sessions/legacy/detail/sync", "POST", false],
    ["/sessions/legacy/detail/actions", "POST", true], ["/sessions/legacy/detail/sync?x=1", "POST", true],
    ["/sessions/legacy/detail/sync", "DELETE", true]]) {
    assert.equal(rejectDevelopmentPreviewWrite({ request: { method }, response: {}, url: new URL(path, "http://localhost"),
      developmentPreview: true, sendJson: () => {} }), blocked);
  }
});
test("paired sync checks credential and Session scope before projecting data", async () => {
  const { store } = setup(); let scopeChecks = 0;
  const token = "a".repeat(43);
  const authority = { authenticate: value => {
    if (value !== token) throw Object.assign(new Error("unauthorized"), { code: "INVALID_CREDENTIAL", statusCode: 401 });
    return { deviceId: "paired" };
  }, checkAdmin: () => false };
  const gateway = new ClientDeviceGateway(authority, { sessionAPI: { inspector: { store, scope: (id, identity) => {
    assert.equal(identity.deviceId, "paired"); scopeChecks++;
    if (id !== "legacy") throw Object.assign(new Error("scope"), { code: "SESSION_NOT_FOUND", statusCode: 404 });
    return { sessionId: "legacy" };
  } } } });
  for (const [sessionID, credential, expected] of [["legacy", token, 200], ["legacy", "b".repeat(43), 401], ["other", token, 404]]) {
    const req = Readable.from([Buffer.from(JSON.stringify(requestBody))]); req.method = "POST";
    req.url = `/client/v1/sessions/${sessionID}/detail/sync`;
    req.headers = { authorization: `Bearer ${credential}`, accept: "text/event-stream; corptie-detail=native-v2", "content-type": "application/json" };
    req.socket = { remoteAddress: "127.0.0.1", encrypted: true };
    const response = new Response();
    try { await gateway.handle(req, response); await delay(10); assert.equal(response.status, expected); }
    finally { response.destroy(); }
  }
  assert.ok(scopeChecks >= 2);
});
test("read-only refresh negotiates a full v2 snapshot without opening another stream", () => {
  const { store } = setup(); let value, status;
  const request = { method: "GET", headers: { accept: "application/json; corptie-detail=native-v2" }, socket: { remoteAddress: "127.0.0.1" } };
  const handled = handleDesktopDetail({ request, response: {}, url: new URL("http://localhost/sessions/legacy/detail"), store,
    sendJson: (_, code, body) => { status = code; value = body; } });
  assert.equal(handled, true); assert.equal(status, 200); validateDetailV2(value);
  assert.equal(value.protocolVersion, 2); assert.ok(Object.keys(value.templates).length);
});
