import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";
import { ClientDeviceAuthority, deviceError } from "../src/application/clientDeviceAuthority.mjs";
import { ClientDeviceGateway } from "../src/application/clientDeviceGateway.mjs";

const identity = { deviceId: "device:reliable" };
const binding = { bindingId: "binding:reliable", providerId: "provider:test", providerSessionId: "thread:reliable", routingVersion: 1 };
const input = () => ({ schemaVersion: 1, requestId: "reliable_request_1", createdAt: new Date().toISOString(), text: "Hello" });
const digest = data => createHash("sha256").update(data).digest("hex");

test("image chunks resume after restart, reject cross-device access and commit once through shared provider admission", async () => {
  const f = await fixture();
  try {
    const imports = [];
    const images = { available: () => true, import: async (_session, image) => {
      imports.push(image); return { managedPath: "managed:image.png", fileName: image.fileName };
    } };
    let api = makeAPI(f.store, { images });
    const data = Buffer.alloc(600 * 1024, 42);
    const uploadId = "image_upload_test";
    const metadata = { schemaVersion: 1, uploadId, fileName: "test.png", byteLength: data.length, sha256: digest(data) };
    assert.equal(api.capabilities(identity, "session:reliable").imageUploads.chunkBytes, 512 * 1024);
    assert.equal(api.imageUploads.begin(identity, "session:reliable", metadata).offset, 0);
    const first = data.subarray(0, 512 * 1024);
    const chunk = { schemaVersion: 1, offset: 0, dataBase64: first.toString("base64"), sha256: digest(first) };
    api.imageUploads.append(identity, "session:reliable", uploadId, chunk);
    assert.equal(api.imageUploads.append(identity, "session:reliable", uploadId, chunk).offset, first.length);
    assert.throws(() => api.imageUploads.status({ deviceId: "other" }, "session:reliable", uploadId), { code: "IMAGE_UPLOAD_NOT_FOUND" });
    assert.throws(() => api.imageUploads.status(identity, "other-session", uploadId), { code: "IMAGE_UPLOAD_NOT_FOUND" });
    assert.throws(() => api.imageUploads.resolve(identity, "session:reliable", uploadId), { code: "IMAGE_UPLOAD_INCOMPLETE" });
    await f.store.close(); await f.store.initialize();
    api = makeAPI(f.store, { images });
    assert.equal(api.imageUploads.begin(identity, "session:reliable", metadata).offset, first.length);
    const last = data.subarray(first.length);
    api.imageUploads.append(identity, "session:reliable", uploadId, { schemaVersion: 1,
      offset: first.length, dataBase64: last.toString("base64"), sha256: digest(last) });
    const body = { ...input(), text: "", imageUploadIds: [uploadId] };
    const receipt = await api.reliableMessage(identity, "session:reliable", body);
    assert.equal(receipt.status, "accepted");
    assert.equal(imports.length, 1);
    assert.deepEqual(Buffer.from(imports[0].dataBase64, "base64"), data);
    assert.throws(() => api.imageUploads.status(identity, "session:reliable", uploadId), { code: "IMAGE_UPLOAD_NOT_FOUND" });
    assert.deepEqual(await api.reliableMessage(identity, "session:reliable", body), receipt);
    await assert.rejects(api.reliableMessage(identity, "session:reliable", { ...body, text: "changed" }), { code: "IDEMPOTENCY_CONFLICT" });
    assert.equal(f.store.listQueuedAgentTasksForSession("session:reliable").length, 1);
  } finally { await f.close(); }
});

