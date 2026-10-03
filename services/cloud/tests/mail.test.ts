import assert from "node:assert/strict";
import test from "node:test";
import { AccountRevocationEvents } from "../src/accountSecurity.js";
import { revokeAccountAfterPasswordReset } from "../src/auth.js";
import { openCloudDatabase } from "../src/database.js";
import { CloudDeviceService, createTestDeviceInput } from "../src/devices.js";
import { CloudMailer } from "../src/mail.js";

test("capture mailer keeps authentication mail local with Corptie branding", async () => {
  const database = openCloudDatabase(":memory:");
  try {
    const mailer = new CloudMailer({ mode: "capture" }, database);
    await mailer.sendVerification("Person@Example.Test", "https://corptie.example.test/verify?token=secret");
    await mailer.sendPasswordReset("person@example.test", "https://corptie.example.test/reset?token=secret");
    const messages = database.prepare(`
      SELECT kind, recipient, subject, text_body FROM cloud_mail_capture ORDER BY created_at, rowid
    `).all() as unknown as Array<{ kind: string; recipient: string; subject: string; text_body: string }>;
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.recipient, "person@example.test");
    assert.equal(messages.every((message) => message.subject.includes("Corptie")), true);
    assert.equal(messages.every((message) => message.text_body.includes("corptie.example.test")), true);
    await mailer.close();
  } finally {
    database.close();
  }
});

test("password recovery revokes devices, sessions, and active-account listeners immediately", () => {
  const database = openCloudDatabase(":memory:");
  try {
    const userId = "user:password-reset";
    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO user(id, name, email, emailVerified, createdAt, updatedAt)
      VALUES (?, 'Person', 'person@example.test', 1, ?, ?)
    `).run(userId, timestamp, timestamp);
    database.prepare(`
      INSERT INTO session(id, expiresAt, token, createdAt, updatedAt, userId)
      VALUES ('session:one', ?, 'secret-session-token', ?, ?, ?)
    `).run(new Date(Date.now() + 60_000).toISOString(), timestamp, timestamp, userId);
    const deviceService = new CloudDeviceService(database);
    deviceService.register(userId, "session:one", createTestDeviceInput());
    const events = new AccountRevocationEvents();
    const notified: string[] = [];
    events.subscribe((accountId) => notified.push(accountId));

    revokeAccountAfterPasswordReset(database, userId, events);
    assert.equal(deviceService.listForAccount(userId).every((device) => device.revokedAt !== null), true);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM session WHERE userId = ?").get(userId) as {
      count: number;
    }).count, 0);
    assert.deepEqual(notified, [userId]);
  } finally {
    database.close();
  }
});
