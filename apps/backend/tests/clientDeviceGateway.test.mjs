import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import https from "node:https";
import http from "node:http";
import { requireDevicePermission } from "../src/application/clientSessionAPI.mjs";
import { ClientDeviceAuthority } from "../src/application/clientDeviceAuthority.mjs";
import { ClientDeviceGateway, startConfiguredDeviceGateway } from "../src/application/clientDeviceGateway.mjs";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "corptie-device-test-"));
  let now = Date.now();
  const authority = new ClientDeviceAuthority(join(dir, "auth"), { now: () => now });
  await authority.initialize();
  return { dir, authority, advance: ms => { now += ms; }, close: () => rm(dir, { recursive: true, force: true }) };
}

test("pairing requires local approval, exchanges once, rotates and revokes persisted credentials", async () => {
  const f = await fixture();
  try {
    const a = f.authority;
    const invite = a.invite();
    const claim = a.claim({ ...invite, name: "Test iPad" });
    await assert.rejects(a.exchange(claim), { code: "PAIRING_NOT_APPROVED" });
    assert.throws(() => a.claim({ ...invite, name: "Other" }), { code: "PAIRING_INVALID" });
    a.approve(invite.pairingId, true);
    const results = await Promise.allSettled([a.exchange(claim), a.exchange(claim)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const creds = results.find(r => r.status === "fulfilled").value;
    assert.equal(a.authenticate(creds.accessToken).deviceId, creds.deviceId);
    const disk = await readFile(join(f.dir, "auth", "devices.json"), "utf8");
    assert.equal(disk.includes(creds.accessToken), false);
    assert.equal(disk.includes(creds.refreshToken), false);
    assert.equal((await stat(join(f.dir, "auth", "devices.json"))).mode & 0o777, 0o600);
    const rotated = await a.refresh(creds);
    await assert.rejects(a.refresh(creds), { code: "INVALID_CREDENTIAL" });
    assert.throws(() => a.authenticate(creds.accessToken), { code: "INVALID_CREDENTIAL" });
    const restored = new ClientDeviceAuthority(join(f.dir, "auth"));
    await restored.initialize();
    assert.equal(restored.authenticate(rotated.accessToken).deviceId, creds.deviceId);
    await restored.revoke(creds.deviceId);
    assert.throws(() => restored.authenticate(rotated.accessToken), { code: "INVALID_CREDENTIAL" });
    await assert.rejects(restored.refresh(rotated), { code: "INVALID_CREDENTIAL" });
  } finally { await f.close(); }
});

test("denied and expired invitations and expired access tokens fail closed", async () => {
  const f = await fixture();
  try {
    const invite = f.authority.invite();
    const claim = f.authority.claim({ ...invite, name: "iPad" });
    f.authority.approve(invite.pairingId, false);
    await assert.rejects(f.authority.exchange(claim), { code: "PAIRING_DENIED" });
    f.advance(300_001);
    assert.throws(() => f.authority.pairing(invite.pairingId), { code: "PAIRING_EXPIRED" });
    const second = f.authority.invite();
    const request = f.authority.claim({ ...second, name: "iPad" });
    f.authority.approve(second.pairingId, true);
    const creds = await f.authority.exchange(request);
    f.advance(900_001);
    assert.throws(() => f.authority.authenticate(creds.accessToken), { code: "INVALID_CREDENTIAL" });
    assert.ok((await f.authority.refresh(creds)).accessToken);
  } finally { await f.close(); }
});

test("gateway is disabled by default and always disabled in preview", async () => {
  assert.equal(await startConfiguredDeviceGateway({ environment: {}, directory: "/unused", preview: false }), null);
  assert.equal(await startConfiguredDeviceGateway({ environment: { CORPTIE_REMOTE_ACCESS: "1" }, directory: "/unused", preview: true }), null);
  await assert.rejects(startConfiguredDeviceGateway({ environment: { CORPTIE_REMOTE_ACCESS: "1" }, directory: "/unused" }),
    { code: "REMOTE_TLS_CONFIGURATION_REQUIRED" });
});

test("real TLS route boundary and authenticated local approval", async () => {
  const f = await fixture();
  const gateway = new ClientDeviceGateway(f.authority, { readAPI: {
    list: (kind, query) => ({ schemaVersion: 1, items: [{ id: `${kind}:one` }], limit: query.get("limit") })
  }, controlAPI: {
    list: async kind => ({ schemaVersion: 1, items: [{ id: `${kind}:one` }] }),
    repository: async id => ({ schemaVersion: 1, repository: { id } })
  }, sessionAPI: {
    messages(identity, sessionId) { requireDevicePermission(identity, "messages.read"); return { schemaVersion: 1, sessionId, items: [] }; },
    command(identity, sessionId, kind, input) {
      requireDevicePermission(identity, kind === "send" ? "messages.write" : "sessions.stop");
      return { schemaVersion: 1, sessionId, kind, requestId: input.requestId, status: "dispatching" };
    },
    receipt(identity, requestId) { return { requestId, deviceId: identity.deviceId }; },
    capabilities() { return { schemaVersion: 1 }; }
  } });
  const remoteAgent = new https.Agent({ keepAlive: true });
  let admin;
  try {
    const keyPath = join(f.dir, "key.pem"), certPath = join(f.dir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
      "-out", certPath, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    const cert = await readFile(certPath);
    const address = await gateway.start({ key: await readFile(keyPath), cert });
    admin = http.createServer((req, res) => void gateway.handleAdmin(req, res));
    await new Promise(resolve => admin.listen(0, "127.0.0.1", resolve));
    const call = (path, { local = false, method = "GET", token, value, headers = {} } = {}) => new Promise((resolve, reject) => {
      const req = (local ? http : https).request({ host: "127.0.0.1", servername: "localhost",
        port: local ? admin.address().port : address.port, path, method, ca: cert, agent: local ? false : remoteAgent,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
          ...(value ? { "content-type": "application/json" } : {}) } }, res => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on("error", reject);
      req.end(value ? JSON.stringify(value) : undefined);
    });
    assert.equal((await call("/internal/client-devices", { local: true })).status, 403);
    const token = f.authority.adminToken;
    assert.equal((await call("/internal/client-devices", { local: true, token, headers: { origin: "https://evil.test" } })).status, 403);
    const invitation = (await call("/internal/client-devices/invite", { local: true, token, method: "POST" })).body;
    const claim = (await call("/client/v1/pairing/claim", { method: "POST", value: { ...invitation, name: "iPad" } })).body;
    assert.equal((await call("/client/v1/pairing/exchange", { method: "POST", value: claim })).status, 403);
    await call("/internal/client-devices/approve", { local: true, token, method: "POST", value: { pairingId: invitation.pairingId, approved: true } });
    const creds = (await call("/client/v1/pairing/exchange", { method: "POST", value: claim })).body;
    assert.equal((await call("/client/v1/me", { token: creds.accessToken })).body.deviceId, creds.deviceId);
    assert.equal((await call("/client/v1/works?limit=1")).status, 401);
    for (const kind of ["works", "tasks", "sessions"]) {
      const page = await call(`/client/v1/${kind}?limit=1`, { token: creds.accessToken });
      assert.equal(page.status, 200);
      assert.equal(page.body.items[0].id, `${kind}:one`);
      assert.equal((await call(`/client/v1/${kind}`, { method: "POST", token: creds.accessToken, value: {} })).status, 404);
    }
    for (const path of ["/settings", "/state/snapshot", "/internal/client-devices", "/sessions/x/messages"]) {
      assert.equal((await call(path, { token: creds.accessToken })).status, 404);
    }
    assert.equal((await call("/client/v1/me", { token: creds.accessToken, headers: { "x-corptie-agent-id": "a" } })).status, 403);
    const messagesPath = "/client/v1/sessions/session%3Atest/messages";
    assert.equal((await call("/client/v1/control/agents", { token: creds.accessToken })).status, 403);
    assert.equal((await call("/client/v1/capabilities", { token: creds.accessToken })).body.controlRead, false);
    assert.equal((await call(messagesPath, { token: creds.accessToken })).status, 403);
    const grant = await call("/internal/client-devices/permissions", { local: true, token, method: "POST",
      value: { deviceId: creds.deviceId, permissions: ["inventory.read", "control.read", "messages.read", "messages.write", "sessions.stop"] } });
    assert.equal(grant.status, 200);
    for (const kind of ["automations", "repositories", "agents", "skills"]) {
      assert.equal((await call(`/client/v1/control/${kind}?limit=1`, { token: creds.accessToken })).body.items[0].id, `${kind}:one`);
      assert.equal((await call(`/client/v1/control/${kind}`, { method: "POST", token: creds.accessToken, value: {} })).status, 404);
    }
    assert.equal((await call("/client/v1/control/repositories/repo%3Aone", { token: creds.accessToken })).body.repository.id, "repo:one");
    assert.equal((await call("/client/v1/capabilities", { token: creds.accessToken })).body.controlRead, true);
    assert.equal((await call("/client/v1/capabilities", { token: creds.accessToken })).body.controlWrite, false);
    assert.equal((await call(messagesPath, { token: creds.accessToken })).body.sessionId, "session:test");
    const sent = await call(messagesPath, { token: creds.accessToken, method: "POST", value: { requestId: "request_123", text: "test" } });
    assert.equal(sent.status, 202);
    assert.equal(sent.body.kind, "send");
    assert.equal((await call("/client/v1/sessions/session%3Atest/stop", { token: creds.accessToken, method: "POST", value: { requestId: "stop_12345" } })).body.kind, "stop");
    assert.equal((await call("/client/v1/commands/request_123", { token: creds.accessToken })).body.requestId, "request_123");
    assert.equal((await call("/client/v1/events")).status, 401);
    const stream = await new Promise((resolve, reject) => {
      const req = https.get({ host: "127.0.0.1", servername: "localhost", port: address.port,
        path: "/client/v1/events", ca: cert, agent: false,
        headers: { authorization: `Bearer ${creds.accessToken}` } }, res => {
        res.once("data", chunk => {
          assert.match(chunk.toString(), /event: reset/);
          resolve(res);
        });
      });
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("stream timeout")));
    });
    const update = new Promise(resolve => stream.once("data", chunk => resolve(chunk.toString())));
    gateway.events.invalidate({ sessionId: "session:test", inventory: true }); gateway.events.flush();
    assert.match(await update, /session:test/);
    const streamClosed = new Promise(resolve => stream.once("close", resolve));
    const authenticatedSockets = [...gateway.sockets].filter(([, owner]) => owner === creds.deviceId).map(([socket]) => socket);
    assert.ok(authenticatedSockets.length > 0);
    await call("/internal/client-devices/revoke", { local: true, token, method: "POST", value: { deviceId: creds.deviceId } });
    assert.ok(authenticatedSockets.every(socket => socket.destroyed));
    await streamClosed;
    assert.equal((await call("/client/v1/me", { token: creds.accessToken })).status, 401);
  } finally {
    remoteAgent.destroy();
    await gateway.close();
    if (admin) await new Promise(resolve => admin.close(resolve));
    await f.close();
  }
});