test("image upload rejects corrupt chunks, oversized inputs and altered immutable metadata", async () => {
  const f = await fixture();
  try {
    const uploads = f.api.imageUploads, data = Buffer.from("image");
    const metadata = { schemaVersion: 1, uploadId: "image_test_2", fileName: "x.png", byteLength: data.length, sha256: digest(data) };
    uploads.begin(identity, "session:reliable", metadata);
    assert.throws(() => uploads.begin(identity, "session:reliable", { ...metadata, sha256: "0".repeat(64) }), { code: "IDEMPOTENCY_CONFLICT" });
    assert.throws(() => uploads.begin(identity, "session:reliable", { ...metadata, uploadId: "image_test_3", byteLength: 20 * 1024 * 1024 + 1 }), { code: "INVALID_IMAGE_UPLOAD" });
    const chunk = { schemaVersion: 1, offset: 0, dataBase64: data.toString("base64"), sha256: "0".repeat(64) };
    assert.throws(() => uploads.append(identity, "session:reliable", metadata.uploadId, chunk), { code: "INVALID_IMAGE_CHUNK" });
    uploads.append(identity, "session:reliable", metadata.uploadId, { ...chunk, sha256: digest(data) });
    assert.throws(() => uploads.append(identity, "session:reliable", metadata.uploadId,
      { ...chunk, dataBase64: Buffer.from("other").toString("base64"), sha256: digest(Buffer.from("other")) }), { code: "IDEMPOTENCY_CONFLICT" });
    f.store.db.run("UPDATE client_image_uploads SET expires_at=0");
    assert.throws(() => uploads.resolve(identity, "session:reliable", metadata.uploadId), { code: "IMAGE_UPLOAD_EXPIRED" });
    uploads.cleanup();
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM client_image_chunks").n, 0);
  } finally { await f.close(); }
});

