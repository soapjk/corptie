import { createHash, createHmac, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toolDiscoveryContract, rankDiscoveryCandidates } from "./toolDiscoveryContracts.mjs";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isComputerUseMcpConfig, isNativeComputerUseMcpConfig, isComputerUseBridgeConfig } from "./computerUseGatewayPolicy.mjs";
import { connectDesktopMcp } from "../mcp/desktopMcpClient.mjs";
import { restrictedMcpFetch } from "./restrictedMcpFetch.mjs";

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
    this.assertSessionEnabled = options.assertSessionEnabled ?? (() => {});
    this.assertSessionRequest = options.assertSessionRequest ?? (() => {});
    this.onElicitation = options.onElicitation ?? null;
    this.executionContext = options.executionContext ?? (input => input.metadata ?? {});
    this.computerUseSupport = options.computerUseSupport ?? (() => false);
    this.activeCalls = new Map();
    this.clientCalls = new WeakMap();
    this.desktopCall = null;
    this.stoppedTurns = new Set();
    this.timeoutMs = Number(options.timeoutMs ?? 10_000);
    this.computerUseTimeoutMs = options.computerUseTimeoutMs ?? 300_000;
    this.retryMs = Number(options.retryMs ?? 10_000);
    this.connectServer = options.connectServer ?? ((serverName, config, context) => {
      const elicit = (client, request, extra) => this.elicit(client, request, extra);
      if (isComputerUseBridgeConfig(config)) return connectDesktopMcp(config, elicit);
      if (isNativeComputerUseMcpConfig(config)) {
        if (!options.connectComputerUseServer) throw gatewayError("COMPUTER_USE_PROVIDER_UNSUPPORTED", "An official Provider tool-host connection is required.", 409);
        return options.connectComputerUseServer(config, context, elicit);
      }
      return connectServer(serverName, config, this.timeoutMs, elicit);
    });
    this.onRuntimeEvent = options.onRuntimeEvent ?? null;
    // Runtime configs can contain Header or environment credentials. Never
    // expose an unkeyed digest of those values in a public catalog version.
    this.fingerprintKey = randomBytes(32);
    this.entries = new Map();
    this.pending = new Map();
    this.leases = new WeakMap();
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
    const grouped = new Map();
    for (const [name, target] of entry.tools) {
      const values = grouped.get(target.serverName) ?? [];
      values.push({ name, target });
      grouped.set(target.serverName, values);
    }
    const domains = [];
    const domainScores = new Map();
    for (const [serverName, tools] of grouped) {
      const domainId = serverName.startsWith("standalone_")
        ? `mcp:${serverName}` : `skill-mcp:${serverName}`;
      if (input.exactDomainId && input.exactDomainId !== domainId) continue;
      const serverLabel = tools[0]?.target?.serverLabel ?? serverName;
      const defaultTool = recommendedToolName(tools.map(({ name }) => name));
      const ranked = rankDiscoveryCandidates(tools.map(({ name, target }) => ({
        name, target, domainId, definition: target.definition,
        aliases: [serverName, serverLabel, domainId], preferred: name === defaultTool
      })), input);
      if (ranked.length === 0) continue;
      const recommendedTool = ranked[0].name;
      domainScores.set(domainId, ranked[0].score);
      const profile = { aliases: Object.freeze([serverName, serverLabel, domainId, `mcp ${serverLabel}`]), recommendedTool };
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
    return Object.freeze({
      catalogVersion: entry.catalogVersion,
      domains: Object.freeze(domains.sort((a, b) => domainScores.get(b.domainId) - domainScores.get(a.domainId))),
      unavailableServers: entry.unavailableServers
    });
  }

  async domain(input = {}, domainId) {
    const entry = await this.#entry(input);
    const unavailable = entry.unavailableServers.find((server) => server.domainId === domainId);
    if (unavailable) throw gatewayError("MCP_SERVER_UNAVAILABLE", `Assigned MCP server is unavailable: ${domainId} (${unavailable.code}).`, 503);
    const result = await this.search({
      ...input,
      intent: "",
      exactDomainId: domainId,
      toolLimit: Number.MAX_SAFE_INTEGER
    });
    return result.domains.find((domain) => domain.domainId === domainId) ?? null;
  }

  async execute(input = {}, options = {}) {
    this.assertSessionRequest(input);
    const entry = await this.#entry(input);
    if (options.expectedCatalogVersion && options.expectedCatalogVersion !== entry.catalogVersion) {
      const error = gatewayError("TOOL_CATALOG_STALE", "The assigned Skill MCP catalog changed; search again before calling the gateway.", 409);
      error.expectedCatalogVersion = options.expectedCatalogVersion;
      error.currentCatalogVersion = entry.catalogVersion;
      throw error;
    }
    const target = entry.tools.get(requiredText(input.tool, "tool"));
    if (!target) throw gatewayError("HOST_TOOL_UNSUPPORTED", `Unsupported assigned Skill MCP tool: ${input.tool}`, 404);
    // Recheck after asynchronous connection/catalog work, immediately before dispatch.
    this.assertSessionEnabled(input, target);
    // #entry re-resolves the current assignment fingerprint before every call,
    // so removing a Skill revokes access even if a Provider retained an old list.
    const event = { serverId: target.serverId, agentId: input.actorId,
      providerId: input.providerId ?? input.metadata?.providerId,
      logicalSessionId: input.metadata?.logicalSessionId,
      bindingId: input.metadata?.bindingId,
      stage: "tool-call", toolName: target.remoteName };
    const lease = this.leases.get(entry);
    const context = this.executionContext(input);
    const desktop = target.computerUse;

    if (desktop && this.desktopCleanupError) throw this.desktopCleanupError;
    if (desktop && !this.computerUseSupport(input)) {
      throw gatewayError("COMPUTER_USE_PROVIDER_UNSUPPORTED", "This Provider does not support the required Computer Use result and approval protocol.", 409);
    }
    if (desktop && (!context.logicalSessionId || !context.turnId || !context.providerBindingId)) {
      throw gatewayError("MCP_TURN_REQUIRED", "Computer Use requires a current Session binding and active turn.", 409);
    }
    if (this.clientCalls.has(target.client) || (desktop && this.desktopCall)) {
      throw gatewayError("MCP_SERVER_BUSY", "The MCP runtime is already executing a Session request. Retry after it finishes.", 409);
    }
    if (this.stoppedTurns.has(`${context.logicalSessionId}:${context.turnId}`)) {
      throw gatewayError("MCP_CALL_CANCELLED", "This Session turn has already ended.", 409);
    }
    if (desktop) lease.lastTurnId = context.turnId;
    const controller = new AbortController();
    const call = { target, context, input, controller };
    this.activeCalls.set(controller, call);
    this.clientCalls.set(target.client, call);
    if (desktop) this.desktopCall = call;
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const timeoutMs = desktop ? this.computerUseTimeoutMs : this.timeoutMs;
    const timer = setTimeout(() => controller.abort(gatewayError("MCP_RUNTIME_TIMEOUT", "MCP operation timed out; its outcome may be unknown. No action was retried.", 504)), timeoutMs);
    lease.active += 1;
    try {
      controller.signal.throwIfAborted();
      const result = await Promise.race([
        target.client.callTool({ name: target.remoteName, arguments: input.arguments ?? {},
          ...(context.requestMetadata ? { _meta: context.requestMetadata } : {}) }, undefined,
          { signal: controller.signal, timeout: timeoutMs }),
        new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason
            ?? gatewayError("MCP_CALL_CANCELLED", "MCP request cancelled.", 409)), { once: true });
        })
      ]);
      this.#emitRuntimeEvent({ ...event, status: result?.isError ? "failed" : "success",
        errorCode: result?.isError ? "MCP_TOOL_RESULT_ERROR" : null });
      return result;
    } catch (error) {
      this.#emitRuntimeEvent({ ...event, status: "failed", errorCode: error?.code });
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      if (controller.signal.aborted) {
        // Cancel closes the runtime before allowing another call: late input must not leak into it.
        lease.retired = true;
        if (desktop) {
          try { await target.client.close(); } catch (e) { this.desktopCleanupError = e; }
          lease.retired = false;
        } else {
          await this.#closeEntry(entry);
          for (const [key, value] of this.entries) if (value === entry) this.entries.delete(key);
        }
      }
      lease.active -= 1;
      if (lease.retired && lease.active === 0) await this.#closeEntry(entry);
      this.activeCalls.delete(controller);
      this.clientCalls.delete(target.client);
      if (this.desktopCall === call) this.desktopCall = null;
      if (desktop && this.desktopCleanupError) throw this.desktopCleanupError;
    }
  }

  async elicit(client, request, extra = {}) {
    const call = this.clientCalls.get(client);
    if (!call || call.controller.signal.aborted || !this.onElicitation) return { action: "cancel" };
    this.assertSessionEnabled(call.input, call.target);
    // Re-resolve authoritative binding at the approval boundary.
    const current = this.executionContext(call.input);
    if (call.context.turnId !== current.turnId) return { action: "cancel" };
    const result = await this.onElicitation({ metadata: { ...call.context,
      mcpServerKey: call.target.serverId ?? call.target.serverName }, request: request.params,
      signal: extra.signal ? AbortSignal.any([call.controller.signal, extra.signal]) : call.controller.signal });
    call.controller.signal.throwIfAborted();
    this.assertSessionEnabled(call.input, call.target);
    if (this.executionContext(call.input).turnId !== call.context.turnId) return { action: "cancel" };
    return result;
  }

  cancelSession(logicalSessionId, turnId = null) {
    if (logicalSessionId && turnId) {
      this.stoppedTurns.add(`${logicalSessionId}:${turnId}`);
      if (this.stoppedTurns.size > 2048) this.stoppedTurns.delete(this.stoppedTurns.values().next().value);
    }
    for (const call of this.activeCalls.values()) {
      if (call.context.logicalSessionId === logicalSessionId && (!turnId || call.context.turnId === turnId)) {
        call.controller.abort(gatewayError("MCP_CALL_CANCELLED", "The Session stopped; no further actions are permitted.", 409));
      }
    }
  }

  async endTurn(logicalSessionId, turnId, reason = "Stop") {
    this.cancelSession(logicalSessionId, turnId);
    // Use real identities only. Hosts are per binding and are never shared across Sessions.
    for (const [key, entry] of this.entries) {
      if (entry.context.logicalSessionId !== logicalSessionId) continue;
      if (!entry.computerUse || (this.leases.get(entry).lastTurnId && this.leases.get(entry).lastTurnId !== turnId)) continue;
      // Desktop facades reopen with fresh state; ordinary MCPs stay connected.
      for (const client of entry.computerUseClients) {
        if (client.nativeTurnEnded) this.leases.get(entry).requiresReconnect = true;
        if (client.nativeTurnEnded && turnId && entry.context.providerSessionId) {
          await client.callTool({ name: "turn_ended", arguments: {
            hook_event_name: reason, session_id: entry.context.providerSessionId, turn_id: turnId
          } }, undefined, { timeout: 1000 }).catch(() => {});
        }
        try { await client.close(); } catch (e) { this.desktopCleanupError = e; throw e; }
      }
    }
  }

  async availability(input = {}) {
    const entry = await this.#entry(input);
    return Object.freeze({
      catalogVersion: entry.catalogVersion,
      servers: Object.freeze(entry.assignedServers.map((server) => {
        const unavailable = entry.unavailableServers.find((item) => item.serverName === server.serverName);
        const toolNames = [...entry.tools.entries()]
          .filter(([, target]) => target.serverName === server.serverName)
          .map(([name]) => name);
        const desktop = [...entry.tools.values()].some(target => target.serverName === server.serverName && target.computerUse);
        const supported = !desktop || this.computerUseSupport(input);
        return Object.freeze({ ...server, available: !unavailable && supported,
          ...(desktop ? { computerUse: { supported, status: supported ? "configured_unverified" : "unsupported_provider" } } : {}),
          errorCode: !supported ? "COMPUTER_USE_PROVIDER_UNSUPPORTED" : unavailable?.code ?? null, toolNames: Object.freeze(toolNames) });
      }))
    });
  }

  async close() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const call of this.activeCalls.values()) call.controller.abort();
    await Promise.all(entries.flatMap((entry) => entry.clients.map((client) => client.close().catch(() => {}))));
  }

  #emitRuntimeEvent(event) {
    if (!event.serverId || !this.onRuntimeEvent) return;
    try { this.onRuntimeEvent(event); } catch { /* diagnostics never change tool authorization */ }
  }

  async #closeEntry(entry) {
    const lease = this.leases.get(entry);
    lease.closePromise ??= Promise.all(entry.clients.map(client => client.close().catch(() => {})));
    await lease.closePromise;
  }

  async #entry(input) {
    const actorId = requiredText(input.actorId, "actorId");
    const providerId = requiredText(input.providerId ?? input.metadata?.providerId, "providerId");
    const key = `${actorId}\u0000${providerId}\u0000${input.metadata?.logicalSessionId ?? input.metadata?.sessionId ?? ""}\u0000${input.metadata?.providerBindingId ?? input.metadata?.bindingId ?? ""}`;
    const servers = await this.resolveServers({ actorId, providerId, context: input.metadata ?? {} });
    const fingerprint = createHmac("sha256", this.fingerprintKey)
      .update(stableStringify(servers ?? {})).digest("hex");
    const existing = this.entries.get(key);
    if (existing?.fingerprint === fingerprint && !this.leases.get(existing)?.requiresReconnect && Date.now() < existing.retryAfter) return existing;
    const pending = this.pending.get(key);
    if (pending?.fingerprint === fingerprint) return pending.promise;
    if (pending) {
      await pending.promise;
      return this.#entry(input);
    }
    const promise = this.#connect(servers ?? {}, fingerprint, {
      agentId: actorId, providerId,
      logicalSessionId: input.metadata?.logicalSessionId,
      bindingId: input.metadata?.providerBindingId ?? input.metadata?.bindingId,
      providerSessionId: input.metadata?.providerSessionId
    })
      .then(async (next) => {
        this.leases.set(next, { active: 0, retired: false, closed: false });
        const previous = this.entries.get(key);
        this.entries.set(key, next);
        if (previous) {
          const lease = this.leases.get(previous);
          lease.retired = true;
          if (lease.active === 0) await this.#closeEntry(previous);
        }
        return next;
      })
      .finally(() => {
        if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
      });
    this.pending.set(key, { fingerprint, promise });
    return promise;
  }

  async #connect(servers, fingerprint, context) {
    const clients = [];
    const computerUseClients = [];
    let tools = new Map();
    let definitions = [];
    let ambiguousToolNames = new Set();
    const unavailableServers = [];
    const assignedServers = Object.freeze(Object.entries(servers).map(([serverName, config]) => Object.freeze({
      serverName,
      serverLabel: config.displayName ?? serverName,
      domainId: serverName.startsWith("standalone_") ? `mcp:${serverName}` : `skill-mcp:${serverName}`,
      toolPolicy: config.toolAllowlist == null ? "all"
        : config.toolAllowlist.length === 0 ? "none" : "selected"
    })));
    try {
      for (const [serverName, config] of Object.entries(servers)) {
        let client;
        try {
          if (config.unavailableCode) {
            throw gatewayError(config.unavailableCode, `Skill MCP server ${serverName} credentials are unavailable.`, 503);
          }
          client = await this.connectServer(serverName, config, context);
          const listed = await withTimeout(client.listTools(), this.timeoutMs, `Skill MCP server ${serverName} tools/list timed out.`);
          if (!Array.isArray(listed?.tools)) {
            throw gatewayError("MCP_TOOL_SCHEMA_INVALID", `Skill MCP server ${serverName} returned an invalid tool list.`, 422);
          }
          if (listed.tools.length === 0) {
            throw gatewayError("MCP_TOOLS_EMPTY", `Skill MCP server ${serverName} returned no tools.`, 422);
          }
          if (listed.tools.length > 256) {
            throw gatewayError("MCP_TOOLS_TOO_MANY", `Skill MCP server ${serverName} returned too many tools.`, 422);
          }
          const serverTools = [];
          const serverNames = new Set();
          const observedNames = new Set();
          // Keep each Server's catalog changes isolated until its entire tool
          // list is valid. A later malformed tool must not rename a healthy
          // Server's existing canonical tools.
          const candidateTools = new Map(tools);
          const candidateDefinitions = [...definitions];
          const candidateAmbiguousNames = new Set(ambiguousToolNames);
          if (config.toolAllowlist != null && !Array.isArray(config.toolAllowlist)) {
            throw gatewayError("MCP_TOOL_ALLOWLIST_INVALID", `Assigned MCP server ${serverName} has an invalid tool policy.`, 422);
          }
          const allowedNames = config.toolAllowlist == null ? null : new Set(config.toolAllowlist);
          for (const raw of listed.tools) {
            const remoteName = typeof raw?.name === "string" ? raw.name.trim() : "";
            if (!remoteName || raw?.inputSchema?.type !== "object") {
              throw gatewayError("MCP_TOOL_SCHEMA_INVALID", `Skill MCP server ${serverName} returned an invalid tool schema.`, 422);
            }
            if (observedNames.has(remoteName)) {
              throw gatewayError("MCP_TOOL_NAME_CONFLICT", `Assigned MCP server ${serverName} returned duplicate tool names.`, 409);
            }
            observedNames.add(remoteName);
            if (allowedNames && !allowedNames.has(remoteName)) continue;
            if (isNativeComputerUseMcpConfig(config) && !["js", "js_reset"].includes(remoteName)) continue;
            let name = serverName.startsWith("standalone_")
              ? `${serverName}__${remoteName}` : remoteName;
            if (candidateAmbiguousNames.has(name) && !serverName.startsWith("standalone_")) {
              name = qualifiedSkillToolName(serverName, remoteName);
            } else if (candidateTools.has(name)) {
              const previous = candidateTools.get(name);
              if (!previous.serverName.startsWith("standalone_")) {
                const previousName = qualifiedSkillToolName(previous.serverName, previous.remoteName);
                if (candidateTools.has(previousName)) {
                  throw gatewayError("MCP_TOOL_NAME_CONFLICT", `Assigned Skill MCP tool name conflicts: ${previousName}`, 409);
                }
                const previousDefinition = Object.freeze({ ...previous.definition, name: previousName });
                candidateDefinitions[candidateDefinitions.indexOf(previous.definition)] = previousDefinition;
                candidateTools.delete(name);
                candidateTools.set(previousName, { ...previous, definition: previousDefinition });
              }
              candidateAmbiguousNames.add(name);
              if (!serverName.startsWith("standalone_")) name = qualifiedSkillToolName(serverName, remoteName);
            }
            if (candidateTools.has(name) || serverNames.has(name)) {
              throw gatewayError("MCP_TOOL_NAME_CONFLICT", `Assigned Skill MCP tool name conflicts: ${name}`, 409);
            }
            serverNames.add(name);
            const serverInstructions = remoteName === "js" ? String(client.getInstructions?.() ?? "").slice(0, 32_768) : "";
            const definition = Object.freeze({
              name,
              description: (typeof raw.description === "string" ? raw.description : "") + (isNativeComputerUseMcpConfig(config) && remoteName === "js"
                ? " Official macOS Computer Use entry point. Bootstrap with var sky = (await import('@oai/sky')).sky; use app-targeted methods only. Return screenshots with nodeRepl.emitImage. App approvals must be completed through Corptie. Never substitute shell UI automation or global input." : "") + (serverInstructions ? `\n\n${serverInstructions}` : ""),
              inputSchema: raw.inputSchema,
              ...(raw.annotations ? { annotations: raw.annotations } : {})
            });
            serverTools.push({ name, remoteName, definition });
          }
          client.nativeTurnEnded = isNativeComputerUseMcpConfig(config);
          clients.push(client);
          if (isComputerUseMcpConfig(config)) computerUseClients.push(client);
          for (const { name, remoteName, definition } of serverTools) {
            candidateDefinitions.push(definition);
            candidateTools.set(name, { client, remoteName, serverName, serverId: config.serverId, skillIds: config.skillIds,
              serverLabel: config.displayName ?? serverName, computerUse: isComputerUseMcpConfig(config), definition });
          }
          definitions = candidateDefinitions;
          tools = candidateTools;
          ambiguousToolNames = candidateAmbiguousNames;
          this.#emitRuntimeEvent({ ...context, serverId: config.serverId,
            stage: "tools-list", status: "success", toolCount: listed.tools.length });
        } catch (error) {
          if (client) await client.close().catch(() => {});
          unavailableServers.push(Object.freeze({
            domainId: serverName.startsWith("standalone_") ? `mcp:${serverName}` : `skill-mcp:${serverName}`,
            serverName,
            serverLabel: config.displayName ?? serverName,
            code: typeof error?.code === "string" ? error.code : "MCP_CONNECTION_FAILED"
          }));
          this.#emitRuntimeEvent({ ...context, serverId: config.serverId,
            stage: "tools-list", status: "failed", errorCode: error?.code });
          continue;
        }
      }
      definitions.sort((left, right) => left.name.localeCompare(right.name));
      const catalogVersion = `skill-mcp:1:${sha256(`${fingerprint}:${stableStringify(definitions)}`)}`;
      return Object.freeze({
        fingerprint, catalogVersion, clients, computerUseClients, tools, assignedServers, context,
        computerUse: Object.values(servers).some(isComputerUseMcpConfig),
        definitions: Object.freeze(definitions),
        unavailableServers: Object.freeze(unavailableServers),
        retryAfter: unavailableServers.length ? Date.now() + this.retryMs : Number.POSITIVE_INFINITY
      });
    } catch (error) {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
      throw error;
    }
  }
}

