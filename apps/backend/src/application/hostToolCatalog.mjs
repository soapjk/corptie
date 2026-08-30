import { createHash } from "node:crypto";

export const TOOL_HOST_CONTRACT_REVISION = "th2";
export const TOOL_CATALOG_SEARCH = "corptie_tool_catalog_search";
export const TOOL_DOMAIN_LOAD = "corptie_tool_domain_load";
export const TOOL_RESTRICTED_GATEWAY = "corptie_tool_call";
export const TOOL_DELIVERY_SURFACES = Object.freeze([
  "native_dynamic", "generated_authenticated_mcp", "restricted_gateway"
]);

const BOOTSTRAP_TOOLS = Object.freeze([
  Object.freeze({
    name: TOOL_CATALOG_SEARCH,
    description: "Search the authorized Corptie Tool Host catalog for capability domains and tools.",
    inputSchema: strictObject({
      intent: { type: "string", minLength: 1, maxLength: 1000 },
      domain_hint: { type: "string", minLength: 1, maxLength: 200 }
    }, ["intent"]),
    deferLoading: false
  }),
  Object.freeze({
    name: TOOL_DOMAIN_LOAD,
    description: "Materialize one authorized Corptie capability domain at a Turn boundary.",
    inputSchema: strictObject({
      domain_id: { type: "string", minLength: 1, maxLength: 200 },
      expected_catalog_version: { type: "string", minLength: 1, maxLength: 200 }
    }, ["domain_id", "expected_catalog_version"]),
    deferLoading: false
  })
]);

export class HostToolCatalog {
  constructor(namespaces = [], options = {}) {
    this.hostToolContractRevision = normalizedText(options.hostToolContractRevision)
      ?? TOOL_HOST_CONTRACT_REVISION;
    this.toolsByName = new Map();
    this.names = new Map();
    this.register({
      id: "tool-catalog-bootstrap",
      domainId: "tool-catalog",
      domainRevision: this.hostToolContractRevision,
      exposure: "bootstrap",
      eligibleSurfaces: ["native_dynamic", "generated_authenticated_mcp"],
      tools: BOOTSTRAP_TOOLS,
      execute: () => {
        throw catalogError("TOOL_HOST_BOOTSTRAP_DISPATCH_REQUIRED", "Bootstrap tools require ToolHostService dispatch.");
      }
    });
    for (const namespace of namespaces) this.register(namespace);
  }

  register(namespace) {
    const id = requiredText(namespace?.id, "namespace.id");
    const domainId = requiredText(namespace?.domainId ?? id, "namespace.domainId");
    const domainRevision = requiredText(namespace?.domainRevision ?? "1", "namespace.domainRevision");
    const exposure = normalizedExposure(namespace?.exposure ?? "deferred");
    const source = normalizedSource(namespace?.source ?? { kind: "host", sourceId: id });
    const eligibleSurfaces = normalizedSurfaces(namespace?.eligibleSurfaces ?? TOOL_DELIVERY_SURFACES);
    const namespaceDiscoveryTerms = normalizedDiscoveryTerms(namespace?.discoveryTerms);
    if (!Array.isArray(namespace?.tools) || typeof namespace?.execute !== "function") {
      throw new TypeError(`Host tool namespace ${id} requires tools and execute().`);
    }
    for (const rawDefinition of namespace.tools) {
      const definition = normalizedDefinition(rawDefinition);
      const canonicalName = definition.name;
      const aliases = normalizedAliases(rawDefinition?.aliases);
      this.#claimName(canonicalName, canonicalName);
      for (const alias of aliases) this.#claimName(alias.name, canonicalName);
      const registered = Object.freeze({
        id,
        canonicalName,
        domainId: requiredText(rawDefinition?.domainId ?? domainId, "tool.domainId"),
        domainRevision: requiredText(rawDefinition?.domainRevision ?? domainRevision, "tool.domainRevision"),
        exposure: normalizedExposure(rawDefinition?.exposure ?? exposure),
        definition: Object.freeze(definition),
        aliases: Object.freeze(aliases),
        source: normalizedSource(rawDefinition?.source ?? source),
        eligibleSurfaces: normalizedSurfaces(rawDefinition?.eligibleSurfaces ?? eligibleSurfaces),
        discoveryTerms: normalizedDiscoveryTerms([
          ...namespaceDiscoveryTerms,
          ...(Array.isArray(rawDefinition?.discoveryTerms) ? rawDefinition.discoveryTerms : [])
        ]),
        execute: namespace.execute,
        authorizeDiscover: typeof namespace.authorizeDiscover === "function"
          ? namespace.authorizeDiscover
          : (typeof namespace.authorize === "function" ? namespace.authorize : null),
        authorizeExecute: typeof namespace.authorizeExecute === "function"
          ? namespace.authorizeExecute
          : (typeof namespace.authorize === "function" ? namespace.authorize : null)
      });
      this.toolsByName.set(canonicalName, registered);
      for (const alias of aliases) this.toolsByName.set(alias.name, registered);
    }
    return this;
  }

