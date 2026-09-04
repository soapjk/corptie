import { createHash } from "node:crypto";
import {
  domainDiscoveryProfile,
  toolDiscoveryContract
} from "./toolDiscoveryContracts.mjs";

export const TOOL_HOST_CONTRACT_REVISION = "th2";
export const TOOL_CATALOG_SEARCH = "corptie_tool_catalog_search";
export const TOOL_DOMAIN_LOAD = "corptie_tool_domain_load";
export const TOOL_RESTRICTED_GATEWAY = "corptie_tool_call";
export const TOOL_HOST_BOOTSTRAP_ABI_REVISION = "tool-host-bootstrap:2";
export const TOOL_HOST_BOOTSTRAP_CONTRACT_REVISION = "tool-host-contract:1";
export const TOOL_HOST_BOOTSTRAP_GUIDANCE_REVISION = "tool-host-guidance:2";
export const TOOL_HOST_BOOTSTRAP_COMPATIBILITY_EPOCH = 1;
export const TOOL_DELIVERY_SURFACES = Object.freeze([
  "native_dynamic", "generated_authenticated_mcp", "restricted_gateway"
]);

const INTERNAL_BOOTSTRAP_NAMESPACE = "tool-catalog-bootstrap";

const BOOTSTRAP_TOOLS = Object.freeze([
  Object.freeze({
    name: TOOL_CATALOG_SEARCH,
    description: "Search the authorized Corptie Tool Host catalog. Returns ranked domain aliases, one recommended canonical tool, complete input Schema, conditional constraints, compatibility status, and a minimal example so the domain can be loaded and called without source inspection.",
    inputSchema: strictObject({
      intent: { type: "string", minLength: 1, maxLength: 1000 },
      domain_hint: { type: "string", minLength: 1, maxLength: 200 }
    }, ["intent"]),
    deferLoading: false
  }),
  Object.freeze({
    name: TOOL_DOMAIN_LOAD,
    description: "Materialize one authorized Corptie capability domain at a Turn boundary and return its complete directly-callable or restricted-gateway-equivalent tool contracts.",
    inputSchema: strictObject({
      domain_id: { type: "string", minLength: 1, maxLength: 200 },
      expected_catalog_version: { type: "string", minLength: 1, maxLength: 200 }
    }, ["domain_id", "expected_catalog_version"]),
    deferLoading: false
  })
]);

export const RESTRICTED_GATEWAY_DEFINITION = Object.freeze({
  name: TOOL_RESTRICTED_GATEWAY,
  description: "Call one Tool Host canonical tool from an applied authorized domain. Use the complete canonical inputSchema and minimalExample returned by catalog search or domain load for arguments.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      tool: { type: "string", minLength: 1, maxLength: 300 },
      arguments: { type: "object", additionalProperties: true },
      expected_catalog_version: { type: "string", minLength: 1, maxLength: 200 }
    }),
    required: Object.freeze(["tool", "arguments", "expected_catalog_version"]),
    additionalProperties: false
  }),
  deferLoading: false
});

export const TOOL_HOST_BOOTSTRAP_ABI_DEFINITIONS = Object.freeze([
  ...BOOTSTRAP_TOOLS,
  RESTRICTED_GATEWAY_DEFINITION
]);

// Changing this value is a deliberate Provider bootstrap ABI migration. CI
// recomputes it from the three entry definitions so ordinary Tool additions
// cannot silently force every existing Provider binding to be replaced.
export const TOOL_HOST_BOOTSTRAP_SCHEMA_HASH = "271bf54a6dcf48623938937de25af17dc383ab3705feb3a40213418b840035ec";
export const TOOL_HOST_BOOTSTRAP_CONTRACT_HASH = "0716b25882249ffd01a4a31ee9effaa5ef6d46a71e02457c6713e4ca48fcddf2";

