import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { access, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isPlatformAssistant } from "../utils/platformAssistantIdentity.mjs";
import { restrictedMcpFetch } from "./restrictedMcpFetch.mjs";
import { copyLocalMcpPackage, discoverLocalMcpPackage, hashLocalMcpPackage } from "./mcpPackageDiscovery.mjs";
import { withMcpGitCheckout } from "./mcpGitSource.mjs";
import { createMcpSecretStore } from "./mcpSecretStore.mjs";

// Independent MCP installations are resources. A Session receives tools only
// through its bound Agent's current assignment and the fixed Tool Host.
export class McpRegistryService {
  constructor({ store, timeoutMs = 10_000, packageRoot, secretStore } = {}) {
    if (!store) throw new TypeError("McpRegistryService requires a store.");
    this.store = store;
    this.timeoutMs = timeoutMs;
    this.packageRoot = resolve(packageRoot ?? join(store.dataDir ?? store.dataRoot ?? process.cwd(), "mcp-packages"));
    this.secretStore = secretStore ?? createMcpSecretStore({ dataRoot: store.dataDir ?? store.dataRoot ?? process.cwd() });
  }

  list() {
    return this.store.selectAll(`
      SELECT server_id, name, url, transport, command, args_json, cwd, enabled, tool_count, verified_at,
             last_checked_at, last_check_status, last_error_code, observed_tool_names_json,
             source_kind, source_locator, source_revision, package_root, package_hash, descriptor_path,
             config_revision,
             credential_ref, credential_names_json,
             created_at, updated_at,
             (SELECT COUNT(*) FROM agent_mcp_assignments a WHERE a.server_id = s.server_id) AS assignment_count
      FROM mcp_server_registry s ORDER BY created_at DESC, server_id DESC
    `).map(presentServer);
  }

  get(serverId) {
    const row = this.store.selectOne(`
      SELECT server_id, name, url, transport, command, args_json, cwd, enabled, tool_count, verified_at,
             last_checked_at, last_check_status, last_error_code, observed_tool_names_json,
             source_kind, source_locator, source_revision, package_root, package_hash, descriptor_path,
             config_revision,
             credential_ref, credential_names_json,
             created_at, updated_at,
             (SELECT COUNT(*) FROM agent_mcp_assignments a WHERE a.server_id = s.server_id) AS assignment_count
      FROM mcp_server_registry s WHERE server_id = ?
    `, [serverId]);
    return row ? presentServer(row) : null;
  }

  async discoverPackage(input = {}) {
    if (input?.sourceType === "git") {
      return withMcpGitCheckout(input.source, async ({ checkout, revision, source }) => {
        const discovery = await discoverLocalMcpPackage(checkout);
        return {
          sourceType: "git", source, sourceRevision: revision,
          descriptorPath: discovery.descriptorPath,
          contentHash: await hashLocalMcpPackage(discovery.sourceRoot),
          candidates: discovery.candidates
        };
      });
    }
    if (input?.sourceType !== "local") {
      throw registryError("MCP_PACKAGE_SOURCE_INVALID", "Local or Git MCP package source is required.", 400);
    }
    const discovery = await discoverLocalMcpPackage(input.source);
    return {
      sourceType: "local", source: discovery.sourceRoot,
      descriptorPath: discovery.descriptorPath,
      contentHash: await hashLocalMcpPackage(discovery.sourceRoot),
      candidates: discovery.candidates
    };
  }

