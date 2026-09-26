import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { isPlatformAssistant } from "../utils/platformAssistantIdentity.mjs";

// Independent MCP installations are resources. A Session receives tools only
// through its bound Agent's current assignment and the fixed Tool Host.
export class McpRegistryService {
  constructor({ store, timeoutMs = 10_000 } = {}) {
    if (!store) throw new TypeError("McpRegistryService requires a store.");
    this.store = store;
    this.timeoutMs = timeoutMs;
  }

  list() {
    return this.store.selectAll(`
      SELECT server_id, name, url, transport, command, args_json, cwd, enabled, tool_count, verified_at,
             created_at, updated_at,
             (SELECT COUNT(*) FROM agent_mcp_assignments a WHERE a.server_id = s.server_id) AS assignment_count
      FROM mcp_server_registry s ORDER BY created_at DESC, server_id DESC
    `).map(presentServer);
  }

  get(serverId) {
    const row = this.store.selectOne(`
      SELECT server_id, name, url, transport, command, args_json, cwd, enabled, tool_count, verified_at,
             created_at, updated_at,
             (SELECT COUNT(*) FROM agent_mcp_assignments a WHERE a.server_id = s.server_id) AS assignment_count
      FROM mcp_server_registry s WHERE server_id = ?
    `, [serverId]);
    return row ? presentServer(row) : null;
  }

