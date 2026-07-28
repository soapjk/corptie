import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureWebAccessCertificate } from "../src/webAccess/webAccessTls.mjs";

test("local PKI keeps one root CA while rotating host-matched server certificates", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "corptie-tls-test-"));
  try {
    const dataPath = join(root, "corptie.sqlite");
    const first = await ensureWebAccessCertificate({ dataPath, host: "127.0.0.1" });
    assert.match(first.fingerprint, /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/);
    assert.match(first.leafFingerprint, /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/);
    assert.ok(Date.parse(first.expiresAt) > Date.now());
    assert.ok(Date.parse(first.leafExpiresAt) > Date.now());
    assert.match(first.key.toString(), /PRIVATE KEY/);
    assert.doesNotMatch(first.cert.toString(), /PRIVATE KEY/);
    assert.doesNotMatch(first.caCert.toString(), /PRIVATE KEY/);
    assert.equal(new X509Certificate(first.caCert).ca, true);
    assert.equal(new X509Certificate(first.cert).ca, false);
    assert.equal(new X509Certificate(first.cert).checkIP("127.0.0.1"), "127.0.0.1");
    const same = await ensureWebAccessCertificate({ dataPath, host: "127.0.0.1" });
    assert.equal(same.fingerprint, first.fingerprint);
    assert.equal(same.leafFingerprint, first.leafFingerprint);
    const rotated = await ensureWebAccessCertificate({ dataPath, host: "127.0.0.2" });
    assert.equal(rotated.fingerprint, first.fingerprint);
    assert.notEqual(rotated.leafFingerprint, first.leafFingerprint);
    assert.equal(new X509Certificate(rotated.cert).checkIP("127.0.0.2"), "127.0.0.2");
    assert.equal((await stat(rotated.certPath)).mode & 0o777, 0o600);
    assert.equal((await stat(rotated.caCertPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "web-access-pki", "root-key.pem"))).mode & 0o777, 0o600);
    assert.equal((await readFile(join(root, "web-access-pki", "lan-host.txt"), "utf8")).trim(), "127.0.0.2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
