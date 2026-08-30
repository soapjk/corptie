import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PROJECT_CODE_SCHEMA_ARTIFACT = Object.freeze({
  artifactId: "artifact:aa6c9c01-7a1a-45bb-9a2d-51b3ffca1516",
  version: 1,
  contentHash: "03e5985fcd33abc95c4d805b3e023390db48b18391a4e49cfb20c758fe2703cc",
  relation: "implementation_spec"
});

export const PROJECT_CODE_RECEIPT_ARTIFACT = Object.freeze({
  artifactId: "artifact:619de450-ff1f-4506-b06e-24c015317422",
  version: 1,
  contentHash: "49deb38e337da1af7067dc458fb552cae2d33e20531124d3c7143060615b957e",
  relation: "implementation_spec"
});

export const STARTUP_BINDING_ARTIFACT = Object.freeze({
  artifactId: "artifact:7f26689a-5b9a-4b32-ad86-ad93c0be2949",
  version: 1,
  contentHash: "472b8c34180f2c1e7f7b59d7e2c8fc620ec515971a56e5f8ecae6fe69a0aced2"
});

export const RUN_RECEIPT_ARTIFACT = Object.freeze({
  artifactId: "artifact:ce3c7e2f-13a5-4c29-be40-368489fe87ef",
  version: 1,
  contentHash: "81b374c134fa74e0eb89673b2599eeb7d7d66f6ef7df0710289c6dc379b67184",
  relation: "implementation_spec",
  schemaVersion: 5
});

export const CLEANUP_RECEIPT_ARTIFACT = Object.freeze({
  ...RUN_RECEIPT_ARTIFACT,
  schemaVersion: 4
});

export const TOOLSET_VALIDATION_ARTIFACT = Object.freeze({
  artifactId: "artifact:f665b81c-aeae-496d-9157-a880588e7005",
  version: 1,
  contentHash: "b54ce2c5d36d2d5b31aa024b1c2ad40267fd1650b67a9545b6fc6062fac70df5",
  schemaVersion: 2
});

export const PROJECT_TOOLSET_ARTIFACT = Object.freeze({
  artifactId: "artifact:172b9f2e-a2d1-451c-a3e4-d52ba3d95850",
  version: 1,
  contentHash: "c203f2fd99d24064c46ab46e17f016a9494d643ab2b64e95c3f363fc8af00e62"
});

const schemaPath = new URL("../contracts/project-code-search-receipts.schema.json", import.meta.url);
const toolsetSchemaPath = new URL("../contracts/toolset-validation-receipt-v2.schema.json", import.meta.url);
const runReceiptSchemaPath = new URL("../contracts/run-receipt-v5.schema.json", import.meta.url);
const cleanupReceiptSchemaPath = new URL("../contracts/cleanup-receipt-v4.schema.json", import.meta.url);
let cachedSchema = null;
let cachedToolsetSchema = null;
const runIsolationSchemas = new Map();

const RUN_ISOLATION_SCHEMA_HASHES = Object.freeze({
  RunReceipt: "1f3f91c1f73352d90a98289e2d73112175f470f518fca5f6066ab8c4768012df",
  CleanupReceipt: "fac1c7b7f1906dcd80bc0bc8d01eef0da60a30fcaa2860b83a6c0f5d731b8adf"
});

export async function loadProjectCodeReceiptSchema() {
  if (cachedSchema) return cachedSchema;
  const bundled = await readFile(schemaPath);
  // apply_patch-backed source files carry one POSIX terminal newline. The
  // approved Artifact object intentionally has none; remove only that exact
  // transport byte before verifying and parsing the immutable Artifact body.
  const bytes = bundled.at(-1) === 0x0a ? bundled.subarray(0, bundled.length - 1) : bundled;
  const hash = sha256Hex(bytes);
  if (hash !== PROJECT_CODE_SCHEMA_ARTIFACT.contentHash) {
    throw contractError("SNAPSHOT_CONTRACT_MISMATCH", "Bundled Snapshot/Search schema does not match its fixed Artifact hash.");
  }
  const schema = JSON.parse(bytes.toString("utf8"));
  assertClosedObjectSchemas(schema);
  cachedSchema = Object.freeze(schema);
  return cachedSchema;
}

export function assertClosedObjectSchemas(schema) {
  if (schema?.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    throw contractError("SNAPSHOT_CONTRACT_MISMATCH", "Snapshot/Search contract must use JSON Schema Draft 2020-12.");
  }
  const open = [];
  visitSchema(schema, "#", (node, location) => {
    if (node?.type === "object" && node.additionalProperties !== false) open.push(location);
  });
  if (open.length > 0) {
    throw contractError("SNAPSHOT_CONTRACT_MISMATCH", `Snapshot/Search schema contains open objects: ${open.join(", ")}`);
  }
}

