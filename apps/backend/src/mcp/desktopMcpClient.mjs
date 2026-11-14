import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { prepareComputerUseBridge, computerUseBridgeFingerprint } from "../application/computerUseBridge.mjs";
import { prepareBuiltinComputerUse, computerUseEngineFingerprint } from "../application/computerUseEngine.mjs";
import { isBuiltinComputerUseConfig } from "../application/computerUseGatewayPolicy.mjs";

const exec = promisify(execFile);
async function waitForExit(exited, ms) {
  let timer;
  try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
  finally { clearTimeout(timer); }
}

// Unlike the generic SDK transport's 2s grace, allow the adapter to finish its
// native cleanup. Only this instance's recorded private descendants are reaped.
export class DesktopStdioTransport {
  constructor(config, { graceMs = 10_000 } = {}) { this.config = config; this.graceMs = graceMs; this.buffer = new ReadBuffer(); }
  async start() {
    if (this.process) throw new Error("Transport already started.");
    const p = this.process = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd, env: this.config.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise(resolve => p.once("close", () => { this.onclose?.(); resolve(); }));
    p.on("error", e => this.onerror?.(e));
    p.stdin.on("error", e => { if (e.code !== "EPIPE") this.onerror?.(e); });
    // Consume stderr without retaining app text, prompts or configuration.
    p.stderr.on("data", () => {});
    p.stdout.on("data", chunk => {
      this.buffer.append(chunk);
      try { let m; while ((m = this.buffer.readMessage()) !== null) this.onmessage?.(m); }
      catch (e) { this.onerror?.(e); }
    });
    await new Promise((resolve, reject) => { p.once("spawn", resolve); p.once("error", reject); });
  }
  async send(message) {
    await new Promise((resolve, reject) => this.process.stdin.write(serializeMessage(message), e => e ? reject(e) : resolve()));
  }
  close() { return this.closing ??= this.#close(); }
  async #close() {
    const p = this.process;
    if (!p) return;
    const before = await processes();
    const owned = new Map();
    const parents = new Set([p.pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of before.values()) if (parents.has(row.ppid) && !parents.has(row.pid)
        && !/SkyComputerUseService|CorptieMac|\/ChatGPT$/.test(row.command)) {
        parents.add(row.pid); owned.set(row.pid, row); changed = true;
      }
    }
    if (before.has(p.pid)) owned.set(p.pid, before.get(p.pid));
    p.stdin.end();
    await waitForExit(this.exited, this.graceMs);
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      const live = await processes();
      for (const [pid, row] of owned) if (live.get(pid)?.identity === row.identity) {
        try { process.kill(pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; }
      }
      await waitForExit(this.exited, 500);
    }
    let live = await processes();
    for (let attempts = 0; attempts < 10 && [...owned].some(([pid, row]) => live.get(pid)?.identity === row.identity); attempts++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      live = await processes();
    }
    if ([...owned].some(([pid, row]) => live.get(pid)?.identity === row.identity)) {
      throw Object.assign(new Error("Private Computer Use process cleanup could not be verified."), { code: "COMPUTER_USE_CLEANUP_FAILED" });
    }
    this.buffer.clear();
  }
}

async function processes() {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,lstart=,comm="], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
  return new Map(stdout.split("\n").flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    return m ? [[Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), command: m[4], identity: `${m[3]}:${m[4]}` }]] : [];
  }));
}

// A facade can reopen after a Turn boundary while ordinary MCP connections in
// the same gateway entry remain alive. Every reopen gets a fresh private state.
export async function connectDesktopMcp(config, onElicitation, { prepare = isBuiltinComputerUseConfig(config)
  ? prepareBuiltinComputerUse : prepareComputerUseBridge,
  transportFactory = c => new DesktopStdioTransport(c), fingerprint = isBuiltinComputerUseConfig(config)
    ? computerUseEngineFingerprint : computerUseBridgeFingerprint } = {}) {
  let connection, opening, instructions = "", closing;
  const facade = {
    getInstructions: () => instructions,
    async listTools() { return (await ensure()).client.listTools(); },
    async callTool(request, schema, options) {
      const active = await ensure();
      // Origin correlation remains in Corptie's invocation/audit context. The
      // published adapter manages its own native transport metadata.
      return active.client.callTool({ name: request.name, arguments: request.arguments }, schema, options);
    },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        const current = connection ?? await opening;
        connection = null;
        if (!current) return;
        await current.client.close();
        await rm(current.config.stateRoot, { recursive: true, force: true });
      })();
      try { await closing; } finally { closing = null; }
    }
  };
  async function ensure() {
    if (closing) await closing;
    if (connection) {
      if (connection.fingerprint === await fingerprint(config)) return connection;
      await facade.close();
      throw Object.assign(new Error("Computer Use components changed; reload the tool catalog before continuing. No action was retried."),
        { code: "COMPUTER_USE_RUNTIME_CHANGED" });
    }
    opening ??= (async () => {
      const prepared = await prepare(config);
      const client = new Client({ name: "corptie-desktop-mcp", version: "1.0.0" }, {
        capabilities: { elicitation: { form: {}, url: {} } } });
      client.setRequestHandler(ElicitRequestSchema, (r, extra) => onElicitation(facade, r, extra));
      try {
        await client.connect(transportFactory(prepared));
        instructions = String(client.getInstructions() ?? "").slice(0, 32_768);
        return connection = { client, config: prepared, fingerprint: await fingerprint(config) };
      } catch (e) { await client.close().catch(() => {}); await rm(prepared.stateRoot, { recursive: true, force: true }); throw e; }
    })();
    try { return await opening; } finally { opening = null; }
  }
  await ensure();
  return facade;
}
