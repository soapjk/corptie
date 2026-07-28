import assert from "node:assert/strict";
import https from "node:https";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LanWebGateway } from "../src/http/lanWebGateway.mjs";
import { ensureWebAccessCertificate } from "../src/webAccess/webAccessTls.mjs";
import {
  defaultWebAccessPort,
  listLanAddresses,
  normalizeWebAccessSettings
} from "../src/utils/webAccessSettings.mjs";

test("Web Access is disabled by default and uses isolated environment ports", () => {
  assert.deepEqual(normalizeWebAccessSettings({}, { environmentName: "production" }), {
    enabled: false,
    host: "",
    port: 47323,
    httpsEnabled: true
  });
  assert.deepEqual(normalizeWebAccessSettings({}, { environmentName: "development" }), {
    enabled: false,
    host: "",
    port: 47324,
    httpsEnabled: true
  });
  assert.notEqual(
    defaultWebAccessPort("production"),
    defaultWebAccessPort("development")
  );
});

test("Web Access requires one explicit interface and rejects wildcard binding", () => {
  assert.throws(() => normalizeWebAccessSettings({
    enabled: true,
    host: "",
    port: 47323
  }), /explicit network interface/);
  assert.throws(() => normalizeWebAccessSettings({
    enabled: true,
    host: "0.0.0.0",
    port: 47323
  }), /cannot bind every network interface/);
  assert.throws(() => normalizeWebAccessSettings({
    enabled: true,
    host: "corptie.local",
    port: 47323
  }), /explicit IPv4 or IPv6/);
  assert.throws(() => normalizeWebAccessSettings({
    enabled: true,
    host: "127.0.0.1",
    port: 47323
  }, { rejectLoopback: true }), /cannot use a loopback address/);
  assert.deepEqual(normalizeWebAccessSettings({
    enabled: true,
    host: "127.0.0.1",
    port: 47323
  }), {
    enabled: false,
    host: "",
    port: 47323,
    httpsEnabled: true
  });
});

test("LAN address discovery excludes loopback, link-local, and virtual interfaces", () => {
  assert.deepEqual(listLanAddresses({
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    utun4: [{ address: "10.20.30.40", family: "IPv4", internal: false }],
    en0: [
      { address: "169.254.1.2", family: "IPv4", internal: false },
      { address: "192.168.1.25", family: "IPv4", internal: false }
    ],
    en1: [{ address: "10.0.0.8", family: 4, internal: false }]
  }), ["192.168.1.25", "10.0.0.8"]);
});