async function connectServer(serverName, config, timeoutMs, onElicitation) {
  if (config.unavailableCode) {
    throw gatewayError(config.unavailableCode, `Skill MCP server ${serverName} credentials are unavailable.`, 503);
  }
  const client = new Client({ name: "corptie-skill-mcp-gateway", version: "1.0.0" }, {
    capabilities: { elicitation: { form: {}, url: {} } }
  });
  client.setRequestHandler(ElicitRequestSchema, (request, extra) => onElicitation(client, request, extra));
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
      requestInit: server.headers ? { headers: server.headers } : undefined,
      fetch: restrictedMcpFetch(server.url)
    });
  }
  if (server.type === "sse") {
    return new SSEClientTransport(new URL(requiredText(server.url, "server.url")), {
      requestInit: server.headers ? { headers: server.headers } : undefined,
      fetch: restrictedMcpFetch(server.url)
    });
  }
  return new StdioClientTransport({
    command: requiredText(server.command, "server.command"),
    args: server.args ?? [],
    cwd: server.cwd,
    env: (server.isolatedEnv || isComputerUseMcpConfig(server)) ? { ...(server.env ?? {}) } : { ...process.env, ...(server.env ?? {}) },
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

function qualifiedSkillToolName(serverName, remoteName) {
  return `skill_${sha256(serverName).slice(0, 20)}__${remoteName}`;
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
