import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { createDeviceSetup, lanAddresses, prepareLocalTLS } from "../src/application/clientDeviceSetup.mjs";

test("LAN selection excludes public, VPN and loopback addresses", () => {
  const value = address => ({ address, family: "IPv4", internal: false });
  assert.deepEqual(lanAddresses({ en0: [value("192.168.1.2"), value("8.8.8.8")], utun0: [value("10.0.0.2")], lo0: [value("127.0.0.1")] }), ["192.168.1.2"]);
});

test("first use is disabled, enables real trusted TLS, restarts and disables without losing devices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-setup-test-"));
  let setup;
  try {
    setup = await createDeviceSetup({ directory, addresses: () => ["127.0.0.1"] });
    assert.equal(setup.state, "disabled");
    assert.equal(setup.server, undefined);
    const serverId = setup.authority.state.serverId;
    const begin = performance.now();
    await Promise.all([setup.enable(), setup.enable()]);
    console.log(`local TLS setup: ${Math.round(performance.now() - begin)} ms`);
    assert.equal(setup.state, "ready");
    const address = setup.address;
    const saved = JSON.parse(await readFile(join(directory, "local-tls.json")));
    assert.equal((await stat(join(directory, "local-tls.json"))).mode & 0o777, 0o600);
    const cert = new X509Certificate(saved.cert);
    assert.equal(cert.raw.toString("base64"), setup.certificate);
    const status = await new Promise((resolve, reject) => {
      https.get(`${address}/client/v1/me`, { ca: saved.cert }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    assert.equal(status, 401); // TLS trusted but device still requires pairing.
    const pin = setup.certificate;
    await setup.close();
    setup = await createDeviceSetup({ directory, addresses: () => ["127.0.0.1"] });
    assert.equal(setup.state, "ready");
    assert.equal(setup.address, address);
    assert.equal(setup.certificate, pin);
    assert.equal(setup.authority.state.serverId, serverId);
    await setup.disable();
    assert.equal(setup.server.listening, false);
    assert.equal(JSON.parse(await readFile(join(directory, "access.json"))).enabled, false);
    await setup.enable();
    assert.equal(setup.state, "ready");
    assert.equal(setup.certificate, pin);
    await setup.reset();
    assert.notEqual(setup.certificate, pin);
    assert.equal(setup.state, "ready");
  } finally { await setup?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("local setup actions require admin credentials and reject browser origins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-setup-test-"));
  const setup = await createDeviceSetup({ directory, addresses: () => ["127.0.0.1"] });
  const call = async (action, headers = {}) => {
    const response = { writeHead(status) { this.status = status; }, end(value) { this.value = JSON.parse(value); } };
    await setup.handleAdmin({ method: "POST", url: `/internal/client-devices/${action}`,
      headers, socket: { remoteAddress: "127.0.0.1" } }, response);
    return response;
  };
  try {
    assert.equal((await call("enable")).status, 403);
    const auth = { authorization: `Bearer ${setup.authority.adminToken}` };
    assert.equal((await call("enable", { ...auth, origin: "https://example.invalid" })).status, 403);
    assert.equal(setup.state, "disabled");
    assert.equal((await call("enable", auth)).status, 200);
    const invitation = (await call("invite", auth)).value;
    assert.equal(invitation.address, setup.address);
    assert.equal(invitation.certificate, setup.certificate);
    const claim = setup.authority.claim({ ...invitation, name: "Test" });
    await assert.rejects(setup.authority.exchange(claim), { code: "PAIRING_NOT_APPROVED" });
    setup.authority.approve(claim.pairingId, true);
    const credentials = await setup.authority.exchange(claim);
    assert.equal((await call("reset", auth)).status, 200);
    assert.throws(() => setup.authority.authenticate(credentials.accessToken), { code: "INVALID_CREDENTIAL" });
    assert.equal((await call("disable", auth)).status, 200);
    assert.equal((await call("invite", auth)).status, 409);
  } finally { await setup.close(); await rm(directory, { recursive: true, force: true }); }
});

test("preview never initializes authority; missing network and changed network fail closed", async () => {
  assert.equal(await createDeviceSetup({ directory: "/unused", preview: true }), null);
  const directory = await mkdtemp(join(tmpdir(), "corptie-setup-test-"));
  let setup;
  try {
    setup = await createDeviceSetup({ directory, addresses: () => [] });
    await assert.rejects(setup.enable(), { code: "LOCAL_NETWORK_UNAVAILABLE" });
    assert.equal(setup.state, "error");
    assert.equal(setup.server, undefined);
    await prepareLocalTLS(directory, ["127.0.0.1"]);
    await assert.rejects(prepareLocalTLS(directory, ["192.168.1.2"]), { code: "NETWORK_CHANGED" });
  } finally { await setup?.close(); await rm(directory, { recursive: true, force: true }); }
});
