import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

// Corptie-owned isolated runtime for the OpenClacky Provider. This mirrors the
// managed Claude/Codex runtimes: Corptie owns a dedicated state/config/log/
// extension directory so OpenClacky Sessions never read or mutate the user's
// native OpenClacky configuration (~/.clacky, project-level MCP manifests).
const BRIDGE_MANIFEST = Object.freeze({
  name: "corptie-openclacky-bridge",
  protocol: "corptie-bridge-v1"
});

export function resolveCorptieOpenClackyRuntimePaths(options = {}) {
  const home = resolve(options.homeDir ?? os.homedir());
  const corptieHome = resolve(options.corptieHome ?? process.env.CORPTIE_HOME ?? join(home, ".corptie"));
  const environmentName = options.environmentName === "development" ? "development" : "production";
  const runtimeRoot = environmentName === "development"
    ? join(corptieHome, "development", "runtimes", "openclacky")
    : join(corptieHome, "runtimes", "openclacky");
  return {
    corptieHome,
    runtimeRoot,
    configDir: join(runtimeRoot, "config"),
    stateDir: join(runtimeRoot, "state"),
    logDir: join(runtimeRoot, "logs"),
    extensionDir: join(runtimeRoot, "extensions"),
    bridgeManifestPath: join(runtimeRoot, "bridge-manifest.json")
  };
}

export async function ensureCorptieOpenClackyRuntime(options = {}) {
  const paths = resolveCorptieOpenClackyRuntimePaths(options);
  for (const dir of [paths.configDir, paths.stateDir, paths.logDir, paths.extensionDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  const manifestChanged = await syncManagedContent(
    `${JSON.stringify(BRIDGE_MANIFEST, null, 2)}\n`,
    paths.bridgeManifestPath,
    0o600
  );
  return {
    ...paths,
    manifestChanged
  };
}

async function syncManagedContent(content, destination, mode) {
  let current = null;
  try {
    current = await readFile(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const expected = Buffer.from(content);
  if (current?.equals(expected)) {
    await chmod(destination, mode);
    return false;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporaryPath = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, expected, { mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, destination);
  return true;
}