  entry(name) {
    return this.toolsByName.get(requiredText(name, "tool")) ?? null;
  }

  entries(context = {}, options = {}) {
    const domains = options.domains == null ? null : new Set(options.domains);
    return this.#canonicalEntries()
      .filter((registered) => !domains || domains.has(registered.domainId))
      .filter((registered) => options.includeBootstrap === true
        || options.exposure != null
        || registered.exposure !== "bootstrap")
      .filter((registered) => options.exposure == null || registered.exposure === options.exposure)
      .filter((registered) => this.#isAuthorized(registered, context, "discover"));
  }

  definitions(context = {}, options = {}) {
    return this.entries(context, options).map(({ definition }) => definition);
  }

  bootstrapDefinitions(context = {}) {
    return this.definitions(context, { exposure: "bootstrap", includeBootstrap: true });
  }

  domains(context = {}) {
    const grouped = new Map();
    for (const entry of this.entries(context)) {
      if (entry.exposure === "bootstrap") continue;
      const values = grouped.get(entry.domainId) ?? [];
      values.push(entry);
      grouped.set(entry.domainId, values);
    }
    return grouped;
  }

  snapshot() {
    const canonical = this.#canonicalEntries().map((entry) => ({
      canonicalName: entry.canonicalName,
      domainId: entry.domainId,
      domainRevision: entry.domainRevision,
      exposure: entry.exposure,
      definition: entry.definition,
      aliases: entry.aliases,
      source: entry.source,
      eligibleSurfaces: entry.eligibleSurfaces,
      discoveryTerms: entry.discoveryTerms
    })).sort((left, right) => left.canonicalName.localeCompare(right.canonicalName));
    const catalogJson = stableStringify(canonical);
    const catalogVersion = `${TOOL_HOST_CONTRACT_REVISION}:${sha256(`${catalogJson}${this.hostToolContractRevision}`)}`;
    const domains = [];
    const grouped = new Map();
    for (const entry of canonical) {
      const values = grouped.get(entry.domainId) ?? [];
      values.push(entry);
      grouped.set(entry.domainId, values);
    }
    for (const [domainId, entries] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
      const definitions = entries.map((entry) => entry.definition);
      const revisions = [...new Set(entries.map((entry) => entry.domainRevision))].sort();
      const schemaJson = stableStringify(definitions);
      domains.push(Object.freeze({
        domainId,
        domainRevision: revisions.join("+"),
        canonicalToolNames: Object.freeze(entries.map((entry) => entry.canonicalName).sort()),
        schemaHash: sha256(schemaJson),
        schemaBytes: Buffer.byteLength(schemaJson),
        sourceIds: Object.freeze([...new Set(entries.map((entry) => entry.source.sourceId))].sort())
      }));
    }
    return Object.freeze({
      catalogVersion,
      hostToolContractRevision: this.hostToolContractRevision,
      generatedAt: new Date().toISOString(),
      bootstrap: Object.freeze([TOOL_CATALOG_SEARCH, TOOL_DOMAIN_LOAD]),
      domains: Object.freeze(domains)
    });
  }

  async execute(input = {}) {
    const requestedName = requiredText(input.tool, "tool");
    const registered = this.toolsByName.get(requestedName);
    if (!registered) throw catalogError("HOST_TOOL_UNSUPPORTED", `Unsupported Corptie host tool: ${requestedName}`);
    if (!this.#isAuthorized(registered, input, "execute")) {
      const error = catalogError(
        "SESSION_TOOL_FORBIDDEN",
        `Session ${input.metadata?.logicalSessionId ?? input.metadata?.sessionId ?? "unknown"} is not allowed to use Corptie host tool ${registered.canonicalName}.`
      );
      error.actorId = input.actorId ?? null;
      error.tool = registered.canonicalName;
      throw error;
    }
    validateArguments(registered.definition.inputSchema, input.arguments ?? {});
    return registered.execute({ ...input, tool: registered.canonicalName, arguments: input.arguments ?? {} });
  }

  #canonicalEntries() {
    return [...new Map([...this.toolsByName.values()].map((entry) => [entry.canonicalName, entry])).values()];
  }

  #claimName(nameValue, canonicalName) {
    const name = requiredText(nameValue, "tool.name");
    const key = name.toLocaleLowerCase();
    const existing = this.names.get(key);
    if (existing) {
      const error = catalogError("TOOL_CATALOG_NAME_CONFLICT", `Host Tool catalog name conflicts: ${name}`);
      error.nameOwner = existing;
      error.conflictingOwner = canonicalName;
      throw error;
    }
    this.names.set(key, canonicalName);
  }

  #isAuthorized(registered, context, phase) {
    const authorize = phase === "execute" ? registered.authorizeExecute : registered.authorizeDiscover;
    if (!authorize) return true;
    try {
      return authorize({
        actorId: context.actorId ?? null,
        tool: registered.canonicalName,
        namespaceId: registered.id,
        metadata: context.metadata ?? null,
        arguments: phase === "execute" ? (context.arguments ?? {}) : undefined
      }) === true;
    } catch {
      return false;
    }
  }
}

