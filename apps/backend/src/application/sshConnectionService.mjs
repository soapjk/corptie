import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, lstat, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { RemoteWorkspaceError, sshClientEnvironment } from "../runtime/sshWorkspaceTransport.mjs";

const runFile = promisify(execFile);
const ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/u;
const REFERENCE = /^ssh-credential:([a-f0-9-]{36})$/u;
const KEY_TYPES = new Set(["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"]);

/**
 * Uses the user's existing OpenSSH authentication in place. The app persists
 * only local reference files and a selected public host key, never private keys,
 * passwords, agent sockets or Provider authentication/configuration.
 */
export class SshConnectionService {
  constructor({ repository, referenceDirectory, configPath = join(homedir(), ".ssh", "config"), knownHostsPath = join(homedir(), ".ssh", "known_hosts"), run = runFile } = {}) {
    if (!repository || !isAbsolute(referenceDirectory ?? "") || !isAbsolute(configPath) || !isAbsolute(knownHostsPath)) {
      throw new TypeError("SSH connections require a repository and absolute local reference/config paths.");
    }
    this.repository = repository;
    this.referenceDirectory = referenceDirectory;
    this.configPath = configPath;
    this.knownHostsPath = knownHostsPath;
    this.run = run;
  }

  async listAliases() {
    let contents;
    try { contents = await readFile(this.configPath, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") return [];
      throw failure("SSH_CONFIG_UNAVAILABLE", "OpenSSH configuration is not readable.");
    }
    if (Buffer.byteLength(contents) > 1024 * 1024) throw failure("SSH_CONFIG_LIMIT", "OpenSSH configuration exceeds the supported size.");
    // Only concrete aliases from the selected file are suggested. Includes,
    // wildcard Host clauses and Match exec aren't evaluated during listing.
    return [...new Set(contents.split(/\r?\n/u).flatMap((line) => {
      const match = /^\s*Host\s+(.+?)(?:\s+#.*)?$/iu.exec(line);
      return match ? match[1].split(/\s+/u).filter((alias) => ALIAS.test(alias)) : [];
    }))].sort().slice(0, 100);
  }

  async inspectAlias(hostAlias) {
    return this.#inspectAlias(hostAlias, this.configPath, this.knownHostsPath);
  }

  async #inspectAlias(hostAlias, configPath, knownHostsPath) {
    if (!ALIAS.test(hostAlias ?? "")) throw failure("SSH_ALIAS_INVALID", "Select a concrete OpenSSH Host alias.");
    const target = await this.#target(hostAlias, configPath);
    let output;
    try {
      output = (await this.run("/usr/bin/ssh-keygen", ["-F", target.port === "22" ? target.hostname : `[${target.hostname}]:${target.port}`, "-f", knownHostsPath], commandOptions())).stdout;
    } catch {
      throw failure("SSH_TRUSTED_HOST_KEY_REQUIRED", "No trusted host key was found. Verify this host with OpenSSH before registering it.");
    }
    const keys = [];
    for (const line of output.split(/\r?\n/u)) {
      const fields = line.trim().split(/\s+/u);
      if (fields[0] === "@revoked") throw failure("SSH_HOST_KEY_REVOKED", "OpenSSH marks a matching host key as revoked.");
      if (fields.length < 3 || fields[0].startsWith("#") || fields[0].startsWith("@") || !KEY_TYPES.has(fields[1])) continue;
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(fields[2])) continue;
      const key = Buffer.from(fields[2], "base64");
      if (key.length < 32 || key.length > 16 * 1024) continue;
      keys.push({ algorithm: fields[1], publicKey: fields[2], fingerprint: `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}` });
    }
    if (!keys.length) throw failure("SSH_TRUSTED_HOST_KEY_REQUIRED", "No supported pinned public host key was found.");
    return { hostAlias, target, keys };
  }

