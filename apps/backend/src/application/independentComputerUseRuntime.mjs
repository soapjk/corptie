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
      errorCode: helper ? null : platform !== "darwin" ? "COMPUTER_USE_PLATFORM_UNSUPPORTED" : "COMPUTER_USE_HELPER_MISSING",
      message: helper ? "已找到 Corptie 独立服务；首次操作需授予辅助功能和屏幕录制权限，后台操作效果仍需验证。"
        : platform !== "darwin" ? "独立桌面操作需要 macOS 14 或更新版本。" : "缺少随 App 提供的 CorptieComputerUse 服务，请修复安装。",
      helperPath: helper },
    config: helper ? { name: "Computer Use", transport: "stdio", command: process.execPath,
      args: [independentComputerUseEntry], cwd,
      env: { CORPTIE_COMPUTER_USE_HELPER: helper ?? "", CORPTIE_COMPUTER_USE_STATE_ROOT: cwd },
      runtimeProfile: "corptie-computer-use/v1" } : null
  };
}
