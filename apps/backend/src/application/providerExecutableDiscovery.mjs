import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { environmentForCommand } from "../utils/externalCommand.mjs";

export async function executableFingerprint(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  try {
    await access(path, constants.X_OK);
    const info = await stat(path);
    return info.isFile() ? JSON.stringify([await realpath(path), info.ino, info.size, info.mtimeMs]) : null;
  } catch { return null; }
}

export function parseExecutableVersion(text) {
  const match = String(text).trim().match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?(?:\s|$)/);
  if (!match) return null;
  return { version: match[0].trim(), core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] };
}

export function compareExecutableVersions(a, b) {
  const left = parseExecutableVersion(a), right = parseExecutableVersion(b);
  if (!left || !right) return Number(Boolean(left)) - Number(Boolean(right));
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  if (!left.prerelease.length || !right.prerelease.length) return Number(!left.prerelease.length) - Number(!right.prerelease.length);
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i], y = right.prerelease[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return Number(x !== undefined) - Number(y !== undefined);
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function readVersion(path, { timeoutMs, signal }) {
  return new Promise(resolve => {
    // Local discovery only: no account operation or inference request.
    const child = execFile(path, ["--version"], { env: environmentForCommand(path), timeout: timeoutMs, detached: true,
      signal, maxBuffer: 16 * 1024, encoding: "utf8" }, (error, stdout) => {
      // A shim may have launched a helper. Clean only our own process group.
      if (error && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      resolve(error ? { version: null, state: error.code === "ABORT_ERR" || error.killed ? "timeout" : "unavailable" }
        : { version: parseExecutableVersion(stdout)?.version ?? null, state: "discovered" });
    });
  });
}

// Provider-neutral inventory. Adapter callbacks own installation locations;
// a version is a recommendation, never proof of model access or login.
export class ProviderExecutableDiscovery {
  constructor({ candidates, controlledPath = () => null, probeVersion = readVersion,
    budgetMs = 8000, perCandidateMs = 2000, maxCandidates = 32 }) {
    Object.assign(this, { candidates, controlledPath, probeVersion, budgetMs, perCandidateMs, maxCandidates });
    this.inventory = [];
    this.cache = new Map();
    this.pending = null;
  }

  async scan({ additionalPaths = [] } = {}) {
    // Coalesce identical inventories only; a different manual path must not
    // get the result of an older scan. Serialize small bounded scans instead.
    const operation = async () => {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.budgetMs);
      const entries = [...additionalPaths.map(path => ({ path, source: "saved" })),
        ...(this.controlledPath() ? [{ path: this.controlledPath(), source: "controlled" }] : []), ...this.candidates()];
      const unique = new Map();
      try {
        for (const entry of entries.slice(0, 128)) {
          const fingerprint = await executableFingerprint(entry.path);
          if (!fingerprint) continue;
          const resolvedPath = JSON.parse(fingerprint)[0];
          const previous = unique.get(resolvedPath);
          if (previous) {
            if (!previous.sources.includes(entry.source)) previous.sources.push(entry.source);
            continue;
          }
          if (unique.size >= this.maxCandidates) continue;
          unique.set(resolvedPath, { id: resolvedPath, path: entry.path, resolvedPath,
            fingerprint, sources: [entry.source] });
        }
        const inventory = [...unique.values()];
        let index = 0;
        await Promise.all([0, 1].map(async () => {
          while (index < inventory.length) {
            const item = inventory[index++];
            let version = this.cache.get(item.fingerprint);
            if (!version) {
              version = controller.signal.aborted ? { version: null, state: "timeout" }
                : await this.probeVersion(item.path, { timeoutMs: Math.min(this.perCandidateMs,
                  Math.max(1, this.budgetMs - (Date.now() - started))), signal: controller.signal });
              if (version.state !== "timeout") this.cache.set(item.fingerprint, version);
            }
            Object.assign(item, version, { prerelease: Boolean(parseExecutableVersion(version.version)?.prerelease.length) });
          }
        }));
        inventory.sort((a, b) => compareExecutableVersions(b.version, a.version));
        this.inventory = inventory;
        this.cache = new Map(inventory.flatMap(item => this.cache.has(item.fingerprint)
          ? [[item.fingerprint, this.cache.get(item.fingerprint)]] : []));
        return this.describe();
      } finally { clearTimeout(timer); }
    };
    const pending = (this.pending ?? Promise.resolve()).catch(() => {}).then(operation);
    this.pending = pending;
    try { return await pending; } finally { if (this.pending === pending) this.pending = null; }
  }

  describe(saved = {}) {
    const controlledPath = this.controlledPath();
    const recommendedPath = controlledPath || this.inventory.find(item => item.version && item.state === "discovered")?.path || "";
    const mode = controlledPath ? "controlled" : saved.selectionMode
      ?? (saved.configuredPath || saved.path ? "legacyPinned" : "auto");
    return { mode, recommendedPath, adoptedPath: controlledPath || saved.configuredPath || "",
      model: saved.probe?.model ?? "", effectiveModel: saved.probe?.effectiveModel ?? null,
      candidates: this.inventory.map(({ fingerprint, ...item }) => item) };
  }
}
