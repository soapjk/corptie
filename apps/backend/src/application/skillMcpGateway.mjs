import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toolDiscoveryContract } from "./toolDiscoveryContracts.mjs";

// Keeps Skill MCP processes behind Corptie's authenticated, Session-scoped MCP
// server. Provider bindings therefore remain stable when Agent assignments
// change; only the permanent server's tools/list result changes.
export class SkillMcpGateway {
  constructor(options = {}) {
    if (typeof options.resolveServers !== "function") {
      throw new TypeError("SkillMcpGateway requires resolveServers().");
    }
    this.resolveServers = options.resolveServers;
    this.resolveRevision = options.resolveRevision ?? (() => "none");
    this.timeoutMs = Number(options.timeoutMs ?? 10_000);
    this.connectServer = options.connectServer ?? ((serverName, config) => connectServer(serverName, config, this.timeoutMs));
    this.entries = new Map();
    this.pending = new Map();
  }

  revision(actorId) {
    return String(this.resolveRevision(actorId) ?? "none");
  }

  async definitions(input = {}) {
    const entry = await this.#entry(input);
    return entry.definitions;
  }

  async search(input = {}) {
    const entry = await this.#entry(input);
    const toolLimit = Number.isSafeInteger(input.toolLimit) && input.toolLimit > 0
      ? input.toolLimit
      : 20;
    const query = searchableText(input.intent);
    const queryTerms = searchTerms(query);
    const hintTerms = searchTerms(input.domainHint);
    const grouped = new Map();
    for (const [name, target] of entry.tools) {
      const values = grouped.get(target.serverName) ?? [];
      values.push({ name, target });
      grouped.set(target.serverName, values);
    }
    const domains = [];
    for (const [serverName, tools] of grouped) {
      const domainId = `skill-mcp:${serverName}`;
      const domainText = searchableText(`${domainId} ${serverName}`);
      if (hintTerms.length > 0 && !hintTerms.every((term) => domainText.includes(term))) continue;
      const ranked = tools.map(({ name, target }) => {
        const haystack = searchableText(`${name} ${target.definition.description ?? ""} ${serverName}`);
        const matches = queryTerms.filter((term) => haystack.includes(term)).length;
        return { name, target, score: haystack.includes(query) ? matches + 2 : matches };
      }).filter(({ score }) => queryTerms.length === 0 || score > 0)
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
      if (queryTerms.length > 0 && ranked.length === 0) continue;
      const recommendedTool = recommendedToolName(ranked.map(({ name }) => name));
      const profile = { aliases: Object.freeze([serverName, domainId, `skill mcp ${serverName}`]), recommendedTool };
      domains.push(Object.freeze({
        domainId,
        domainRevision: entry.catalogVersion,
        toolCount: ranked.length,
        aliases: profile.aliases,
        recommendedTool,
        invocation: Object.freeze({
          mode: "restricted_gateway",
          gatewayTool: "corptie_tool_call",
          expectedCatalogVersion: entry.catalogVersion,
          contract: "Call the selected assigned Skill MCP tool through the fixed Corptie gateway using its minimalExample and authoritative inputSchema."
        }),
        tools: Object.freeze(ranked.slice(0, toolLimit).map(({ name, target }) => toolDiscoveryContract({
          canonicalName: name,
          domainId,
          definition: target.definition,
          aliases: Object.freeze([])
        }, profile)))
      }));
    }
    return Object.freeze({ catalogVersion: entry.catalogVersion, domains: Object.freeze(domains) });
  }

  async domain(input = {}, domainId) {
    const result = await this.search({
      ...input,
      intent: "",
      domainHint: String(domainId).replace(/^skill-mcp:/, ""),
      toolLimit: Number.MAX_SAFE_INTEGER
    });
    return result.domains.find((domain) => domain.domainId === domainId) ?? null;
  }

  async execute(input = {}, options = {}) {
    const entry = await this.#entry(input);
    if (options.expectedCatalogVersion && options.expectedCatalogVersion !== entry.catalogVersion) {
      const error = gatewayError("TOOL_CATALOG_STALE", "The assigned Skill MCP catalog changed; search again before calling the gateway.", 409);
      error.expectedCatalogVersion = options.expectedCatalogVersion;
      error.currentCatalogVersion = entry.catalogVersion;
      throw error;
    }
    const target = entry.tools.get(requiredText(input.tool, "tool"));
    if (!target) throw gatewayError("HOST_TOOL_UNSUPPORTED", `Unsupported assigned Skill MCP tool: ${input.tool}`, 404);
    // #entry re-resolves the current assignment fingerprint before every call,
    // so removing a Skill revokes access even if a Provider retained an old list.
    return withTimeout(
      target.client.callTool({ name: target.remoteName, arguments: input.arguments ?? {} }),
      this.timeoutMs,
      `Skill MCP tool ${input.tool} timed out.`
    );
  }

