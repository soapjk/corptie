import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, get } from "node:http";
import { gzipSync, gunzipSync } from "node:zlib";
import { sendDetailV2Snapshot, DETAIL_COMPRESSION_THRESHOLD } from "../src/application/detailSnapshotTransport.mjs";
import { createDetailBusinessReadPorts } from "../src/application/detailBusinessReadPorts.mjs";
import { DetailDocumentService, detailDocumentCacheScope } from "../src/application/detailDocumentService.mjs";
import { DETAIL_COMPONENTS_CATALOG, DETAIL_COMPONENT_CAPABILITIES } from "../src/application/detailV2Catalog.mjs";
import { DETAIL_RICH_BUSINESS_MODULES } from "../src/application/detailBusinessRichProjection.mjs";
import { applyDetailV2, canonicalDetailV2, validateDetailV2 } from "../src/application/detailSyncV2.mjs";

const identity = { principalId: "principal", accountId: "account", serverId: "server", deviceId: "device" };
const profile = { catalog: DETAIL_COMPONENTS_CATALOG, clientCapabilities: [...DETAIL_COMPONENT_CAPABILITIES] };
const input = { protocolVersion: 2, ...profile, cachedTemplateHashes: [], resume: null };
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const setup = () => {
  const task = { id: "task", title: "Task", description: "Definition" };
  const service = new DetailDocumentService({ getLogicalSession: () => null,
    getSession: id => ({ id, taskId: "task", sessionKind: "worker" }), getTask: () => task, getWork: () => null });
  service.v2Events.coalesceMs = 1;
  return { service, task };
};
const ports = (read = () => ({ items: [] })) => Object.fromEntries(DETAIL_RICH_BUSINESS_MODULES.map(name => [name,
  { dependencies: ["task"], read: (...args) => read(name, ...args) }]));
class Response extends EventEmitter {
  frames = []; destroyed = false; writableLength = 0; writableNeedDrain = false; backpressure = false;
  writeHead() { this.headersSent = true; }
  write(frame) {
    this.frames.push(frame);
    if (this.backpressure) { this.writableNeedDrain = true; return false; }
    return true;
  }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}
const frame = raw => ({ name: /^event: (.*)$/m.exec(raw)[1], value: JSON.parse(/^data: (.*)$/m.exec(raw)[1]) });
const cursor = state => ({ documentId: state.documentId, generation: state.generation, revision: state.revision, stateHash: state.stateHash });
const realPorts = () => createDetailBusinessReadPorts({
  store: { countArtifactsReferencedByTask: () => 0, listMemoryPage: () => ({ items: [], hasMore: false }),
    listMemoryRecallAudit: () => [{ id: "recall", phase: "planning", mode: "automatic", reason: "eligible",
      createdAt: "2026-10-11T12:00:00+08:00", selectedIds: [], candidateIds: [], diagnostics: { injection: { status: "injected" } }, private: "secret" }] },
  references: { list: () => [{ referenceId: "ref", targetType: "webURL", displayName: "Reference", locator: "https://secret.invalid", metadata: "secret" }] },
  artifacts: { listForTask: () => [] },
  schedules: { list: () => [{ taskId: "schedule", name: "计划", status: "active", scheduleType: "once", timezone: "Asia/Shanghai",
    runAt: "2026-10-10T04:00:00Z", nextRunAt: "2026-10-11T12:00:00+08:00", message: "secret" }] },
  providerRegistry: { descriptors: () => [{ id: "provider", displayName: "Provider", credential: "secret" }], supports: () => true },
  observability: { latestSummary: () => ({ identity: { logicalSessionId: "session", turnExecutionId: "turn" },
    wall: { totalMs: 12 }, completeness: { state: "partial" }, private: "secret" }) },
  readWorktree: async () => ({ attached: true, repositoryId: "repo", worktree: { worktreeId: "tree", branchName: "feature", dirty: true, path: "/private/secret" } })
});