test("LAN listener serves HTTPS with downloadable local root CA formats", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "corptie-https-gateway-test-"));
  const gateway = new LanWebGateway({
    environmentName: "development",
    allowEphemeralPort: true,
    logger: { info: () => {} },
    auth: {
      requestPairing: () => ({
        requestId: "request-https",
        exchangeToken: "exchange-https",
        status: "pending",
        expiresAt: "2026-07-26T12:10:00.000Z"
      }),
      claimRequest: () => ({
        status: "approved",
        sessionToken: "session-https",
        csrfToken: "csrf-https",
        device: { id: "device-https", name: "Phone", permission: "reply" },
        expiresAt: "2026-08-26T12:10:00.000Z"
      })
    },
    tlsProvider: ({ host }) => ensureWebAccessCertificate({
      dataPath: join(root, "corptie.sqlite"),
      host
    })
  });

  try {
    const status = await gateway.applySettings({
      enabled: true,
      host: "127.0.0.1",
      port: 0
    });
    assert.equal(status.secure, true);
    assert.equal(status.certificate.type, "local-ca");
    assert.match(status.certificate.fingerprint, /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/);
    assert.match(status.certificate.leafFingerprint, /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/);
    const health = await insecureHttpsGet(`https://127.0.0.1:${status.port}/health`);
    assert.equal(health.statusCode, 200);
    assert.equal(JSON.parse(health.body).service, "corptie-lan-web-gateway");
    const certificate = await insecureHttpsGet(`https://127.0.0.1:${status.port}/pair/certificate`);
    assert.equal(certificate.statusCode, 200);
    assert.match(certificate.headers["content-type"], /^application\/x-pem-file/);
    assert.match(certificate.body, /BEGIN CERTIFICATE/);
    assert.doesNotMatch(certificate.body, /PRIVATE KEY/);
    const appleProfile = await insecureHttpsGet(`https://127.0.0.1:${status.port}/pair/certificate.mobileconfig`);
    assert.equal(appleProfile.statusCode, 200);
    assert.match(appleProfile.headers["content-type"], /^application\/x-apple-aspen-config/);
    assert.match(appleProfile.body, /com\.apple\.security\.root/);
    assert.match(appleProfile.body, /Corptie Local Root CA/);
    const derCertificate = await insecureHttpsGet(`https://127.0.0.1:${status.port}/pair/certificate.cer`);
    assert.equal(derCertificate.statusCode, 200);
    assert.match(derCertificate.headers["content-type"], /^application\/x-x509-ca-cert/);
    const origin = `https://127.0.0.1:${status.port}`;
    const requested = await insecureHttpsRequest(`${origin}/pair/requests`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code: "123456", deviceName: "Phone" })
    });
    assert.equal(requested.statusCode, 202);
    const claim = await insecureHttpsRequest(`${origin}/pair/requests/request-https/claim`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ exchangeToken: "exchange-https" })
    });
    assert.equal(claim.statusCode, 200);
    assert.match(claim.headers["set-cookie"][0], /;\s*Secure/);
    assert.match(claim.headers["set-cookie"][0], /;\s*HttpOnly/);
    assert.match(claim.headers["set-cookie"][0], /;\s*SameSite=Strict/);
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTPS can be disabled explicitly even when a TLS provider is configured", async () => {
  let tlsRequests = 0;
  const gateway = new LanWebGateway({
    environmentName: "development",
    allowEphemeralPort: true,
    logger: { info: () => {} },
    tlsProvider: () => {
      tlsRequests += 1;
      throw new Error("TLS should not be requested");
    }
  });
  try {
    const status = await gateway.applySettings({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      httpsEnabled: false
    });
    assert.equal(status.secure, false);
    assert.equal(status.certificate, null);
    assert.equal(tlsRequests, 0);
    const response = await fetch(`http://127.0.0.1:${status.port}/health`);
    assert.equal(response.status, 200);
  } finally {
    await gateway.close();
  }
});

test("LAN listener exposes only its health and reserved Web surface", async () => {
  const logs = [];
  const gateway = new LanWebGateway({
    environmentName: "development",
    allowEphemeralPort: true,
    logger: { info: (message) => logs.push(message) }
  });

  try {
    assert.equal(gateway.status().listening, false);
    await gateway.applySettings({
      enabled: true,
      host: "127.0.0.1",
      port: 0
    });
    const status = gateway.status();
    assert.equal(status.listening, true);
    assert.ok(status.port > 0);
    assert.match(logs[0], /^\[lan-web\] listening on http:\/\/127\.0\.0\.1:/);

    const origin = `http://127.0.0.1:${status.port}`;
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "corptie-lan-web-gateway");
    assert.equal(health.headers.get("access-control-allow-origin"), null);
    assert.equal(health.headers.get("x-frame-options"), "DENY");

    for (const legacyPath of ["/settings", "/sessions", "/events", "/codex/models"]) {
      const response = await fetch(`${origin}${legacyPath}`);
      assert.equal(response.status, 404, legacyPath);
    }

    const reservedApi = await fetch(`${origin}/api/v1/bootstrap`);
    assert.equal(reservedApi.status, 401);
    assert.equal((await reservedApi.json()).error.code, "AUTHENTICATION_REQUIRED");

    await gateway.applySettings({ enabled: false, host: "", port: 47324 });
    assert.equal(gateway.status().listening, false);
    await assert.rejects(fetch(`${origin}/health`));
  } finally {
    await gateway.close();
  }
});