export async function validateProjectCodeReceipt(receipt, definition) {
  const schema = await loadProjectCodeReceiptSchema();
  const root = schema?.$defs?.[definition];
  if (!root) throw contractError("SNAPSHOT_CONTRACT_MISMATCH", `Unknown receipt definition: ${definition}`);
  const errors = [];
  validateSchemaNode(receipt, root, schema, "$", errors);
  validateReceiptInvariants(receipt, definition, errors);
  if (errors.length > 0) {
    const code = definition === "SearchReceipt" ? "RECEIPT_REFERENCE_MISMATCH" : "SNAPSHOT_CONTRACT_MISMATCH";
    const error = contractError(code, `Invalid ${definition}: ${errors.slice(0, 8).join("; ")}`);
    error.validationErrors = errors;
    throw error;
  }
  return receipt;
}

export function snapshotArtifactRef() {
  return Object.freeze({
    ...PROJECT_CODE_RECEIPT_ARTIFACT,
    receiptType: "RepositorySourceSnapshotReceipt",
    schemaVersion: 1
  });
}

export function searchArtifactRef() {
  return Object.freeze({
    ...PROJECT_CODE_RECEIPT_ARTIFACT,
    receiptType: "SearchReceipt",
    schemaVersion: 1
  });
}

export async function validateToolsetValidationReceipt(receipt) {
  const schema = await loadToolsetValidationReceiptSchema();
  const errors = [];
  validateSchemaNode(receipt, schema, schema, "$", errors);
  try { verifyReceiptHash(receipt, "TOOLSET_RECEIPT_HASH_MISMATCH"); } catch (error) { errors.push(error.message); }
  const artifactRef = receipt?.artifactRef;
  if (artifactRef?.artifactId !== PROJECT_TOOLSET_ARTIFACT.artifactId
    || artifactRef?.version !== PROJECT_TOOLSET_ARTIFACT.version
    || artifactRef?.contentHash !== PROJECT_TOOLSET_ARTIFACT.contentHash) {
    errors.push("$.artifactRef must point to the approved Project Toolset Artifact");
  }
  if (errors.length > 0) {
    const error = contractError("TOOLSET_VALIDATION_RECEIPT_INVALID", `Invalid ToolsetValidationReceipt: ${errors.slice(0, 8).join("; ")}`);
    error.validationErrors = errors;
    throw error;
  }
  return receipt;
}

export async function validateRunIsolationReceiptSchema(receipt, receiptType) {
  const schema = await loadRunIsolationReceiptSchema(receiptType);
  const errors = [];
  validateSchemaNode(receipt, schema, schema, "$", errors);
  if (errors.length > 0) {
    const error = contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", `Invalid ${receiptType}: ${errors.slice(0, 8).join("; ")}`);
    error.validationErrors = errors;
    throw error;
  }
  return receipt;
}

export async function loadRunIsolationReceiptSchema(receiptType) {
  if (!Object.hasOwn(RUN_ISOLATION_SCHEMA_HASHES, receiptType)) {
    throw contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", `Unknown RunIsolation receipt type: ${receiptType}`);
  }
  if (runIsolationSchemas.has(receiptType)) return runIsolationSchemas.get(receiptType);
  const path = receiptType === "RunReceipt" ? runReceiptSchemaPath : cleanupReceiptSchemaPath;
  const bytes = await readFile(path);
  if (sha256Hex(bytes) !== RUN_ISOLATION_SCHEMA_HASHES[receiptType]) {
    throw contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", `${receiptType} schema bytes do not match the approved RunIsolation Artifact section.`);
  }
  const schema = JSON.parse(bytes.toString("utf8"));
  assertClosedObjectSchemas(schema);
  runIsolationSchemas.set(receiptType, Object.freeze(schema));
  return runIsolationSchemas.get(receiptType);
}

export function projectToolsetReceiptRef(receipt, sourceFingerprint) {
  if (receipt?.snapshotRef?.sourceFingerprint !== sourceFingerprint) {
    throw contractError("RUN_SOURCE_FINGERPRINT_MISMATCH", "Toolset and Repository Snapshot source fingerprints differ.");
  }
  return Object.freeze({
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    schemaVersion: receipt.schemaVersion,
    resourceVersion: receipt.resourceVersion,
    artifactRef: receipt.artifactRef,
    toolsetVersion: receipt.toolsetVersion,
    validationPlanIdentity: receipt.validationPlanIdentity,
    sourceFingerprint
  });
}