  async register({ hostAlias, label, fingerprint }) {
    if (typeof label !== "string" || !label.trim() || label.length > 200) throw failure("SSH_LABEL_INVALID", "An SSH connection label is required.");
    const inspected = await this.inspectAlias(hostAlias);
    const key = inspected.keys.find((candidate) => candidate.fingerprint === fingerprint);
    if (!key) throw failure("SSH_HOST_KEY_CHANGED", "The reviewed host key is no longer present in known_hosts.");
    const hostIdentity = `ssh-host:${hash(JSON.stringify([inspected.target.hostname, inspected.target.port, inspected.target.user, key.fingerprint]))}`;
    const id = randomUUID();
    const credentialRef = `ssh-credential:${id}`;
    const hostKeyAlias = `corptie-${id}`;
    await mkdir(this.referenceDirectory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.referenceDirectory);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw failure("SSH_REFERENCE_PERMISSIONS", "SSH reference directory must be privately owned (0700).");
    }
    const pinnedPath = join(this.referenceDirectory, `${id}.known_hosts`);
    const referencePath = join(this.referenceDirectory, `${id}.json`);
    const pinned = `${hostKeyAlias} ${key.algorithm} ${key.publicKey}\n`;
    try {
      await writeFile(pinnedPath, pinned, { flag: "wx", mode: 0o600 });
      await writeFile(referencePath, JSON.stringify({ version: 1, hostAlias, hostKeyAlias, hostIdentity,
        target: inspected.target, configPath: this.configPath, knownHostsPath: this.knownHostsPath, pinnedHash: hash(pinned) }), { flag: "wx", mode: 0o600 });
      return this.repository.registerConnection({ connectionId: `ssh-connection:${id}`, label: label.trim(),
        hostIdentity, credentialRef, hostAlias, hostKeyAlias });
    } catch (error) {
      await Promise.all([rm(pinnedPath, { force: true }), rm(referencePath, { force: true })]);
      throw error;
    }
  }

  async resolve(connectionId) {
    const connection = this.repository.connection(connectionId);
    const match = REFERENCE.exec(connection?.credentialRef ?? "");
    if (!match) throw failure("SSH_REFERENCE_UNAVAILABLE", "SSH authentication reference is unavailable.");
    const referencePath = join(this.referenceDirectory, `${match[1]}.json`);
    const knownHostsPath = join(this.referenceDirectory, `${match[1]}.known_hosts`);
    try {
      for (const path of [referencePath, knownHostsPath]) {
        const info = await lstat(path);
        if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > 64 * 1024) throw new Error("unsafe reference");
      }
      const reference = JSON.parse(await readFile(referencePath, "utf8"));
      if (reference.version !== 1 || reference.hostIdentity !== connection.hostIdentity
        || reference.hostAlias !== connection.hostAlias || reference.hostKeyAlias !== connection.hostKeyAlias
        || !isAbsolute(reference.configPath ?? "")) throw new Error("reference changed");
      const pinned = await readFile(knownHostsPath, "utf8");
      if (hash(pinned) !== reference.pinnedHash) throw new Error("pin changed");
      // A saved pin cannot override a later revocation or removal of trust.
      // Resolve locally on every launch; never fetch a replacement host key.
      const trustPath = reference.knownHostsPath ?? this.knownHostsPath;
      if (!isAbsolute(trustPath)) throw new Error("trust source changed");
      const inspected = await this.#inspectAlias(reference.hostAlias, reference.configPath, trustPath);
      if (JSON.stringify(inspected.target) !== JSON.stringify(reference.target)) throw new Error("target changed");
      if (!inspected.keys.some((key) => pinned === `${reference.hostKeyAlias} ${key.algorithm} ${key.publicKey}\n`)) throw new Error("trust removed");
      return { configPath: reference.configPath, knownHostsPath,
        hostAlias: reference.hostAlias, hostKeyAlias: reference.hostKeyAlias, hostIdentity: reference.hostIdentity };
    } catch {
      throw failure("SSH_REFERENCE_CHANGED", "SSH target or reference changed. Review and register the connection again.");
    }
  }

  async #target(alias, configPath) {
    let output;
    try {
      output = (await this.run("/usr/bin/ssh", ["-G", "-F", configPath, "-o", "PermitLocalCommand=no", "-o", "BatchMode=yes", "--", alias], commandOptions())).stdout;
    } catch {
      throw failure("SSH_CONFIG_INVALID", "OpenSSH could not resolve the selected alias.");
    }
    const fields = new Map(output.split(/\r?\n/u).map((line) => {
      const separator = line.indexOf(" "); return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    const target = { hostname: fields.get("hostname"), port: fields.get("port"), user: fields.get("user") };
    if (!target.hostname || !target.user || !/^\d+$/u.test(target.port ?? "")
      || Number(target.port) < 1 || Number(target.port) > 65535) throw failure("SSH_CONFIG_INVALID", "OpenSSH returned an incomplete target.");
    return target;
  }
}

function commandOptions() { return { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true, env: sshClientEnvironment() }; }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function failure(code, message) { return new RemoteWorkspaceError(code, message); }
