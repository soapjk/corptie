import { networkInterfaces } from "node:os";
import { X509Certificate, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ClientDeviceAuthority, deviceError } from "./clientDeviceAuthority.mjs";
import { ClientDeviceGateway, reply, bearer } from "./clientDeviceGateway.mjs";

const execute = promisify(execFile);
export function lanAddresses(interfaces = networkInterfaces()) {
  return [...new Set(Object.entries(interfaces).filter(([name]) => /^en\d+$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b)).flatMap(([, values]) => values ?? [])
    .filter(v => !v.internal && v.family === "IPv4" && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v.address))
    .map(v => v.address))];
}

async function saveJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.new`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

// Uses the system's crypto implementation, never a shell, package download or remote CA.
export async function prepareLocalTLS(directory, addresses) {
  const path = join(directory, "local-tls.json");
  try {
    const saved = JSON.parse(await readFile(path, "utf8"));
    const cert = new X509Certificate(saved.cert);
    if (Date.parse(cert.validTo) <= Date.now()) throw deviceError("CERTIFICATE_EXPIRED", 409);
    if (!addresses.some(address => cert.checkIP(address))) throw deviceError("NETWORK_CHANGED", 409);
    return { ...saved, host: addresses.find(address => cert.checkIP(address)), certificate: cert.raw.toString("base64") };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const tlsDirectory = join(directory, `tls-${randomUUID()}`);
  await mkdir(tlsDirectory, { mode: 0o700 });
  const keyPath = join(tlsDirectory, "key.pem"), certPath = join(tlsDirectory, "cert.pem");
  const config = join(tlsDirectory, "openssl.cnf");
  await writeFile(config, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Corptie Local Device Access\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${addresses.map(a => `IP:${a}`).join(",")}\n`, { mode: 0o600 });
  await execute("/usr/bin/openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath], { timeout: 15_000 });
  await chmod(keyPath, 0o600);
  await execute("/usr/bin/openssl", ["req", "-new", "-x509", "-sha256", "-days", "365", "-key", keyPath,
    "-out", certPath, "-config", config], { timeout: 15_000 });
  const saved = { key: await readFile(keyPath, "utf8"), cert: await readFile(certPath, "utf8") };
  await saveJSON(path, saved);
  return { ...saved, host: addresses[0], certificate: new X509Certificate(saved.cert).raw.toString("base64") };
}

/** Local authenticated admin exists even while the LAN listener is disabled. */
export class ClientDeviceSetup extends ClientDeviceGateway {
  constructor(authority, options = {}) {
    super(authority, options);
    this.directory = authority.directory;
    this.addresses = options.addresses ?? lanAddresses;
    this.tls = options.tls ?? prepareLocalTLS;
    this.state = "disabled";
    this.operation = null;
    this.errorCode = null;
    this.adminTail = Promise.resolve();
  }

  async initialize() {
    await this.authority.initialize();
    try {
      const config = JSON.parse(await readFile(join(this.directory, "access.json"), "utf8"));
      if (config.enabled === true) await this.enable(config.port);
    } catch (error) {
      if (error.code !== "ENOENT") { this.state = "error"; this.errorCode = error.code ?? "DEVICE_SETUP_FAILED"; }
    }
    return this;
  }

  status() { return { ...this.authority.list(), state: this.state, address: this.address ?? null, errorCode: this.errorCode }; }

  async enable(port = 0) {
    if (this.state === "ready") return;
    if (this.operation) return this.operation;
    this.operation = (async () => {
      this.state = "starting"; this.errorCode = null;
      try {
        const addresses = this.addresses();
        if (!addresses.length) throw deviceError("LOCAL_NETWORK_UNAVAILABLE", 409);
        const tls = await this.tls(this.directory, addresses);
        const listening = await this.start({ ...tls, port });
        this.address = `https://${tls.host}:${listening.port}`;
        this.certificate = tls.certificate;
        await saveJSON(join(this.directory, "access.json"), { enabled: true, port: listening.port });
        this.state = "ready";
      } catch (error) {
        await super.close();
        this.state = "error"; this.address = null;
        this.errorCode = error.code ?? "DEVICE_SETUP_FAILED";
        throw error;
      }
    })();
    try { await this.operation; } finally { this.operation = null; }
  }

  async disable() {
    if (this.operation) await this.operation.catch(() => {});
    await saveJSON(join(this.directory, "access.json"), { enabled: false });
    await super.close();
    this.authority.pending.clear();
    this.state = "disabled"; this.address = null; this.errorCode = null;
  }

  async reset() {
    await this.disable();
    for (const device of this.authority.state.devices) if (!device.revoked) await this.authority.revoke(device.id);
    try { await rename(join(this.directory, "local-tls.json"), join(this.directory, `retired-tls-${randomUUID()}.json`)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await this.enable();
  }

  async handleAdmin(request, response) {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)
        || request.headers.origin || !this.authority.checkAdmin(bearer(request))) {
      return reply(response, 403, { code: "ADMIN_AUTH_REQUIRED" });
    }
    try {
      this.limit(request);
      if (request.method === "GET" && request.url === "/internal/client-devices") return reply(response, 200, this.status());
      const action = /^\/internal\/client-devices\/(enable|disable|reset)$/.exec(request.url)?.[1];
      if (request.method === "POST" && action) {
        const next = this.adminTail.then(() => this[action]());
        this.adminTail = next.catch(() => {});
        await next; return reply(response, 200, this.status());
      }
      if (request.method === "POST" && request.url === "/internal/client-devices/invite") {
        if (this.state !== "ready") throw deviceError("REMOTE_ACCESS_DISABLED", 409);
        return reply(response, 201, { ...this.authority.invite(), address: this.address, certificate: this.certificate });
      }
      return super.handleAdmin(request, response);
    } catch (error) { return reply(response, error.status ?? 500, { code: error.code ?? "DEVICE_SETUP_FAILED" }); }
  }
}

export async function createDeviceSetup(options) {
  if (options.preview) return null;
  return new ClientDeviceSetup(new ClientDeviceAuthority(options.directory), {
    ...options, sessionAPI: options.sessionAPIFactory?.() ?? null
  }).initialize();
}