test("device gateway dispatches bounded uploads only after authentication and capability validation", async () => {
  const f = await fixture();
  try {
    const api = makeAPI(f.store, { images: { available: () => true } });
    const gateway = new ClientDeviceGateway({ authenticate: token => {
      if (!token) throw deviceError("DEVICE_AUTH_REQUIRED", 401);
      return identity;
    } }, { sessionAPI: api });
    async function call(method, suffix, value, authorized = true) {
      const request = Readable.from(value ? [Buffer.from(JSON.stringify(value))] : []);
      Object.assign(request, { method, url: `/client/v1/sessions/session%3Areliable/image-uploads${suffix}`,
        headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${"a".repeat(43)}` } : {}) },
        socket: { encrypted: true, remoteAddress: "192.168.1.2" } });
      const response = { status: 0, writeHead(status) { this.status = status; }, end(data) { this.body = JSON.parse(data); } };
      await gateway.handle(request, response);
      return response;
    }
    const data = Buffer.from("image");
    const metadata = { schemaVersion: 1, uploadId: "gateway_upload_1", fileName: "x.png", byteLength: data.length, sha256: digest(data) };
    assert.equal((await call("POST", "", metadata, false)).status, 401);
    assert.equal((await call("POST", "", metadata)).body.offset, 0);
    assert.equal((await call("PUT", "/gateway_upload_1", { schemaVersion: 1, offset: 0, dataBase64: data.toString("base64"), sha256: digest(data) })).body.offset, data.length);
    assert.equal((await call("GET", "/gateway_upload_1")).body.offset, data.length);
    assert.equal((await call("DELETE", "/gateway_upload_1")).status, 200);
    api.images.available = () => false;
    assert.equal((await call("POST", "", metadata)).status, 409);
  } finally { await f.close(); }
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-reliable-"));
  const path = { dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") };
  const store = new CorptieStore(path); await store.initialize();
  store.createAgent({ id: "agent:reliable", name: "Agent", role: "independentContributor" });
  store.upsertSession({ id: "session:reliable", title: "Reliable", agentId: "agent:reliable", provider: "provider:test", status: "complete" });
  const api = makeAPI(store);
  return { api, store, path, close: async () => { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}
function makeAPI(store, overrides = {}) {
  return new ClientSessionAPI({ store, actions: () => ({ send: { available: true } }),
    admitReliableMessage: (sessionId, message, source) => store.createUserMessageDelivery({
      deliveryId: `delivery:${source.messageId}`, messageId: source.messageId, sessionId, binding,
      agentId: "agent:reliable", text: message.text, content: message, source
    }), ...overrides });
}

test("durable receipt, user message and queued work commit once; lost ACK and process restart are safe", async () => {
  const f = await fixture();
  try {
    const body = input();
    const first = await f.api.reliableMessage(identity, "session:reliable", body);
    assert.equal(first.status, "accepted");
    assert.equal(first.messageId, `client:${createHash("sha256").update(`${identity.deviceId}:${body.requestId}`).digest("hex")}`);
    assert.equal(f.store.getSessionItem("session:reliable", first.messageId).id, first.messageId);
    assert.equal(f.api.receipt(identity, body.requestId).status, "accepted");
    assert.deepEqual(await f.api.reliableMessage(identity, "session:reliable", body), first);
    const restarted = makeAPI(f.store);
    assert.deepEqual(await restarted.reliableMessage(identity, "session:reliable", body), first);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM client_message_receipts").n, 1);
    assert.equal(f.store.listSessionEvents("session:reliable").filter(event => event.type === "SessionUserMessageCreated").length, 1);
    await assert.rejects(restarted.reliableMessage(identity, "session:reliable", { ...body, text: "Changed" }), { code: "IDEMPOTENCY_CONFLICT" });
    // Reopen the actual database, not just another API instance.
    await f.store.close();
    const reopened = new CorptieStore(f.path); await reopened.initialize();
    try { assert.deepEqual(await makeAPI(reopened).reliableMessage(identity, "session:reliable", body), first); }
    finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("receipt identities isolate devices and Sessions; identical text is not deduplicated", async () => {
  const f = await fixture();
  try {
    const body = input();
    const first = await f.api.reliableMessage(identity, "session:reliable", body);
    const other = { deviceId: "device:other" };
    const second = await f.api.reliableMessage(other, "session:reliable", body);
    assert.notEqual(first.messageId, second.messageId);
    const third = await f.api.reliableMessage(identity, "session:reliable", { ...body, requestId: "another_request_1" });
    assert.notEqual(first.messageId, third.messageId);
    assert.equal(f.store.listQueuedAgentTasksForSession("session:reliable").length, 3);
    await assert.rejects(f.api.reliableMessage(identity, "session:other", body), { code: "IDEMPOTENCY_CONFLICT" });
    assert.throws(() => f.api.receipt({ deviceId: "device:stranger" }, body.requestId), { code: "COMMAND_NOT_FOUND" });
  } finally { await f.close(); }
});

test("relay-to-LAN retry after a lost receipt retains one durable message and one execution", async () => {
  const f = await fixture();
  try {
    const authority = new ClientDeviceAuthority(join(dirname(f.path.dbPath), "authority"));
    await authority.initialize();
    const cloudDeviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await authority.registerCloudRelayPeer({ cloudDeviceId, name: "Phone" });
    const grant = await authority.issueCloudGrant({ cloudDeviceId, name: "Phone" });
    const gateway = new ClientDeviceGateway(authority);
    const relayRequest = { headers: { authorization: `Bearer ${authority.adminToken}`,
      "x-corptie-relay-cloud-device-id": cloudDeviceId }, socket: { remoteAddress: "127.0.0.1" } };
    const relayIdentity = gateway.authenticateRequest(relayRequest);
    const lanIdentity = gateway.authenticateRequest({ headers: { authorization: `Bearer ${grant.accessToken}` },
      socket: { encrypted: true, remoteAddress: "192.168.1.3" } });
    const body = input();
    const accepted = await f.api.reliableMessage(relayIdentity, "session:reliable", body,
      () => gateway.authenticateRequest(relayRequest));
    const retried = await f.api.reliableMessage(lanIdentity, "session:reliable", body);
    assert.equal(accepted.messageId, retried.messageId);
    assert.equal(retried.messageId, `client:${createHash("sha256").update(`${grant.deviceId}:${body.requestId}`).digest("hex")}`);
    assert.deepEqual(f.api.receipt(lanIdentity, body.requestId), accepted);
    assert.equal(f.store.listQueuedAgentTasksForSession("session:reliable").length, 1);
    assert.equal(f.store.listSessionEvents("session:reliable").filter(event => event.type === "SessionUserMessageCreated").length, 1);
  } finally { await f.close(); }
});

test("queue write failure rolls back receipt; the exact same request can recover", async () => {
  const f = await fixture();
  try {
    const body = input(), enqueue = f.store.enqueueAgentTaskWithResult;
    f.store.enqueueAgentTaskWithResult = () => { throw new Error("injected crash before commit"); };
    await assert.rejects(f.api.reliableMessage(identity, "session:reliable", body));
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM client_message_receipts").n, 0);
    assert.equal(f.store.listSessionEvents("session:reliable").length, 0);
    f.store.enqueueAgentTaskWithResult = enqueue;
    assert.equal((await f.api.reliableMessage(identity, "session:reliable", body)).status, "accepted");
  } finally { await f.close(); }
});

test("publication failure after commit returns acceptance, not an uncertain command", async () => {
  const f = await fixture();
  try {
    const admit = f.api.admitReliableMessage;
    f.api.admitReliableMessage = (...args) => { admit(...args); throw new Error("publication failed after commit"); };
    assert.equal((await f.api.reliableMessage(identity, "session:reliable", input())).status, "accepted");
  } finally { await f.close(); }
});

test("same-clock-tick admissions preserve Session instruction order", async () => {
  const f = await fixture();
  try {
    const sameTime = new Date().toISOString();
    f.api.admitReliableMessage = (sessionId, message, source) => f.store.createUserMessageDelivery({
      deliveryId: `delivery:${source.messageId}`, messageId: source.messageId, sessionId, binding,
      agentId: "agent:reliable", text: message.text, content: message, source, createdAt: sameTime
    });
    await f.api.reliableMessage(identity, "session:reliable", { ...input(), text: "first" });
    await f.api.reliableMessage(identity, "session:reliable", { ...input(), requestId: "reliable_request_2", text: "second" });
    const queue = f.store.listQueuedAgentTasksForSession("session:reliable");
    assert.deepEqual(queue.map(task => task.text), ["first", "second"]);
    assert.ok(Date.parse(queue[1].createdAt) > Date.parse(queue[0].createdAt));
  } finally { await f.close(); }
});

test("image import singleflight, conflict checks and revocation occur before durable admission", async () => {
  const f = await fixture();
  try {
    let imports = 0, finish;
    f.api.images = { available: () => true, import: async () => {
      imports++; await new Promise(resolve => { finish = resolve; });
      return { managedPath: "chat-resources/image.png" };
    } };
    const body = { ...input(), images: [{ fileName: "image.png", dataBase64: "aGVsbG8=" }] };
    const first = f.api.reliableMessage(identity, "session:reliable", body);
    const second = f.api.reliableMessage(identity, "session:reliable", body);
    await assert.rejects(f.api.reliableMessage(identity, "session:reliable", { ...body, text: "Other" }), { code: "IDEMPOTENCY_CONFLICT" });
    finish();
    assert.equal((await first).status, "accepted"); assert.equal((await second).status, "accepted"); assert.equal(imports, 1);
    const reordered = { ...body, images: [{ dataBase64: "aGVsbG8=", fileName: "image.png" }] };
    assert.equal((await f.api.reliableMessage(identity, "session:reliable", reordered)).status, "accepted");
    assert.equal(imports, 1);
    const revoked = { ...input(), requestId: "revoked_request_1" };
    await assert.rejects(f.api.reliableMessage(identity, "session:reliable", revoked,
      () => { throw Object.assign(new Error("revoked"), { code: "DEVICE_REVOKED" }); }), { code: "DEVICE_REVOKED" });
    assert.throws(() => f.api.receipt(identity, revoked.requestId), { code: "COMMAND_NOT_FOUND" });
  } finally { await f.close(); }
});

test("expired messages cannot be re-admitted after receipt cleanup; unsafe operations are excluded", async () => {
  const f = await fixture();
  try {
    const expired = { ...input(), createdAt: new Date(Date.now() - 8 * 86400000).toISOString() };
    await assert.rejects(f.api.reliableMessage(identity, "session:reliable", expired), { code: "MESSAGE_EXPIRED" });
    for (const extra of [{ text: "/clear" }, { schedule: {} }, { confirmed: true }, { deviceId: "device:forged" }]) {
      await assert.rejects(f.api.reliableMessage(identity, "session:reliable", { ...input(), ...extra }), { code: "INVALID_MESSAGE" });
    }
    assert.equal(f.api.capabilities(identity, "session:reliable").reliableMessages.version, 1);
    assert.equal(makeAPI(f.store, { admitReliableMessage: null }).capabilities(identity, "session:reliable").reliableMessages, null);
  } finally { await f.close(); }
});
