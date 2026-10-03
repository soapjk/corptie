import assert from "node:assert/strict";
import test from "node:test";
import { openCloudDatabase } from "../src/database.js";
import {
  CloudDeviceService,
  DeviceConflictError,
  createTestDeviceInput
} from "../src/devices.js";

test("devices are account-isolated and cannot be claimed by another account", () => {
  const database = openCloudDatabase(":memory:");
  try {
    const service = new CloudDeviceService(database, () => new Date("2026-10-03T00:00:00.000Z"));
    const input = createTestDeviceInput();
    const device = service.register("account:a", "session:a", input);

    assert.equal(device.accountId, "account:a");
    assert.equal(service.listForAccount("account:b").length, 0);
    assert.throws(() => service.register("account:b", "session:b", input), DeviceConflictError);
  } finally {
    database.close();
  }
});

test("device revocation is durable, idempotent, and prevents identifier reuse", () => {
  const database = openCloudDatabase(":memory:");
  try {
    let now = new Date("2026-10-03T00:00:00.000Z");
    const service = new CloudDeviceService(database, () => now);
    const input = createTestDeviceInput();
    service.register("account:a", "session:a", input);

    now = new Date("2026-10-03T00:01:00.000Z");
    const first = service.revokeDevice("account:a", input.id);
    const second = service.revokeDevice("account:a", input.id);
    assert.equal(first.revokedAt, now.toISOString());
    assert.equal(second.authEpoch, 2);
    assert.throws(() => service.register("account:a", "session:a2", input), DeviceConflictError);
  } finally {
    database.close();
  }
});

test("account-wide recovery increments the account epoch and revokes every device", () => {
  const database = openCloudDatabase(":memory:");
  try {
    const service = new CloudDeviceService(database);
    service.register("account:a", "session:a", createTestDeviceInput());
    service.register("account:a", "session:b", createTestDeviceInput({
      publicKey: Buffer.alloc(32, 8).toString("base64")
    }));

    assert.equal(service.revokeAccount("account:a"), 2);
    assert.equal(service.listForAccount("account:a").every((device) => device.revokedAt !== null), true);
  } finally {
    database.close();
  }
});

test("one authorization session binds one active device and revocation invalidates its OAuth credentials", () => {
  const database = openCloudDatabase(":memory:");
  try {
    const service = new CloudDeviceService(database);
    const first = createTestDeviceInput();
    service.register("account:a", "session:a", first);
    assert.equal(service.getAuthorizedForAccount("account:a", first.id, "session:other"), null);
    assert.throws(
      () => service.register("account:a", "session:a", createTestDeviceInput()),
      DeviceConflictError
    );

    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO user(id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('account:a', 'A', 'a@example.test', 1, ?, ?)
    `).run(now, now);
    database.prepare(`
      INSERT INTO session(id, expiresAt, token, createdAt, updatedAt, userId)
      VALUES ('session:a', ?, 'session-token', ?, ?, 'account:a')
    `).run(new Date(Date.now() + 60_000).toISOString(), now, now);
    database.prepare(`
      INSERT INTO oauthClient(id, clientId, redirectUris)
      VALUES ('client:a', 'corptie-ios', '["corptie://oauth/callback"]')
    `).run();
    database.prepare(`
      INSERT INTO oauthRefreshToken(id, token, clientId, sessionId, userId, expiresAt, createdAt, scopes)
      VALUES ('refresh:a', 'refresh-token', 'corptie-ios', 'session:a', 'account:a', ?, ?, '[]')
    `).run(new Date(Date.now() + 60_000).toISOString(), now);

    service.revokeDevice("account:a", first.id);
    assert.equal(database.prepare(`SELECT id FROM session WHERE id = 'session:a'`).get(), undefined);
    const refresh = database.prepare(`SELECT revoked FROM oauthRefreshToken WHERE id = 'refresh:a'`).get() as { revoked: string };
    assert.equal(typeof refresh.revoked, "string");
    assert.equal(service.getAuthorizedForAccount("account:a", first.id, "session:a")?.revokedAt !== null, true);
  } finally {
    database.close();
  }
});