export function toolsetValidationReceiptRef(receipt) {
  return Object.freeze({
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    schemaVersion: receipt.schemaVersion,
    resourceVersion: receipt.resourceVersion,
    artifactRef: Object.freeze({
      artifactId: TOOLSET_VALIDATION_ARTIFACT.artifactId,
      version: TOOLSET_VALIDATION_ARTIFACT.version,
      contentHash: TOOLSET_VALIDATION_ARTIFACT.contentHash,
      relation: "implementation_spec",
      receiptType: "ToolsetValidationReceipt",
      schemaVersion: TOOLSET_VALIDATION_ARTIFACT.schemaVersion
    })
  });
}

async function loadToolsetValidationReceiptSchema() {
  if (cachedToolsetSchema) return cachedToolsetSchema;
  const bytes = await readFile(toolsetSchemaPath);
  if (sha256Hex(bytes) !== TOOLSET_VALIDATION_ARTIFACT.contentHash) {
    throw contractError("TOOLSET_DEPENDENCY_CONTRACT_MISMATCH", "Bundled Toolset receipt schema does not match its approved fixed Artifact hash.");
  }
  const schema = JSON.parse(bytes.toString("utf8"));
  assertClosedObjectSchemas(schema);
  cachedToolsetSchema = Object.freeze(schema);
  return cachedToolsetSchema;
}

export function startupBindingRef(receipt) {
  return Object.freeze({
    artifactId: STARTUP_BINDING_ARTIFACT.artifactId,
    artifactVersion: STARTUP_BINDING_ARTIFACT.version,
    artifactContentHash: STARTUP_BINDING_ARTIFACT.contentHash,
    startupOperationId: receipt.startupOperationId,
    startupReceiptHash: receipt.receiptHash
  });
}

export function runStartupBindingReceiptRef(receipt) {
  return Object.freeze({
    startupOperationId: receipt.startupOperationId,
    receiptHash: receipt.receiptHash,
    schemaVersion: receipt.schemaVersion,
    resourceVersion: receipt.resourceVersion,
    artifactRef: Object.freeze({
      ...STARTUP_BINDING_ARTIFACT,
      relation: "implementation_spec",
      receiptType: "StartupBindingReceipt",
      schemaVersion: 2
    })
  });
}

export function snapshotReceiptRef(receipt) {
  return Object.freeze({
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    sourceFingerprint: receipt.sourceFingerprint,
    schemaVersion: receipt.schemaVersion,
    resourceVersion: receipt.resourceVersion,
    artifactRef: receipt.artifactRef
  });
}

export function signReceipt(fields) {
  const unsigned = { ...fields };
  delete unsigned.receiptHash;
  return Object.freeze({ ...unsigned, receiptHash: hashCanonical(unsigned) });
}

export function createReceiptId(prefix) {
  return `${prefix}:${randomUUID()}`;
}