// Definition hashes are exact Provider payload identities. This registry does
// not claim that an old payload was refreshed; it only records audited wire-
// contract compatibility for receipts created before contract hashes existed.
const LEGACY_PROVIDER_DEFINITION_CONTRACT_HASHES = Object.freeze({
  b57c8ea168bd12a45b3b3f1d832c450027fdf7587d86d0add42654b4531f502f:
    "499142548fe15dbac05ea6362f785ff25bccc07967b22688b25e046ac4a9d37f"
});

export class HostToolCatalog {
  constructor(namespaces = [], options = {}) {
    this.hostToolContractRevision = normalizedText(options.hostToolContractRevision)
      ?? TOOL_HOST_CONTRACT_REVISION;
    this.toolsByName = new Map();
    this.names = new Map();
    this.#register({
      id: INTERNAL_BOOTSTRAP_NAMESPACE,
      domainId: "tool-catalog",
      domainRevision: this.hostToolContractRevision,
      exposure: "bootstrap",
      eligibleSurfaces: ["native_dynamic", "generated_authenticated_mcp"],
      tools: BOOTSTRAP_TOOLS,
      execute: () => {
        throw catalogError("TOOL_HOST_BOOTSTRAP_DISPATCH_REQUIRED", "Bootstrap tools require ToolHostService dispatch.");
      }
    }, true);
    assertBootstrapAbi();
    for (const namespace of namespaces) this.register(namespace);
  }

  register(namespace) {
    return this.#register(namespace, false);
  }

  #register(namespace, allowBootstrap) {
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
    if (!allowBootstrap && (exposure === "bootstrap"
      || namespace.tools.some((tool) => tool?.exposure === "bootstrap"))) {
      throw catalogError(
        "TOOL_BOOTSTRAP_ABI_LOCKED",
        "Only the Tool Host may define bootstrap tools; capability namespaces must remain deferred."
      );
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

  domainContract(context = {}, domainId, options = {}) {
    const entries = this.domains(context).get(domainId) ?? [];
    if (entries.length === 0) return null;
    const profile = domainDiscoveryProfile(domainId);
    const recommendedTool = entries.some((entry) => entry.canonicalName === profile.recommendedTool)
      ? profile.recommendedTool
      : entries[0].canonicalName;
    const effectiveProfile = { ...profile, recommendedTool };
    const tools = entries.map((entry) => toolDiscoveryContract(entry, effectiveProfile))
      .sort((left, right) => Number(right.recommended) - Number(left.recommended)
        || left.canonicalName.localeCompare(right.canonicalName));
    const surface = options.surface ?? null;
    return Object.freeze({
      domainId,
      aliases: profile.aliases,
      recommendedTool,
      invocation: surface === "restricted_gateway"
        ? Object.freeze({
          mode: "restricted_gateway",
          gatewayTool: TOOL_RESTRICTED_GATEWAY,
          expectedCatalogVersion: options.catalogVersion ?? null,
          contract: "Pass the selected tool's minimalExample as arguments; its inputSchema is authoritative."
        })
        : surface == null
          ? Object.freeze({
            mode: "load_then_call",
            expectedCatalogVersion: options.catalogVersion ?? null,
            maximumAdditionalRoundTrips: 2,
            contract: "Load this domain once, then call the recommended canonical tool using the complete contract below."
          })
          : Object.freeze({
            mode: "direct",
            contract: "Call the canonical tool directly with arguments matching its inputSchema."
          }),
      tools: Object.freeze(tools)
    });
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
    const contractCatalog = canonical.map((entry) => ({
      canonicalName: entry.canonicalName,
      domainId: entry.domainId,
      domainRevision: entry.domainRevision,
      exposure: entry.exposure,
      contract: toolContractProjection(entry.definition),
      eligibleSurfaces: entry.eligibleSurfaces
    }));
    const catalogContractVersion = `${TOOL_HOST_CONTRACT_REVISION}-contract:${sha256(stableStringify(contractCatalog))}`;
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
      const contractJson = stableStringify(definitions.map(toolContractProjection));
      domains.push(Object.freeze({
        domainId,
        domainRevision: revisions.join("+"),
        canonicalToolNames: Object.freeze(entries.map((entry) => entry.canonicalName).sort()),
        schemaHash: sha256(schemaJson),
        definitionHash: sha256(schemaJson),
        contractHash: sha256(contractJson),
        schemaBytes: Buffer.byteLength(schemaJson),
        sourceIds: Object.freeze([...new Set(entries.map((entry) => entry.source.sourceId))].sort())
      }));
    }
    return Object.freeze({
      catalogVersion,
      catalogContractVersion,
      hostToolContractRevision: this.hostToolContractRevision,
      bootstrapAbiRevision: TOOL_HOST_BOOTSTRAP_ABI_REVISION,
      bootstrapSchemaHash: TOOL_HOST_BOOTSTRAP_SCHEMA_HASH,
      bootstrapContractRevision: TOOL_HOST_BOOTSTRAP_CONTRACT_REVISION,
      bootstrapContractHash: TOOL_HOST_BOOTSTRAP_CONTRACT_HASH,
      bootstrapGuidanceRevision: TOOL_HOST_BOOTSTRAP_GUIDANCE_REVISION,
      bootstrapDefinitionHash: TOOL_HOST_BOOTSTRAP_SCHEMA_HASH,
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

export function toolContractProjection(definition = {}) {
  return Object.freeze({
    name: definition.name,
    inputSchema: definition.inputSchema,
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    deferLoading: definition.deferLoading === true
  });
}

export function toolDefinitionsContractHash(definitions = [], options = {}) {
  const projected = definitions.map(toolContractProjection);
  const value = options.bootstrap === true
    ? { compatibilityEpoch: TOOL_HOST_BOOTSTRAP_COMPATIBILITY_EPOCH, definitions: projected }
    : projected;
  return sha256(stableStringify(value));
}

export function providerContractHashFromReceipt(receipt = {}, definitions = null) {
  if (typeof receipt.providerContractHash === "string" && receipt.providerContractHash.trim()) {
    return receipt.providerContractHash.trim();
  }
  const exactHash = typeof receipt.providerDefinitionsHash === "string"
    ? receipt.providerDefinitionsHash.trim()
    : "";
  if (exactHash && LEGACY_PROVIDER_DEFINITION_CONTRACT_HASHES[exactHash]) {
    return LEGACY_PROVIDER_DEFINITION_CONTRACT_HASHES[exactHash];
  }
  if (Array.isArray(definitions) && exactHash === schemaHash(definitions)) {
    return toolDefinitionsContractHash(definitions);
  }
  return null;
}

export function computedToolHostBootstrapSchemaHash() {
  return sha256(stableStringify(TOOL_HOST_BOOTSTRAP_ABI_DEFINITIONS));
}

export function computedToolHostBootstrapContractHash() {
  return toolDefinitionsContractHash(TOOL_HOST_BOOTSTRAP_ABI_DEFINITIONS, { bootstrap: true });
}

function assertBootstrapAbi() {
  const actual = computedToolHostBootstrapSchemaHash();
  const actualContract = computedToolHostBootstrapContractHash();
  if (actual === TOOL_HOST_BOOTSTRAP_SCHEMA_HASH
    && actualContract === TOOL_HOST_BOOTSTRAP_CONTRACT_HASH) return;
  const error = catalogError(
    "TOOL_BOOTSTRAP_ABI_DRIFT",
    `Tool Host bootstrap ABI ${TOOL_HOST_BOOTSTRAP_ABI_REVISION} changed without an explicit hash migration.`
  );
  error.expectedHash = TOOL_HOST_BOOTSTRAP_SCHEMA_HASH;
  error.actualHash = actual;
  error.expectedContractHash = TOOL_HOST_BOOTSTRAP_CONTRACT_HASH;
  error.actualContractHash = actualContract;
  throw error;
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

function validateArguments(schema, value) {
  const issues = Object.freeze(validateSchema(schema, value));
  if (issues.length === 0) return;
  const error = catalogError(
    "TOOL_ARGUMENT_SCHEMA_INVALID",
    `Tool arguments contain ${issues.length} schema violation${issues.length === 1 ? "" : "s"}.`
  );
  error.path = issues[0]?.path ?? "$";
  error.issues = issues;
  error.statusCode = 400;
  throw error;
}

function validateSchema(schema, value, path = "$") {
  if (!schema || schema === true) return [];
  if (schema === false) return [validationIssue(path, "falseSchema", "is not allowed")];
  const issues = [];
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesType(type, value))) {
    return [validationIssue(path, "type", `must be ${allowedTypes.join(" or ")}`, { type: schema.type })];
  }
  if (schema.const !== undefined && value !== schema.const) {
    issues.push(validationIssue(path, "const", `must equal ${JSON.stringify(schema.const)}`, { allowedValue: schema.const }));
  }
  if (schema.enum && !schema.enum.includes(value)) {
    issues.push(validationIssue(path, "enum", `must be one of ${schema.enum.join(", ")}`, { allowedValues: schema.enum }));
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) issues.push(validationIssue(path, "minLength", `must contain at least ${schema.minLength} characters`));
    if (schema.maxLength != null && value.length > schema.maxLength) issues.push(validationIssue(path, "maxLength", `must contain at most ${schema.maxLength} characters`));
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push(validationIssue(path, "pattern", `must match ${schema.pattern}`));
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) issues.push(validationIssue(path, "minimum", `must be at least ${schema.minimum}`));
    if (schema.maximum != null && value > schema.maximum) issues.push(validationIssue(path, "maximum", `must be at most ${schema.maximum}`));
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) issues.push(validationIssue(path, "minItems", `must contain at least ${schema.minItems} items`));
    if (schema.maxItems != null && value.length > schema.maxItems) issues.push(validationIssue(path, "maxItems", `must contain at most ${schema.maxItems} items`));
    for (let index = 0; index < value.length; index += 1) issues.push(...validateSchema(schema.items, value[index], `${path}[${index}]`));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) issues.push(validationIssue(`${path}.${required}`, "required", "is required", { missingProperty: required }));
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) issues.push(validationIssue(`${path}.${name}`, "additionalProperties", "is not allowed", { additionalProperty: name }));
      }
    }
    if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) {
      issues.push(validationIssue(path, "minProperties", `must contain at least ${schema.minProperties} properties`));
    }
    for (const [name, property] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) issues.push(...validateSchema(property, value[name], `${path}.${name}`));
    }
  }
  for (const rule of schema.allOf ?? []) issues.push(...validateSchema(rule, value, path));
  if (schema.if) {
    const matches = validateSchema(schema.if, value, path).length === 0;
    issues.push(...validateSchema(matches ? schema.then : schema.else, value, path));
  }
  for (const keyword of ["oneOf", "anyOf"]) {
    const alternatives = schema[keyword];
    if (!Array.isArray(alternatives)) continue;
    const results = alternatives.map((alternative) => validateSchema(alternative, value, path));
    const matches = results.filter((result) => result.length === 0).length;
    const valid = keyword === "oneOf" ? matches === 1 : matches >= 1;
    if (!valid) {
      if (matches === 0) issues.push(...results.flat());
      issues.push(validationIssue(path, keyword, keyword === "oneOf"
        ? "must match exactly one allowed combination" : "must match at least one allowed combination"));
    }
  }
  if (schema.not && validateSchema(schema.not, value, path).length === 0) {
    issues.push(validationIssue(path, "not", "matches a forbidden combination"));
  }
  return deduplicatedIssues(issues);
}

function matchesType(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validationIssue(path, keyword, message, params = {}) {
  return Object.freeze({ path, keyword, message, params: Object.freeze({ ...params }) });
}

function deduplicatedIssues(issues) {
  const unique = new Map();
  for (const issue of issues) unique.set(`${issue.path}\0${issue.keyword}\0${issue.message}`, issue);
  return [...unique.values()];
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
