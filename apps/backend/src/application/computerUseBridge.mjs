import { createRequire } from "node:module";
import { readFile, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { discoverComputerUseRuntime } from "./computerUseRuntime.mjs";

export const COMPUTER_USE_BRIDGE_PROFILE = "official-computer-use-mcp/v1";
export const COMPUTER_USE_BRIDGE_VERSION = "0.7.1";
const require = createRequire(import.meta.url);

export async function computerUseBridgeFingerprint(config) {
  const files = [config.args?.[0], "/Applications/ChatGPT.app/Contents/Info.plist",
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
    join(homedir(), ".codex/computer-use/Codex Computer Use.app/Contents/Info.plist")].filter(Boolean);
  const identities = await Promise.all(files.map(async file => {
    try { const s = await stat(file); return [file, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]; }
    catch { return [file, "missing"]; }
  }));
  return createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}

// The published adapter owns the signed AppServer and native correlation. This
// module only supplies an explicit, computer-only configuration using OpenAI's
// installed environment builder. It never changes the account's plugin cache.
export async function computerUseBridgePreset({ dataDir, discover = discoverComputerUseRuntime,
  packageFile = () => require.resolve("codex-computer-use-mcp/package.json") } = {}) {
  const runtime = await discover();
  if (runtime.status !== "dependencies_available") return { runtime, config: null };
  let manifestPath, pkg;
  try {
    manifestPath = packageFile();
    pkg = JSON.parse(await readFile(manifestPath, "utf8"));
    if (pkg.name !== "codex-computer-use-mcp" || pkg.version !== COMPUTER_USE_BRIDGE_VERSION) throw new Error("package mismatch");
  } catch {
    return { runtime: { ...runtime, status: "missing_bridge", errorCode: "COMPUTER_USE_BRIDGE_MISSING",
      message: "请安装此版本 Corptie 配套的 Computer Use MCP 依赖。" }, config: null };
  }
  const entry = join(dirname(manifestPath), "dist", "mcp-server.js");
  const info = await stat(entry);
  const revision = createHash("sha256").update(JSON.stringify([runtime.runtimeRevision, pkg.version, info.size, info.mtimeMs])).digest("hex");
  const root = join(dataDir, "computer-use", "bridge");
  await mkdir(root, { recursive: true });
  return { runtime: { ...runtime, runtimeRevision: revision, bridgeVersion: pkg.version,
    message: "官方依赖与 MCP 已找到；使用原生桌面接口，实际操作及后台行为仍需验证。" },
  config: { name: "Computer Use", transport: "stdio", command: process.execPath, args: [entry], cwd: root,
    env: {}, runtimeProfile: COMPUTER_USE_BRIDGE_PROFILE } };
}

export async function prepareComputerUseBridge(config, { runtime, discover = discoverComputerUseRuntime,
  buildEnvironment } = {}) {
  runtime ??= await discover();
  if (runtime.status !== "dependencies_available") throw Object.assign(new Error("Official Computer Use runtime unavailable."), { code: runtime.errorCode });
  const root = join(config.cwd, `instance-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
  const modules = runtime.paths.nodeModuleDirs;
  const builder = buildEnvironment ?? (await import(pathToFileURL(join(modules, "@oai", "cua-repl",
    "dist/lib/js/oai_js_cua_repl/src/environment.js")).href)).create_launch_environment;
  const env = builder({ env: {
    CUA_REPL_ENABLED_SURFACES: "computer", NODE_REPL_NODE_PATH: runtime.paths.nodePath,
    NODE_REPL_NODE_MODULE_DIRS: modules, NODE_REPL_TRUSTED_CODE_PATHS: modules,
    SKY_CUA_SERVICE_PATH: runtime.paths.serviceAppPath, NODE_REPL_DISABLE_ANALYTICS: "1"
  }, instructions_directory: pathToFileURL(join(modules, "@oai", "cua-repl", "instructions") + "/"), platform: "darwin" });
  if (env.CUA_REPL_ENABLED_SURFACES !== "computer" || JSON.parse(env.NODE_REPL_TRUSTED_SERVICES).browser) {
    throw Object.assign(new Error("Computer-only runtime configuration was not preserved."), { code: "COMPUTER_USE_SURFACE_UNSUPPORTED" });
  }
  const runtimeConfig = join(root, "native-runtime.json");
  await writeFile(runtimeConfig, JSON.stringify({ mcpServers: { cua_repl: {
    command: runtime.paths.nodeReplPath, args: [], env
  } } }), { mode: 0o600 });
  await writeFile(join(root, "config.json"), JSON.stringify({ cuaReplConfigPath: runtimeConfig }), { mode: 0o600 });
  return { ...config, cwd: root, stateRoot: root, env: {
    ...Object.fromEntries(["PATH", "TMPDIR", "LANG", "USER", "LOGNAME"].filter(k => process.env[k]).map(k => [k, process.env[k]])),
    CODEX_COMPUTER_USE_HOME: root
  }, isolatedEnv: true };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