function normalizedDiscoveryTerms(values) {
  if (values == null) return Object.freeze([]);
  if (!Array.isArray(values)) throw new TypeError("Tool discoveryTerms must be an array.");
  return Object.freeze([...new Set(values.map((value) => requiredText(value, "discoveryTerm")))].sort());
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function schemaHash(definition) {
  return sha256(stableStringify(definition));
}

function normalizedDefinition(input) {
  const name = requiredText(input?.name, "tool.name");
  const inputSchema = input?.inputSchema && typeof input.inputSchema === "object"
    ? { ...input.inputSchema, additionalProperties: false }
    : strictObject();
  return {
    ...input,
    name,
    inputSchema: Object.freeze(inputSchema),
    deferLoading: input?.deferLoading === true
  };
}

function normalizedAliases(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new TypeError("Host Tool aliases must be an array.");
  return input.map((alias) => typeof alias === "string"
    ? Object.freeze({ name: requiredText(alias, "tool.alias"), deprecated: false })
    : Object.freeze({ name: requiredText(alias?.name, "tool.alias.name"), deprecated: alias?.deprecated === true }));
}

function normalizedSource(input) {
  const kind = requiredText(input?.kind, "tool.source.kind");
  if (!["host", "skill_mcp"].includes(kind)) throw new TypeError(`Unsupported Host Tool source kind: ${kind}`);
  return Object.freeze({ kind, sourceId: requiredText(input?.sourceId, "tool.source.sourceId") });
}

function normalizedSurfaces(input) {
  if (!Array.isArray(input) || input.length === 0) throw new TypeError("Host Tool eligibleSurfaces must not be empty.");
  const values = [...new Set(input.map((value) => requiredText(value, "tool.eligibleSurfaces[]")))].sort();
  for (const value of values) {
    if (!TOOL_DELIVERY_SURFACES.includes(value)) throw new TypeError(`Unsupported Tool delivery surface: ${value}`);
  }
  return Object.freeze(values);
}

function normalizedExposure(value) {
  const exposure = requiredText(value, "tool.exposure");
  if (!["bootstrap", "deferred"].includes(exposure)) throw new TypeError(`Unsupported Tool exposure: ${exposure}`);
  return exposure;
}

function validateArguments(schema, value, path = "$") {
  if (schema?.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw schemaError(path, "must be an object");
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) throw schemaError(`${path}.${required}`, "is required");
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unknown) throw schemaError(`${path}.${unknown}`, "is not allowed");
    }
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) validateArguments(properties[key], item, `${path}.${key}`);
    }
    return;
  }
  if (schema?.type === "array") {
    if (!Array.isArray(value)) throw schemaError(path, "must be an array");
    for (let index = 0; index < value.length; index += 1) validateArguments(schema.items ?? {}, value[index], `${path}[${index}]`);
    return;
  }
  if (schema?.type === "string" && typeof value !== "string") throw schemaError(path, "must be a string");
  if ((schema?.type === "number" || schema?.type === "integer") && typeof value !== "number") throw schemaError(path, "must be a number");
  if (schema?.type === "boolean" && typeof value !== "boolean") throw schemaError(path, "must be a boolean");
  if (schema?.enum && !schema.enum.includes(value)) throw schemaError(path, "has an unsupported value");
  if (typeof value === "string" && schema?.minLength != null && value.length < schema.minLength) throw schemaError(path, "is too short");
  if (typeof value === "string" && schema?.maxLength != null && value.length > schema.maxLength) throw schemaError(path, "is too long");
  if (typeof value === "string" && schema?.pattern && !new RegExp(schema.pattern).test(value)) throw schemaError(path, "has an invalid format");
}

function schemaError(path, reason) {
  const error = catalogError("TOOL_ARGUMENT_SCHEMA_INVALID", `Tool arguments ${path} ${reason}.`);
  error.path = path;
  error.statusCode = 400;
  return error;
}

function strictObject(properties = {}, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredText(value, field) {
  const normalized = normalizedText(value);
  if (!normalized) throw new TypeError(`Host Tool ${field} is required.`);
  return normalized;
}

function normalizedText(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function catalogError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}