test("internal async GET contract returns only state/revalidate and rechecks post-await scope/ports/retirement", async () => {
  for (const change of ["account", "ports", "retire", "binding"]) {
    const { service, task } = setup(); let current = identity;
    service.configureBusinessPorts(ports());
    const promise = service.prepareRichSnapshot("session", { authenticate: () => current, ...profile });
    assert.equal(typeof promise.then, "function");
    const prepared = await promise;
    assert.deepEqual(Object.keys(prepared).sort(), ["revalidate", "state"]);
    assert.equal(typeof prepared.revalidate, "function"); assert.ok(Object.isFrozen(prepared));
    validateDetailV2(prepared.state, profile); assert.strictEqual(prepared.revalidate(), identity);
    assert.doesNotMatch(JSON.stringify(prepared), /revalidate|principal|account|device/);
    if (change === "account") current = { ...identity, accountId: "changed" };
    else if (change === "ports") service.configureBusinessPorts(ports());
    else if (change === "retire") service.clearCache({ principalId: identity.principalId });
    else task.description = "New binding";
    assert.throws(prepared.revalidate, { code: change === "account" ? "DETAIL_IDENTITY_CHANGED" : "DETAIL_READ_INVALIDATED" });
  }
});

test("rich internal attach never downgrades wrapper profile and first subscriber refreshes current facts", async () => {
  const { service } = setup(); let reads = 0, title = "Before";
  service.configureBusinessPorts(ports(name => { reads++; return name === "references"
    ? { items: [{ resource: { resourceType: "contextReference", id: "ref" }, displayName: title }] } : { items: [] }; }));
  await service.prepareRichSnapshot("session", { authenticate: () => identity, ...profile }); assert.equal(reads, 9);
  title = "After"; // no consumer was attached, and no explicit invalidation was delivered
  service.v2Events.snapshot = () => { throw new Error("global legacy fallback must not run"); };
  const response = new Response(), request = structuredClone(input);
  service.attachRichBusiness(response, () => identity, "session", null, request);
  const client = [...service.v2Events.clients][0];
  assert.deepEqual(client.detailCacheScope, detailDocumentCacheScope(identity, "session", profile));
  request.catalog = "native-v2"; request.clientCapabilities = [];
  await tick(); assert.equal(reads, 18);
  const initial = frame(response.frames[0]); assert.equal(initial.name, "detail-snapshot");
  validateDetailV2(initial.value, profile); assert.match(initial.value.instances["business-references"].fields.body, /After/);
  const journal = service.v2Journal("session", { identity, ...profile });
  assert.equal(journal.profile.catalog, profile.catalog); assert.deepEqual(journal.profile.clientCapabilities, profile.clientCapabilities);
  let publishes = 0; const publish = journal.publish.bind(journal);
  journal.publish = state => { publishes++; return publish(state); };
  const event = client.eventForSnapshot(null, client.previous);
  assert.equal(event.name, "detail-snapshot"); assert.equal(publishes, 0); // pure resume/diff
  await service.v2Events.deliver(client); assert.equal(response.frames.length, 1);
  title = "Delta"; service.markDirty({ resourceType: "task", sessionId: "session" });
  await service.v2Events.deliver(client);
  const delta = frame(response.frames[1]); assert.equal(delta.name, "detail-commit");
  assert.equal(canonicalDetailV2(applyDetailV2(initial.value, delta.value, profile)), canonicalDetailV2(client.previous));
  const entries = journal.entries, bytes = journal.bytes, retained = entries.length;
  assert.ok(retained >= 2);
  journal.now = () => Date.now() + journal.limits.journalMs + 1000;
  const afterPruneQuery = client.eventForSnapshot(null, client.previous);
  assert.equal(afterPruneQuery.name, "detail-snapshot");
  assert.strictEqual(journal.entries, entries); assert.equal(journal.entries.length, retained); assert.equal(journal.bytes, bytes);
  response.destroy();
  assert.throws(() => service.attachV2(new Response(), () => identity, "session", null, input), { code: "DETAIL_CATALOG_UNSUPPORTED" });
  assert.throws(() => service.v2Snapshot("session", { identity, ...profile }), { code: "DETAIL_CATALOG_UNSUPPORTED" });
});

