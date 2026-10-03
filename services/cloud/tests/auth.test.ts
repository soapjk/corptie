import assert from "node:assert/strict";
import test from "node:test";
import { createCloudAuth } from "../src/auth.js";
import type { CloudConfig } from "../src/config.js";
import { openCloudDatabase } from "../src/database.js";

const config: CloudConfig = {
  host: "127.0.0.1",
  port: 4310,
  databasePath: ":memory:",
  publicBaseUrl: "http://127.0.0.1:4310",
  authSecret: "7vQ!2mx9L#p4Az8Wc6Ty1Nk5Rs3Hd0Uf",
  adminToken: "8wR!3ny0M$q5Ba9Xd7Uz2Pm6St4Je1Vg",
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

test("generic Better Auth sign-up fails closed until invitation redemption is implemented", async () => {
  const database = openCloudDatabase(":memory:");
  try {
    const { auth } = createCloudAuth(config, database);
    const response = await auth.handler(new Request("http://127.0.0.1:4310/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:4310" },
      body: JSON.stringify({ name: "Uninvited", email: "uninvited@example.test", password: "correct horse battery staple" })
    }));

    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, "EMAIL_PASSWORD_SIGN_UP_DISABLED");
    const count = database.prepare('SELECT COUNT(*) AS count FROM "user"').get() as { count: number };
    assert.equal(count.count, 0);
  } finally {
    database.close();
  }
});
