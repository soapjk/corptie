import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClientDeviceAuthority } from "../src/application/clientDeviceAuthority.mjs";
import { ClientDeviceGateway } from "../src/application/clientDeviceGateway.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";

test("paired preparation keeps canonical scope and rejects changed authority after await", async () => {
  let identity = { deviceId: "device", accountId: "account" };
  const calls = [];
  const api = { preparations: {
    start: async id => { calls.push(id); identity = { ...identity, accountId: "changed" }; return { state: "queued" }; }
  }, inspector: { scope: () => ({ logicalSessionId: "logical", sessionId: "legacy" }) } };
  await assert.rejects(ClientSessionAPI.prototype.preparation.call(api, identity, "alias", "start", null,
    () => identity), { code: "AUTHORITY_CHANGED" });
  assert.deepEqual(calls, ["logical"]);
});

test("real paired HTTP preparation routes require credentials, closed body and reauthentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-preparation-device-"));
  const authority = new ClientDeviceAuthority(directory);
  let server;
  try {
    await authority.initialize();
    const invitation = authority.invite();
    const claim = authority.claim({ ...invitation, name: "Test device" });
    authority.approve(invitation.pairingId, true);
    const credentials = await authority.exchange(claim);
    const calls = [];
    let revoke = false;
    const api = { inspector: { scope: () => ({ logicalSessionId: "logical", sessionId: "legacy" }) },
      preparations: {
        start: async id => {
          calls.push(["start", id]);
          if (revoke) await authority.revoke(credentials.deviceId);
          return { id: "attempt", state: "queued" };
        },
        current: async id => { calls.push(["current", id]); return null; },
        cancel: async (...args) => { calls.push(["cancel", ...args]); return { state: "cancelled" }; }
      } };
    api.preparation = (...args) => ClientSessionAPI.prototype.preparation.call(api, ...args);
    const gateway = new ClientDeviceGateway(authority, { sessionAPI: api });
    server = http.createServer((request, response) => void gateway.handle(request, response));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}/client/v1/sessions/alias/preparation`;
    const headers = { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" };
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { method: "POST", headers, body: '{"identity":"fake"}' })).status, 400);
    assert.equal(calls.length, 0);
    const start = await fetch(base, { method: "POST", headers, body: "{}" });
    assert.equal(start.status, 202);
    assert.equal((await start.json()).schemaVersion, 1);
    assert.equal((await fetch(base, { headers })).status, 200);
    assert.equal((await fetch(base + "/attempt/cancel", { method: "POST", headers, body: "{}" })).status, 200);
    assert.deepEqual(calls, [["start", "logical"], ["current", "logical"], ["cancel", "logical", "attempt"]]);
    revoke = true;
    const revoked = await fetch(base, { method: "POST", headers, body: "{}" });
    assert.ok([401, 403].includes(revoked.status));
    assert.equal((await revoked.json()).preparation, undefined);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
