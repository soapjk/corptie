import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultFs = { access, readFile, realpath, stat };
const DEFAULT_APP_PATH = "/Applications/ChatGPT.app";
const PROTOCOL_REQUIREMENTS = Object.freeze(["nativeConnection", "appApprovals", "images", "cancellation", "context"]);

// Filesystem-only, on-demand discovery. It never launches a helper, reads
// Provider credentials or changes OS permissions. Installed files are not
// evidence of a working authorization / screenshot / cancellation protocol.
export async function discoverComputerUseRuntime({
  appPath = DEFAULT_APP_PATH, serviceAppPath,
  platform = process.platform, homeDir = homedir(),
  fs = defaultFs, readAppMetadata = appMetadata, verifyBundle = verifyOfficialBundle
} = {}) {
  if (platform !== "darwin") return unavailable("unsupported_platform", "COMPUTER_USE_PLATFORM_UNSUPPORTED");
  validateAbsolute(appPath, "appPath");
  validateAbsolute(homeDir, "homeDir");
  if (serviceAppPath != null) validateAbsolute(serviceAppPath, "serviceAppPath");
  const requestedService = serviceAppPath ?? join(homeDir, ".codex", "computer-use", "Codex Computer Use.app");
  let app;
  try {
    app = await fs.realpath(appPath);
    if (!(await fs.stat(app)).isDirectory()) throw new Error("not an application directory");
  } catch {
    return unavailable("missing_app", "COMPUTER_USE_APP_MISSING");
  }
  try { await verifyBundle(app); }
  catch { return unavailable("invalid_signature", "COMPUTER_USE_SIGNATURE_INVALID"); }
  const runtimeRoot = join(app, "Contents", "Resources", "cua_node");
  const paths = {
    appPath: app,
    nodePath: join(runtimeRoot, "bin", "node"),
    nodeReplPath: join(runtimeRoot, "bin", "node_repl"),
    nodeModuleDirs: join(runtimeRoot, "lib", "node_modules"),
    serviceAppPath: requestedService
  };
  const fingerprints = [];
  try {
    for (const key of ["nodePath", "nodeReplPath", "nodeModuleDirs"]) {
      const path = await fs.realpath(paths[key]);
      if (!isWithin(app, path)) throw new Error("runtime path escaped application bundle");
      const info = await fs.stat(path);
      if (key === "nodeModuleDirs" ? !info.isDirectory() : !info.isFile()) throw new Error("invalid runtime entry");
      if (key !== "nodeModuleDirs") await fs.access(path, constants.X_OK);
      paths[key] = path;
      fingerprints.push([key, path, info.dev, info.ino, info.size, info.mtimeMs]);
    }
  } catch {
    return unavailable("missing_runtime", "COMPUTER_USE_RUNTIME_MISSING");
  }
  let manifest, sky, metadata;
  try {
    [manifest, sky, metadata] = await Promise.all([
      readJson(fs, join(runtimeRoot, "manifest.json")),
      readJson(fs, join(paths.nodeModuleDirs, "@oai", "sky", "package.json")),
      readAppMetadata(app)
    ]);
    if (manifest.platform !== "darwin" || !nonempty(manifest.node_version)
      || sky.name !== "@oai/sky" || !nonempty(sky.version)
      || typeof sky.exports?.["./service"] !== "string") throw new Error("invalid official runtime metadata");
    const skyRoot = await fs.realpath(join(paths.nodeModuleDirs, "@oai", "sky"));
    if (!isWithin(paths.nodeModuleDirs, skyRoot)) throw new Error("Sky package escaped trusted module directory");
    const servicePath = await fs.realpath(resolve(skyRoot, sky.exports["./service"]));
    if (!isWithin(skyRoot, servicePath) || !(await fs.stat(servicePath)).isFile()) throw new Error("Sky service entry unavailable");
    if (!nonempty(metadata.version) || !nonempty(metadata.bundleIdentifier)) throw new Error("application metadata missing");
  } catch {
    return unavailable("invalid_runtime", "COMPUTER_USE_RUNTIME_INVALID");
  }
  const versions = Object.freeze({ app: metadata.version, build: metadata.build ?? null,
    bundleIdentifier: metadata.bundleIdentifier, node: manifest.node_version, sky: sky.version,
    architecture: manifest.arch ?? null });
  try {
    paths.serviceAppPath = await fs.realpath(requestedService);
    if (!(await fs.stat(paths.serviceAppPath)).isDirectory()) throw new Error("native service missing");
    const serviceMetadata = await readAppMetadata(paths.serviceAppPath);
    if (serviceMetadata.bundleIdentifier !== "com.openai.sky.CUAService") throw new Error("unexpected service identifier");
    const info = await fs.stat(join(paths.serviceAppPath, "Contents", "Info.plist"));
    fingerprints.push(["service", paths.serviceAppPath, serviceMetadata.version, info.size, info.mtimeMs]);
  } catch {
    return Object.freeze({ ...unavailable("missing_native_service", "COMPUTER_USE_NATIVE_SERVICE_MISSING"),
      paths: Object.freeze(paths), versions });
  }
  try { await verifyBundle(paths.serviceAppPath); }
  catch { return unavailable("invalid_signature", "COMPUTER_USE_SIGNATURE_INVALID"); }
  const runtimeRevision = createHash("sha256")
    .update(JSON.stringify({ fingerprints, versions })).digest("hex");
  return Object.freeze({ status: "dependencies_available", errorCode: null,
    paths: Object.freeze(paths), versions, runtimeRevision,
    // These checks require an explicit, scoped runtime verification. They
    // cannot be inferred from bundle installation or MCP tools/list.
    permissions: "unknown", protocol: "unverified" });
}