  async verify(input) {
    const config = await normalizedConfig(input);
    const client = new Client({ name: "corptie-mcp-installer", version: "1.0.0" });
    const transport = config.transport === "stdio"
      ? new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd,
        env: isolatedStdioEnv() })
      : config.transport === "sse"
        ? new SSEClientTransport(new URL(config.url))
        : new StreamableHTTPClientTransport(new URL(config.url));
    try {
      await timed(client.connect(transport), this.timeoutMs);
      const result = await timed(client.listTools(), this.timeoutMs);
      const tools = result?.tools;
      if (!Array.isArray(tools) || tools.length === 0) {
        throw registryError("MCP_TOOLS_EMPTY", "MCP Server did not expose tools.", 422);
      }
      for (const tool of tools) {
        if (typeof tool?.name !== "string" || !tool.name.trim()
          || tool?.inputSchema?.type !== "object") {
          throw registryError("MCP_TOOL_SCHEMA_INVALID", "MCP Server returned an invalid tool schema.", 422);
        }
      }
      return { ...config,
        toolCount: tools.length, toolNames: tools.map((tool) => tool.name) };
    } catch (error) {
      if (error?.code && String(error.code).startsWith("MCP_")) throw error;
      throw registryError("MCP_CONNECTION_FAILED", "MCP Server connection or tools/list failed.", 422);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async register(input) {
    const verified = await this.verify(input);
    const serverId = `mcp:${randomUUID()}`;
    const now = new Date().toISOString();
    this.store.db.run(`INSERT INTO mcp_server_registry
      (server_id, name, url, transport, command, args_json, cwd,
       enabled, tool_count, verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [serverId, verified.name, verified.url ?? "", verified.transport, verified.command ?? null,
      JSON.stringify(verified.args ?? []), verified.cwd ?? null, verified.toolCount, now, now, now]);
    this.store.scheduleSave();
    return this.get(serverId);
  }

  setEnabled(serverId, enabled) {
    if (typeof enabled !== "boolean") throw registryError("INVALID_INPUT", "enabled must be boolean.", 400);
    if (!this.get(serverId)) throw registryError("MCP_SERVER_NOT_FOUND", "MCP Server not found.", 404);
    this.store.db.run("UPDATE mcp_server_registry SET enabled = ?, updated_at = ? WHERE server_id = ?",
      [enabled ? 1 : 0, new Date().toISOString(), serverId]);
    this.store.scheduleSave();
    return this.get(serverId);
  }

  listForAgent(agentId) {
    if (!this.store.getAgent(agentId)) throw registryError("AGENT_NOT_FOUND", "Agent not found.", 404);
    return this.store.selectAll(
      "SELECT server_id FROM agent_mcp_assignments WHERE agent_id = ? ORDER BY added_at, server_id",
      [agentId]
    ).map((row) => row.server_id);
  }

  setAssignment(agentId, serverId, assigned) {
    if (!this.store.getAgent(agentId)) throw registryError("AGENT_NOT_FOUND", "Agent not found.", 404);
    if (isPlatformAssistant(agentId)) {
      throw registryError("PLATFORM_ASSISTANT_PROTECTED", "The built-in assistant's MCP assignments are managed by Corptie.", 403);
    }
    if (!this.get(serverId)) throw registryError("MCP_SERVER_NOT_FOUND", "MCP Server not found.", 404);
    if (assigned) {
      this.store.db.run(`INSERT OR IGNORE INTO agent_mcp_assignments (agent_id, server_id, added_at)
        VALUES (?, ?, ?)`, [agentId, serverId, new Date().toISOString()]);
    } else {
      this.store.db.run("DELETE FROM agent_mcp_assignments WHERE agent_id = ? AND server_id = ?",
        [agentId, serverId]);
    }
    this.store.scheduleSave();
    return { agentId, serverId, assigned: this.listForAgent(agentId).includes(serverId) };
  }

  remove(serverId) {
    const server = this.get(serverId);
    if (!server) throw registryError("MCP_SERVER_NOT_FOUND", "MCP Server not found.", 404);
    if (server.assignmentCount > 0) {
      throw registryError("MCP_SERVER_ASSIGNED", "Remove all Agent assignments before deleting this MCP Server.", 409);
    }
    this.store.db.run("DELETE FROM mcp_server_registry WHERE server_id = ?", [serverId]);
    this.store.scheduleSave();
    return { serverId, removed: true };
  }

  serversForAgent(agentId) {
    if (!this.store.getAgent(agentId)) return {};
    const rows = this.store.selectAll(`
      SELECT s.server_id, s.name, s.url, s.transport, s.command, s.args_json, s.cwd
      FROM mcp_server_registry s
      JOIN agent_mcp_assignments a ON a.server_id = s.server_id
      WHERE a.agent_id = ? AND s.enabled = 1 ORDER BY s.server_id
    `, [agentId]);
    return Object.fromEntries(rows.map((row) => [serverKey(row.server_id),
      row.transport === "stdio"
        ? { type: "stdio", command: row.command, args: JSON.parse(row.args_json), cwd: row.cwd,
          env: isolatedStdioEnv(), isolatedEnv: true, displayName: row.name }
        : { type: row.transport, url: row.url, displayName: row.name }]));
  }

  assignmentRevisionForAgent(agentId) {
    if (!this.store.getAgent(agentId)) return "none";
    const rows = this.store.selectAll(`
      SELECT s.server_id, s.url, s.transport, s.command, s.args_json, s.cwd, s.enabled, s.updated_at
      FROM mcp_server_registry s JOIN agent_mcp_assignments a ON a.server_id = s.server_id
      WHERE a.agent_id = ? ORDER BY s.server_id
    `, [agentId]);
    return rows.length === 0 ? "none"
      : createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  }
}

async function normalizedConfig(input = {}) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const transport = ["sse", "http", "stdio"].includes(input.transport) ? input.transport : null;
  if (!name || name.length > 120 || !transport) {
    throw registryError("INVALID_INPUT", "A name and supported transport are required.", 400);
  }
  if (input.headers != null || input.env != null) {
    throw registryError("MCP_CREDENTIALS_UNSUPPORTED", "This installation path does not accept credentials.", 400);
  }
  if (transport === "stdio") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    const args = input.args ?? [];
    if (!isAbsolute(command) || !isAbsolute(cwd) || !Array.isArray(args)
      || args.length > 32 || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw registryError("MCP_COMMAND_INVALID", "Local MCP requires an absolute executable, working directory and up to 32 string arguments.", 400);
    }
    try {
      await access(command, constants.X_OK);
      if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw registryError("MCP_COMMAND_INVALID", "Local MCP executable or working directory is unavailable.", 400);
    }
    return { name, transport, command, args, cwd };
  }
  if (input.command != null || input.args != null || input.cwd != null) {
    throw registryError("INVALID_INPUT", "Remote MCP configuration cannot include a local command.", 400);
  }
  let parsed;
  try { parsed = new URL(input.url); } catch { /* handled below */ }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed?.hostname);
  if (!parsed || (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:"))
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw registryError("MCP_URL_INVALID", "Use an HTTPS URL, or HTTP on local loopback, without embedded credentials or query parameters.", 400);
  }
  return { name, transport, url: parsed.href };
}

function presentServer(row) {
  return { serverId: row.server_id, name: row.name, url: row.url,
    transport: row.transport, enabled: Boolean(row.enabled), toolCount: row.tool_count,
    command: row.command, args: JSON.parse(row.args_json ?? "[]"), cwd: row.cwd,
    verifiedAt: row.verified_at, assignmentCount: row.assignment_count,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

function isolatedStdioEnv() {
  return Object.fromEntries(["PATH", "TMPDIR", "LANG"].filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]));
}

function serverKey(serverId) {
  return `standalone_${serverId.slice(4).replaceAll("-", "")}`;
}

function timed(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(registryError("MCP_RUNTIME_TIMEOUT", "MCP verification timed out.", 504)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function registryError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
