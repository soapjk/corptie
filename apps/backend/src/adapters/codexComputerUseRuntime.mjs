import { spawn } from "node:child_process";
import { once } from "node:events";
import { CodexStdioTransport } from "./codexStdioTransport.mjs";
import { resolveCodexCommand } from "../utils/codexCommand.mjs";

// An official tool host, not another product Session. No model turn is ever
// started here; Corptie's owning Session remains the sole authorization actor.
export async function connectCodexComputerUseRuntime(config, { onElicitation, command = resolveCodexCommand(),
  transportFactory = options => new CodexStdioTransport(options) } = {}) {
  let client, threadId, groupPid, closePromise;
  const killGroup = signal => {
    if (!groupPid) return;
    try { process.kill(-groupPid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const transport = transportFactory({ command,
    spawnProcess: (executable, args, options) => {
      const child = spawn(executable, args, { ...options, detached: true });
      groupPid = child.pid;
      return child;
    }, env: { ...process.env, CODEX_HOME: config.env.CODEX_HOME },
    onServerRequest: async request => {
      if (request.method !== "mcpServer/elicitation/request" || request.params?.threadId !== threadId) {
        transport.rejectUnsupportedRequest(request.id);
        return;
      }
      try {
        const result = await onElicitation(client, { params: request.params });
        await transport.respondToServerRequest(request.id, result);
      } catch {
        await transport.respondToServerRequest(request.id, { action: "cancel", content: null }).catch(() => {});
      }
    } });
  let closed = false;
  client = {
    async listTools() {
      const result = await transport.request("mcpServerStatus/list", { threadId, serverName: "node_repl" }, 30_000);
      const server = result.data?.find(value => value.name === "node_repl");
      if (!server || server.runtimeStatus !== "connected" || server.toolsError) {
        throw Object.assign(new Error("Official Computer Use host could not connect."), { code: "COMPUTER_USE_HOST_UNAVAILABLE" });
      }
      return { tools: Object.values(server.tools ?? {}) };
    },
    async callTool(request, _schema, options = {}) {
      if (closed) throw new Error("Computer Use host is closed.");
      options.signal?.throwIfAborted();
      const nativeMetadata = request._meta?.["x-codex-turn-metadata"];
      // AppServer rejects a source conversation's identity on this different
      // tool-host thread. Never strip or rewrite it to make a call succeed.
      if (nativeMetadata?.thread_id && nativeMetadata.thread_id !== threadId) {
        throw Object.assign(new Error("The isolated Computer Use host cannot bind the originating Provider Turn. A same-thread or delegated transport is required."), {
          code: "COMPUTER_USE_TURN_BINDING_UNSUPPORTED"
        });
      }
      // Only correlation supplied by the Provider adapter is forwarded. There
      // is no synthetic turn on the private tool-host thread and no model call.
      const abort = () => { void client.close().catch(() => {}); };
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        options.signal?.throwIfAborted();
        return await transport.request("mcpServer/tool/call", { threadId, server: "node_repl", tool: request.name,
          arguments: request.arguments, ...(request._meta ? { _meta: request._meta } : {}) }, options.timeout ?? 300_000);
      } finally { options.signal?.removeEventListener("abort", abort); }
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        const child = transport.process;
        const exited = child && child.exitCode == null ? once(child, "exit").catch(() => {}) : Promise.resolve();
        await transport.close();
        killGroup("SIGTERM");
        if (!child) return;
        let timer;
        await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => {
          killGroup("SIGKILL");
          if (child.exitCode == null) child.kill("SIGKILL");
          resolve();
        }, 3000); })]);
        clearTimeout(timer);
        await exited;
        // Root exit does not prove all MCP/kernel descendants exited.
        killGroup("SIGKILL");
      })();
      return closePromise;
    }
  };
  try {
    await transport.initialize();
    const result = await transport.request("thread/start", { cwd: config.cwd, ephemeral: true,
      approvalPolicy: "on-request", sandbox: "read-only", config: {
        "features.apps": false, "features.plugins": false, "analytics.enabled": false,
        "mcp_servers.node_repl": { command: config.command, args: config.args ?? [], env: config.env,
          startup_timeout_sec: 30 }
      } }, 30_000);
    threadId = result.thread.id;
    return client;
  } catch (error) { await client.close(); throw error; }
}
