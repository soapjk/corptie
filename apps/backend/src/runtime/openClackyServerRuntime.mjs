import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import { join } from "node:path";

export class OpenClackyServerRuntime {
  constructor(options = {}) {
    this.command = options.command ?? "openclacky";
    this.host = options.host ?? "127.0.0.1";
    this.port = Number(options.port ?? 47071);
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? (() => process.env);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.spawn = options.spawn ?? spawn;
    this.startupTimeoutMs = Number(options.startupTimeoutMs ?? 15_000);
    this.pollIntervalMs = Number(options.pollIntervalMs ?? 100);
    this.process = null;
    this.starting = null;
    this.lastExit = null;
    this.stderrTail = "";
  }

  get baseURL() {
    return `http://${this.host}:${this.port}`;
  }

  async ensureRunning() {
    if (await this.isHealthy()) return { baseURL: this.baseURL, reused: true };
    if (this.starting) return this.starting;
    this.starting = this.startProcess().finally(() => { this.starting = null; });
    return this.starting;
  }

  async startProcess() {
    if (this.process && this.process.exitCode == null && !this.process.killed) {
      return this.waitUntilHealthy(false);
    }
    this.stderrTail = "";
    this.lastExit = null;
    const child = this.spawn(this.command, [
      "server", "--host", this.host, "--port", String(this.port)
    ], {
      cwd: this.cwd,
      env: { ...this.env() },
      stdio: ["ignore", "ignore", "pipe"]
    });
    this.process = child;
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_000);
    });
    child.once?.("exit", (code, signal) => {
      this.lastExit = { code, signal };
      if (this.process === child) this.process = null;
    });
    child.once?.("error", (error) => {
      this.stderrTail = `${this.stderrTail}\n${error.message}`.slice(-4_000);
    });
    return this.waitUntilHealthy(false);
  }

  async waitUntilHealthy(reused) {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return { baseURL: this.baseURL, reused };
      if (this.lastExit) break;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    const detail = this.stderrTail.trim() || (this.lastExit
      ? `process exited code=${this.lastExit.code ?? "null"} signal=${this.lastExit.signal ?? "null"}`
      : `health check timed out after ${this.startupTimeoutMs}ms`);
    const error = new Error(`Corptie could not start its managed OpenClacky runtime at ${this.baseURL}: ${detail}`);
    error.code = "OPENCLACKY_RUNTIME_START_FAILED";
    throw error;
  }

  async isHealthy() {
    if (typeof this.fetch !== "function") return false;
    try {
      const response = await this.fetch(`${this.baseURL}/health`, { signal: AbortSignal.timeout(750) });
      if (!response.ok) return false;
      const payload = await response.json().catch(() => ({}));
      return payload.status === "ok" || payload.healthy === true;
    } catch {
      return false;
    }
  }

  stop() {
    const child = this.process;
    this.process = null;
    this.starting = null;
    if (child && child.exitCode == null && !child.killed) child.kill("SIGTERM");
  }
}

export function resolveOpenClackyManagedPort(environmentName, value = process.env.OPENCLACKY_MANAGED_PORT) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) return parsed;
  return environmentName === "development" ? 47072 : 47071;
}

export function resolveOpenClackyCommand(value = process.env.OPENCLACKY_COMMAND, homeDir = os.homedir()) {
  const configured = typeof value === "string" ? value.trim() : "";
  if (configured) return configured;
  const candidates = [
    join(homeDir, ".gem", "ruby", "2.6.0", "bin", "openclacky"),
    "/opt/homebrew/bin/openclacky",
    "/usr/local/bin/openclacky"
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next stable installation location.
    }
  }
  return "openclacky";
}
