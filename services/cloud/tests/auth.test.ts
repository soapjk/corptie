import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import { createCloudApplication } from "../src/application.js";
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
      body: JSON.stringify({
        name: "Uninvited",
        email: "uninvited@example.test",
        password: "correct horse battery staple",
        callbackURL: "http://127.0.0.1:4310/auth/verified"
      })
    }));

    assert.equal(response.status, 200);
    const count = database.prepare('SELECT COUNT(*) AS count FROM "user"').get() as { count: number };
    assert.equal(count.count, 1);
    const mail = database.prepare("SELECT kind, recipient, text_body FROM cloud_mail_capture").get() as {
      kind: string;
      recipient: string;
      text_body: string;
    };
    assert.equal(mail.kind, "email_verification");
    assert.equal(mail.recipient, "uninvited@example.test");
    const verificationUrl = mail.text_body.match(/https?:\/\/\S+/)?.[0];
    assert.ok(verificationUrl);
    assert.equal(new URL(verificationUrl).searchParams.get("callbackURL"), "http://127.0.0.1:4310/auth/verified");

    const verification = await auth.handler(new Request(verificationUrl));
    assert.equal(verification.status, 302);
    assert.equal(verification.headers.get("location"), "http://127.0.0.1:4310/auth/verified");
    const user = database.prepare('SELECT emailVerified FROM "user" WHERE email = ?').get("uninvited@example.test") as {
      emailVerified: number;
    };
    assert.equal(user.emailVerified, 1);
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

test("unverified sign-in uses a dedicated verification resend callback", async () => {
  const database = openCloudDatabase(":memory:");
  const mailer = new CloudMailer({ mode: "capture" }, database);
  try {
    const { auth } = createCloudAuth(config, database, { mailer });
    const headers = { "content-type": "application/json", origin: "http://127.0.0.1:4310" };
    const signUp = await auth.handler(new Request("http://127.0.0.1:4310/api/auth/sign-up/email", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Pending",
        email: "pending@example.test",
        password: "correct horse battery staple",
        callbackURL: "http://127.0.0.1:4310/auth/verified"
      })
    }));
    assert.equal(signUp.status, 200);
    database.exec("DELETE FROM cloud_mail_capture");

    const signIn = await auth.handler(new Request("http://127.0.0.1:4310/api/auth/sign-in/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "pending@example.test", password: "correct horse battery staple" })
    }));
    assert.equal(signIn.status, 403);
    assert.equal((await signIn.json() as { code: string }).code, "EMAIL_NOT_VERIFIED");
    const automaticMailCount = database.prepare("SELECT COUNT(*) AS count FROM cloud_mail_capture").get() as { count: number };
    assert.equal(automaticMailCount.count, 0);

    const resend = await auth.handler(new Request("http://127.0.0.1:4310/api/auth/send-verification-email", {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: "pending@example.test",
        callbackURL: "http://127.0.0.1:4310/auth/verified"
      })
    }));
    assert.equal(resend.status, 200);
    const mail = database.prepare("SELECT text_body FROM cloud_mail_capture").get() as { text_body: string };
    const verificationUrl = mail.text_body.match(/https?:\/\/\S+/)?.[0];
    assert.ok(verificationUrl);
    assert.equal(new URL(verificationUrl).searchParams.get("callbackURL"), "http://127.0.0.1:4310/auth/verified");
  } finally {
    await mailer.close();
    database.close();
  }
});

test("native OAuth bearer token can register and list its Cloud device", async () => {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const localConfig = { ...config, port: address.port, publicBaseUrl: baseUrl, trustedOrigins: [baseUrl] };
  const database = openCloudDatabase(":memory:");
  const mailer = new CloudMailer({ mode: "capture" }, database);
  const cloudAuth = createCloudAuth(localConfig, database, { mailer });
  const application = createCloudApplication({
    config: localConfig,
    database,
    auth: cloudAuth.auth,
    resolvePrincipal: cloudAuth.resolvePrincipal,
    provisionInvitedUser: cloudAuth.provisionInvitedUser,
    verifyOAuthPageQuery: cloudAuth.verifyOAuthPageQuery
  });
  try {
    await application.listen();
    const email = "device-login@example.test";
    const password = "correct horse battery staple";
    const headers = { "content-type": "application/json", origin: baseUrl };
    const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST", headers, body: JSON.stringify({ name: "Device", email, password })
    });
    assert.equal(signUp.status, 200);
    database.prepare('UPDATE "user" SET emailVerified = 1 WHERE email = ?').run(email);
    const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST", headers, body: JSON.stringify({ email, password })
    });
    assert.equal(signIn.status, 200);
    const cookie = signIn.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
    assert.ok(cookie);
    const verifier = "a".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      client_id: "corptie-ios", redirect_uri: "corptie://oauth/callback", response_type: "code",
      scope: "openid profile email offline_access devices:read devices:write",
      resource: `${baseUrl}/v1`, code_challenge: challenge, code_challenge_method: "S256", state: "b".repeat(43)
    });
    const authorization = await fetch(`${baseUrl}/api/auth/oauth2/authorize?${query}`, {
      headers: { cookie }, redirect: "manual"
    });
    assert.equal(authorization.status, 200);
    const callback = new URL((await authorization.json() as { url: string }).url);
    assert.equal(callback.protocol, "corptie:");
    const code = callback.searchParams.get("code");
    assert.ok(code);
    const token = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: "corptie-ios", code,
        redirect_uri: "corptie://oauth/callback", code_verifier: verifier, resource: `${baseUrl}/v1`
      })
    });
    assert.equal(token.status, 200);
    const accessToken = (await token.json() as { access_token: string }).access_token;
    assert.ok(accessToken);
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString("utf8")) as {
      aud: string[]; iss: string; sid: string; scope: string;
    };
    assert.ok(claims.aud.includes(`${baseUrl}/v1`));
    assert.equal(claims.iss, `${baseUrl}/api/auth`);
    assert.ok(claims.sid);
    await cloudAuth.resolvePrincipal(new Request(`${baseUrl}/v1/devices`, {
      headers: { authorization: `Bearer ${accessToken}` }
    }), ["devices:write"]);
    const device = {
      id: "a64d49ad-eb0f-44bc-bfe8-048b7cf79d96", kind: "mobile",
      displayName: "Test iPhone", publicKeyAlgorithm: "X25519", publicKey: Buffer.alloc(32, 7).toString("base64")
    };
    const registered = await fetch(`${baseUrl}/v1/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(device)
    });
    assert.equal(registered.status, 201, JSON.stringify(await registered.json()));
    const listed = await fetch(`${baseUrl}/v1/devices`, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    assert.equal(listed.status, 200, JSON.stringify(await listed.json()));
    const tampered = await fetch(`${baseUrl}/v1/devices`, {
      headers: { authorization: `Bearer ${accessToken.slice(0, -2)}aa` }
    });
    assert.equal(tampered.status, 401);
  } finally {
    await application.close();
    await mailer.close();
    database.close();
  }
});
