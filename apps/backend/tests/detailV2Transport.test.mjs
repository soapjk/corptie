import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { parseDetailV2JSON, readDetailV2Request } from "../src/application/detailV2JSON.mjs";
import { validateDetailV2Envelope } from "../src/application/detailV2Contract.mjs";
import { DetailDocumentService, detailServiceFor, handleDesktopDetailSync, handleDesktopDetail } from "../src/application/detailDocumentService.mjs";
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
test("read-only refresh negotiates a full v2 snapshot without opening another stream", async () => {
  const { store } = setup(); const response = new Response();
  const request = { method: "GET", headers: { accept: "application/json; corptie-detail=native-v2" }, socket: { remoteAddress: "127.0.0.1" } };
  const handled = handleDesktopDetail({ request, response, url: new URL("http://localhost/sessions/legacy/detail"), store,
    sendJson: () => assert.fail("unexpected error") });
  await delay(1); const value = JSON.parse(response.body);
  assert.equal(handled, true); assert.equal(response.status, 200); validateDetailV2(value);
  assert.equal(value.protocolVersion, 2); assert.ok(Object.keys(value.templates).length);
});
test("desktop GET passes service scope parameters and unintegrated rich catalog stays closed", async () => {
  const { store } = setup(), service = detailServiceFor(store), original = service.v2Snapshot.bind(service);
  const options = [];
  service.v2Snapshot = (id, context) => { options.push(context); return original(id); };
  const response = new Response();
  const request = { method: "GET", headers: { accept: "application/json; corptie-detail=native-v2" }, socket: { remoteAddress: "127.0.0.1" } };
  handleDesktopDetail({ request, response, url: new URL("http://localhost/sessions/legacy/detail"), store, sendJson: () => assert.fail("unexpected error") });
  await delay(1);
  assert.deepEqual(options, [{ identity: { principalId: "local-user" }, catalog: "native-v2", clientCapabilities: [] }]);
  let status;
  handleDesktopDetail({ request: { ...request, headers: { accept: "application/json; corptie-detail=native-v2-components-1",
    "x-corptie-detail-capabilities": "detail.chart" } }, response: new Response(), url: new URL("http://localhost/sessions/legacy/detail"), store,
    sendJson: (_, code) => { status = code; } });
  assert.equal(status, 409); assert.equal(options.length, 1);
});
test("desktop and paired rich negotiation validates exact Accept and Request without enabling routes", async () => {
  const rich = "native-v2-components-1", token = "a".repeat(43);
  const cases = [
    ["GET", `application/json; corptie-detail=${rich}`, undefined, undefined, 400],
    ["GET", `application/json; corptie-detail=${rich}`, "detail.chart", undefined, 409],
    ["GET", `application/json; corptie-detail=${rich}`, "detail.Chart", undefined, 400],
    ["POST", "text/event-stream; corptie-detail=native-v2", undefined, { ...requestBody, catalog: rich, clientCapabilities: [] }, 409],
    ["POST", "text/event-stream; corptie-detail=native-v2", undefined, { ...requestBody, catalog: rich }, 400],
    ["POST", "text/event-stream; corptie-detail=native-v2", undefined, { ...requestBody, clientCapabilities: [] }, 400],
    ["POST", "text/event-stream; corptie-detail=native-v2", undefined, { ...requestBody, catalog: rich, clientCapabilities: ["detail.markdown", "detail.chart"] }, 400],
    ["POST", `text/event-stream; corptie-detail=${rich}`, undefined, { ...requestBody, catalog: rich, clientCapabilities: [] }, 409]
  ];
  for (const paired of [false, true]) {
    const { store } = setup();
    const gateway = new ClientDeviceGateway({ authenticate: () => ({ deviceId: "paired" }), checkAdmin: () => false },
      { sessionAPI: { inspector: { store, scope: () => ({ sessionId: "legacy" }) } } });
    for (const [method, accept, header, input, expected] of cases) {
      const req = Readable.from(input ? [Buffer.from(JSON.stringify(input))] : []);
      req.method = method; req.url = `${paired ? "/client/v1" : ""}/sessions/legacy/detail${method === "POST" ? "/sync" : ""}`;
      req.headers = { accept, authorization: `Bearer ${token}`, "content-type": "application/json" };
      if (header !== undefined) req.headers["x-corptie-detail-capabilities"] = header;
      req.socket = { remoteAddress: "127.0.0.1", encrypted: true };
      const response = new Response();
      if (paired) await gateway.handle(req, response);
      else (method === "POST" ? handleDesktopDetailSync : handleDesktopDetail)({ request: req, response,
        url: new URL(req.url, "http://localhost"), store, sendJson: (res, status) => res.writeHead(status) });
      await delay(1);
      assert.equal(response.status, expected, `${paired ? "paired" : "desktop"} ${method} ${accept} ${JSON.stringify(input)}`);
      assert.equal(response.frames.length, 0); response.destroy();
    }
  }
});
test("paired GET and five-argument sync reject authority or canonical Session changes before publication", async () => {
  for (const method of ["GET", "POST"]) for (const dimension of ["accountId", "deviceId", "session"]) {
    const { store } = setup(); let calls = 0;
    const first = { serverId: "server", accountId: "account", principalId: "user", deviceId: "paired" };
    const authority = { authenticate: () => {
      calls++;
      return calls > 1 && dimension !== "session" ? { ...first, [dimension]: "changed" } : { ...first };
    }, checkAdmin: () => false };
    const gateway = new ClientDeviceGateway(authority, { sessionAPI: { inspector: { store, scope: () => ({
      sessionId: calls > 1 && dimension === "session" ? "other" : "legacy"
    }) } } });
    const req = Readable.from(method === "POST" ? [Buffer.from(JSON.stringify(requestBody))] : []);
    req.method = method; req.url = `/client/v1/sessions/legacy/detail${method === "POST" ? "/sync" : ""}`;
    req.headers = { authorization: `Bearer ${"a".repeat(43)}`, "content-type": "application/json",
      accept: `${method === "POST" ? "text/event-stream" : "application/json"}; corptie-detail=native-v2` };
    req.socket = { remoteAddress: "127.0.0.1", encrypted: true };
    const response = new Response();
    await gateway.handle(req, response); await delay(1);
    assert.equal(response.status, 403, `${method} ${dimension}`);
    assert.equal(response.frames.length, 0); assert.equal(response.body.includes('"protocolVersion"'), false);
    response.destroy();
  }
});
test("loopback HTTP delivers bounded gzip snapshots and immediate uncompressed sync frames", async t => {
  const { store, session } = setup(); const service = detailServiceFor(store); session.summary = "摘要 中文 😀 ".repeat(1200);
  const work = { name: "Work" }; store.getWork = () => work;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const sendJson = (res, status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    if (handleDesktopDetailSync({ request, response, url, store, sendJson })) return;
    handleDesktopDetail({ request, response, url, store, sendJson });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const get = encoding => new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/sessions/legacy/detail", headers: {
      accept: "application/json; corptie-detail=native-v2", "accept-encoding": encoding } }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    }); request.on("error", reject);
  });
  try {
    const plain = await get("identity"), compressed = await get("gzip");
    assert.equal(compressed.headers["content-encoding"], "gzip");
    assert.deepEqual(JSON.parse(gunzipSync(compressed.body)), JSON.parse(plain.body));
    const snapshot = JSON.parse(plain.body); validateDetailV2(snapshot);
    work.name = "Updated Work"; service.invalidate();
    const next = service.v2Snapshot("legacy");
    const cursor = { documentId: snapshot.documentId, generation: snapshot.generation, revision: snapshot.revision, stateHash: snapshot.stateHash };
    const input = { ...requestBody, resume: cursor, cachedTemplateHashes: Object.keys(snapshot.templates) };
    await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/sessions/legacy/detail/sync", method: "POST",
        headers: { accept: "text/event-stream; corptie-detail=native-v2", "content-type": "application/json", "accept-encoding": "gzip" } }, response => {
        let text = "";
        response.on("data", chunk => {
          text += chunk;
          if (!text.includes("\n\n")) return;
          try {
            assert.equal(response.headers["content-encoding"], undefined);
            assert.equal(response.headers["x-accel-buffering"], "no");
            assert.match(response.headers["cache-control"], /no-transform/);
            assert.match(text, /event: detail-commit/);
            const commit = JSON.parse(text.split("\ndata: ")[1].split("\n\n")[0]);
            const applied = applyDetailV2(snapshot, commit); assert.equal(applied.stateHash, next.stateHash);
            t.diagnostic(`synthetic loopback bytes: snapshot=${plain.body.length}, gzip=${compressed.body.length}, resumed commit SSE=${Buffer.byteLength(text)}`);
            resolve();
          } catch (error) { reject(error); }
          finally { request.destroy(); }
        }); response.on("error", reject);
      });
      request.setTimeout(2000, () => request.destroy(new Error("first SSE frame was buffered")));
      request.on("error", reject); request.end(JSON.stringify(input));
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
