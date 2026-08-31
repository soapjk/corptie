import { createHash } from "node:crypto";
import {
  TOOL_DELIVERY_SURFACES,
  TOOL_HOST_BOOTSTRAP_ABI_REVISION,
  TOOL_HOST_BOOTSTRAP_SCHEMA_HASH,
  TOOL_RESTRICTED_GATEWAY,
  RESTRICTED_GATEWAY_DEFINITION,
  schemaHash,
  stableStringify
} from "./hostToolCatalog.mjs";

export { RESTRICTED_GATEWAY_DEFINITION } from "./hostToolCatalog.mjs";

export function buildToolExposurePlan({ catalog, context = {}, desiredDomains = [], capabilities, phase = "refresh" }) {
  if (!catalog) throw new TypeError("Tool Exposure Plan requires a Host Tool Catalog.");
  const normalizedCapabilities = normalizeToolSchemaCapabilities(capabilities);
  const domainIds = [...new Set(desiredDomains)].sort();
  const entries = catalog.entries(context, { domains: domainIds });
  const surface = selectDeliverySurface(normalizedCapabilities, phase);
  const ownership = {};
  for (const entry of entries) {
    if (!entry.eligibleSurfaces.includes(surface)) {
      throw surfaceError(`Tool ${entry.canonicalName} is not eligible for ${surface}.`, entry.canonicalName);
    }
    claim(ownership, entry.canonicalName, {
      sourceId: entry.source.sourceId,
      domainId: entry.domainId,
      surface,
      schemaHash: schemaHash(entry.definition)
    });
  }
  const bootstrap = catalog.entries(context, { exposure: "bootstrap" });
  const bootstrapSurface = normalizedCapabilities.generatedMcpRefresh && !normalizedCapabilities.bootstrapAttach
    ? "generated_authenticated_mcp"
    : "native_dynamic";
  for (const entry of bootstrap) {
    claim(ownership, entry.canonicalName, {
      sourceId: entry.source.sourceId,
      domainId: entry.domainId,
      surface: bootstrapSurface,
      schemaHash: schemaHash(entry.definition)
    });
  }
  const providerDefinitions = bootstrap.map((entry) => entry.definition);
  if (surface === "restricted_gateway") {
    claim(ownership, TOOL_RESTRICTED_GATEWAY, {
      sourceId: "tool-host",
      domainId: "tool-catalog",
      surface: "restricted_gateway",
      schemaHash: schemaHash(RESTRICTED_GATEWAY_DEFINITION)
    });
    providerDefinitions.push(RESTRICTED_GATEWAY_DEFINITION);
  } else {
    providerDefinitions.push(...entries.map((entry) => entry.definition));
  }
  const orderedOwnership = Object.fromEntries(Object.entries(ownership).sort(([left], [right]) => left.localeCompare(right)));
  const exposurePlanHash = sha256(stableStringify(orderedOwnership));
  return Object.freeze({
    surface,
    refreshMode: refreshMode(normalizedCapabilities, phase, surface),
    bootstrapAbiRevision: TOOL_HOST_BOOTSTRAP_ABI_REVISION,
    bootstrapSchemaHash: TOOL_HOST_BOOTSTRAP_SCHEMA_HASH,
    exposurePlanHash,
    ownership: Object.freeze(orderedOwnership),
    providerDefinitions: Object.freeze(providerDefinitions),
    desiredDomains: Object.freeze(domainIds),
    capabilityRevision: normalizedCapabilities.capabilityRevision
  });
}

export function assertUniqueToolSurfaces(plans) {
  const ownership = {};
  for (const plan of plans ?? []) {
    for (const [canonicalName, owner] of Object.entries(plan?.ownership ?? {})) claim(ownership, canonicalName, owner);
  }
  return true;
}

export function normalizeToolSchemaCapabilities(input = {}) {
  const capabilityRevision = typeof input.capabilityRevision === "string" && input.capabilityRevision.trim()
    ? input.capabilityRevision.trim()
    : null;
  if (!capabilityRevision) {
    const error = new TypeError("Tool Schema capabilityRevision is required.");
    error.code = "PROVIDER_CAPABILITY_INVALID";
    throw error;
  }
  return Object.freeze({
    bootstrapAttach: input.bootstrapAttach === true,
    appendInPlace: input.appendInPlace === true,
    replaceAtTurnBoundary: input.replaceAtTurnBoundary === true,
    generatedMcpRefresh: input.generatedMcpRefresh === true,
    restrictedGateway: input.restrictedGateway === true,
    bindingReplacement: input.bindingReplacement === true,
    capabilityRevision
  });
}

function selectDeliverySurface(capabilities, phase) {
  if (capabilities.appendInPlace) return "native_dynamic";
  if (capabilities.generatedMcpRefresh) return "generated_authenticated_mcp";
  if (capabilities.restrictedGateway) return "restricted_gateway";
  if (capabilities.replaceAtTurnBoundary) return "native_dynamic";
  if (phase === "create" && capabilities.bootstrapAttach) return "native_dynamic";
  if (capabilities.bindingReplacement) return "native_dynamic";
  const error = new Error("Provider cannot apply or safely route the requested Tool Schema plan.");
  error.code = "PROVIDER_CAPABILITY_UNSUPPORTED";
  error.statusCode = 422;
  throw error;
}

function refreshMode(capabilities, phase, surface) {
  if (phase === "create") return "create";
  if (surface === "restricted_gateway") return "restricted_gateway";
  if (surface === "generated_authenticated_mcp") return "generated_mcp_refresh";
  if (capabilities.appendInPlace) return "append_in_place";
  if (capabilities.replaceAtTurnBoundary) return "turn_boundary_replace";
  return "binding_replacement";
}

function claim(ownership, canonicalName, owner) {
  const existing = ownership[canonicalName];
  if (existing) {
    const error = surfaceError(`Canonical Tool ${canonicalName} has more than one delivery surface.`, canonicalName);
    error.existing = existing;
    error.conflicting = owner;
    throw error;
  }
  if (!TOOL_DELIVERY_SURFACES.includes(owner.surface)) {
    throw surfaceError(`Canonical Tool ${canonicalName} has invalid delivery surface ${owner.surface}.`, canonicalName);
  }
  ownership[canonicalName] = Object.freeze({ ...owner });
}

function surfaceError(message, canonicalName) {
  const error = new Error(message);
  error.code = "TOOL_DELIVERY_SURFACE_CONFLICT";
  error.statusCode = 409;
  error.canonicalName = canonicalName;
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
