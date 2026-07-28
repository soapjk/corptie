import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  X509Certificate
} from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT_VALIDITY_DAYS = 3650;
const LEAF_VALIDITY_DAYS = 90;
const ROOT_RENEWAL_WINDOW_SECONDS = 90 * 86400;
const LEAF_RENEWAL_WINDOW_SECONDS = 14 * 86400;

export async function ensureWebAccessCertificate({ dataPath, host, clock = () => new Date() }) {
  const normalizedHost = certificateHost(host);
  const directory = join(dirname(dataPath), "web-access-pki");
  const rootKeyPath = join(directory, "root-key.pem");
  const rootCertPath = join(directory, "root-cert.pem");
  const keyPath = join(directory, "lan-key.pem");
  const certPath = join(directory, "lan-cert.pem");
  const metadataPath = join(directory, "lan-host.txt");
  await mkdir(directory, { recursive: true, mode: 0o700 });

  if (!await rootCertificateValid(rootKeyPath, rootCertPath)) {
    await generateRootCertificate({ directory, rootKeyPath, rootCertPath });
    await Promise.all([
      rm(keyPath, { force: true }),
      rm(certPath, { force: true }),
      rm(metadataPath, { force: true })
    ]);
  }

  const previousHost = await readFile(metadataPath, "utf8").catch(() => "");
  const leafValid = previousHost.trim() === normalizedHost
    && await leafCertificateValid({
      keyPath,
      certPath,
      rootCertPath,
      host: normalizedHost
    });
  if (!leafValid) {
    await generateLeafCertificate({
      directory,
      rootKeyPath,
      rootCertPath,
      keyPath,
      certPath,
      metadataPath,
      host: normalizedHost
    });
  }

  await Promise.all([
    chmod(rootKeyPath, 0o600),
    chmod(rootCertPath, 0o600),
    chmod(keyPath, 0o600),
    chmod(certPath, 0o600),
    chmod(metadataPath, 0o600)
  ]);
  const [key, cert, caCert] = await Promise.all([
    readFile(keyPath),
    readFile(certPath),
    readFile(rootCertPath)
  ]);
  const [rootDetails, leafDetails] = await Promise.all([
    certificateDetails(caCert),
    certificateDetails(cert)
  ]);
  return {
    key,
    cert,
    caCert,
    certPath,
    caCertPath: rootCertPath,
    fingerprint: rootDetails.fingerprint,
    expiresAt: rootDetails.expiresAt,
    leafFingerprint: leafDetails.fingerprint,
    leafExpiresAt: leafDetails.expiresAt,
    generatedAt: clock().toISOString(),
    type: "local-ca"
  };
}