export function hashCanonical(value) {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

// RFC 8785 uses ECMAScript JSON primitive serialization and lexicographic key ordering.
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function verifyReceiptHash(receipt, code = "SNAPSHOT_RECEIPT_HASH_MISMATCH") {
  if (!receipt || typeof receipt !== "object" || typeof receipt.receiptHash !== "string") {
    throw contractError(code, "Receipt hash is missing.");
  }
  const unsigned = { ...receipt };
  delete unsigned.receiptHash;
  if (hashCanonical(unsigned) !== receipt.receiptHash) throw contractError(code, "Receipt hash does not match canonical receipt content.");
  return receipt;
}

export function contractError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validateReceiptInvariants(receipt, definition, errors) {
  if (definition === "RepositorySourceSnapshotReceipt" || definition === "SearchReceipt") {
    try {
      verifyReceiptHash(receipt, definition === "SearchReceipt" ? "RECEIPT_REFERENCE_MISMATCH" : "SNAPSHOT_RECEIPT_HASH_MISMATCH");
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (definition !== "SearchReceipt") return;
  if (receipt.sourceFingerprint !== receipt.snapshotReceiptRef?.sourceFingerprint) {
    errors.push("$.sourceFingerprint must equal $.snapshotReceiptRef.sourceFingerprint");
  }
  const refs = [receipt.runIsolationReceiptRef, receipt.runId, receipt.cleanupReceiptRef];
  if (refs.every((value) => value === null)) return;
  if (refs.some((value) => value === null)) {
    errors.push("run isolation refs and runId must be all null or all non-null");
    return;
  }
  if (receipt.runIsolationReceiptRef.runId !== receipt.runId || receipt.cleanupReceiptRef.runId !== receipt.runId) {
    errors.push("runId must match RunReceiptRef and CleanupReceiptRef");
  }
}

function validateSchemaNode(value, node, root, path, errors) {
  if (!node || typeof node !== "object") return;
  if (node.$ref) return validateSchemaNode(value, resolveRef(root, node.$ref), root, path, errors);
  if (node.const !== undefined && !deepEqual(value, node.const)) errors.push(`${path} must equal the fixed value`);
  if (node.enum && !node.enum.some((entry) => deepEqual(value, entry))) errors.push(`${path} is not an allowed value`);
  if (node.anyOf) {
    if (!node.anyOf.some((candidate) => validates(value, candidate, root))) errors.push(`${path} does not match any allowed schema`);
  }
  if (node.oneOf) {
    if (node.oneOf.filter((candidate) => validates(value, candidate, root)).length !== 1) errors.push(`${path} must match exactly one schema`);
  }
  if (node.allOf) for (const candidate of node.allOf) validateSchemaNode(value, candidate, root, path, errors);
  if (node.if) validateSchemaNode(value, validates(value, node.if, root) ? node.then : node.else, root, path, errors);
  if (node.type) validateType(value, node, root, path, errors);
  else if ((node.properties || node.required || node.additionalProperties !== undefined)
    && value !== null && typeof value === "object" && !Array.isArray(value)) {
    validateObject(value, node, root, path, errors);
  }
}

function validateType(value, node, root, path, errors) {
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if ((node.type === "integer" && !Number.isInteger(value)) || (node.type !== "integer" && actual !== node.type)) {
    errors.push(`${path} must be ${node.type}`);
    return;
  }
  if (node.type === "object") {
    validateObject(value, node, root, path, errors);
  } else if (node.type === "array") {
    if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${path} has too few items`);
    if (node.maxItems !== undefined && value.length > node.maxItems) errors.push(`${path} has too many items`);
    if (node.uniqueItems && new Set(value.map(canonicalJson)).size !== value.length) errors.push(`${path} must contain unique items`);
    if (node.items) value.forEach((entry, index) => validateSchemaNode(entry, node.items, root, `${path}[${index}]`, errors));
  } else if (node.type === "string") {
    if (node.minLength !== undefined && [...value].length < node.minLength) errors.push(`${path} is too short`);
    if (node.maxLength !== undefined && [...value].length > node.maxLength) errors.push(`${path} is too long`);
    if (node.pattern && !(new RegExp(node.pattern)).test(value)) errors.push(`${path} does not match ${node.pattern}`);
    if (node.format === "date-time" && !Number.isFinite(Date.parse(value))) errors.push(`${path} must be an ISO date-time`);
  } else if (node.type === "number" || node.type === "integer") {
    if (node.minimum !== undefined && value < node.minimum) errors.push(`${path} is below minimum`);
    if (node.maximum !== undefined && value > node.maximum) errors.push(`${path} is above maximum`);
  }
}

function validateObject(value, node, root, path, errors) {
  const properties = node.properties ?? {};
  for (const field of node.required ?? []) if (!Object.hasOwn(value, field)) errors.push(`${path}.${field} is required`);
  if (node.additionalProperties === false) {
    for (const field of Object.keys(value)) if (!Object.hasOwn(properties, field)) errors.push(`${path}.${field} is unknown`);
  }
  for (const [field, child] of Object.entries(properties)) {
    if (Object.hasOwn(value, field)) validateSchemaNode(value[field], child, root, `${path}.${field}`, errors);
  }
}

function validates(value, node, root) {
  const errors = [];
  validateSchemaNode(value, node, root, "$", errors);
  return errors.length === 0;
}

function resolveRef(root, reference) {
  if (!reference.startsWith("#/")) throw contractError("SNAPSHOT_CONTRACT_MISMATCH", `External JSON Schema ref is forbidden: ${reference}`);
  return reference.slice(2).split("/").reduce((value, field) => value?.[field.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

function visitSchema(node, path, visit) {
  if (!node || typeof node !== "object") return;
  visit(node, path);
  if (Array.isArray(node)) return node.forEach((child, index) => visitSchema(child, `${path}/${index}`, visit));
  for (const [field, child] of Object.entries(node)) visitSchema(child, `${path}/${field}`, visit);
}

function deepEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}