// Internal transport shape consumed by the Session-scoped MCP gateway. The
// caller owns creation/cleanup of this Session's isolated home. Do not persist
// this directly into a Provider's native config or expose a second tool route.
export function computerUseMcpConfig(runtime, { codexHome, cwd = codexHome } = {}) {
  if (runtime?.status !== "dependencies_available" || !runtime.paths || !runtime.runtimeRevision) {
    throw runtimeError("COMPUTER_USE_DEPENDENCIES_UNAVAILABLE", "Official Computer Use dependencies are unavailable.");
  }
  validateAbsolute(codexHome, "codexHome");
  validateAbsolute(cwd, "cwd");
  const { nodePath, nodeReplPath, nodeModuleDirs, serviceAppPath } = runtime.paths;
  for (const [key, value] of Object.entries({ nodePath, nodeReplPath, nodeModuleDirs, serviceAppPath })) validateAbsolute(value, key);
  const env = Object.freeze({
    CODEX_HOME: codexHome,
    NODE_REPL_NODE_PATH: nodePath,
    NODE_REPL_NODE_MODULE_DIRS: nodeModuleDirs,
    NODE_REPL_TRUSTED_CODE_PATHS: nodeModuleDirs,
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
    SKY_CUA_SERVICE_PATH: serviceAppPath,
    NODE_REPL_DISABLE_ANALYTICS: "1",
    BROWSER_USE_DISABLE_AMBIENT_NETWORK: "1"
  });
  return Object.freeze({ type: "stdio", command: nodeReplPath, args: Object.freeze([]), cwd,
    env, isolatedEnv: true, startup_timeout_sec: 30,
    observationRevision: runtime.runtimeRevision,
    displayName: "Computer Use", toolAllowlist: Object.freeze(["js", "js_reset", "turn_ended"]) });
}

// Provider-neutral capability result: callers supply *observed* protocol
// support, not a Provider-name comparison or model-authored claims.
export function computerUseAvailability(runtime, {
  enabled = false, supported = false, protocol = {}, permissions = {}
} = {}) {
  if (!enabled) return unavailable("disabled", "COMPUTER_USE_DISABLED");
  if (!supported) return unavailable("unsupported_provider", "COMPUTER_USE_PROVIDER_UNSUPPORTED");
  if (runtime?.status !== "dependencies_available") return runtime ?? unavailable("not_configured", "COMPUTER_USE_NOT_CONFIGURED");
  if (permissions.accessibility === false || permissions.screenRecording === false) {
    return unavailable("needs_os_permissions", "COMPUTER_USE_OS_PERMISSIONS_REQUIRED");
  }
  const missingProtocols = PROTOCOL_REQUIREMENTS.filter(key => protocol[key] !== true);
  if (missingProtocols.length) return Object.freeze({ ...unavailable("protocol_unverified", "COMPUTER_USE_PROTOCOL_UNVERIFIED"),
    missingProtocols: Object.freeze(missingProtocols) });
  if (permissions.accessibility !== true || permissions.screenRecording !== true) {
    return unavailable("permissions_unknown", "COMPUTER_USE_OS_PERMISSIONS_UNKNOWN");
  }
  return Object.freeze({ status: "ready", errorCode: null, runtimeRevision: runtime.runtimeRevision });
}

async function appMetadata(path) {
  const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(path, "Contents", "Info.plist")],
    { timeout: 5000, maxBuffer: 1024 * 1024 });
  const value = JSON.parse(stdout);
  return { version: value.CFBundleShortVersionString, build: value.CFBundleVersion,
    bundleIdentifier: value.CFBundleIdentifier };
}

async function verifyOfficialBundle(path) {
  // Verify the sealed resources as well as the signer. The trusted service
  // registration loads JavaScript from the bundle, not just the executables.
  await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", "-R",
    '=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"', path],
  { timeout: 30_000, maxBuffer: 64 * 1024 });
}

async function readJson(fs, path) { return JSON.parse(await fs.readFile(path, "utf8")); }
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function isWithin(root, path) { const suffix = relative(root, path); return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix)); }
function unavailable(status, errorCode) { return Object.freeze({ status, errorCode }); }
function validateAbsolute(value, name) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw runtimeError("COMPUTER_USE_PATH_INVALID", `${name} must be an absolute path.`);
  }
}
function runtimeError(code, message) { return Object.assign(new Error(message), { code }); }
