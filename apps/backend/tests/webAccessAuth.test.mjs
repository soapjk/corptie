import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LanWebGateway } from "../src/http/lanWebGateway.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import {
  isCsrfValid,
  parseCookieHeader,
  serializeWebSessionCookie,
  WEB_SESSION_COOKIE,
  WebAccessAuth
} from "../src/webAccess/webAccessAuth.mjs";

async function withAuth(run) {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-web-auth-test-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  let now = Date.parse("2026-07-26T12:00:00.000Z");
  try {
    await store.initialize();
    const auth = new WebAccessAuth({ store, clock: () => now });
    await run({
      store,
      auth,
      advance: (durationMs) => { now += durationMs; }
    });
  } finally {
    await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

test("pairing requires Mac approval and stores only hashes of secrets", async () => {
  await withAuth(async ({ store, auth }) => {
    const pairingCode = auth.createPairingCode();
    assert.match(pairingCode.code, /^\d{6}$/);
    const storedCode = store.listUsableWebPairingCodes("2026-07-26T12:00:00.000Z")[0];
    assert.notEqual(storedCode.codeHash, pairingCode.code);

    const requested = auth.requestPairing({
      code: pairingCode.code,
      deviceName: "Alice's iPhone",
      permission: "reply"
    }, {
      userAgent: "Mobile Safari",
      sourceIp: "192.168.1.80"
    });
    const storedRequest = store.getWebPairingRequest(requested.requestId);
    assert.notEqual(storedRequest.exchangeTokenHash, requested.exchangeToken);
    assert.equal(auth.pendingRequests()[0].deviceName, "Alice's iPhone");

    assert.deepEqual(auth.claimRequest(requested.requestId, requested.exchangeToken), {
      status: "pending",
      expiresAt: requested.expiresAt
    });

    const approved = auth.approveRequest(requested.requestId, "reply");
    assert.equal(approved.status, "approved");
    const claimed = auth.claimRequest(requested.requestId, requested.exchangeToken);
    assert.equal(claimed.status, "approved");
    assert.equal(claimed.device.permission, "reply");
    const storedSession = store.selectOne("SELECT token_hash FROM web_sessions LIMIT 1");
    assert.match(storedSession.token_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(storedSession.token_hash, claimed.sessionToken);

    const session = auth.authenticate(claimed.sessionToken);
    assert.equal(session.device.name, "Alice's iPhone");
    assert.equal(isCsrfValid(session, claimed.csrfToken), true);
    assert.equal(isCsrfValid(session, "wrong"), false);

    const cookie = serializeWebSessionCookie(claimed.sessionToken);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal(parseCookieHeader(cookie)[WEB_SESSION_COOKIE], claimed.sessionToken);

    auth.revokeDevice(claimed.device.id);
    assert.throws(
      () => auth.authenticate(claimed.sessionToken),
      (error) => error.code === "AUTHENTICATION_EXPIRED"
    );
  });
});

test("pairing code is single-use and repeated invalid attempts exhaust it", async () => {
  await withAuth(async ({ auth }) => {
    const first = auth.createPairingCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.throws(
        () => auth.requestPairing({ code: "999999", deviceName: "Unknown" }),
        (error) => error.code === "PAIRING_CODE_INVALID"
      );
    }
    assert.throws(
      () => auth.requestPairing({ code: first.code, deviceName: "Too late" }),
      (error) => error.code === "PAIRING_CODE_INVALID"
    );

    const second = auth.createPairingCode();
    auth.requestPairing({ code: second.code, deviceName: "First device" });
    assert.throws(
      () => auth.requestPairing({ code: second.code, deviceName: "Second device" }),
      (error) => error.code === "PAIRING_CODE_INVALID"
    );
  });
});

test("disabling Web Access can revoke every device, session, and pending approval", async () => {
  await withAuth(async ({ auth }) => {
    const code = auth.createPairingCode();
    const first = auth.requestPairing({ code: code.code, deviceName: "Phone" });
    auth.approveRequest(first.requestId, "full-control");
    const claimed = auth.claimRequest(first.requestId, first.exchangeToken);
    assert.equal(auth.authenticate(claimed.sessionToken).device.name, "Phone");

    const pendingCode = auth.createPairingCode();
    auth.requestPairing({ code: pendingCode.code, deviceName: "Tablet" });
    assert.equal(auth.pendingRequests().length, 1);

    assert.equal(auth.revokeAllDevices(), 1);
    assert.equal(auth.listDevices().length, 0);
    assert.equal(auth.pendingRequests().length, 0);
    assert.throws(
      () => auth.authenticate(claimed.sessionToken),
      (error) => error.code === "AUTHENTICATION_EXPIRED"
    );
  });
});

test("LAN pairing issues a strict cookie and protects API routes", async () => {
  await withAuth(async ({ auth }) => {
    const gateway = new LanWebGateway({
      environmentName: "development",
      allowEphemeralPort: true,
      auth,
      logger: { info() {} }
    });
    try {
      await gateway.applySettings({ enabled: true, host: "127.0.0.1", port: 0 });
      const origin = `http://127.0.0.1:${gateway.status().port}`;
      const pairingCode = auth.createPairingCode();

      const requestedResponse = await fetch(`${origin}/pair/requests`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin
        },
        body: JSON.stringify({
          code: pairingCode.code,
          deviceName: "Test browser"
        })
      });
      assert.equal(requestedResponse.status, 202);
      const requested = await requestedResponse.json();
      auth.approveRequest(requested.requestId);

      const claimResponse = await fetch(`${origin}/pair/requests/${requested.requestId}/claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin
        },
        body: JSON.stringify({ exchangeToken: requested.exchangeToken })
      });
      assert.equal(claimResponse.status, 200);
      const claim = await claimResponse.json();
      const setCookie = claimResponse.headers.get("set-cookie");
      assert.match(setCookie, /corptie_web_session=/);
      const cookieHeader = setCookie.split(";")[0];

      const anonymous = await fetch(`${origin}/api/v1/bootstrap`);
      assert.equal(anonymous.status, 401);
      assert.equal((await anonymous.json()).error.code, "AUTHENTICATION_REQUIRED");

      const authenticated = await fetch(`${origin}/api/v1/bootstrap`, {
        headers: { cookie: cookieHeader }
      });
      assert.equal(authenticated.status, 503);

      const missingCsrf = await fetch(`${origin}/api/v1/sessions/example/actions`, {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          origin
        },
        body: "{}"
      });
      assert.equal(missingCsrf.status, 403);
      assert.equal((await missingCsrf.json()).error.code, "CSRF_INVALID");

      const withCsrf = await fetch(`${origin}/api/v1/sessions/example/actions`, {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          origin,
          "x-csrf-token": claim.csrfToken
        },
        body: "{}"
      });
      assert.equal(withCsrf.status, 503);

      auth.revokeDevice(claim.device.id);
      const revoked = await fetch(`${origin}/api/v1/bootstrap`, {
        headers: { cookie: cookieHeader }
      });
      assert.equal(revoked.status, 401);
    } finally {
      await gateway.close();
    }
  });
});
