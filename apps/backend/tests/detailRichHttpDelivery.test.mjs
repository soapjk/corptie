import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { gunzipSync } from "node:zlib";
import { detailServiceFor, handleDesktopDetail, handleDesktopDetailSync } from "../src/application/detailDocumentService.mjs";
import { ClientDeviceGateway } from "../src/application/clientDeviceGateway.mjs";
import { createDetailBusinessReadPorts } from "../src/application/detailBusinessReadPorts.mjs";
import { DETAIL_COMPONENTS_CATALOG, DETAIL_COMPONENT_CAPABILITIES } from "../src/application/detailV2Catalog.mjs";
import { validateDetailV2, canonicalDetailV2 } from "../src/application/detailSyncV2.mjs";
import { routeBackendHttpRequest } from "../src/application/backendHttpRouter.mjs";
import { createDetailBusinessActionService } from "../src/application/detailBusinessActionComposition.mjs";

const profile = { catalog: DETAIL_COMPONENTS_CATALOG, clientCapabilities: [...DETAIL_COMPONENT_CAPABILITIES] };
const input = { protocolVersion: 2, ...profile, cachedTemplateHashes: [], resume: null };
const token = "a".repeat(43);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const reply = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
};
function setup(enabled = true, referenceRead = () => []) {
  const session = { id: "session", taskId: "task", sessionKind: "worker", summary: "Summary" };
  const task = { id: "task", title: "Task", description: "Definition" };
  const store = { getLogicalSession: () => null, getSession: id => id === session.id ? session : null,
    getTask: () => task, getWork: () => null };
  const service = detailServiceFor(store, { richReadEnabled: enabled }); service.v2Events.coalesceMs = 1;
  const makePorts = () => createDetailBusinessReadPorts({ store: { listMemoryRecallAudit: () => [] },
    references: { list: referenceRead }, artifacts: {}, schedules: { list: () => [] },
    providerRegistry: { descriptors: () => [], supports: () => false },
    observability: { latestSummary: () => null }, readWorktree: async () => ({ attached: false }) });
  service.configureBusinessPorts(makePorts());
  let identity = { deviceId: "device", accountId: "account", principalId: "principal" };
  const gateway = new ClientDeviceGateway({ authenticate: () => identity, checkAdmin: () => false },
    { sessionAPI: { inspector: { store, scope: id => {
      if (id !== session.id) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return { sessionId: session.id };
    } } } });
  return { store, service, task, makePorts, gateway, changeIdentity: () => { identity = { ...identity, accountId: "changed" }; } };
}
async function listen(t, host, paired) {
  const actions = createDetailBusinessActionService({ commandAPI: { store: host.store },
    inspector: host.gateway.sessionAPI.inspector, documentService: host.service });
  const server = createServer((request, response) => {
    if (paired) { void host.gateway.handle(request, response); return; }
    const context = { request, response, url: new URL(request.url, "http://localhost"), store: host.store, sendJson: reply };
    if (!handleDesktopDetailSync(context) && !handleDesktopDetail(context)) routeBackendHttpRequest(request, response, {
      store: host.store, detailActionService: actions, sendJson: reply,
      rejectDevelopmentPreviewWrite: () => false, handleFoundationModelUpdateHttpRequest: () => false, rejectUnavailableStoreRequest: () => false
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return ({ method = "GET", encoding = "identity", body, capabilities = profile.clientCapabilities, firstFrame = false, advertisement = false, actionRead = false } = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: server.address().port, agent: false, method,
        path: `${paired ? "/client/v1" : ""}/sessions/session/detail${advertisement ? "/capabilities" : actionRead ? "/read" : method === "POST" ? "/sync" : ""}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "accept-encoding": encoding,
          accept: advertisement ? "application/json" : actionRead ? `application/json; corptie-detail=${profile.catalog}`
            : method === "POST" ? "text/event-stream; corptie-detail=native-v2" : `application/json; corptie-detail=${profile.catalog}`,
          "x-corptie-detail-capabilities": capabilities.join(",") } }, response => {
        const chunks = []; let settled = false;
        const finish = () => { if (settled) return; settled = true;
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }); };
        response.on("data", chunk => { chunks.push(chunk);
          if (firstFrame && Buffer.concat(chunks).toString().includes("\n\n")) { finish(); req.destroy(); } });
        response.on("end", finish); response.on("error", error => { if (!settled) reject(error); });
      });
      req.setTimeout(5000, () => req.destroy(new Error("delivery timeout"))); req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
}
test("actual desktop/paired handlers retain default closed gate even with all ports and capabilities", async t => {
  for (const paired of [false, true]) {
    const host = setup(false), send = await listen(t, host, paired);
    assert.equal((await send()).status, 409);
    assert.equal((await send({ method: "POST", body: input })).status, 409);
    assert.equal(host.service.v2Events.clients.size, 0);
    assert.deepEqual(JSON.parse((await send({ advertisement: true })).body), {
      schemaVersion: 1, catalogs: ["native-v2"], requiredCapabilities: [], pagination: false, writes: false
    });
  }
});
test("host-enabled desktop/paired GET sends strict rich state, identity/gzip agree, no host authority leaks", async t => {
  for (const paired of [false, true]) {
    const host = setup(), send = await listen(t, host, paired);
    const raw = await send(), zipped = await send({ encoding: "gzip, identity;q=0" });
    assert.equal(raw.status, 200); assert.equal(zipped.status, 200); assert.equal(zipped.headers["content-encoding"], "gzip");
    const state = JSON.parse(raw.body), compressed = JSON.parse(gunzipSync(zipped.body));
    validateDetailV2(state, profile); validateDetailV2(compressed, profile);
    assert.equal(canonicalDetailV2(state), canonicalDetailV2(compressed));
    assert.doesNotMatch(raw.body.toString(), /revalidate|principalId|accountId|deviceId|capabilitiesHash/);
    assert.equal(raw.headers["cache-control"], "no-store");
    assert.equal(raw.headers.vary, "Accept, X-Corptie-Detail-Capabilities, Accept-Encoding");
    assert.equal((await send({ capabilities: [] })).status, 409);
    const advertised = JSON.parse((await send({ advertisement: true })).body);
    assert.deepEqual(advertised.catalogs, ["native-v2", profile.catalog]);
    assert.deepEqual(advertised.requiredCapabilities, ["detail.button", "detail.dateTime", "detail.keyValue", "detail.markdown", "detail.resourceList", "detail.status"]);
    assert.equal(advertised.writes, false);
  }
});
test("actual public five-argument SSE entry sends same-profile snapshot and resumes to ready", async t => {
  for (const paired of [false, true]) {
    const host = setup(), send = await listen(t, host, paired);
    const first = await send({ method: "POST", body: input, firstFrame: true });
    assert.equal(first.status, 200); assert.match(first.body.toString(), /event: detail-snapshot/);
    const state = JSON.parse(/^data: (.*)$/m.exec(first.body.toString())[1]); validateDetailV2(state, profile);
    const resumed = await send({ method: "POST", firstFrame: true, body: { ...input, resume: {
      documentId: state.documentId, generation: state.generation, revision: state.revision, stateHash: state.stateHash } } });
    assert.equal(resumed.status, 200); assert.match(resumed.body.toString(), /event: detail-ready/);
  }
});
test("paused real read-port adapter rejects account, ports, Task binding or retired journal before GET state publication", async t => {
  for (const paired of [false, true]) for (const mode of ["ports", "binding", "retire", ...(paired ? ["account"] : [])]) {
    const entered = deferred(), gate = deferred();
    const host = setup(true, async () => { entered.resolve(); await gate.promise; return []; });
    const send = await listen(t, host, paired), pending = send({ encoding: "gzip" }); await entered.promise;
    if (mode === "ports") host.service.configureBusinessPorts(host.makePorts());
    else if (mode === "binding") host.task.description = "Changed";
    else if (mode === "account") host.changeIdentity();
    else host.service.clearCache();
    gate.resolve(); const result = await pending;
    assert.ok([403, 409].includes(result.status), `${paired}/${mode}: ${result.status}`);
    assert.doesNotMatch(result.body.toString(), /instances|templates|fields|revalidate/);
    assert.equal(result.headers["content-encoding"], undefined);
  }
});
test("actual desktop/paired collection Action reads page through real adapter, keep <=20 and reject foreign/retired cursors", async t => {
  for (const paired of [false, true]) {
    const rows = Array.from({ length: 45 }, (_, i) => ({ referenceId: `ref-${i}`, displayName: `Reference ${i}`, targetType: "webURL",
      locator: "https://private.invalid", status: "available", enabled: true }));
    const host = setup(true, () => rows), send = await listen(t, host, paired);
    const first = JSON.parse((await send()).body), page = first.instances["business-references"].collections.resources;
    assert.equal(page.order.length, 20); assert.ok(page.nextCursor); assert.doesNotMatch(JSON.stringify(first), /private.invalid|sourceCursor/);
    const inputFor = state => ({ schemaVersion: 1, requestId: "page-read-001", documentId: state.documentId,
      cardId: "business-references", actionId: "page", fields: { collectionName: "resources",
        cursor: state.instances["business-references"].collections.resources.nextCursor } });
    const secondResponse = await send({ method: "POST", actionRead: true, body: inputFor(first) });
    assert.equal(secondResponse.status, 200, secondResponse.body.toString());
    const second = JSON.parse(secondResponse.body); validateDetailV2(second, profile);
    assert.deepEqual(second.instances["business-references"].collections.resources.order, rows.slice(20, 40).map(row => row.referenceId));
    const current = JSON.parse((await send()).body);
    assert.equal(canonicalDetailV2(current), canonicalDetailV2(second)); // GET preserves current page, not first-page fallback.
    const thirdResponse = await send({ method: "POST", actionRead: true, body: inputFor(second) });
    assert.equal(thirdResponse.status, 200, thirdResponse.body.toString());
    const third = JSON.parse(thirdResponse.body); validateDetailV2(third, profile);
    assert.deepEqual(third.instances["business-references"].collections.resources.order, rows.slice(40).map(row => row.referenceId));
    assert.equal(third.instances["business-references"].collections.resources.nextCursor, null);
    const foreign = await send({ method: "POST", actionRead: true, body: { ...inputFor(first),
      fields: { collectionName: "credentials", cursor: page.nextCursor } } });
    assert.equal(foreign.status, 409);
    host.service.clearCache();
    const retired = await send({ method: "POST", actionRead: true, body: inputFor(first) });
    assert.equal(retired.status, 409); assert.equal(JSON.parse(retired.body).instances, undefined);
  }
});