async function generateRootCertificate({ directory, rootKeyPath, rootCertPath }) {
  const suffix = `${process.pid}-${Date.now()}`;
  const nextKey = join(directory, `root-key-${suffix}.pem`);
  const nextCert = join(directory, `root-cert-${suffix}.pem`);
  const configPath = join(directory, `root-${suffix}.cnf`);
  const config = [
    "[req]",
    "prompt = no",
    "distinguished_name = dn",
    "x509_extensions = v3_ca",
    "[dn]",
    "CN = Corptie Local Root CA",
    "[v3_ca]",
    "basicConstraints = critical,CA:TRUE,pathlen:0",
    "keyUsage = critical,keyCertSign,cRLSign",
    "subjectKeyIdentifier = hash"
  ].join("\n");
  try {
    await writeFile(configPath, `${config}\n`, { encoding: "utf8", mode: 0o600 });
    await execFileAsync("/usr/bin/openssl", [
      "req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes",
      "-days", String(ROOT_VALIDITY_DAYS),
      "-config", configPath,
      "-keyout", nextKey,
      "-out", nextCert
    ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    await chmod(nextKey, 0o600);
    await chmod(nextCert, 0o600);
    await rename(nextKey, rootKeyPath);
    await rename(nextCert, rootCertPath);
  } finally {
    await Promise.all([
      rm(nextKey, { force: true }).catch(() => {}),
      rm(nextCert, { force: true }).catch(() => {}),
      rm(configPath, { force: true }).catch(() => {})
    ]);
  }
}

async function generateLeafCertificate({
  directory,
  rootKeyPath,
  rootCertPath,
  keyPath,
  certPath,
  metadataPath,
  host
}) {
  const suffix = `${process.pid}-${Date.now()}`;
  const nextKey = join(directory, `lan-key-${suffix}.pem`);
  const nextCsr = join(directory, `lan-${suffix}.csr`);
  const nextCert = join(directory, `lan-cert-${suffix}.pem`);
  const configPath = join(directory, `lan-${suffix}.cnf`);
  const san = host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)
    ? `IP:${host}`
    : `DNS:${host}`;
  const config = [
    "[v3_leaf]",
    "basicConstraints = critical,CA:FALSE",
    "keyUsage = critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage = serverAuth",
    `subjectAltName = ${san}`,
    "subjectKeyIdentifier = hash",
    "authorityKeyIdentifier = keyid,issuer"
  ].join("\n");
  try {
    await writeFile(configPath, `${config}\n`, { encoding: "utf8", mode: 0o600 });
    await execFileAsync("/usr/bin/openssl", [
      "req", "-new", "-newkey", "rsa:2048", "-sha256", "-nodes",
      "-subj", `/CN=${host}`,
      "-keyout", nextKey,
      "-out", nextCsr
    ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    await execFileAsync("/usr/bin/openssl", [
      "x509", "-req",
      "-in", nextCsr,
      "-CA", rootCertPath,
      "-CAkey", rootKeyPath,
      "-set_serial", `0x${randomBytes(16).toString("hex")}`,
      "-days", String(LEAF_VALIDITY_DAYS),
      "-sha256",
      "-extfile", configPath,
      "-extensions", "v3_leaf",
      "-out", nextCert
    ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    await chmod(nextKey, 0o600);
    await chmod(nextCert, 0o600);
    await rename(nextKey, keyPath);
    await rename(nextCert, certPath);
    await writeFile(metadataPath, `${host}\n`, { encoding: "utf8", mode: 0o600 });
  } finally {
    await Promise.all([
      rm(nextKey, { force: true }).catch(() => {}),
      rm(nextCsr, { force: true }).catch(() => {}),
      rm(nextCert, { force: true }).catch(() => {}),
      rm(configPath, { force: true }).catch(() => {})
    ]);
  }
}

async function rootCertificateValid(keyPath, certPath) {
  try {
    await checkCertificateWindow(certPath, ROOT_RENEWAL_WINDOW_SECONDS);
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    const certificate = new X509Certificate(cert);
    return certificate.ca === true && keyMatchesCertificate(key, certificate);
  } catch {
    return false;
  }
}

async function leafCertificateValid({ keyPath, certPath, rootCertPath, host }) {
  try {
    await checkCertificateWindow(certPath, LEAF_RENEWAL_WINDOW_SECONDS);
    await execFileAsync("/usr/bin/openssl", [
      "verify", "-CAfile", rootCertPath, certPath
    ], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    const certificate = new X509Certificate(cert);
    const identity = host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)
      ? certificate.checkIP(host)
      : certificate.checkHost(host);
    return certificate.ca === false
      && Boolean(identity)
      && keyMatchesCertificate(key, certificate);
  } catch {
    return false;
  }
}

async function checkCertificateWindow(path, seconds) {
  await execFileAsync("/usr/bin/openssl", [
    "x509", "-in", path, "-checkend", String(seconds), "-noout"
  ], { timeout: 5_000, maxBuffer: 1024 * 1024 });
}

function keyMatchesCertificate(key, certificate) {
  const privatePublicKey = createPublicKey(createPrivateKey(key))
    .export({ type: "spki", format: "der" });
  const certificatePublicKey = certificate.publicKey
    .export({ type: "spki", format: "der" });
  return privatePublicKey.equals(certificatePublicKey);
}

function certificateDetails(cert) {
  const certificate = new X509Certificate(cert);
  return {
    fingerprint: certificate.fingerprint256,
    expiresAt: new Date(certificate.validTo).toISOString()
  };
}

function certificateHost(value) {
  const host = String(value ?? "").trim();
  if (/^[A-Za-z0-9.-]+$/.test(host) || /^[A-Fa-f0-9:]+$/.test(host)) {
    return host;
  }
  throw new Error("Web Access certificate host is invalid.");
}