test("same-profile resume is ready; account/session/capability/generation foreign cursors reset to snapshot", async () => {
  const { service } = setup(); service.configureBusinessPorts(ports());
  const prepared = await service.prepareRichSnapshot("session", { authenticate: () => identity, ...profile });
  const saved = cursor(prepared.state);
  for (const variant of ["same", "account", "session", "caps", "generation"]) {
    const response = new Response();
    const who = variant === "account" ? { ...identity, accountId: "other" } : identity;
    const id = variant === "session" ? "another" : "session";
    const negotiated = variant === "caps" ? { ...profile, clientCapabilities: profile.clientCapabilities.filter(c => c !== "detail.chart") } : profile;
    service.attachRichBusiness(response, () => who, id, null, { ...input, ...negotiated,
      resume: variant === "generation" ? { ...saved, generation: "foreign-generation" } : saved });
    await tick(); assert.equal(frame(response.frames[0]).name, variant === "same" ? "detail-ready" : "detail-snapshot");
    response.destroy();
  }
});

test("await-time revoke/ports replacement/close cannot advance rich client baseline", async () => {
  for (const mode of ["revoke", "ports", "close"]) {
    const { service } = setup(), gate = defer(), response = new Response(); let current = identity;
    service.configureBusinessPorts(ports(async () => { await gate.promise; return { items: [] }; }));
    service.attachRichBusiness(response, () => { if (!current) throw Object.assign(new Error("revoked"), { status: 403 }); return current; }, "session", null, input);
    const client = [...service.v2Events.clients][0]; await tick();
    if (mode === "revoke") current = null;
    else if (mode === "ports") service.configureBusinessPorts(ports());
    else response.destroy();
    gate.resolve(); await tick();
    assert.equal(client.previous, undefined); assert.equal(client.hash, undefined);
    assert.equal(response.frames.length, 0); assert.equal(response.destroyed, true);
  }
});

test("write-time revocation/ports changes and refused frames do not advance delivery baseline", async () => {
  for (const mode of ["revoke", "ports", "oversize", "throw"]) {
    const { service } = setup(), gate = defer(), response = new Response(); let current = identity;
    service.configureBusinessPorts(ports(async () => { await gate.promise; return { items: [] }; }));
    service.attachRichBusiness(response, () => current, "session", null, input);
    const client = [...service.v2Events.clients][0], eventForSnapshot = client.eventForSnapshot;
    client.eventForSnapshot = (previous, next) => {
      const result = eventForSnapshot(previous, next);
      if (mode === "revoke") current = { ...identity, accountId: "changed" };
      if (mode === "ports") service.configureBusinessPorts(ports());
      return result;
    };
    if (mode === "oversize") response.writableLength = service.v2Events.maxFrameBytes;
    if (mode === "throw") response.write = () => { throw new Error("closed socket"); };
    gate.resolve(); await tick();
    assert.equal(client.previous, undefined); assert.equal(client.hash, undefined); assert.equal(response.destroyed, true);
    assert.equal(response.frames.length, 0);
  }
});

test("accepted false write retains backpressure and applies only the latest subsequent rich baseline", async () => {
  const { service } = setup(), response = new Response(); response.backpressure = true; let title = "A", reads = 0;
  service.configureBusinessPorts(ports(name => { reads++; return name === "references"
    ? { items: [{ resource: { resourceType: "contextReference", id: "ref" }, displayName: title }] } : { items: [] }; }));
  service.attachRichBusiness(response, () => identity, "session", null, input);
  const client = [...service.v2Events.clients][0]; await tick();
  assert.equal(client.busy, true); assert.equal(response.frames.length, 1); assert.ok(client.previous);
  const initial = frame(response.frames[0]).value, count = reads;
  for (const value of ["B", "C", "D"]) { title = value; service.invalidate({ resourceType: "task", sessionId: "session" }); }
  await tick(); assert.equal(reads, count); assert.equal(response.frames.length, 1);
  response.backpressure = false; response.writableNeedDrain = false; response.emit("drain");
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(response.frames.length, 2);
  const next = frame(response.frames[1]); assert.equal(next.name, "detail-commit");
  const applied = applyDetailV2(initial, next.value, profile);
  assert.match(applied.instances["business-references"].fields.body, /D/);
  assert.equal(canonicalDetailV2(applied), canonicalDetailV2(client.previous));
  response.destroy();
});

