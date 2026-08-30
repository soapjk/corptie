import { createHash, randomUUID } from "node:crypto";
import { normalizeToolSchemaCapabilities } from "../application/toolExposurePlan.mjs";

export function providerToolSchemaCapabilities(provider, binding = null) {
  if (typeof provider?.probeToolSchemaCapabilities === "function") {
    return Promise.resolve(provider.probeToolSchemaCapabilities(binding)).then(normalizeToolSchemaCapabilities);
  }
  const declared = provider?.descriptor?.metadata?.toolSchemaCapabilities ?? {};
  return Promise.resolve(normalizeToolSchemaCapabilities({
    bootstrapAttach: typeof provider?.attachTools === "function",
    appendInPlace: false,
    replaceAtTurnBoundary: false,
    generatedMcpRefresh: false,
    restrictedGateway: typeof provider?.attachTools === "function",
    bindingReplacement: typeof provider?.createSession === "function",
    ...declared,
    capabilityRevision: declared.capabilityRevision
      ?? capabilityHash(provider?.descriptor ?? {}, declared)
  }));
}

export function appliedToolMaterializationReceipt(input = {}) {
  const receipt = {
    providerBindingId: required(input.providerBindingId, "providerBindingId"),
    providerCapabilityRevision: required(input.providerCapabilityRevision, "providerCapabilityRevision"),
    requestedVersion: required(input.requestedVersion, "requestedVersion"),
    appliedVersion: required(input.appliedVersion ?? input.requestedVersion, "appliedVersion"),
    appliedCatalogVersion: required(input.appliedCatalogVersion, "appliedCatalogVersion"),
    appliedDomains: Array.isArray(input.appliedDomains) ? input.appliedDomains.map((domain) => ({ ...domain })) : [],
    appliedExposurePlanHash: required(input.appliedExposurePlanHash, "appliedExposurePlanHash"),
    refreshMode: required(input.refreshMode, "refreshMode"),
    providerRevision: required(input.providerRevision, "providerRevision"),
    receiptId: required(input.receiptId ?? `tool_receipt:${randomUUID()}`, "receiptId"),
    appliedAt: required(input.appliedAt ?? new Date().toISOString(), "appliedAt")
  };
  return Object.freeze(receipt);
}

export function validateToolMaterializationReceipt(receipt, expected) {
  const fields = [
    ["providerBindingId", expected.providerBindingId],
    ["providerCapabilityRevision", expected.providerCapabilityRevision],
    ["requestedVersion", expected.requestedVersion],
    ["appliedVersion", expected.requestedVersion],
    ["appliedCatalogVersion", expected.catalogVersion],
    ["appliedExposurePlanHash", expected.exposurePlanHash]
  ];
  for (const [field, value] of fields) {
    if (receipt?.[field] !== value) {
      const error = new Error(`Provider Tool receipt ${field} did not match the requested materialization.`);
      error.code = "PROVIDER_TOOL_RECEIPT_INVALID";
      error.statusCode = 502;
      error.field = field;
      throw error;
    }
  }
  const expectedDomains = JSON.stringify(expected.appliedDomains ?? []);
  if (JSON.stringify(receipt.appliedDomains ?? []) !== expectedDomains) {
    const error = new Error("Provider Tool receipt appliedDomains did not match the requested materialization.");
    error.code = "PROVIDER_TOOL_RECEIPT_INVALID";
    error.statusCode = 502;
    error.field = "appliedDomains";
    throw error;
  }
  return true;
}

function capabilityHash(descriptor, declared) {
  const stable = JSON.stringify({
    transport: descriptor.transport ?? null,
    protocolVersion: descriptor.protocolVersion ?? null,
    declared: Object.fromEntries(Object.entries(declared).sort(([a], [b]) => a.localeCompare(b)))
  });
  return `cap:${createHash("sha256").update(stable).digest("hex")}`;
}

function required(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`Tool Materialization receipt ${field} is required.`);
  return normalized;
}