  async verify(input) {
    const config = await normalizedConfig(input);
    const client = new Client({ name: "corptie-mcp-installer", version: "1.0.0" });
    const transport = config.transport === "stdio"
      ? new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd,
        env: { ...isolatedStdioEnv(), ...(config.env ?? {}) } })
      : config.transport === "sse"
        ? new SSEClientTransport(new URL(config.url), { fetch: restrictedMcpFetch(config.url),
          requestInit: config.headers ? { headers: config.headers } : undefined })
        : new StreamableHTTPClientTransport(new URL(config.url), { fetch: restrictedMcpFetch(config.url),
          requestInit: config.headers ? { headers: config.headers } : undefined });
    try {
      await timed(client.connect(transport), this.timeoutMs);
      const result = await timed(client.listTools(), this.timeoutMs);
      const tools = result?.tools;
      if (!Array.isArray(tools) || tools.length === 0) {
        throw registryError("MCP_TOOLS_EMPTY", "MCP Server did not expose tools.", 422);
      }
      if (tools.length > 256) {
        throw registryError("MCP_TOOLS_TOO_MANY", "MCP Server exposes more than 256 tools.", 422);
      }
      for (const tool of tools) {
        if (typeof tool?.name !== "string" || !tool.name.trim()
          || tool?.inputSchema?.type !== "object") {
          throw registryError("MCP_TOOL_SCHEMA_INVALID", "MCP Server returned an invalid tool schema.", 422);
        }
      }
      if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
        throw registryError("MCP_TOOL_NAME_CONFLICT", "MCP Server returned duplicate tool names.", 422);
      }
      const { headers, env, ...publicConfig } = config;
      return { ...publicConfig,
        toolCount: tools.length, toolNames: tools.map((tool) => tool.name) };
    } catch (error) {
      if (error?.code && String(error.code).startsWith("MCP_")) throw error;
      throw registryError("MCP_CONNECTION_FAILED", "MCP Server connection or tools/list failed.", 422);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async register(input) {
    const installRequestId = validatedInstallRequestId(input);
    const existing = this.#installedForRequest(installRequestId);
    if (existing) return { ...existing, idempotentReplay: true };
    const verified = await this.verify(input);
    const credentials = credentialPayload(input, verified.transport);
    const serverId = `mcp:${randomUUID()}`;
    const credentialRef = credentials ? `${serverId}:1:${randomUUID()}` : null;
    if (credentialRef) this.secretStore.put(credentialRef, credentials);
    try {
      return this.#saveVerified(verified, { serverId, credentialRef, installRequestId,
        credentialNames: credentials ? Object.keys(verified.transport === "stdio" ? credentials.env : credentials.headers) : [] });
    } catch (error) {
      if (credentialRef) this.secretStore.delete(credentialRef);
      const winner = this.#installedForRequest(installRequestId);
      if (winner) return { ...winner, idempotentReplay: true };
      throw error;
    }
  }

  async registerPackage(input = {}) {
    const installRequestId = validatedInstallRequestId(input);
    const existing = this.#installedForRequest(installRequestId);
    if (existing) return { ...existing, idempotentReplay: true };
    if (!["local", "git"].includes(input?.sourceType) || typeof input.serverName !== "string"
      || !/^[a-f0-9]{64}$/.test(input.expectedContentHash ?? "")) {
      throw registryError("MCP_PACKAGE_SOURCE_INVALID", "MCP package, content hash and Server selection are required.", 400);
    }
    if (input.sourceType === "git") {
      if (!/^[a-f0-9]{40,64}$/.test(input.expectedSourceRevision ?? "")) {
        throw registryError("MCP_GIT_REVISION_INVALID", "Expected Git revision is required.", 400);
      }
      return withMcpGitCheckout(input.source, async ({ checkout, revision, source }) => {
        if (revision !== input.expectedSourceRevision) {
          throw registryError("MCP_PACKAGE_CHANGED", "Git package revision changed after discovery; discover again.", 409);
        }
        return this.#registerCopiedPackage(input, {
          sourceRoot: checkout, sourceKind: "git_package", sourceLocator: source,
          sourceRevision: revision
        });
      });
    }
    const discovered = await discoverLocalMcpPackage(input.source);
    return this.#registerCopiedPackage(input, {
      sourceRoot: discovered.sourceRoot, sourceKind: "local_package", sourceLocator: discovered.sourceRoot
    });
  }

  async #registerCopiedPackage(input, source) {
    const serverId = `mcp:${randomUUID()}`;
    const installRequestId = validatedInstallRequestId(input);
    const destination = join(this.packageRoot, serverId.slice(4));
    try {
      const copied = await copyLocalMcpPackage(source.sourceRoot, destination);
      if (copied.contentHash !== input.expectedContentHash) {
        throw registryError("MCP_PACKAGE_CHANGED", "MCP package contents changed after discovery; discover again.", 409);
      }
      if (!Object.hasOwn(copied.servers, input.serverName)) {
        throw registryError("MCP_PACKAGE_CHANGED", "Selected MCP Server changed during installation.", 409);
      }
      const config = await packageServerConfig(destination, input.serverName, copied.servers[input.serverName], input);
      const verified = await this.verify(config);
      const credentials = credentialPayload(config, verified.transport);
      const credentialRef = credentials ? `${serverId}:1:${randomUUID()}` : null;
      if (credentialRef) this.secretStore.put(credentialRef, credentials);
      try {
        return this.#saveVerified(verified, {
          serverId,
          sourceKind: source.sourceKind,
          sourceLocator: source.sourceLocator,
          sourceRevision: source.sourceRevision ?? null,
          packageRoot: destination,
          packageHash: copied.contentHash,
          descriptorPath: copied.descriptorPath,
          installRequestId,
          credentialRef,
          credentialNames: Object.keys(credentials?.[verified.transport === "stdio" ? "env" : "headers"] ?? {})
        });
      } catch (error) {
        if (credentialRef) this.secretStore.delete(credentialRef);
        throw error;
      }
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      const winner = this.#installedForRequest(installRequestId);
      if (winner) return { ...winner, idempotentReplay: true };
      throw error;
    }
  }

  #installedForRequest(installRequestId) {
    if (!installRequestId) return null;
    const row = this.store.selectOne(`SELECT server_id FROM mcp_server_registry
      WHERE install_request_id = ?`, [installRequestId]);
    return row ? this.get(row.server_id) : null;
  }

  listPackageVersions(serverId) {
    const current = this.get(serverId);
    if (!current) throw registryError("MCP_SERVER_NOT_FOUND", "MCP Server not found.", 404);
    if (current.sourceKind === "direct") {
      throw registryError("MCP_PACKAGE_REQUIRED", "MCP Server was not installed from a package.", 409);
    }
    const history = this.store.selectAll(`SELECT revision, transport, source_kind, source_locator,
      source_revision, package_hash, credential_ref, credential_names_json, retained_at
      FROM mcp_server_package_versions WHERE server_id = ? ORDER BY revision DESC`, [serverId]);
    return [{ revision: current.configRevision, current: true, transport: current.transport,
      sourceKind: current.sourceKind,
      sourceLocator: current.sourceLocator, sourceRevision: current.sourceRevision,
      packageHash: current.packageHash, credentialNames: current.credentialNames,
      credentialsAvailable: current.hasCredentials, retainedAt: current.updatedAt },
    ...history.map((row) => ({ revision: row.revision, current: false, transport: row.transport,
      sourceKind: row.source_kind, sourceLocator: row.source_locator,
      sourceRevision: row.source_revision, packageHash: row.package_hash,
      credentialNames: JSON.parse(row.credential_names_json),
      credentialsAvailable: Boolean(row.credential_ref), retainedAt: row.retained_at }))];
  }

  #enqueueCleanup(kind, target, serverId) {
    this.store.db.run(`INSERT OR IGNORE INTO mcp_cleanup_queue
      (cleanup_kind, target, server_id, created_at) VALUES (?, ?, ?, ?)`,
    [kind, target, serverId, new Date().toISOString()]);
  }

  #prunePackageVersions(serverId) {
    const stale = this.store.selectAll(`SELECT revision, package_root, credential_ref
      FROM mcp_server_package_versions WHERE server_id = ?
      ORDER BY revision DESC LIMIT -1 OFFSET 5`, [serverId]);
    for (const row of stale) {
      this.store.db.run(`DELETE FROM mcp_server_package_versions
        WHERE server_id = ? AND revision = ?`, [serverId, row.revision]);
    }
    for (const path of new Set(stale.map((row) => row.package_root).filter(Boolean))) {
      const remaining = this.store.selectOne(`SELECT 1 AS present FROM mcp_server_registry
        WHERE package_root = ? UNION SELECT 1 FROM mcp_server_package_versions
        WHERE package_root = ? LIMIT 1`, [path, path]);
      if (!remaining) this.#enqueueCleanup("package_path", path, serverId);
    }
    for (const ref of new Set(stale.map((row) => row.credential_ref).filter(Boolean))) {
      const remaining = this.store.selectOne(`SELECT 1 AS present FROM mcp_server_registry
        WHERE credential_ref = ? UNION SELECT 1 FROM mcp_server_package_versions
        WHERE credential_ref = ? UNION SELECT 1 FROM agent_mcp_assignments
        WHERE credential_ref = ? LIMIT 1`, [ref, ref, ref]);
      if (!remaining) this.#enqueueCleanup("credential_ref", ref, serverId);
    }
  }

  async drainCleanup({ serverId, limit = 64 } = {}) {
    const rows = serverId
      ? this.store.selectAll(`SELECT cleanup_kind, target, server_id FROM mcp_cleanup_queue
        WHERE server_id = ? ORDER BY attempts, created_at LIMIT ?`, [serverId, limit])
      : this.store.selectAll(`SELECT cleanup_kind, target, server_id FROM mcp_cleanup_queue
        ORDER BY attempts, created_at LIMIT ?`, [limit]);
    for (const row of rows) {
      try {
        if (row.cleanup_kind === "package_path") {
          assertManagedPackagePath(this.packageRoot, row.server_id, row.target);
          const stillReferenced = this.store.selectOne(`SELECT 1 AS present FROM mcp_server_registry
            WHERE package_root = ? UNION SELECT 1 FROM mcp_server_package_versions
            WHERE package_root = ? LIMIT 1`, [row.target, row.target]);
          if (!stillReferenced) await rm(row.target, { recursive: true, force: true });
        } else if (row.cleanup_kind === "credential_ref") {
          const stillReferenced = this.store.selectOne(`SELECT 1 AS present FROM mcp_server_registry
            WHERE credential_ref = ? UNION SELECT 1 FROM mcp_server_package_versions
            WHERE credential_ref = ? UNION SELECT 1 FROM agent_mcp_assignments
            WHERE credential_ref = ? LIMIT 1`, [row.target, row.target, row.target]);
          if (!stillReferenced) this.secretStore.delete(row.target);
        } else throw registryError("MCP_CLEANUP_INVALID", "MCP cleanup item is invalid.", 409);
        this.store.db.run(`DELETE FROM mcp_cleanup_queue
          WHERE cleanup_kind = ? AND target = ?`, [row.cleanup_kind, row.target]);
      } catch {
        this.store.db.run(`UPDATE mcp_cleanup_queue SET attempts = attempts + 1
          WHERE cleanup_kind = ? AND target = ?`, [row.cleanup_kind, row.target]);
      }
    }
    if (rows.length) this.store.scheduleSave();
    return serverId
      ? this.store.selectOne(`SELECT COUNT(*) AS count FROM mcp_cleanup_queue WHERE server_id = ?`, [serverId]).count
      : this.store.selectOne("SELECT COUNT(*) AS count FROM mcp_cleanup_queue").count;
  }

  async updatePackage(serverId, input = {}) {
    const current = this.get(serverId);
    if (!current) throw registryError("MCP_SERVER_NOT_FOUND", "MCP Server not found.", 404);
    if (current.sourceKind === "direct") {
      throw registryError("MCP_PACKAGE_REQUIRED", "MCP Server was not installed from a package.", 409);
    }
    if (!Number.isSafeInteger(input.expectedConfigRevision)
      || input.expectedConfigRevision !== current.configRevision) {
      throw registryError("MCP_CONFIG_STALE", "MCP Server configuration changed; reload before updating.", 409);
    }
    if (!["local", "git"].includes(input.sourceType) || typeof input.serverName !== "string"
      || !/^[a-f0-9]{64}$/.test(input.expectedContentHash ?? "")
      || (input.clearCredentials != null && input.clearCredentials !== true)) {
      throw registryError("MCP_PACKAGE_SOURCE_INVALID", "Package source, selected Server, content hash and valid options are required.", 400);
    }
    if (input.sourceType === "git") {
      if (!/^[a-f0-9]{40,64}$/.test(input.expectedSourceRevision ?? "")) {
        throw registryError("MCP_GIT_REVISION_INVALID", "Expected Git revision is required.", 400);
      }
      return withMcpGitCheckout(input.source, async ({ checkout, revision, source }) => {
        if (revision !== input.expectedSourceRevision) {
          throw registryError("MCP_PACKAGE_CHANGED", "Git package revision changed after discovery; discover again.", 409);
        }
        return this.#updateCopiedPackage(serverId, current, input, {
          sourceRoot: checkout, sourceKind: "git_package", sourceLocator: source, sourceRevision: revision
        });
      });
    }
    const discovered = await discoverLocalMcpPackage(input.source);
    return this.#updateCopiedPackage(serverId, current, input, {
      sourceRoot: discovered.sourceRoot, sourceKind: "local_package", sourceLocator: discovered.sourceRoot,
      sourceRevision: null
    });
  }

  async #updateCopiedPackage(serverId, current, input, source) {
    const destination = join(this.packageRoot,
      `${serverId.slice(4)}-v${current.configRevision + 1}-${randomUUID()}`);
    let credentialRef = null;
    let wroteCredentials = false;
    try {
      const copied = await copyLocalMcpPackage(source.sourceRoot, destination);
      if (copied.contentHash !== input.expectedContentHash
        || !Object.hasOwn(copied.servers, input.serverName)) {
        throw registryError("MCP_PACKAGE_CHANGED", "MCP package changed after discovery; discover again.", 409);
      }
      const explicitCredential = input.env != null || input.headers != null;
      let retainedCredentials = null;
      if (!explicitCredential && !input.clearCredentials && current.credentialRef) {
        retainedCredentials = this.secretStore.get(current.credentialRef);
        if (!retainedCredentials) {
          throw registryError("MCP_CREDENTIAL_MISSING", "MCP Server credential is unavailable.", 503);
        }
      }
      const installation = { ...input, ...(retainedCredentials ?? {}) };
      const config = await packageServerConfig(destination, input.serverName,
        copied.servers[input.serverName], installation);
      const verified = await this.verify(config);
      const credentials = credentialPayload(config, verified.transport);
      credentialRef = credentials
        ? (explicitCredential ? `${serverId}:${current.configRevision + 1}:${randomUUID()}` : current.credentialRef)
        : null;
      wroteCredentials = Boolean(credentialRef && credentialRef !== current.credentialRef);
      if (wroteCredentials) this.secretStore.put(credentialRef, credentials);
      const now = new Date().toISOString();
      this.store.db.run("BEGIN IMMEDIATE");
      try {
        this.store.db.run(`INSERT OR IGNORE INTO mcp_server_package_versions
          (server_id, revision, name, url, transport, command, args_json, cwd,
           tool_count, verified_at, source_kind, source_locator, source_revision,
           package_root, package_hash, descriptor_path, credential_ref, credential_names_json, retained_at)
          SELECT server_id, config_revision, name, url, transport, command, args_json, cwd,
                 tool_count, verified_at, source_kind, source_locator, source_revision,
                 package_root, package_hash, descriptor_path, credential_ref, credential_names_json, ?
          FROM mcp_server_registry WHERE server_id = ?`, [now, serverId]);
        this.store.db.run(`UPDATE mcp_server_registry SET name = ?, url = ?, transport = ?,
          command = ?, args_json = ?, cwd = ?, tool_count = ?, verified_at = ?,
          last_checked_at = ?, last_check_status = 'available', last_error_code = NULL,
          observed_tool_names_json = ?, source_kind = ?, source_locator = ?, source_revision = ?,
          package_root = ?, package_hash = ?, descriptor_path = ?, credential_ref = ?,
          credential_names_json = ?, config_revision = config_revision + 1, updated_at = ?
          WHERE server_id = ? AND config_revision = ?`,
        [verified.name, verified.url ?? "", verified.transport, verified.command ?? null,
          JSON.stringify(verified.args ?? []), verified.cwd ?? null, verified.toolCount,
          now, now, JSON.stringify(verified.toolNames), source.sourceKind, source.sourceLocator,
          source.sourceRevision, destination, copied.contentHash, copied.descriptorPath, credentialRef,
          JSON.stringify(Object.keys(credentials?.[verified.transport === "stdio" ? "env" : "headers"] ?? {})),
          now, serverId, current.configRevision]);
        if (this.store.db.getRowsModified() !== 1) {
          throw registryError("MCP_CONFIG_STALE", "MCP Server configuration changed during verification.", 409);
        }
        if (current.credentialRef && current.credentialRef !== credentialRef) {
          this.store.db.run(`UPDATE mcp_server_package_versions SET credential_ref = NULL
            WHERE server_id = ? AND credential_ref = ?`, [serverId, current.credentialRef]);
          this.#enqueueCleanup("credential_ref", current.credentialRef, serverId);
        }
        this.#prunePackageVersions(serverId);
        this.store.db.run("COMMIT");
      } catch (error) {
        this.store.db.run("ROLLBACK");
        throw error;
      }
      this.store.scheduleSave();
      const cleanupPending = (await this.drainCleanup({ serverId })) > 0;
      return { ...this.get(serverId), cleanupPending };
    } catch (error) {
      if (wroteCredentials) {
        try { this.secretStore.delete(credentialRef); } catch { /* preserve original failure */ }
      }
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async rollbackPackage(serverId, input = {}) {
    const current = this.get(serverId);
    if (!current) throw registryError("MCP_SERVER_NOT_FOUND", "MCP Server not found.", 404);
    if (current.sourceKind === "direct") {
      throw registryError("MCP_PACKAGE_REQUIRED", "MCP Server was not installed from a package.", 409);
    }
    if (!Number.isSafeInteger(input.expectedConfigRevision)
      || input.expectedConfigRevision !== current.configRevision) {
      throw registryError("MCP_CONFIG_STALE", "MCP Server configuration changed; reload before rolling back.", 409);
    }
    if (!Number.isSafeInteger(input.targetRevision) || input.targetRevision < 1) {
      throw registryError("MCP_PACKAGE_VERSION_INVALID", "A retained package revision is required.", 400);
    }
    const target = this.store.selectOne(`SELECT * FROM mcp_server_package_versions
      WHERE server_id = ? AND revision = ?`, [serverId, input.targetRevision]);
    if (!target) throw registryError("MCP_PACKAGE_VERSION_NOT_FOUND", "Retained package revision not found.", 404);
    assertManagedPackagePath(this.packageRoot, serverId, target.package_root);
    try {
      if (!(await stat(target.package_root)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw registryError("MCP_PACKAGE_VERSION_MISSING", "Retained package files are unavailable.", 409);
    }
    const explicitCredentials = input.headers != null || input.env != null;
    const supplied = credentialPayload(input, target.transport);
    let credentials = supplied;
    let credentialRef = null;
    if (!explicitCredentials && target.credential_ref) {
      credentials = this.secretStore.get(target.credential_ref);
      credentialRef = target.credential_ref;
    }
    if (!explicitCredentials && !credentials && current.credentialRef
      && current.transport === target.transport) {
      credentials = this.secretStore.get(current.credentialRef);
      credentialRef = current.credentialRef;
    }
    if (!explicitCredentials && target.credential_ref && !credentials) {
      throw registryError("MCP_CREDENTIAL_MISSING", "Retained MCP Server credential is unavailable.", 503);
    }
    const requiredNames = JSON.parse(target.credential_names_json ?? "[]");
    if (requiredNames.some((name) => !credentials?.[target.transport === "stdio" ? "env" : "headers"]?.[name])) {
      throw registryError("MCP_PACKAGE_CREDENTIAL_REQUIRED", "Provide credentials for the retained package revision.", 400);
    }
    const candidate = target.transport === "stdio"
      ? { name: target.name, transport: target.transport, command: target.command,
        args: JSON.parse(target.args_json), cwd: target.cwd,
        ...(credentials?.env ? { env: credentials.env } : {}) }
      : { name: target.name, transport: target.transport, url: target.url,
        ...(credentials?.headers ? { headers: credentials.headers } : {}) };
    const verified = await this.verify(candidate);
    const wroteCredentials = Boolean(explicitCredentials && supplied);
    if (wroteCredentials) {
      credentialRef = `${serverId}:${current.configRevision + 1}:${randomUUID()}`;
      this.secretStore.put(credentialRef, supplied);
    } else if (!credentials) credentialRef = null;
    const now = new Date().toISOString();
    try {
      this.store.db.run("BEGIN IMMEDIATE");
      try {
        this.store.db.run(`INSERT OR IGNORE INTO mcp_server_package_versions
          (server_id, revision, name, url, transport, command, args_json, cwd,
           tool_count, verified_at, source_kind, source_locator, source_revision,
           package_root, package_hash, descriptor_path, credential_ref, credential_names_json, retained_at)
          SELECT server_id, config_revision, name, url, transport, command, args_json, cwd,
                 tool_count, verified_at, source_kind, source_locator, source_revision,
                 package_root, package_hash, descriptor_path, credential_ref, credential_names_json, ?
          FROM mcp_server_registry WHERE server_id = ?`, [now, serverId]);
        this.store.db.run(`UPDATE mcp_server_registry SET name = ?, url = ?, transport = ?,
          command = ?, args_json = ?, cwd = ?, tool_count = ?, verified_at = ?,
          last_checked_at = ?, last_check_status = 'available', last_error_code = NULL,
          observed_tool_names_json = ?, source_kind = ?, source_locator = ?, source_revision = ?,
          package_root = ?, package_hash = ?, descriptor_path = ?, credential_ref = ?,
          credential_names_json = ?, config_revision = config_revision + 1, updated_at = ?
          WHERE server_id = ? AND config_revision = ?`,
        [verified.name, verified.url ?? "", verified.transport, verified.command ?? null,
          JSON.stringify(verified.args ?? []), verified.cwd ?? null, verified.toolCount,
          now, now, JSON.stringify(verified.toolNames), target.source_kind, target.source_locator,
          target.source_revision, target.package_root, target.package_hash, target.descriptor_path,
          credentialRef, JSON.stringify(Object.keys(credentials?.[target.transport === "stdio" ? "env" : "headers"] ?? {})),
          now, serverId, current.configRevision]);
        if (this.store.db.getRowsModified() !== 1) {
          throw registryError("MCP_CONFIG_STALE", "MCP Server configuration changed during rollback verification.", 409);
        }
        if (wroteCredentials && current.credentialRef) {
          this.store.db.run(`UPDATE mcp_server_package_versions SET credential_ref = NULL
            WHERE server_id = ? AND credential_ref = ?`, [serverId, current.credentialRef]);
          this.#enqueueCleanup("credential_ref", current.credentialRef, serverId);
        }
        this.#prunePackageVersions(serverId);
        this.store.db.run("COMMIT");
      } catch (error) {
        this.store.db.run("ROLLBACK");
        throw error;
      }
    } catch (error) {
      if (wroteCredentials) {
        try { this.secretStore.delete(credentialRef); } catch { /* preserve rollback failure */ }
      }
      throw error;
    }
    this.store.scheduleSave();
    const cleanupPending = (await this.drainCleanup({ serverId })) > 0;
    return { ...this.get(serverId), cleanupPending };
  }

  #saveVerified(verified, metadata = {}) {
    const serverId = metadata.serverId ?? `mcp:${randomUUID()}`;
    const now = new Date().toISOString();
    this.store.db.run(`INSERT INTO mcp_server_registry
      (server_id, name, url, transport, command, args_json, cwd,
       enabled, tool_count, verified_at, last_checked_at, last_check_status,
       observed_tool_names_json, source_kind, source_locator, source_revision, package_root,
       package_hash, descriptor_path, credential_ref, credential_names_json, install_request_id,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [serverId, verified.name, verified.url ?? "", verified.transport, verified.command ?? null,
      JSON.stringify(verified.args ?? []), verified.cwd ?? null, verified.toolCount, now, now,
      JSON.stringify(verified.toolNames), metadata.sourceKind ?? "direct", metadata.sourceLocator ?? null,
      metadata.sourceRevision ?? null, metadata.packageRoot ?? null, metadata.packageHash ?? null,
      metadata.descriptorPath ?? null, metadata.credentialRef ?? null,
      JSON.stringify(metadata.credentialNames ?? []), metadata.installRequestId ?? null, now, now]);
    this.store.scheduleSave();
    this.#recordRuntimeEventBestEffort({ serverId, stage: "tools-list", status: "success",
      toolCount: verified.toolCount });
    return this.get(serverId);
  }

  async updateConfig(serverId, input = {}) {
    const current = this.get(serverId);
    if (!current) throw registryError("MCP_SERVER_NOT_FOUND", "MCP Server not found.", 404);
    if (current.sourceKind !== "direct") {
      throw registryError("MCP_PACKAGE_UPDATE_UNSUPPORTED", "Package MCP Servers must be rescanned before updating.", 409);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["expectedConfigRevision", "name", "transport", "url",
        "command", "args", "cwd", "headers", "env", "clearCredentials"].includes(key))) {
      throw registryError("INVALID_INPUT", "MCP configuration update contains unsupported fields.", 400);
    }
    if (!Number.isSafeInteger(input.expectedConfigRevision)
      || input.expectedConfigRevision !== current.configRevision) {
      throw registryError("MCP_CONFIG_STALE", "MCP Server configuration changed; reload before updating.", 409);
    }
    const transport = input.transport ?? current.transport;
    if (input.clearCredentials != null && input.clearCredentials !== true) {
      throw registryError("INVALID_INPUT", "clearCredentials must be true when provided.", 400);
    }
    if (input.clearCredentials && (input.headers != null || input.env != null)) {
      throw registryError("INVALID_INPUT", "Cannot clear and replace credentials together.", 400);
    }
    if ((transport === "stdio" && (input.url != null || input.headers != null))
      || (transport !== "stdio" && [input.command, input.args, input.cwd, input.env].some((value) => value != null))) {
      throw registryError("INVALID_INPUT", "MCP configuration mixes remote and local fields.", 400);
    }
    const sameTransport = transport === current.transport;
    const replacementCredentials = credentialPayload(input, transport);
    const retainedCredentials = sameTransport && current.credentialRef && !input.clearCredentials && !replacementCredentials
      ? this.secretStore.get(current.credentialRef) : null;
    if (sameTransport && current.credentialRef && !input.clearCredentials && !replacementCredentials && !retainedCredentials) {
      throw registryError("MCP_CREDENTIAL_MISSING", "MCP Server credential is unavailable.", 503);
    }
    const credentials = input.clearCredentials ? null : replacementCredentials ?? retainedCredentials;
    const candidate = transport === "stdio"
      ? { name: input.name ?? current.name, transport,
        command: input.command ?? (sameTransport ? current.command : undefined),
        args: input.args ?? (sameTransport ? current.args : undefined),
        cwd: input.cwd ?? (sameTransport ? current.cwd : undefined),
        ...(credentials?.env ? { env: credentials.env } : {}) }
      : { name: input.name ?? current.name, transport,
        url: input.url ?? (sameTransport ? current.url : undefined),
        ...(credentials?.headers ? { headers: credentials.headers } : {}) };
    const verified = await this.verify(candidate);
    const credentialRef = credentials
      ? (replacementCredentials || !sameTransport
        ? `${serverId}:${current.configRevision + 1}:${randomUUID()}` : current.credentialRef)
      : null;
    const wroteCredentials = credentialRef && credentialRef !== current.credentialRef;
    if (wroteCredentials) this.secretStore.put(credentialRef, credentials);
    const now = new Date().toISOString();
    try {
      this.store.db.run("BEGIN IMMEDIATE");
      try {
        this.store.db.run(`UPDATE mcp_server_registry SET name = ?, url = ?, transport = ?,
          command = ?, args_json = ?, cwd = ?, tool_count = ?, verified_at = ?,
          last_checked_at = ?, last_check_status = 'available', last_error_code = NULL,
          observed_tool_names_json = ?, credential_ref = ?, credential_names_json = ?,
          config_revision = config_revision + 1,
          updated_at = ? WHERE server_id = ? AND config_revision = ?`,
        [verified.name, verified.url ?? "", verified.transport, verified.command ?? null,
          JSON.stringify(verified.args ?? []), verified.cwd ?? null, verified.toolCount,
          now, now, JSON.stringify(verified.toolNames), credentialRef,
          JSON.stringify(Object.keys(credentials?.[transport === "stdio" ? "env" : "headers"] ?? {})),
          now, serverId, current.configRevision]);
        if (this.store.db.getRowsModified() !== 1) {
          throw registryError("MCP_CONFIG_STALE", "MCP Server configuration changed during verification.", 409);
        }
        if (current.credentialRef && current.credentialRef !== credentialRef) {
          this.#enqueueCleanup("credential_ref", current.credentialRef, serverId);
        }
        this.store.db.run("COMMIT");
      } catch (error) {
        this.store.db.run("ROLLBACK");
        throw error;
      }
    } catch (error) {
      if (wroteCredentials) {
        try { this.secretStore.delete(credentialRef); } catch { /* preserve update failure */ }
      }
      throw error;
    }
    this.store.scheduleSave();
    const cleanupPending = (await this.drainCleanup({ serverId })) > 0;
    return { ...this.get(serverId), cleanupPending };
  }

  async checkInstallation(serverId) {
    const server = this.get(serverId);
    if (!server) throw registryError("MCP_SERVER_NOT_FOUND", "MCP Server not found.", 404);
    let credentials;
    try { credentials = server.credentialRef ? this.secretStore.get(server.credentialRef) : null; }
    catch { credentials = null; }
    const config = server.transport === "stdio"
      ? { name: server.name, transport: server.transport, command: server.command,
        args: server.args, cwd: server.cwd, ...(credentials?.env ? { env: credentials.env } : {}) }
      : { name: server.name, transport: server.transport, url: server.url,
        ...(credentials?.headers ? { headers: credentials.headers } : {}) };
    const checkedAt = new Date().toISOString();
    try {
      if (server.credentialRef && !credentials) {
        throw registryError("MCP_CREDENTIAL_MISSING", "MCP Server credential is unavailable.", 503);
      }
      const verified = await this.verify(config);
      this.store.db.run(`UPDATE mcp_server_registry SET
        tool_count = ?, verified_at = ?, last_checked_at = ?, last_check_status = 'available',
        last_error_code = NULL, observed_tool_names_json = ? WHERE server_id = ?`,
      [verified.toolCount, checkedAt, checkedAt, JSON.stringify(verified.toolNames), serverId]);
      this.#recordRuntimeEventBestEffort({ serverId, stage: "tools-list", status: "success",
        toolCount: verified.toolCount });
    } catch (error) {
      const safeCode = ["MCP_CONNECTION_FAILED", "MCP_RUNTIME_TIMEOUT", "MCP_TOOLS_EMPTY",
        "MCP_TOOLS_TOO_MANY", "MCP_TOOL_SCHEMA_INVALID", "MCP_TOOL_NAME_CONFLICT",
        "MCP_CREDENTIAL_MISSING"].includes(error?.code)
        ? error.code : "MCP_CONNECTION_FAILED";
      this.store.db.run(`UPDATE mcp_server_registry SET
        last_checked_at = ?, last_check_status = 'unavailable', last_error_code = ?
        WHERE server_id = ?`,
      [checkedAt, safeCode, serverId]);
      this.#recordRuntimeEventBestEffort({ serverId, stage: "tools-list", status: "failed",
        errorCode: safeCode });
    }
    this.store.scheduleSave();
    return this.get(serverId);
  }

  setEnabled(serverId, enabled) {
    if (typeof enabled !== "boolean") throw registryError("INVALID_INPUT", "enabled must be boolean.", 400);
    const current = this.get(serverId);
    if (!current) throw registryError("MCP_SERVER_NOT_FOUND", "MCP Server not found.", 404);
    if (current.enabled === enabled) return { ...current, idempotentReplay: true };
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

  assignmentDetailsForAgent(agentId) {
    if (!this.store.getAgent(agentId)) throw registryError("AGENT_NOT_FOUND", "Agent not found.", 404);
    return this.store.selectAll(`SELECT server_id, credential_ref, credential_names_json,
      credential_revision, tool_allowlist_json FROM agent_mcp_assignments
      WHERE agent_id = ? ORDER BY added_at, server_id`,
    [agentId]).map((row) => ({ serverId: row.server_id,
      hasOwnCredentials: Boolean(row.credential_ref),
      credentialNames: JSON.parse(row.credential_names_json),
      credentialRevision: row.credential_revision,
      toolAllowlist: row.tool_allowlist_json === null ? null : JSON.parse(row.tool_allowlist_json) }));
  }

  setAssignment(agentId, serverId, assigned, options = {}) {
    if (!this.store.getAgent(agentId)) throw registryError("AGENT_NOT_FOUND", "Agent not found.", 404);
    if (isPlatformAssistant(agentId)) {
      throw registryError("PLATFORM_ASSISTANT_PROTECTED", "The built-in assistant's MCP assignments are managed by Corptie.", 403);
    }
    const server = this.get(serverId);
    if (!server) throw registryError("MCP_SERVER_NOT_FOUND", "MCP Server not found.", 404);
    if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["headers", "env", "clearCredentials", "toolAllowlist"].includes(key))
      || (options.clearCredentials != null && options.clearCredentials !== true)
      || (options.clearCredentials && (options.headers != null || options.env != null))) {
      throw registryError("INVALID_INPUT", "MCP assignment credential options are invalid.", 400);
    }
    if (!assigned && Object.keys(options).length) {
      throw registryError("INVALID_INPUT", "Unassignment cannot replace credentials.", 400);
    }
    const replacement = assigned ? credentialPayload(options, server.transport) : null;
    const existing = this.store.selectOne(`SELECT credential_ref, credential_names_json,
      credential_revision, tool_allowlist_json
      FROM agent_mcp_assignments WHERE agent_id = ? AND server_id = ?`, [agentId, serverId]);
    const toolAllowlist = Object.hasOwn(options, "toolAllowlist")
      ? normalizedToolAllowlist(options.toolAllowlist, server.observedToolNames)
      : existing?.tool_allowlist_json === null || !existing ? null
        : JSON.parse(existing.tool_allowlist_json);
    const toolAllowlistJson = toolAllowlist === null ? null : JSON.stringify(toolAllowlist);
    const credentialRef = replacement
      ? `${serverId}:${(existing?.credential_revision ?? 0) + 1}:${randomUUID()}`
      : !assigned || options.clearCredentials ? null : existing?.credential_ref ?? null;
    const credentialNames = replacement
      ? Object.keys(replacement[server.transport === "stdio" ? "env" : "headers"])
      : !assigned || options.clearCredentials ? [] : JSON.parse(existing?.credential_names_json ?? "[]");
    const changed = assigned !== Boolean(existing) || credentialRef !== (existing?.credential_ref ?? null)
      || (assigned && toolAllowlistJson !== (existing?.tool_allowlist_json ?? null));
    if (!changed) return { agentId, serverId, assigned, hasOwnCredentials: Boolean(credentialRef),
      credentialNames, toolAllowlist, changed: false };
    if (replacement) this.secretStore.put(credentialRef, replacement);
    try {
      this.store.db.run("BEGIN IMMEDIATE");
      try {
        if (!assigned) {
          this.store.db.run("DELETE FROM agent_mcp_assignments WHERE agent_id = ? AND server_id = ?",
            [agentId, serverId]);
        } else if (!existing) {
          this.store.db.run(`INSERT INTO agent_mcp_assignments
            (agent_id, server_id, added_at, credential_ref, credential_names_json,
             credential_revision, tool_allowlist_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [agentId, serverId, new Date().toISOString(),
              credentialRef, JSON.stringify(credentialNames), replacement ? 1 : 0,
              toolAllowlistJson]);
        } else {
          this.store.db.run(`UPDATE agent_mcp_assignments SET credential_ref = ?,
            credential_names_json = ?, credential_revision = credential_revision + ?,
            tool_allowlist_json = ?
            WHERE agent_id = ? AND server_id = ?`,
          [credentialRef, JSON.stringify(credentialNames),
            credentialRef !== existing.credential_ref ? 1 : 0,
            toolAllowlistJson, agentId, serverId]);
        }
        if (existing?.credential_ref && existing.credential_ref !== credentialRef) {
          this.#enqueueCleanup("credential_ref", existing.credential_ref, serverId);
        }
        this.store.db.run("COMMIT");
      } catch (error) {
        this.store.db.run("ROLLBACK");
        throw error;
      }
    } catch (error) {
      if (replacement) {
        try { this.secretStore.delete(credentialRef); } catch { /* preserve original failure */ }
      }
      throw error;
    }
    this.store.scheduleSave();
    if (existing?.credential_ref && existing.credential_ref !== credentialRef) {
      void this.drainCleanup({ serverId }).catch(() => {});
    }
    return { agentId, serverId, assigned, hasOwnCredentials: Boolean(assigned && credentialRef),
      credentialNames: assigned ? credentialNames : [], toolAllowlist: assigned ? toolAllowlist : null,
      changed: true };
  }

  deletionImpact(serverId) {
    const server = this.get(serverId);
    if (!server) throw registryError("MCP_SERVER_NOT_FOUND", "MCP Server not found.", 404);
    const assignedAgents = this.store.selectAll(`SELECT a.agent_id, a.name
      FROM agent_mcp_assignments link JOIN agents a ON a.agent_id = link.agent_id
      WHERE link.server_id = ? ORDER BY a.name, a.agent_id`, [serverId])
      .map((row) => ({ agentId: row.agent_id, name: row.name }));
    const history = this.store.selectAll(`SELECT package_root, credential_ref
      FROM mcp_server_package_versions WHERE server_id = ?`, [serverId]);
    return {
      serverId, configRevision: server.configRevision,
      canRemove: assignedAgents.length === 0,
      blockingCode: assignedAgents.length ? "MCP_SERVER_ASSIGNED" : null,
      assignedAgents,
      managedPackageCopies: new Set([server.packageRoot,
        ...history.map((row) => row.package_root)].filter(Boolean)).size,
      credentialReferences: new Set([server.credentialRef,
        ...history.map((row) => row.credential_ref)].filter(Boolean)).size,
      originalSourceWillBeDeleted: false
    };
  }

  recordRuntimeEvent(input) {
    if (!input || !["tools-list", "tool-call"].includes(input.stage)
      || !["success", "failed"].includes(input.status)
      || !this.store.selectOne("SELECT 1 AS present FROM mcp_server_registry WHERE server_id = ?",
        [input.serverId])) return;
    const safeCode = input.status === "failed"
      ? ["MCP_CONNECTION_FAILED", "MCP_RUNTIME_TIMEOUT", "MCP_TOOLS_EMPTY",
        "MCP_TOOLS_TOO_MANY", "MCP_TOOL_SCHEMA_INVALID", "MCP_TOOL_NAME_CONFLICT",
        "MCP_CREDENTIAL_MISSING", "MCP_TOOL_RESULT_ERROR"].includes(input.errorCode)
        ? input.errorCode : input.stage === "tools-list" ? "MCP_CONNECTION_FAILED" : "MCP_TOOL_CALL_FAILED"
      : null;
    this.store.db.run(`INSERT INTO mcp_runtime_events
      (event_id, server_id, agent_id, provider_id, logical_session_id, provider_binding_id,
       stage, status, error_code, tool_name, tool_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`mcp_event:${randomUUID()}`, input.serverId, input.agentId ?? null, input.providerId ?? null,
      input.logicalSessionId ?? null, input.bindingId ?? null, input.stage, input.status,
      safeCode, typeof input.toolName === "string" ? input.toolName.slice(0, 200) : null,
      Number.isSafeInteger(input.toolCount) ? input.toolCount : null, new Date().toISOString()]);
    this.store.db.run(`DELETE FROM mcp_runtime_events WHERE event_id IN (
      SELECT event_id FROM mcp_runtime_events WHERE server_id = ?
      ORDER BY rowid DESC LIMIT -1 OFFSET 200
    )`, [input.serverId]);
    this.store.scheduleSave();
  }

  #recordRuntimeEventBestEffort(input) {
    try { this.recordRuntimeEvent(input); }
    catch { /* diagnostics must not change an installation or verification result */ }
  }

  runtimeEvents(serverId, limit = 50) {
    if (!this.get(serverId)) throw registryError("MCP_SERVER_NOT_FOUND", "MCP Server not found.", 404);
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
    return this.store.selectAll(`SELECT event_id, server_id, agent_id, provider_id,
      logical_session_id, provider_binding_id, stage, status, error_code, tool_name,
      tool_count, created_at FROM mcp_runtime_events WHERE server_id = ?
      ORDER BY rowid DESC LIMIT ?`, [serverId, bounded])
      .map((row) => ({ eventId: row.event_id, serverId: row.server_id,
        agentId: row.agent_id, providerId: row.provider_id,
        logicalSessionId: row.logical_session_id, bindingId: row.provider_binding_id,
        stage: row.stage, status: row.status, errorCode: row.error_code,
        toolName: row.tool_name, toolCount: row.tool_count, createdAt: row.created_at }));
  }

  latestRuntimeEvent(serverId, stage, logicalSessionId = null) {
    if (!["tools-list", "tool-call"].includes(stage)) return null;
    const row = logicalSessionId
      ? this.store.selectOne(`SELECT status, error_code, tool_name, tool_count,
        provider_binding_id, created_at FROM mcp_runtime_events
        WHERE server_id = ? AND stage = ? AND logical_session_id = ?
        ORDER BY rowid DESC LIMIT 1`, [serverId, stage, logicalSessionId])
      : this.store.selectOne(`SELECT status, error_code, tool_name, tool_count,
        provider_binding_id, created_at FROM mcp_runtime_events
        WHERE server_id = ? AND stage = ?
        ORDER BY rowid DESC LIMIT 1`, [serverId, stage]);
    return row ? { status: row.status, errorCode: row.error_code,
      toolName: row.tool_name, toolCount: row.tool_count,
      bindingId: row.provider_binding_id, createdAt: row.created_at } : null;
  }

  async remove(serverId) {
    const server = this.get(serverId);
    if (!server) return { serverId, removed: false, cleanupPending: (await this.drainCleanup({ serverId })) > 0 };
    if (server.assignmentCount > 0) {
      throw registryError("MCP_SERVER_ASSIGNED", "Remove all Agent assignments before deleting this MCP Server.", 409);
    }
    const history = this.store.selectAll(`SELECT package_root, credential_ref
      FROM mcp_server_package_versions WHERE server_id = ?`, [serverId]);
    const packagePaths = [...new Set([server.packageRoot, ...history.map((row) => row.package_root)]
      .filter(Boolean))];
    for (const path of packagePaths) assertManagedPackagePath(this.packageRoot, serverId, path);
    const credentialRefs = [...new Set([server.credentialRef,
      ...history.map((row) => row.credential_ref)].filter(Boolean))];
    this.store.db.run("BEGIN IMMEDIATE");
    try {
      this.store.db.run("DELETE FROM mcp_server_registry WHERE server_id = ?", [serverId]);
      for (const path of packagePaths) this.#enqueueCleanup("package_path", path, serverId);
      for (const ref of credentialRefs) this.#enqueueCleanup("credential_ref", ref, serverId);
      this.store.db.run("COMMIT");
    } catch (error) {
      this.store.db.run("ROLLBACK");
      throw error;
    }
    this.store.scheduleSave();
    const cleanupPending = (await this.drainCleanup({ serverId })) > 0;
    return { serverId, removed: true, cleanupPending };
  }

  serversForAgent(agentId) {
    if (!this.store.getAgent(agentId)) return {};
    const rows = this.store.selectAll(`
      SELECT s.server_id, s.name, s.url, s.transport, s.command, s.args_json, s.cwd,
             s.verified_at, s.credential_ref, a.credential_ref AS assignment_credential_ref,
             a.credential_revision, a.tool_allowlist_json
      FROM mcp_server_registry s
      JOIN agent_mcp_assignments a ON a.server_id = s.server_id
      WHERE a.agent_id = ? AND s.enabled = 1 ORDER BY s.server_id
    `, [agentId]);
    return Object.fromEntries(rows.map((row) => {
      const selectedRef = row.assignment_credential_ref ?? row.credential_ref;
      const toolAllowlist = row.tool_allowlist_json === null ? null : JSON.parse(row.tool_allowlist_json);
      let credentials;
      try { credentials = selectedRef ? this.secretStore.get(selectedRef) : null; }
      catch { credentials = null; }
      const unavailableCode = selectedRef && !credentials ? "MCP_CREDENTIAL_MISSING" : null;
      return [serverKey(row.server_id), row.transport === "stdio"
        ? { serverId: row.server_id, type: "stdio", command: row.command, args: JSON.parse(row.args_json), cwd: row.cwd,
          env: { ...isolatedStdioEnv(), ...(credentials?.env ?? {}) }, isolatedEnv: true,
          displayName: row.name, observationRevision: row.verified_at,
          credentialVersion: selectedRef ?? "none", toolAllowlist, unavailableCode }
        : { serverId: row.server_id, type: row.transport, url: row.url, headers: credentials?.headers,
          displayName: row.name, observationRevision: row.verified_at,
          credentialVersion: selectedRef ?? "none", toolAllowlist, unavailableCode }];
    }));
  }

  assignmentRevisionForAgent(agentId) {
    if (!this.store.getAgent(agentId)) return "none";
    const rows = this.store.selectAll(`
      SELECT s.server_id, s.url, s.transport, s.command, s.args_json, s.cwd, s.enabled,
             s.updated_at, s.verified_at, s.credential_ref,
             a.credential_ref AS assignment_credential_ref, a.credential_revision,
             a.tool_allowlist_json
      FROM mcp_server_registry s JOIN agent_mcp_assignments a ON a.server_id = s.server_id
      WHERE a.agent_id = ? ORDER BY s.server_id
    `, [agentId]);
    return rows.length === 0 ? "none"
      : createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  }
}

async function normalizedConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw registryError("INVALID_INPUT", "MCP Server configuration must be an object.", 400);
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const transport = ["sse", "http", "stdio"].includes(input.transport) ? input.transport : null;
  if (!name || name.length > 120 || !transport) {
    throw registryError("INVALID_INPUT", "A name and supported transport are required.", 400);
  }
  if (transport === "stdio") {
    if (input.headers != null) throw registryError("INVALID_INPUT", "Local MCP cannot use HTTP headers.", 400);
    const env = credentialFields(input.env, "env");
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
    return { name, transport, command, args, cwd, ...(env ? { env } : {}) };
  }
  if (input.command != null || input.args != null || input.cwd != null || input.env != null) {
    throw registryError("INVALID_INPUT", "Remote MCP configuration cannot include a local command.", 400);
  }
  const headers = credentialFields(input.headers, "headers");
  let parsed;
  try { parsed = new URL(input.url); } catch { /* handled below */ }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed?.hostname);
  if (!parsed || (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:"))
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw registryError("MCP_URL_INVALID", "Use an HTTPS URL, or HTTP on local loopback, without embedded credentials or query parameters.", 400);
  }
  return { name, transport, url: parsed.href, ...(headers ? { headers } : {}) };
}

function credentialFields(value, kind) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length > 16
    || Object.entries(value).some(([key, secret]) => kind === "env"
      ? !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof secret !== "string" || secret.includes("\0")
      : !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof secret !== "string"
        || /[\r\n]/.test(secret))
    || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) {
    throw registryError("MCP_CREDENTIALS_INVALID", "MCP credential fields are invalid or too large.", 400);
  }
  return Object.keys(value).length ? value : null;
}

function credentialPayload(input, transport) {
  if (transport === "stdio") {
    if (input.headers != null) {
      throw registryError("INVALID_INPUT", "Stdio MCP credentials cannot include HTTP headers.", 400);
    }
    const env = credentialFields(input.env, "env");
    return env ? { env } : null;
  }
  if (input.env != null) {
    throw registryError("INVALID_INPUT", "Remote MCP credentials cannot include environment variables.", 400);
  }
  const headers = credentialFields(input.headers, "headers");
  return headers ? { headers } : null;
}

function normalizedToolAllowlist(value, observedToolNames) {
  if (value === null) return null;
  const observed = new Set(observedToolNames ?? []);
  if (!Array.isArray(value) || value.length > 256
    || value.some((name) => typeof name !== "string" || !name
      || name.length > 256 || !observed.has(name))
    || new Set(value).size !== value.length) {
    throw registryError("MCP_TOOL_ALLOWLIST_INVALID",
      "MCP tool allowlist must contain distinct currently observed tool names.", 400);
  }
  return [...value].sort();
}

async function packageServerConfig(root, name, input, installation = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw registryError("MCP_PACKAGE_CONFIG_INVALID", "Package Server configuration is invalid.", 400);
  }
  const transport = String(input.type ?? (input.url ? "http" : "stdio")).toLowerCase();
  if (transport !== "stdio") {
    if (installation.env != null || input.env != null) {
      throw registryError("MCP_PACKAGE_CONFIG_INVALID", "Remote package Server cannot use environment variables.", 400);
    }
    const headers = credentialFields(installation.headers, "headers");
    requirePackageCredentials(input.headers, headers);
    return { name, transport, url: input.url, ...(headers ? { headers } : {}) };
  }
  if (installation.headers != null || input.headers != null) {
    throw registryError("MCP_PACKAGE_CONFIG_INVALID", "Stdio package Server cannot use HTTP headers.", 400);
  }
  const env = credentialFields(installation.env, "env");
  requirePackageCredentials(input.env, env);
  const command = await packageCommand(root, input.command);
  const args = [];
  if (input.args != null && !Array.isArray(input.args)) {
    throw registryError("MCP_PACKAGE_CONFIG_INVALID", "Package Server arguments must be an array.", 400);
  }
  for (const argument of input.args ?? []) {
    if (typeof argument !== "string") {
      throw registryError("MCP_PACKAGE_CONFIG_INVALID", "Package Server arguments must be strings.", 400);
    }
    args.push(await packageArgument(root, argument));
  }
  const cwd = input.cwd == null ? root : packagePath(root, input.cwd);
  if (!(await stat(cwd)).isDirectory()) {
    throw registryError("MCP_PACKAGE_CONFIG_INVALID", "Package Server working directory is invalid.", 400);
  }
  return { name, transport, command, args, cwd, ...(env ? { env } : {}) };
}

function requirePackageCredentials(declared, supplied) {
  if (declared == null) return;
  if (typeof declared !== "object" || Array.isArray(declared)
    || Object.keys(declared).some((name) => typeof supplied?.[name] !== "string" || !supplied[name])) {
    throw registryError("MCP_PACKAGE_CREDENTIAL_REQUIRED", "Provide each credential declared by the selected MCP Server.", 400);
  }
}

async function packageCommand(root, raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw registryError("MCP_PACKAGE_CONFIG_INVALID", "Package Server command is required.", 400);
  }
  const value = raw.trim();
  if (value.includes("/") || value.includes("${")) {
    const path = packagePath(root, value);
    await access(path, constants.X_OK);
    return path;
  }
  for (const directory of String(process.env.PATH ?? "").split(":")) {
    if (!directory || !isAbsolute(directory)) continue;
    const path = join(directory, value);
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch { /* try next PATH entry */ }
  }
  throw registryError("MCP_PACKAGE_COMMAND_MISSING", "Package Server executable was not found on PATH.", 400);
}

async function packageArgument(root, raw) {
  if (raw.includes("${")) return packagePath(root, raw);
  if (raw.startsWith("./") || raw.startsWith("../")) return packagePath(root, raw);
  if (raw && !raw.startsWith("-") && !isAbsolute(raw)) {
    const candidate = join(root, raw);
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* ordinary value */ }
  }
  return raw;
}

function packagePath(root, raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw registryError("MCP_PACKAGE_CONFIG_INVALID", "Package Server path is invalid.", 400);
  }
  const substituted = raw.replaceAll("${PLUGIN_ROOT}", root).replaceAll("${SKILL_ROOT}", root);
  if (substituted.includes("${")) {
    throw registryError("MCP_PACKAGE_CONFIG_INVALID", "Package Server path contains an unsupported placeholder.", 400);
  }
  const path = resolve(root, substituted);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw registryError("MCP_PACKAGE_PATH_OUTSIDE", "Package Server path escapes its installed root.", 400);
  }
  return path;
}

function presentServer(row) {
  const server = { serverId: row.server_id, name: row.name, url: row.url,
    transport: row.transport, enabled: Boolean(row.enabled), toolCount: row.tool_count,
    command: row.command, args: JSON.parse(row.args_json ?? "[]"), cwd: row.cwd,
    verifiedAt: row.verified_at, assignmentCount: row.assignment_count,
    configRevision: row.config_revision,
    lastCheckedAt: row.last_checked_at, lastCheckStatus: row.last_check_status,
    lastErrorCode: row.last_error_code, observedToolNames: JSON.parse(row.observed_tool_names_json ?? "[]"),
    sourceKind: row.source_kind, sourceLocator: row.source_locator, sourceRevision: row.source_revision,
    packageRoot: row.package_root, packageHash: row.package_hash, descriptorPath: row.descriptor_path,
    hasCredentials: Boolean(row.credential_ref),
    credentialNames: JSON.parse(row.credential_names_json ?? "[]"),
    createdAt: row.created_at, updatedAt: row.updated_at };
  Object.defineProperty(server, "credentialRef", { value: row.credential_ref, enumerable: false });
  return server;
}

function assertManagedPackagePath(root, serverId, path) {
  const name = basename(path);
  const identity = serverId.slice(4);
  if (resolve(path) !== join(root, name)
    || (name !== identity && !new RegExp(`^${identity}-v[1-9][0-9]*-[a-f0-9-]{36}$`).test(name))) {
    throw registryError("MCP_PACKAGE_LOCATION_INVALID", "Managed MCP package location is invalid.", 409);
  }
}

function isolatedStdioEnv() {
  return Object.fromEntries(["PATH", "TMPDIR", "LANG"].filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]));
}

function serverKey(serverId) {
  return `standalone_${serverId.slice(4).replaceAll("-", "")}`;
}

function validatedInstallRequestId(input) {
  const value = input?.installRequestId;
  if (value == null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    throw registryError("MCP_INSTALL_REQUEST_INVALID", "Install request ID must be a UUID.", 400);
  }
  return value.toLowerCase();
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
