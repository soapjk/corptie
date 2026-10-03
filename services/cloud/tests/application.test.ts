import assert from "node:assert/strict";
import test from "node:test";
import { createCloudApplication } from "../src/application.js";
import { createCloudAuth, type CloudPrincipal } from "../src/auth.js";
import type { CloudConfig } from "../src/config.js";
import { openCloudDatabase } from "../src/database.js";
import { createTestDeviceInput } from "../src/devices.js";
import { CloudDeviceService } from "../src/devices.js";

const config: CloudConfig = {
  host: "127.0.0.1",
  port: 0,
  databasePath: ":memory:",
  publicBaseUrl: "http://127.0.0.1",
  authSecret: "7vQ!2mx9L#p4Az8Wc6Ty1Nk5Rs3Hd0Uf",
  adminToken: "8wR!3ny0M$q5Ba9Xd7Uz2Pm6St4Je1Vg",
  publicRegistration: true,
  trustedOrigins: ["https://trusted.example.test"],
  logLevel: "error",
  maxJsonBytes: 65_536,
  relayMaxFrameBytes: 262_144,
  relayMaxQueuedBytes: 1_048_576,
  relayMaxConnectionsPerAccount: 20,
  relayHeartbeatMs: 30_000,
  version: "test-revision",
  environment: "test",
  mail: { mode: "capture" }
};

test("HTTP control plane keeps device inventory isolated by authenticated account", async () => {
  const database = openCloudDatabase(":memory:");
  const observedScopes: string[][] = [];
  const now = new Date("2026-10-03T00:10:00.000Z");
  const application = createCloudApplication({
    config,
    database,
    auth: { handler: async () => Response.json({ code: "unused" }, { status: 404 }) },
    provisionInvitedUser: async () => { throw new Error("unused"); },
    resolvePrincipal: async (request, scopes): Promise<CloudPrincipal> => {
      observedScopes.push([...scopes]);
      const accountId = request.headers.get("x-test-account");
      if (!accountId) throw new Error("test account is required");
      return {
        accountId,
        authorizationSessionId: request.headers.get("x-test-session") ?? `session:${accountId}`,
        scopes: new Set(scopes),
        reauthenticatedAt: request.headers.get("x-test-reauth") === "fresh"
          ? new Date(now.getTime() - 60_000)
          : new Date(now.getTime() - 10 * 60_000)
      };
    },
    now: () => now
  });

  try {
    const address = await application.listen();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${baseUrl}/healthz`);
    assert.deepEqual(await health.json(), { status: "ok", version: "test-revision" });

    const input = createTestDeviceInput();
    const created = await fetch(`${baseUrl}/v1/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-account": "account:a" },
      body: JSON.stringify(input)
    });
    assert.equal(created.status, 201);

    const otherAccount = await fetch(`${baseUrl}/v1/devices`, {
      headers: { "x-test-account": "account:b" }
    });
    assert.deepEqual(await otherAccount.json(), { devices: [] });

    const staleRevoke = await fetch(`${baseUrl}/v1/devices/${input.id}`, {
      method: "DELETE",
      headers: { "x-test-account": "account:a" }
    });
    assert.equal(staleRevoke.status, 403);
    assert.equal((await staleRevoke.json() as { code: string }).code, "RECENT_AUTHENTICATION_REQUIRED");

    const revoked = await fetch(`${baseUrl}/v1/devices/${input.id}`, {
      method: "DELETE",
      headers: { "x-test-account": "account:a", "x-test-reauth": "fresh" }
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(observedScopes, [
      ["devices:write"],
      ["devices:read"],
      ["devices:manage"],
      ["devices:manage"]
    ]);
  } finally {
    await application.close();
    database.close();
  }
});

