import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const independentComputerUseEntry = resolve(here, "../mcp/independentComputerUseMcpServer.mjs");

// Dependency discovery only. Never launch a process, prompt TCC, or inspect an
// official App / Provider installation here. Parent owns engine selection.
export async function independentComputerUsePreset({ dataDir, platform = process.platform,
  helperPath = process.env.CORPTIE_COMPUTER_USE_HELPER, fs = { access, mkdir, stat } } = {}) {
  if (!dataDir || !isAbsolute(dataDir)) throw new TypeError("dataDir must be absolute");
  const cwd = join(dataDir, "computer-use", "independent");
  const candidates = helperPath ? [helperPath] : [
    resolve(here, "../../../../Helpers/CorptieComputerUse"),
    resolve(here, "../../../../apps/macos/.build/debug/CorptieComputerUse")
  ];
  let helper = null;
  if (platform === "darwin") {
    for (const path of candidates) {
      if (!isAbsolute(path)) continue;
      try {
        if (!(await fs.stat(path)).isFile()) continue;
        await fs.access(path, constants.X_OK);
        helper = path;
        break;
      } catch { /* Report missing dependency without changing the machine. */ }
    }
  }
  const status = platform !== "darwin" ? "unsupported_platform" : helper ? "dependencies_available" : "missing_helper";
  if (helper) await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
  return {
    runtime: { status, engine: "independent", permissions: "unknown", protocol: "unverified",
      message: helper ? "Corptie native helper available; macOS permissions require runtime verification."
        : platform !== "darwin" ? "Independent Computer Use requires macOS 14+." : "Bundled CorptieComputerUse helper is missing.",
      helperPath: helper },
    config: { name: "Computer Use", transport: "stdio", command: process.execPath,
      args: [independentComputerUseEntry], cwd,
      env: { CORPTIE_COMPUTER_USE_HELPER: helper ?? "", CORPTIE_COMPUTER_USE_STATE_ROOT: cwd },
      runtimeProfile: "corptie-computer-use/v1" }
  };
}