  async close() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.flatMap((entry) => entry.clients.map((client) => client.close().catch(() => {}))));
  }

  async #entry(input) {
    const actorId = requiredText(input.actorId, "actorId");
    const providerId = requiredText(input.providerId ?? input.metadata?.providerId, "providerId");
    const key = `${actorId}\u0000${providerId}`;
    const servers = await this.resolveServers({ actorId, providerId, context: input.metadata ?? {} });
    const fingerprint = sha256(stableStringify(servers ?? {}));
    const existing = this.entries.get(key);
    if (existing?.fingerprint === fingerprint) return existing;
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = this.#connect(servers ?? {}, fingerprint)
      .then(async (next) => {
        const previous = this.entries.get(key);
        this.entries.set(key, next);
        if (previous) await Promise.all(previous.clients.map((client) => client.close().catch(() => {})));
        return next;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  async #connect(servers, fingerprint) {
    const clients = [];
    const tools = new Map();
    const definitions = [];
    try {
      for (const [serverName, config] of Object.entries(servers)) {
        const client = await this.connectServer(serverName, config);
        clients.push(client);
        const listed = await withTimeout(client.listTools(), this.timeoutMs, `Skill MCP server ${serverName} tools/list timed out.`);
        for (const raw of listed?.tools ?? []) {
          const name = requiredText(raw?.name, "tool.name");
          if (tools.has(name)) throw gatewayError("MCP_TOOL_NAME_CONFLICT", `Assigned Skill MCP tool name conflicts: ${name}`, 409);
          const definition = Object.freeze({
            name,
            description: typeof raw.description === "string" ? raw.description : "",
            inputSchema: raw.inputSchema && typeof raw.inputSchema === "object"
              ? raw.inputSchema
              : { type: "object", properties: {}, additionalProperties: false },
            ...(raw.annotations ? { annotations: raw.annotations } : {})
          });
          definitions.push(definition);
          tools.set(name, { client, remoteName: name, serverName, definition });
        }
      }
      definitions.sort((left, right) => left.name.localeCompare(right.name));
      const catalogVersion = `skill-mcp:1:${sha256(`${fingerprint}:${stableStringify(definitions)}`)}`;
      return Object.freeze({ fingerprint, catalogVersion, clients, tools, definitions: Object.freeze(definitions) });
    } catch (error) {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
      throw error;
    }
  }
}

async function connectServer(serverName, config, timeoutMs) {
  const client = new Client({ name: "corptie-skill-mcp-gateway", version: "1.0.0" });
  try {
    await withTimeout(client.connect(createTransport(config)), timeoutMs, `Skill MCP server ${serverName} initialize timed out.`);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

function createTransport(server = {}) {
  if (server.type === "http") {
    return new StreamableHTTPClientTransport(new URL(requiredText(server.url, "server.url")), {
      requestInit: server.headers ? { headers: server.headers } : undefined
    });
  }
  if (server.type === "sse") {
    return new SSEClientTransport(new URL(requiredText(server.url, "server.url")), {
      requestInit: server.headers ? { headers: server.headers } : undefined
    });
  }
  return new StdioClientTransport({
    command: requiredText(server.command, "server.command"),
    args: server.args ?? [],
    cwd: server.cwd,
    env: { ...process.env, ...(server.env ?? {}) },
    stderr: "pipe"
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(gatewayError("MCP_RUNTIME_TIMEOUT", message, 504)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function searchableText(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function searchTerms(value) {
  return searchableText(value).split(/[^\p{L}\p{N}_:-]+/u).filter(Boolean);
}

function recommendedToolName(names) {
  return names.find((name) => /(?:^|_)diagnostics(?:_|$)/.test(name))
    ?? names.find((name) => /(?:^|_)context(?:_|$)/.test(name))
    ?? names[0]
    ?? null;
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw gatewayError("MCP_RUNTIME_INVALID", `${field} is required.`, 400);
  return text;
}

function gatewayError(code, message, statusCode = 503) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
