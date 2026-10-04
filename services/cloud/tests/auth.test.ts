import assert from "node:assert/strict";
import test from "node:test";
import { createCloudAuth } from "../src/auth.js";
import type { CloudConfig } from "../src/config.js";
import { openCloudDatabase } from "../src/database.js";
import { CloudMailer } from "../src/mail.js";

const config: CloudConfig = {
  host: "127.0.0.1",
  port: 4310,
  databasePath: ":memory:",
  publicBaseUrl: "http://127.0.0.1:4310",
  authSecret: "7vQ!2mx9L#p4Az8Wc6Ty1Nk5Rs3Hd0Uf",
  adminToken: "8wR!3ny0M$q5Ba9Xd7Uz2Pm6St4Je1Vg",
  publicRegistration: true,
  trustedOrigins: ["http://127.0.0.1:4310"],
  logLevel: "error",
  maxJsonBytes: 65_536,
  relayMaxFrameBytes: 262_144,
  relayMaxQueuedBytes: 1_048_576,
  relayMaxConnectionsPerAccount: 20,
  relayHeartbeatMs: 30_000,
  version: "test",
  environment: "test",
  mail: { mode: "capture" }
};

test("public registration creates a credential account and requests email verification", async () => {
  const database = openCloudDatabase(":memory:");
  try {
    const mailer = new CloudMailer({ mode: "capture" }, database);
    const { auth } = createCloudAuth(config, database, { mailer });
    const response = await auth.handler(new Request("http://127.0.0.1:4310/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:4310" },
      body: JSON.stringify({ name: "Uninvited", email: "uninvited@example.test", password: "correct horse battery staple" })
    }));

    assert.equal(response.status, 200);
    const count = database.prepare('SELECT COUNT(*) AS count FROM "user"').get() as { count: number };
    assert.equal(count.count, 1);
    const mail = database.prepare("SELECT kind, recipient FROM cloud_mail_capture").get() as {
      kind: string;
      recipient: string;
    };
    assert.equal(mail.kind, "email_verification");
    assert.equal(mail.recipient, "uninvited@example.test");
    await mailer.close();
  } finally {
    database.close();
  }
});

test("public registration can be disabled by configuration", async () => {
  const database = openCloudDatabase(":memory:");
  try {
    const { auth } = createCloudAuth({ ...config, publicRegistration: false }, database);
    const response = await auth.handler(new Request("http://127.0.0.1:4310/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:4310" },
      body: JSON.stringify({ name: "Closed", email: "closed@example.test", password: "correct horse battery staple" })
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, "EMAIL_PASSWORD_SIGN_UP_DISABLED");
  } finally {
    database.close();
  }
});