test("empty and error module states stay distinct on internal stream and preparation fails before headers for missing ports", async () => {
  const { service } = setup(), response = new Response();
  service.configureBusinessPorts(ports(name => { if (name === "schedules") throw Object.assign(new Error("/private/secret"), { status: 403 }); return { items: [] }; }));
  service.attachRichBusiness(response, () => identity, "session", null, input); await tick();
  const state = frame(response.frames[0]).value;
  assert.equal(state.instances["business-schedules"].fields.state, "无权读取");
  assert.equal(state.instances["business-recalls"].fields.state, "暂无内容");
  assert.doesNotMatch(JSON.stringify(state), /private|secret/); response.destroy();
  service.configureBusinessPorts({}); const missing = new Response();
  assert.throws(() => service.attachRichBusiness(missing, () => identity, "session", null, input), { code: "DETAIL_BUSINESS_RICH_MODULE_UNAVAILABLE" });
  assert.equal(missing.headersSent, undefined);
});

async function loopback(t, handler) {
  // Test-only host adapter, not a product handler or a registered rich route.
  const server = createServer((request, response) => { void handler(request, response).catch(error => {
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(error.status ?? 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: error.code ?? "TEST_HOST_ERROR" }));
    } else response.destroy();
  }); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return header => new Promise((resolve, reject) => {
    const request = get({ hostname: "127.0.0.1", port: server.address().port, path: "/__test_prepared_snapshot",
      headers: { "accept-encoding": header }, agent: false }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }); request.on("error", reject);
  });
}

test("prepared real business state crosses internal loopback identity/gzip with only State on wire", async t => {
  const { service } = setup(); service.configureBusinessPorts(realPorts()); let expected;
  const read = await loopback(t, async (request, response) => {
    const prepared = await service.prepareRichSnapshot("session", { authenticate: () => identity, ...profile });
    expected = prepared.state;
    assert.ok(Buffer.byteLength(JSON.stringify(expected)) >= DETAIL_COMPRESSION_THRESHOLD);
    await sendDetailV2Snapshot(request, response, prepared.state, () => identity, { beforeWrite: prepared.revalidate });
  });
  for (const encoding of ["identity", "gzip"]) {
    const result = await read(encoding); assert.equal(result.status, 200);
    const compressed = result.headers["content-encoding"] === "gzip"; assert.equal(compressed, encoding === "gzip");
    const state = JSON.parse(compressed ? gunzipSync(result.body) : result.body);
    validateDetailV2(state, profile); assert.equal(canonicalDetailV2(state), canonicalDetailV2(expected));
    assert.equal(state.manifest.order.length, 10);
    assert.equal(state.instances["business-schedules"].fields.date0, "2026-10-11T12:00:00+08:00");
    assert.equal(state.instances["business-schedules"].fields.scheduledDate0, "2026-10-10T04:00:00Z");
    assert.match(state.instances["business-turn"].fields.body, /totalMs: 12/);
    assert.doesNotMatch(JSON.stringify(state), /secret|credential|private|locator/);
    assert.equal(result.headers.vary, "Accept, X-Corptie-Detail-Capabilities, Accept-Encoding");
    assert.doesNotMatch(JSON.stringify(state), /revalidate|authenticate|principalId|accountId|deviceId/);
  }
});