test("LAN listener routes authenticated API v1 requests without exposing legacy settings", async () => {
  const webSession = {
    csrfToken: "csrf-1",
    device: { id: "device-1", name: "Phone", permission: "full-control" }
  };
  const gateway = new LanWebGateway({
    environmentName: "development",
    allowEphemeralPort: true,
    logger: { info: () => {} },
    auth: {
      authenticate: (token) => {
        assert.equal(token, "session-token");
        return webSession;
      }
    },
    api: {
      bootstrap: (session) => ({ apiVersion: "1", deviceId: session.device.id }),
      sessions: () => ({ apiVersion: "1", sessions: [] }),
      session: async (id) => ({ apiVersion: "1", session: { id } }),
      action: async (id, input, context) => ({
        apiVersion: "1",
        operationId: context.idempotencyKey,
        status: "succeeded",
        sessionId: id,
        action: input.action
      })
    }
  });

  try {
    await gateway.applySettings({ enabled: true, host: "127.0.0.1", port: 0 });
    const { port } = gateway.status();
    const origin = `http://127.0.0.1:${port}`;
    const headers = { cookie: "corptie_web_session=session-token" };

    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers });
    assert.equal(bootstrap.status, 200);
    assert.equal((await bootstrap.json()).deviceId, "device-1");

    const action = await fetch(`${origin}/api/v1/sessions/codex%3A1/actions`, {
      method: "POST",
      headers: {
        ...headers,
        origin,
        "content-type": "application/json",
        "x-csrf-token": "csrf-1",
        "idempotency-key": "operation-1"
      },
      body: JSON.stringify({ action: "session.interrupt", payload: {} })
    });
    assert.equal(action.status, 200);
    assert.deepEqual(await action.json(), {
      apiVersion: "1",
      operationId: "operation-1",
      status: "succeeded",
      sessionId: "codex:1",
      action: "session.interrupt"
    });

    assert.equal((await fetch(`${origin}/settings`, { headers })).status, 404);
  } finally {
    await gateway.close();
  }
});

test("API v1 event stream replays from a cursor and closes after device revocation", async () => {
  let authorized = true;
  let listener = null;
  const events = [{
    schemaVersion: 1,
    eventId: 3,
    serverTime: "2026-07-26T12:00:00.000Z",
    type: "SessionProgressChanged",
    sessionId: "codex:1",
    sessionRevision: 2,
    payload: { progress: 0.5 }
  }];
  const gateway = new LanWebGateway({
    environmentName: "development",
    allowEphemeralPort: true,
    eventAuthCheckIntervalMs: 20,
    logger: { info: () => {} },
    auth: {
      authenticate: () => {
        if (!authorized) {
          const error = new Error("revoked");
          error.code = "AUTHENTICATION_EXPIRED";
          throw error;
        }
        return { csrfToken: "csrf", device: { id: "device-1", permission: "full-control" } };
      }
    },
    api: {
      events: (cursor) => events.filter((event) => event.eventId > cursor),
      subscribe: (next) => {
        listener = next;
        return () => { listener = null; };
      }
    }
  });

  try {
    await gateway.applySettings({ enabled: true, host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${origin}/api/v1/events?cursor=2`, {
      headers: { cookie: "corptie_web_session=session-token" }
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    const reader = response.body.getReader();
    const first = await readStreamUntil(reader, /id: 3/);
    assert.match(first, /retry: 2000/);
    assert.match(first, /"schemaVersion":1/);

    listener({ ...events[0], eventId: 4, sessionRevision: 3 });
    const live = await readStreamUntil(reader, /id: 4/);
    assert.match(live, /id: 4/);

    authorized = false;
    const closed = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("stream did not close")), 500))
    ]);
    assert.equal(closed.done, true);
    assert.equal(listener, null);
  } finally {
    await gateway.close();
  }
});

async function readStreamUntil(reader, pattern) {
  const decoder = new TextDecoder();
  let text = "";
  for (let chunk = 0; chunk < 20; chunk += 1) {
    const result = await reader.read();
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
    if (pattern.test(text)) return text;
  }
  throw new Error(`Stream did not contain ${pattern}`);
}

function insecureHttpsGet(url) {
  return insecureHttpsRequest(url);
}

function insecureHttpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      rejectUnauthorized: false,
      method: options.method ?? "GET",
      headers: options.headers
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

test("LAN listener serves the built SPA and deep links from its local Web root", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-web-root-test-"));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Corptie Web</title>");
  await writeFile(join(directory, "assets", "app.js"), "globalThis.corptie = true;");
  const gateway = new LanWebGateway({
    environmentName: "development",
    allowEphemeralPort: true,
    webRoot: directory,
    logger: { info: () => {} }
  });

  try {
    await gateway.applySettings({ enabled: true, host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${gateway.status().port}`;
    const home = await fetch(origin);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Corptie Web/);
    assert.match(home.headers.get("content-security-policy"), /default-src 'self'/);

    const deepLink = await fetch(`${origin}/sessions/codex%3Athread`);
    assert.equal(deepLink.status, 200);
    assert.match(await deepLink.text(), /Corptie Web/);

    const asset = await fetch(`${origin}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control"), /immutable/);
    assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});
