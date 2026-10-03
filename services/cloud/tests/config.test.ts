import assert from "node:assert/strict";
import test from "node:test";
import { loadCloudConfig } from "../src/config.js";

const validEnvironment = {
  CORPTIE_CLOUD_DATABASE_PATH: ":memory:",
  CORPTIE_CLOUD_PUBLIC_BASE_URL: "https://corptie.example.test",
  CORPTIE_CLOUD_AUTH_SECRET: "a".repeat(32),
  CORPTIE_CLOUD_ADMIN_TOKEN: "b".repeat(32),
  CORPTIE_CLOUD_TRUSTED_ORIGINS: "https://corptie.example.test,corptie://oauth"
};

test("loads strict Cloud configuration without exposing implicit public bindings", () => {
  const config = loadCloudConfig(validEnvironment);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4310);
  assert.deepEqual(config.trustedOrigins, ["https://corptie.example.test", "corptie://oauth"]);
});

test("rejects insecure non-loopback public URLs", () => {
  assert.throws(
    () => loadCloudConfig({ ...validEnvironment, CORPTIE_CLOUD_PUBLIC_BASE_URL: "http://corptie.example.test" }),
    /HTTPS/
  );
});

test("rejects short secrets and base URLs with paths", () => {
  assert.throws(() => loadCloudConfig({ ...validEnvironment, CORPTIE_CLOUD_AUTH_SECRET: "short" }));
  assert.throws(
    () => loadCloudConfig({ ...validEnvironment, CORPTIE_CLOUD_PUBLIC_BASE_URL: "https://corptie.example.test/auth" }),
    /must not include a path/
  );
});

test("production fails closed without complete SMTP configuration", () => {
  assert.throws(() => loadCloudConfig({ ...validEnvironment, CORPTIE_CLOUD_ENV: "production" }), /requires.*smtp/i);
  assert.throws(() => loadCloudConfig({
    ...validEnvironment,
    CORPTIE_CLOUD_ENV: "production",
    CORPTIE_CLOUD_MAIL_MODE: "smtp",
    CORPTIE_CLOUD_SMTP_HOST: "smtp.example.test"
  }), /requires host, port, secure, user, pass, and from/);
  const config = loadCloudConfig({
    ...validEnvironment,
    CORPTIE_CLOUD_ENV: "production",
    CORPTIE_CLOUD_MAIL_MODE: "smtp",
    CORPTIE_CLOUD_SMTP_HOST: "smtp.example.test",
    CORPTIE_CLOUD_SMTP_PORT: "465",
    CORPTIE_CLOUD_SMTP_SECURE: "true",
    CORPTIE_CLOUD_SMTP_USER: "corptie",
    CORPTIE_CLOUD_SMTP_PASS: "secret",
    CORPTIE_CLOUD_SMTP_FROM: "Corptie <no-reply@example.test>"
  });
  assert.equal(config.mail.mode, "smtp");
});
