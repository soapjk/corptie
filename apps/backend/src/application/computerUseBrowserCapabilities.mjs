import { readFile, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";

// Read-only compatibility detection. Installed components do not establish a
// browser connection or a grant. No extension/profile settings are read here.
export async function discoverBrowserSurface(modules) {
  try {
    const directory = await realpath(join(modules, "@oai/browser-desktop"));
    const base = await realpath(modules);
    const child = relative(base, directory);
    if (child.startsWith("..") || isAbsolute(child)) throw new Error("Untrusted browser service path.");
    const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (pkg.name !== "@oai/browser-desktop" || typeof pkg.exports?.["./service"] !== "string") throw new Error("Missing browser service.");
    const service = await realpath(resolve(directory, pkg.exports["./service"]));
    const suffix = relative(directory, service);
    if (suffix.startsWith("..") || isAbsolute(suffix)) throw new Error("Untrusted browser service entry.");
    const source = await readFile(service, "utf8");
    const compatible = ["codex.browserAccess.v1", "BROWSER_USE_ACCESS_EXECUTOR_ID", "BROWSER_USE_ACCESS_PIPE_PATH",
      "BROWSER_USE_ACCESS_VERIFYING_IDENTITY"].every(marker => source.includes(marker));
    return { supported: true, configured: compatible, connected: null, ready: false,
      permissionStatus: "unknown", status: compatible ? "not_checked" : "protocol_incompatible",
      reasonCode: compatible ? "BROWSER_CONNECTION_UNCHECKED" : "BROWSER_PROTOCOL_INCOMPATIBLE", version: pkg.version };
  } catch {
    return { supported: false, configured: false, connected: null, ready: false,
      permissionStatus: "unknown", status: "missing_component", reasonCode: "BROWSER_COMPONENT_MISSING" };
  }
}

export function computerUseSurfaces(engine, browser) {
  return {
    computer: { supported: true, configured: true, ready: false, status: "permissions_unknown", permissionStatus: "unknown" },
    browser: engine === "independent"
      ? { supported: false, configured: false, connected: false, ready: false, status: "unsupported",
        reasonCode: "BROWSER_INDEPENDENT_UNSUPPORTED", permissionStatus: "unknown" }
      : browser
  };
}