test("paused real nine-port producer rejects scope/ports/journal/binding changes before sender headers or body", async () => {
  for (const mode of ["revoke", "account", "canonicalSession", "ports", "journal", "binding"]) {
    const { service, task } = setup(), gate = defer(); let current = identity;
    const source = realPorts();
    service.configureBusinessPorts(Object.fromEntries(Object.entries(source).map(([name, port]) => [name,
      { ...port, read: async (...args) => { await gate.promise; return port.read(...args); } }])));
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    const authenticate = () => { if (!current) throw Object.assign(new Error("revoked"), { code: "AUTH_REVOKED", status: 403 }); return current; };
    const operation = (async () => {
      const prepared = await service.prepareRichSnapshot("session", { authenticate, ...profile });
      await sendDetailV2Snapshot({ headers: { "accept-encoding": "gzip" } }, response, prepared.state, authenticate, { beforeWrite: prepared.revalidate });
    })();
    const rejected = assert.rejects(operation, { status: ["revoke", "account", "canonicalSession"].includes(mode) ? 403 : 409 });
    await tick(); assert.equal(service.businessReader.active, 2);
    if (mode === "revoke") current = null;
    else if (mode === "account") current = { ...identity, accountId: "changed" };
    else if (mode === "canonicalSession") service.store.getLogicalSession = () => ({ logicalSessionId: "changed", legacySessionId: "session" });
    else if (mode === "ports") service.configureBusinessPorts(realPorts());
    else if (mode === "journal") service.clearCache({ principalId: identity.principalId });
    else task.description = "Changed while producer awaited";
    gate.resolve(); await rejected;
    assert.equal(response.status, undefined); assert.equal(response.headers, undefined); assert.equal(response.body, undefined);
  }
});

test("real prepared compression success/fallback refuses retired/revoked/changed bindings before publication", async t => {
  for (const fault of [false, true]) for (const mode of ["account", "ports", "retire", "binding"]) {
    const { service, task } = setup(); service.configureBusinessPorts(realPorts()); let current = identity, published = 0;
    const read = await loopback(t, async (request, response) => {
      const prepared = await service.prepareRichSnapshot("session", { authenticate: () => current, ...profile });
      const writeHead = response.writeHead.bind(response);
      response.writeHead = (status, ...args) => { if (status === 200) published++; return writeHead(status, ...args); };
      await sendDetailV2Snapshot(request, response, prepared.state, () => current, { beforeWrite: prepared.revalidate,
        compressor: async raw => {
          await tick();
          if (mode === "account") current = { ...identity, accountId: "changed" };
          else if (mode === "ports") service.configureBusinessPorts(realPorts());
          else if (mode === "retire") service.clearCache({ principalId: identity.principalId });
          else task.description = "Changed after prepare";
          if (fault) throw new Error("zlib failure");
          return gzipSync(raw);
        } });
    });
    const result = await read("gzip");
    assert.equal(result.status, mode === "account" ? 403 : 409); assert.equal(published, 0);
    assert.equal(JSON.parse(result.body).code, mode === "account" ? "DETAIL_IDENTITY_CHANGED" : "DETAIL_READ_INVALIDATED");
    assert.doesNotMatch(result.body.toString(), /templates|instances|zlib|revalidate/);
  }
});

test("prepared revalidate catches post-auth microtask ports replacement for identity and gzip", async t => {
  for (const encoding of ["identity", "gzip"]) {
    const { service } = setup(); service.configureBusinessPorts(realPorts()); let published = 0;
    const read = await loopback(t, async (request, response) => {
      const prepared = await service.prepareRichSnapshot("session", { authenticate: () => identity, ...profile });
      const writeHead = response.writeHead.bind(response);
      response.writeHead = (status, ...args) => { if (status === 200) published++; return writeHead(status, ...args); };
      await sendDetailV2Snapshot(request, response, prepared.state, () => {
        queueMicrotask(() => service.configureBusinessPorts(realPorts())); return identity;
      }, { beforeWrite: prepared.revalidate });
    });
    const result = await read(encoding); assert.equal(result.status, 409); assert.equal(published, 0);
    assert.equal(JSON.parse(result.body).code, "DETAIL_READ_INVALIDATED");
  }
});
