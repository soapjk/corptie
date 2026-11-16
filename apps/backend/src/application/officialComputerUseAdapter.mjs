import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Minimal adaptation of MIT codex-computer-use-mcp 0.7.1. Keep upstream signature
// verification, direct-only dispatch and cleanup. Materialize only in the private
// runtime directory; never patch node_modules or the official application bundle.
export async function prepareOfficialBrokerAdapter(packagePath, root) {
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  if (pkg.name !== "codex-computer-use-mcp" || pkg.version !== "0.7.1") throw new Error("Unsupported Computer Use adapter version.");
  const directory = join(dirname(packagePath), "dist");
  const upstream = await readFile(join(directory, "direct-broker.js"), "utf8");
  const needle = 'const toolCall = (tool, args, timeoutMs, kind) => request("mcpServer/tool/call", {';
  if (upstream.split(needle).length !== 2) throw Object.assign(new Error("Computer Use broker identity hook is incompatible."), { code: "BROWSER_BROKER_INCOMPATIBLE" });
  const adapted = upstream.replace(needle,
    'const toolCall = (tool, args, timeoutMs, kind) => (options.onNativeDispatch?.({sessionId: threadId, turnId, tool}), request("mcpServer/tool/call", {')
    .replace('}, timeoutMs, kind);\n    const drainToolResponse', '}, timeoutMs, kind));\n    const drainToolResponse')
    .replace(/from "(\.\/[^"\n]+)"/g, (_, specifier) => `from ${JSON.stringify(pathToFileURL(join(directory, specifier)).href)}`)
    // A relocated module must resolve zod in the pinned package, not its temporary parent.
    .replace('from "zod"', `from ${JSON.stringify(pathToFileURL(join(directory, "../node_modules/zod/index.js")).href)}`);
  if (!adapted.includes('}, timeoutMs, kind));\n    const drainToolResponse')) throw new Error("Computer Use broker dispatch shape changed.");
  // Resolve dependencies through the upstream module's own resolver, including hoisted installs.
  const { createRequire } = await import("node:module");
  const require = createRequire(packagePath);
  const source = adapted.replace(pathToFileURL(join(directory, "../node_modules/zod/index.js")).href,
    pathToFileURL(require.resolve("zod")).href);
  const entry = join(root, "corptie-direct-broker.mjs");
  await writeFile(entry, source, { mode: 0o600 });
  await writeFile(join(root, "broker-LICENSE"), await readFile(join(dirname(packagePath), "LICENSE")), { mode: 0o600 });
  return entry;
}
