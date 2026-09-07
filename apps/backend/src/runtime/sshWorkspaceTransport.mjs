import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { posix } from "node:path";

export class RemoteWorkspaceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RemoteWorkspaceError";
    this.code = code;
    this.statusCode = 409;
    this.details = details;
  }
}

function invalid(field) {
  throw new RemoteWorkspaceError("SSH_WORKSPACE_INPUT_INVALID", `Invalid ${field}.`);
}

export function remoteAbsolutePath(value, field = "remote path") {
  if (typeof value !== "string" || !value.startsWith("/") || /[\0\r\n]/u.test(value)) invalid(field);
  // A remote POSIX cwd is deliberately independent of the local platform.
  return posix.normalize(value);
}

export function shellQuote(value) {
  if (typeof value !== "string" || value.includes("\0")) invalid("command argument");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sshWorkspaceIdentity(hostIdentity, rootPath) {
  if (typeof hostIdentity !== "string" || !hostIdentity.trim() || /[\0\r\n]/u.test(hostIdentity)) invalid("host identity");
  const path = remoteAbsolutePath(rootPath);
  return `ssh-workspace:${createHash("sha256").update(JSON.stringify([hostIdentity, path])).digest("hex")}`;
}

/**
 * Connections contain opaque local credential references, never key material.
 * The trusted resolver supplies OpenSSH configuration/known-hosts paths. Those
 * paths and SSH diagnostics are intentionally absent from the returned DTO.
 */
export class SshWorkspaceTransport {
  constructor({ resolveConnection, spawnProcess = spawn, maxConcurrent = 4, timeoutMs = 30_000, maxOutputBytes = 1024 * 1024 } = {}) {
    if (typeof resolveConnection !== "function") throw new TypeError("resolveConnection() is required.");
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError("maxConcurrent must be positive.");
    this.resolveConnection = resolveConnection;
    this.spawnProcess = spawnProcess;
    this.maxConcurrent = maxConcurrent;
    this.timeoutMs = bounded(timeoutMs, 1, 600_000, "timeoutMs");
    this.maxOutputBytes = bounded(maxOutputBytes, 1, 16 * 1024 * 1024, "maxOutputBytes");
    this.active = 0;
  }

  async execute({ connectionRef, expectedHostIdentity, cwd, argv, stdin = "", signal, timeoutMs = this.timeoutMs, onOutput } = {}) {
    const directory = remoteAbsolutePath(cwd, "cwd");
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 4096
      || argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !argv[0] || argv[0].startsWith("-")) invalid("argv");
    if (typeof stdin !== "string" || Buffer.byteLength(stdin) > 16 * 1024 * 1024) invalid("stdin");
    bounded(timeoutMs, 1, 600_000, "timeoutMs");
    if (typeof connectionRef !== "string" || !connectionRef) invalid("connection reference");
    if (typeof expectedHostIdentity !== "string" || !expectedHostIdentity) invalid("expected host identity");
    if (signal?.aborted) return notStarted("cancelled");
    if (this.active >= this.maxConcurrent) {
      throw new RemoteWorkspaceError("SSH_WORKSPACE_BUSY", "Remote execution concurrency limit reached.");
    }
    this.active += 1;
    try {
      let connection;
      try { connection = await this.resolveConnection(connectionRef); }
      catch { throw new RemoteWorkspaceError("SSH_CONNECTION_UNAVAILABLE", "SSH connection reference could not be resolved."); }
      validateConnection(connection);
      if (connection.hostIdentity !== expectedHostIdentity) {
        throw new RemoteWorkspaceError("SSH_HOST_IDENTITY_CHANGED", "SSH connection identity changed; explicit rebinding is required.");
      }
      if (signal?.aborted) return notStarted("cancelled");
      const command = `cd -- ${shellQuote(directory)} && exec ${argv.map(shellQuote).join(" ")}`;
      const args = [
        "-T", "-F", connection.configPath,
        "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${sshConfigPath(connection.knownHostsPath)}`,
        "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", `HostKeyAlias=${connection.hostKeyAlias}`,
        "-o", "UpdateHostKeys=no", "-o", "ForwardAgent=no",
        "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes",
        "-o", "ControlMaster=no", "-o", "ControlPath=none",
        "-o", "PermitLocalCommand=no", "-o", "RequestTTY=no",
        "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5",
        "-o", "ServerAliveCountMax=2", "--", connection.hostAlias, command
      ];
      return await this.#run(args, stdin, signal, timeoutMs, onOutput);
    } finally {
      this.active -= 1;
    }
  }

  #run(args, stdin, signal, timeoutMs, onOutput) {
    return new Promise((resolve) => {
      let child;
      try { child = this.spawnProcess("/usr/bin/ssh", args, { stdio: ["pipe", "pipe", "pipe"], shell: false, env: sshClientEnvironment() }); }
      catch { resolve(notStarted("spawn_failed")); return; }
      const stdout = [];
      let bytes = 0;
      let stopReason = null;
      let killTimer;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const stop = (reason) => {
        if (settled || stopReason) return;
        stopReason = reason;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
        killTimer.unref?.();
      };
      const abort = () => stop("cancelled");
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > this.maxOutputBytes) { stop("output_limit"); return; }
        stdout.push(chunk);
        // Backpressure is not delegated to arbitrary async UI callbacks.
        // Consumers must enqueue synchronously and bound their own queues.
        try { onOutput?.({ stream: "stdout", data: Buffer.from(chunk) }); }
        catch { stop("output_consumer_failed"); }
      });
      // SSH's stderr mixes remote output and transport diagnostics that can
      // expose usernames, key/config paths and proxy credentials. The remote
      // protocol must envelope application stderr on stdout instead.
      child.stderr.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > this.maxOutputBytes) stop("output_limit");
      });
      child.stdin.on("error", () => stop("input_closed"));
      child.on("error", () => finish(notStarted("spawn_failed")));
      child.on("close", (code, processSignal) => {
        const unknown = Boolean(stopReason || code === 255 || code === null || processSignal);
        finish({
          state: unknown ? "unknown" : "completed",
          reason: stopReason ?? (unknown ? "connection_lost" : null),
          exitCode: unknown ? null : code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          // Closing ssh proves nothing about remote descendants. Consumers
          // must retain the operation and reconcile before allowing replay.
          remoteProcessTermination: "unverified",
          retrySafe: false
        });
      });
      if (signal?.aborted) abort();
      child.stdin.end(stdin);
    });
  }
}