test("HTTP control plane rejects untrusted browser origins before authorization", async () => {
  const database = openCloudDatabase(":memory:");
  let resolverCalled = false;
  const application = createCloudApplication({
    config,
    database,
    auth: { handler: async () => new Response(null, { status: 404 }) },
    provisionInvitedUser: async () => { throw new Error("unused"); },
    resolvePrincipal: async () => {
      resolverCalled = true;
      throw new Error("must not be called");
    }
  });
  try {
    const address = await application.listen();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/devices`, {
      headers: { origin: "https://evil.example.test" }
    });
    assert.equal(response.status, 403);
    assert.equal(resolverCalled, false);
  } finally {
    await application.close();
    database.close();
  }
});

test("administration endpoint creates an invitation that provisions a Better Auth credential account", async () => {
  const database = openCloudDatabase(":memory:");
  const cloudAuth = createCloudAuth(config, database);
  const application = createCloudApplication({
    config,
    database,
    auth: cloudAuth.auth,
    resolvePrincipal: cloudAuth.resolvePrincipal,
    provisionInvitedUser: cloudAuth.provisionInvitedUser,
    now: () => new Date("2026-10-03T00:00:00.000Z")
  });
  try {
    const address = await application.listen();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const denied = await fetch(`${baseUrl}/v1/admin/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ maxUses: 1, expiresAt: "2026-10-04T00:00:00.000Z" })
    });
    assert.equal(denied.status, 401);

    const created = await fetch(`${baseUrl}/v1/admin/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.adminToken}` },
      body: JSON.stringify({ maxUses: 1, expiresAt: "2026-10-04T00:00:00.000Z" })
    });
    assert.equal(created.status, 201);
    const code = (await created.json() as { invitation: { code: string } }).invitation.code;

    const redeemed = await fetch(`${baseUrl}/v1/invitations/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        email: "Invited@Example.Test",
        name: "Invited User",
        password: "correct horse battery staple"
      })
    });
    assert.equal(redeemed.status, 201);
    const body = await redeemed.json() as { user: { id: string; email: string; emailVerified: boolean } };
    assert.equal(body.user.email, "invited@example.test");
    assert.equal(body.user.emailVerified, false);
    const account = database.prepare(`
      SELECT providerId, accountId, password FROM account WHERE userId = ?
    `).get(body.user.id) as { providerId: string; accountId: string; password: string };
    assert.equal(account.providerId, "credential");
    assert.equal(account.accountId, body.user.id);
    assert.notEqual(account.password, "correct horse battery staple");
  } finally {
    await application.close();
    database.close();
  }
});

test("administration endpoint deletes an account and all Cloud device access", async () => {
  const database = openCloudDatabase(":memory:");
  const userId = "user:delete-me";
  const timestamp = new Date().toISOString();
  database.prepare(`
    INSERT INTO "user"(id, name, email, emailVerified, createdAt, updatedAt)
    VALUES (?, 'Delete Me', 'delete@example.test', 1, ?, ?)
  `).run(userId, timestamp, timestamp);
  database.prepare(`
    INSERT INTO "session"(id, expiresAt, token, createdAt, updatedAt, userId)
    VALUES ('session:delete', ?, 'session-token-delete', ?, ?, ?)
  `).run(new Date(Date.now() + 60_000).toISOString(), timestamp, timestamp, userId);
  database.prepare(`
    INSERT INTO "account"(id, accountId, providerId, userId, password, createdAt, updatedAt)
    VALUES ('account:delete', ?, 'credential', ?, 'password-hash', ?, ?)
  `).run(userId, userId, timestamp, timestamp);
  new CloudDeviceService(database).register(userId, "session:delete", createTestDeviceInput());
  const application = createCloudApplication({
    config,
    database,
    auth: { handler: async () => new Response(null, { status: 404 }) },
    provisionInvitedUser: async () => { throw new Error("unused"); },
    resolvePrincipal: async () => { throw new Error("unused"); }
  });
  try {
    const address = await application.listen();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/admin/accounts`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.adminToken}` },
      body: JSON.stringify({ email: "Delete@Example.Test" })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true, email: "delete@example.test" });
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM "user" WHERE id = ?').get(userId) as { count: number }).count, 0);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM "session" WHERE userId = ?').get(userId) as { count: number }).count, 0);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM "account" WHERE userId = ?').get(userId) as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM cloud_devices WHERE account_id = ?").get(userId) as { count: number }).count, 0);
  } finally {
    await application.close();
    database.close();
  }
});
