import { stat, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverComputerUseRuntime } from "./computerUseRuntime.mjs";
import { computerUseBridgePreset, prepareComputerUseBridge } from "./computerUseBridge.mjs";
import { independentComputerUsePreset } from "./independentComputerUseRuntime.mjs";
import { BUILTIN_COMPUTER_USE_PROFILE } from "./computerUseProfiles.mjs";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../mcp/builtinComputerUseMcpServer.mjs", import.meta.url));

// Presence is intentionally separate from readiness: a broken or uninitialized
// installed official app must never silently select a different input engine.
export async function findOfficialComputerUseApp({ home = homedir(), fs = { stat }, search = spotlightApps } = {}) {
  const candidates = ["/Applications/ChatGPT.app", "/Applications/Codex.app",
    join(home, "Applications/ChatGPT.app"), join(home, "Applications/Codex.app")];
  const installed = [];
  for (const path of candidates) {
    try { if ((await fs.stat(path)).isDirectory()) installed.push(path); }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  }
  for (const path of installed) {
    try { if ((await fs.stat(join(path, "Contents/Resources/cua_node"))).isDirectory()) return { installed: true, appPath: path }; }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  }
  for (const path of await search()) {
    if (!path.startsWith("/") || !path.endsWith(".app")) continue;
    try { if ((await fs.stat(path)).isDirectory()) return { installed: true, appPath: path }; }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  }
  return { installed: installed.length > 0, appPath: installed[0] ?? null };
}

let spotlightCache;
async function spotlightApps() {
  if (spotlightCache && Date.now() - spotlightCache.at < 5000) return spotlightCache.paths;
  const { stdout } = await exec("/usr/bin/mdfind", [
    "kMDItemCFBundleIdentifier == 'com.openai.codex' || kMDItemCFBundleIdentifier == 'com.openai.chat'"
  ], { timeout: 3000, maxBuffer: 64 * 1024 });
  const paths = stdout.split("\n").map(x => x.trim()).filter(Boolean).sort();
  spotlightCache = { at: Date.now(), paths };
  return paths;
}

export function builtinComputerUseConfig(dataDir) {
  return { name: "Computer Use", transport: "stdio", command: process.execPath,
    args: [entry, "--data-dir", dataDir], cwd: join(dataDir, "computer-use", "builtin"),
    env: {}, runtimeProfile: BUILTIN_COMPUTER_USE_PROFILE };
}

export async function computerUseEnginePreset({ dataDir, platform = process.platform,
  findOfficial = findOfficialComputerUseApp, officialPreset = computerUseBridgePreset,
  independentPreset = independentComputerUsePreset, discover = discoverComputerUseRuntime } = {}) {
  if (platform !== "darwin") return { runtime: { status: "unsupported_platform", engine: null,
    errorCode: "COMPUTER_USE_PLATFORM_UNSUPPORTED", message: "桌面操作目前仅支持 macOS。" }, config: null };
  let presence;
  try { presence = await findOfficial(); }
  catch {
    return { runtime: { status: "discovery_failed", engine: null, errorCode: "COMPUTER_USE_APP_DISCOVERY_FAILED",
      message: "无法确认官方 App 是否安装，请检查本机应用访问；尚未切换到独立引擎。" }, config: null };
  }
  if (presence.installed) {
    const result = await officialPreset({ dataDir, discover: () => discover({ appPath: presence.appPath }) });
    return { ...result, runtime: { ...result.runtime, engine: "official", officialAppInstalled: true,
      appPath: presence.appPath, message: result.config
        ? "已选择官方引擎；实际操作仍需系统和应用授权。"
        : `已安装官方 App，运行组件尚未就绪（${result.runtime.status}）。请先完成官方组件设置；不会自动切换到独立引擎。` } };
  }
  const result = await independentPreset({ dataDir });
  return { ...result, runtime: { ...result.runtime, engine: "independent", officialAppInstalled: false } };
}

export async function prepareBuiltinComputerUse(config, { preset = computerUseEnginePreset,
  prepareOfficial = prepareComputerUseBridge } = {}) {
  const dataDir = config.builtinDataDir ?? config.args?.[config.args.indexOf("--data-dir") + 1];
  if (!dataDir?.startsWith("/")) throw Object.assign(new Error("Computer Use data directory is unavailable."),
    { code: "COMPUTER_USE_PATH_INVALID" });
  const selected = await preset({ dataDir });
  if (!selected.config) throw Object.assign(new Error(selected.runtime.message ?? "Computer Use is not ready."),
    { code: selected.runtime.errorCode ?? "COMPUTER_USE_DEPENDENCIES_UNAVAILABLE" });
  if (selected.runtime.engine === "official") {
    return prepareOfficial({ ...selected.config, cwd: config.cwd }, {
      runtime: selected.runtime,
      discover: () => discoverComputerUseRuntime({ appPath: selected.runtime.appPath })
    });
  }
  await mkdir(config.cwd, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(config.cwd, "instance-"));
  return { ...selected.config, cwd: root, stateRoot: root, isolatedEnv: true,
    env: { ...Object.fromEntries(["PATH", "TMPDIR", "LANG", "USER", "LOGNAME"].filter(k => process.env[k])
      .map(k => [k, process.env[k]])), HOME: homedir(), ...selected.config.env,
      CORPTIE_COMPUTER_USE_STATE_ROOT: root } };
}

// Called only at catalog/connection boundaries; never polls or launches an app.
export async function computerUseEngineFingerprint(config, { findOfficial = findOfficialComputerUseApp,
  independentPreset = independentComputerUsePreset } = {}) {
  const dataDir = config.builtinDataDir ?? config.args?.[config.args.indexOf("--data-dir") + 1];
  const presence = await findOfficial();
  const selected = presence.installed ? null : await independentPreset({ dataDir });
  const officialFiles = presence.installed ? [join(presence.appPath, "Contents/Info.plist"),
    join(presence.appPath, "Contents/Resources/cua_node/bin/node_repl"),
    join(presence.appPath, "Contents/Resources/cua_node/bin/node"),
    join(presence.appPath, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
    join(presence.appPath, "Contents/Resources/codex"),
    join(homedir(), ".codex/computer-use/Codex Computer Use.app/Contents/Info.plist"),
    fileURLToPath(new URL("./computerUseBridge.mjs", import.meta.url))] : [];
  const files = [entry, ...officialFiles, ...(selected?.config?.args ?? []), ...Object.values(selected?.config?.env ?? {})]
    .filter(v => typeof v === "string" && v.startsWith("/"));
  const stamps = await Promise.all(files.map(async file => {
    try { const s = await stat(file); return [file, s.ino, s.size, s.mtimeMs]; }
    catch { return [file, "missing"]; }
  }));
  return createHash("sha256").update(JSON.stringify([presence, selected?.runtime, stamps])).digest("hex");
}