function validateConnection(connection) {
  if (!connection || typeof connection !== "object") invalid("connection");
  for (const field of ["configPath", "knownHostsPath"]) {
    if (typeof connection[field] !== "string" || !connection[field].startsWith("/") || /[\0\r\n]/u.test(connection[field])) invalid(field);
  }
  for (const field of ["hostAlias", "hostKeyAlias"]) {
    if (typeof connection[field] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/u.test(connection[field])) invalid(field);
  }
  if (typeof connection.hostIdentity !== "string" || !connection.hostIdentity) invalid("host identity");
}

function bounded(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(name);
  return value;
}

function sshConfigPath(path) {
  // -o values use OpenSSH configuration syntax even though spawn uses argv.
  // Preserve spaces/quotes and escape OpenSSH percent-token expansion.
  return `"${path.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function notStarted(reason) {
  return { state: "not_started", reason, exitCode: null, stdout: "", remoteProcessTermination: "not_started", retrySafe: true };
}

export function sshClientEnvironment(environment = process.env) {
  // OpenSSH SendEnv must never export backend/Provider secrets. Keep only the
  // small local authentication/runtime environment; ForwardAgent is disabled.
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "TMPDIR", "LANG", "LC_CTYPE"];
  return Object.fromEntries(allowed.filter((key) => typeof environment[key] === "string").map((key) => [key, environment[key]]));
}
