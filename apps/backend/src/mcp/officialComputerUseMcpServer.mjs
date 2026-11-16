import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createBrowserAccessHost, BROWSER_CONTEXT_META } from "../application/browserAccessHost.mjs";
import { prepareOfficialBrokerAdapter } from "../application/officialComputerUseAdapter.mjs";

const require = createRequire(import.meta.url);
export async function createOfficialComputerUseServer({ root = process.env.CODEX_COMPUTER_USE_HOME,
  packagePath = require.resolve("codex-computer-use-mcp/package.json"), brokerFactory } = {}) {
  if (!root) throw new Error("Private Computer Use runtime directory required.");
  const configPath = join(root, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const native = JSON.parse(await readFile(config.cuaReplConfigPath, "utf8"));
  const env = native.mcpServers.cua_repl.env;
  const browserEnabled = env.CUA_REPL_ENABLED_SURFACES.split(",").includes("browser");
  const { cuaReplToolDefinitions } = await import(pathToFileURL(join(dirname(packagePath), "dist/tools.js")).href);
  const definitions = cuaReplToolDefinitions(env);
  const { forwardOfficialElicitationToMcpClient } = await import(pathToFileURL(join(dirname(packagePath), "dist/mcp-elicitation.js")).href);
  let broker, active = false, closed = false, closing, granted;
  let browserState = { configured: browserEnabled, connected: null, permissionStatus: "unknown", status: "not_checked" };
  const server = new Server({ name: "corptie-official-computer-use", version: "1.0.0" }, {
    capabilities: { tools: {} }, instructions: definitions.instructions });
  const host = browserEnabled ? await createBrowserAccessHost({ authorize: async () => granted === true }) : null;
  try {
    if (host) {
      Object.assign(env, host.env);
      // Configuration is private to this MCP instance and is not a user/plugin cache.
      await writeFile(config.cuaReplConfigPath, JSON.stringify(native), { mode: 0o600 });
    }
  } catch (error) { await host?.close(); throw error; }
  const statusTool = { name: "computer_use_status", description: "Show desktop/browser configuration. Set inspectBrowsers=true to check the browser connection in this Session; may request browser access. Does not open or navigate tabs.",
    inputSchema: { type: "object", properties: { inspectBrowsers: { type: "boolean" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...definitions.tools, statusTool] }));
  const status = () => ({ engine: "official", surfaces: { computer: { configured: true, permissionStatus: "unknown" }, browser: browserState } });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {}, _meta } = request.params;
    if (name === "computer_use_status" && args.inspectBrowsers !== true) {
      return { content: [{ type: "text", text: JSON.stringify(status()) }], structuredContent: status() };
    }
    if (!["js", "js_reset", "computer_use_status"].includes(name)) throw new Error("Unknown Computer Use tool.");
    if (closed || active) throw new Error("Computer Use runtime is closed or busy.");
    if (name === "computer_use_status" && !browserEnabled) return {
      isError: true, content: [{ type: "text", text: "Browser runtime is unavailable. Check Computer Use runtime status." }], structuredContent: status() };
    active = true;
    let finish;
    try {
      // Only the parent facade can supply this metadata over the private pipe.
      finish = host?.begin(_meta?.[BROWSER_CONTEXT_META], extra.signal);
      if (host && granted === undefined) {
        // Ask before native dispatch: the runtime's signed challenge has a 10s
        // timeout, which must not become the user's time limit for answering.
        const reply = await server.elicitInput({ mode: "form",
          message: "允许当前 Session 本轮访问已连接的浏览器吗？网站访问仍会单独请求授权。拒绝后仍可使用原生桌面操作。",
          requestedSchema: { type: "object", properties: {}, additionalProperties: false },
          _meta: { connector_id: "computer-use-browser", riskLevel: "medium" } }, { signal: extra.signal });
        granted = reply.action === "accept" && !extra.signal.aborted;
        browserState = { ...browserState, permissionStatus: granted ? "granted" : "denied" };
      }
      extra.signal.throwIfAborted();
      if (!broker) {
        const createBroker = brokerFactory ?? (await import(pathToFileURL(await prepareOfficialBrokerAdapter(packagePath, root)).href)).createOfficialCuaReplSession;
        broker = await createBroker({ configPath, supportsOpenAiFormElicitation: true,
          onNativeDispatch: identity => host?.bindNative(identity) });
      }
      const inspect = name === "computer_use_status";
      const result = await broker.call(inspect ? "js" : name, inspect ? {
        code: 'var __corptieBrowserInventory = await cua.listBrowsers({emit:false}); nodeRepl.write(JSON.stringify({corptieBrowserInventory:__corptieBrowserInventory.map(b=>({id:b.id,name:b.name,type:b.type,family:b.family}))}));',
        title: "检查浏览器连接" } : args, {
        signal: extra.signal,
        onElicitation: input => forwardOfficialElicitationToMcpClient(server, input, extra.signal) });
      if (inspect) {
        let browsers;
        for (const block of result.content ?? []) {
          if (block.type !== "text") continue;
          try { const parsed = JSON.parse(block.text); if (Array.isArray(parsed.corptieBrowserInventory)) browsers = parsed.corptieBrowserInventory; } catch {}
        }
        browserState = { ...browserState, connected: browsers ? browsers.length > 0 : null,
          status: result.isError ? "check_failed" : browsers ? (browsers.length ? "connected" : "disconnected") : "check_failed",
          ...(browsers ? { browsers } : {}) };
        return { content: result.content, ...(result.isError || !browsers ? { isError: true } : {}), structuredContent: status() };
      }
      return { content: result.content, ...(result.isError ? { isError: true } : {}),
        ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}) };
    } catch (error) {
      // Failed dispatch has an unknown outcome: retire the broker, never replay.
      closed = true;
      await host?.close();
      await broker?.close().catch(() => {});
      return { isError: true, content: [{ type: "text", text: `${error.code ?? "COMPUTER_USE_CALL_FAILED"}: ${error.message}` }] };
    } finally { finish?.(); active = false; }
  });
  const close = () => closing ??= (async () => { closed = true; await host?.close(); await broker?.close(); })();
  server.onclose = () => { void close().catch(() => { process.exitCode = 1; }); };
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, close } = await createOfficialComputerUseServer();
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void close().finally(() => process.exit()); });
  await server.connect(new StdioServerTransport());
}
