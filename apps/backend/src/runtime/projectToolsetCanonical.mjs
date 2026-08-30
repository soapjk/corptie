import { createHash } from "node:crypto";

const DOMAINS = Object.freeze({
  toolsetVersion: "corptie.project-toolset.toolset-version.v1\0",
  validationPlan: "corptie.project-toolset.validation-plan.v1\0",
  validationCache: "corptie.project-toolset.validation-cache.v1\0"
});

export function canonicalJson(value) {
  return serialize(value, new Set());
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function dependencyManifestIdentity(manifest) {
  requireClosedObject(manifest, ["schemaVersion", "entries"], "DependencyContractManifest");
  if (manifest.schemaVersion !== 4 || !Array.isArray(manifest.entries)) {
    throw contractError("TOOLSET_DEPENDENCY_CONTRACT_MISMATCH", "Dependency manifest schema is invalid.");
  }
  const entries = manifest.entries.map((entry, index) => {
    requireClosedObject(entry, ["dependency", "acceptanceState", "artifactId", "version", "contentHash", "contractSchemaVersions"], `DependencyContractManifest.entries[${index}]`);
    requireString(entry.dependency, "dependency");
    requireString(entry.acceptanceState, "acceptanceState");
    requireArtifactId(entry.artifactId, "artifactId");
    requirePositiveInteger(entry.version, "version");
    requireHash(entry.contentHash, "contentHash");
    if (!isPlainObject(entry.contractSchemaVersions) || Object.keys(entry.contractSchemaVersions).length < 1) {
      throw contractError("TOOLSET_DEPENDENCY_CONTRACT_MISMATCH", "contractSchemaVersions must be a non-empty closed integer map.");
    }
    const contractSchemaVersions = Object.fromEntries(Object.keys(entry.contractSchemaVersions).sort(asciiCompare).map((name) => {
      requireString(name, "contractSchemaVersions name"); requirePositiveInteger(entry.contractSchemaVersions[name], `contractSchemaVersions.${name}`); return [name, entry.contractSchemaVersions[name]];
    }));
    return { ...entry, contractSchemaVersions };
  }).sort((left, right) => asciiCompare(left.dependency, right.dependency));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].dependency === entries[index].dependency) {
      throw contractError("TOOLSET_DEPENDENCY_CONTRACT_MISMATCH", "Dependency names must be unique.");
    }
  }
  return sha256(canonicalJson({ schemaVersion: 4, entries }));
}

export function toolsetVersion(input) {
  requireClosedObject(input, ["schemaVersion", "declaration", "generatedConfigManifest", "generatorPolicyVersion", "dependencyManifestIdentity"], "toolsetVersion input");
  requireHash(input.dependencyManifestIdentity, "dependencyManifestIdentity");
  return `ptv1:${sha256(DOMAINS.toolsetVersion + canonicalJson(input))}`;
}

export function validationPlanIdentity(input) {
  requireClosedObject(input, ["schemaVersion", "toolsetVersion", "actions", "assertions", "requiredCapabilityClass", "validationPolicyVersion", "dependencyManifestIdentity"], "validationPlanIdentity input");
  requirePrefixedHash(input.toolsetVersion, "ptv1", "toolsetVersion");
  requireHash(input.dependencyManifestIdentity, "dependencyManifestIdentity");
  return `vp1:${sha256(DOMAINS.validationPlan + canonicalJson(input))}`;
}

export function validationCacheKey(input) {
  requireClosedObject(input, ["schemaVersion", "repositoryId", "worktreeId", "snapshotReceiptHash", "sourceFingerprint", "toolsetVersion", "validationPlanIdentity", "validationPolicyVersion"], "validationCacheKey input");
  requireHash(input.snapshotReceiptHash, "snapshotReceiptHash");
  requireHash(input.sourceFingerprint, "sourceFingerprint");
  requirePrefixedHash(input.toolsetVersion, "ptv1", "toolsetVersion");
  requirePrefixedHash(input.validationPlanIdentity, "vp1", "validationPlanIdentity");
  return `tvck1:${sha256(DOMAINS.validationCache + canonicalJson(input))}`;
}

export function validationReceiptHash(receipt) {
  if (!isPlainObject(receipt)) throw contractError("TOOLSET_RECEIPT_INVALID", "Receipt must be an object.");
  const { receiptHash: _removed, ...projection } = receipt;
  return sha256(canonicalJson(projection));
}

export function operationIdentity({ repositoryId, worktreeId, declarationHash, idempotencyKey }) {
  for (const [name, value] of Object.entries({ repositoryId, worktreeId, declarationHash, idempotencyKey })) requireString(value, name);
  return `toolset_operation:${sha256(canonicalJson({ repositoryId, worktreeId, declarationHash, idempotencyKey }))}`;
}

export function requireClosedObject(value, fields, name = "object") {
  if (!isPlainObject(value)) throw contractError("TOOLSET_RECEIPT_INVALID", `${name} must be a plain object.`);
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = fields.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    throw contractError("TOOLSET_RECEIPT_INVALID", `${name} has unknown or missing fields.`);
  }
}

export function requireHash(value, name) {
  if (!/^[0-9a-f]{64}$/.test(String(value ?? ""))) throw contractError("TOOLSET_RECEIPT_INVALID", `${name} must be a lowercase SHA-256 hash.`);
}

export function requirePrefixedHash(value, prefix, name) {
  if (!new RegExp(`^${prefix}:[0-9a-f]{64}$`).test(String(value ?? ""))) throw contractError("TOOLSET_RECEIPT_INVALID", `${name} is invalid.`);
}

export function contractError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = options.retryable === true;
  error.details = options.details ?? null;
  return error;
}

function serialize(value, stack) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw contractError("TOOLSET_RECEIPT_INVALID", "Canonical JSON forbids non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    enter(value, stack);
    try { return `[${value.map((item) => serialize(item, stack)).join(",")}]`; }
    finally { stack.delete(value); }
  }
  if (isPlainObject(value)) {
    enter(value, stack);
    try {
      return `{${Object.keys(value).sort(utf16Compare).map((key) => `${JSON.stringify(key)}:${serialize(value[key], stack)}`).join(",")}}`;
    } finally { stack.delete(value); }
  }
  throw contractError("TOOLSET_RECEIPT_INVALID", "Canonical JSON accepts only JSON values.");
}

function enter(value, stack) {
  if (stack.has(value)) throw contractError("TOOLSET_RECEIPT_INVALID", "Canonical JSON forbids cycles.");
  stack.add(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function utf16Compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function asciiCompare(left, right) { return Buffer.from(left, "ascii").compare(Buffer.from(right, "ascii")); }
function requireString(value, name) { if (typeof value !== "string" || !value) throw contractError("TOOLSET_RECEIPT_INVALID", `${name} must be a non-empty string.`); }
function requirePositiveInteger(value, name) { if (!Number.isInteger(value) || value < 1) throw contractError("TOOLSET_RECEIPT_INVALID", `${name} must be a positive integer.`); }
function requireArtifactId(value, name) { if (!/^artifact:[0-9a-f-]+$/.test(String(value ?? ""))) throw contractError("TOOLSET_RECEIPT_INVALID", `${name} is invalid.`); }
