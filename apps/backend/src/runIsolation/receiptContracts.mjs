import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const RUN_RECEIPT_CONTRACT = Object.freeze({
  artifactId: "artifact:42cd149b-e230-4347-b4ff-b816c18cf25f",
  version: 1,
  contentHash: "b64fab56fdce275b29a99dd63f1ecd84a95419d3e0c8a4e752ebdf91e5321951",
  approvalStatus: "approved",
  schemaVersion: 6
});

export const CLEANUP_RECEIPT_CONTRACT = Object.freeze({
  ...RUN_RECEIPT_CONTRACT,
  schemaVersion: 4
});

const resourceDirectory = new URL("../../resources/run-isolation/", import.meta.url);
export const runReceiptSchema = loadSchema("RunReceipt.schema.json");
export const cleanupReceiptSchema = loadSchema("CleanupReceipt.schema.json");
export const toolsetValidationReceiptSchema = loadSchema("ToolsetValidationReceipt.schema.json");
export const searchSnapshotReceiptSchema = loadSchema("SearchSnapshotReceipt.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(searchSnapshotReceiptSchema);
export const validateRunReceiptSchema = ajv.compile(runReceiptSchema);
export const validateCleanupReceiptSchema = ajv.compile(cleanupReceiptSchema);
export const validateToolsetValidationReceiptSchema = ajv.compile(toolsetValidationReceiptSchema);
export const validateRepositorySourceSnapshotReceiptSchema = ajv.compile({
  $ref: `${searchSnapshotReceiptSchema.$id}#/$defs/RepositorySourceSnapshotReceipt`
});

export const SAFETY_CHECKS = Object.freeze([
  "canonicalRoot", "runMarker", "identity", "leaseOwner", "fence", "noSymlink",
  "noHardlinkEscape", "noMountCrossing", "noActiveProcess", "noActivePort",
  "noActiveDataLease", "noActiveCredentialLease", "serverHandleClosed", "targetBoundary"
]);

export const SAFETY_ERROR_CODES = Object.freeze({
  canonicalRoot: "RUN_CLEANUP_CANONICAL_ROOT_INVALID",
  runMarker: "RUN_CLEANUP_MARKER_INVALID",
  identity: "RUN_CLEANUP_IDENTITY_MISMATCH",
  leaseOwner: "RUN_CLEANUP_LEASE_OWNER_MISMATCH",
  fence: "RUN_STALE_FENCE",
  noSymlink: "RUN_SYMLINK_FORBIDDEN",
  noHardlinkEscape: "RUN_HARDLINK_ESCAPE",
  noMountCrossing: "RUN_MOUNT_CROSSING",
  noActiveProcess: "RUN_ACTIVE_PROCESS",
  noActivePort: "RUN_ACTIVE_PORT",
  noActiveDataLease: "RUN_ACTIVE_DATA_LEASE",
  noActiveCredentialLease: "RUN_ACTIVE_CREDENTIAL_LEASE",
  serverHandleClosed: "RUN_SERVER_HANDLE_OPEN",
  targetBoundary: "RUN_CLEANUP_TARGET_FORBIDDEN"
});

export function canonicalizeJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw contractError("RECEIPT_CANONICALIZATION_FAILED", "Receipt contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(",")}}`;
  }
  throw contractError("RECEIPT_CANONICALIZATION_FAILED", `Unsupported JSON value: ${typeof value}.`);
}

export function receiptHash(receipt) {
  const copy = structuredClone(receipt);
  delete copy.receiptHash;
  return createHash("sha256").update(canonicalizeJson(copy), "utf8").digest("hex");
}

export function signReceipt(receipt, kind) {
  const signed = { ...receipt, receiptHash: "0".repeat(64) };
  validateReceipt(signed, kind, { verifyHash: false });
  signed.receiptHash = receiptHash(signed);
  validateReceipt(signed, kind);
  return Object.freeze(signed);
}

export function validateReceipt(receipt, kind, { verifyHash = true } = {}) {
  const validate = kind === "run" ? validateRunReceiptSchema : kind === "cleanup" ? validateCleanupReceiptSchema : null;
  if (!validate) throw new TypeError(`Unknown receipt kind: ${kind}`);
  if (!validate(receipt)) {
    const version = kind === "run" ? 6 : 4;
    throw contractError("RECEIPT_SCHEMA_INVALID", `Receipt does not match schemaVersion ${version}.`, { errors: validate.errors });
  }
  if (kind === "run") validateRunSemantics(receipt);
  else validateCleanupSemantics(receipt);
  if (verifyHash && receiptHash(receipt) !== receipt.receiptHash) {
    throw contractError("RECEIPT_HASH_MISMATCH", "Receipt RFC8785 SHA-256 does not match receiptHash.");
  }
  return receipt;
}

export function validateToolsetValidationReceipt(receipt, { verifyHash = true } = {}) {
  if (!validateToolsetValidationReceiptSchema(receipt)) {
    throw contractError("RUN_TOOLSET_SCHEMA_INVALID", "ToolsetValidationReceipt does not match the approved ed9 schemaVersion 3 contract.", { errors: validateToolsetValidationReceiptSchema.errors });
  }
  if (verifyHash && receiptHash(receipt) !== receipt.receiptHash) throw contractError("RUN_TOOLSET_RECEIPT_HASH_MISMATCH", "ToolsetValidationReceipt RFC8785 hash is invalid.");
  return receipt;
}

export function validateRepositorySourceSnapshotReceipt(receipt, { verifyHash = true } = {}) {
  if (!validateRepositorySourceSnapshotReceiptSchema(receipt)) {
    throw contractError("SOURCE_SNAPSHOT_SCHEMA_INVALID", "RepositorySourceSnapshotReceipt does not match the approved ee9 schemaVersion 1 contract.", { errors: validateRepositorySourceSnapshotReceiptSchema.errors });
  }
  if (verifyHash && receiptHash(receipt) !== receipt.receiptHash) {
    throw contractError("SOURCE_SNAPSHOT_HASH_MISMATCH", "RepositorySourceSnapshotReceipt RFC8785 hash is invalid.");
  }
  return receipt;
}

export function validateRunSemantics(receipt) {
  const terminal = ["completed", "failed", "cancelled"];
  const timeValues = [receipt.readyAt, receipt.startedAt, receipt.stoppedAt, receipt.completedAt].filter(Boolean).map(Date.parse);
  if (timeValues.some((value) => !Number.isFinite(value)) || timeValues.some((value, index) => index > 0 && value < timeValues[index - 1])) {
    throw contractError("RECEIPT_TIME_INVALID", "RunReceipt timestamps are not monotonic.");
  }
  if (terminal.includes(receipt.state) && receipt.completedAt === null) {
    throw contractError("RECEIPT_STATE_INVALID", "Terminal RunReceipt requires completedAt.");
  }
  const repositoryValues = [receipt.repositoryId, receipt.worktreeId, receipt.sourceFingerprint,
    receipt.startupBindingReceiptRef, receipt.repositorySourceSnapshotReceiptRef];
  if (!repositoryValues.every((value) => value === null) && !repositoryValues.every((value) => value !== null)) {
    throw contractError("RECEIPT_IDENTITY_INVALID", "Repository identity fields must be all null or all present.");
  }
  if (receipt.toolsetValidationReceiptPointer && receipt.toolsetValidationReceiptPointer.sourceFingerprint !== receipt.sourceFingerprint) {
    throw contractError("SOURCE_FINGERPRINT_MISMATCH", "Toolset sourceFingerprint differs from the verified Snapshot fingerprint.");
  }
}

export function validateCleanupSemantics(receipt) {
  if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) {
    throw contractError("RECEIPT_TIME_INVALID", "CleanupReceipt finishedAt precedes startedAt.");
  }
  const checks = Object.entries(receipt.safetyChecks);
  for (const [name, check] of checks) {
    if (check.status === "passed" && (check.errorCode !== null || check.evidenceHash === null)) {
      throw contractError("RECEIPT_SAFETY_INVALID", `${name} passed without canonical evidence.`);
    }
    if (["failed", "indeterminate"].includes(check.status)
      && (check.errorCode !== SAFETY_ERROR_CODES[name] || check.evidenceHash === null)) {
      throw contractError("RECEIPT_SAFETY_INVALID", `${name} failure is missing its fixed code or evidence.`);
    }
    if (check.status === "not_applicable" && receipt.outcome !== "retained") {
      throw contractError("RECEIPT_SAFETY_INVALID", `${name} is not_applicable outside retained cleanup.`);
    }
  }
  const reconciliationUnsafe = ["indeterminate", "foreign", "pidReused"].includes(receipt.processReconciliation);
  if (receipt.outcome === "cleaned") {
    if (checks.some(([, check]) => check.status !== "passed") || reconciliationUnsafe) {
      throw contractError("RUN_CLEANUP_BLOCKED", "Unsafe cleanup cannot report cleaned.");
    }
  } else if (["blocked", "quarantined", "unknown"].includes(receipt.outcome)) {
    if (!reconciliationUnsafe && checks.every(([, check]) => check.status === "passed")) {
      throw contractError("RECEIPT_SAFETY_INVALID", `${receipt.outcome} requires failed or indeterminate evidence.`);
    }
  }
  if (receipt.outcome === "retained" && Date.parse(receipt.retainUntil) <= Date.parse(receipt.finishedAt)) {
    throw contractError("RECEIPT_RETENTION_INVALID", "retainUntil must be later than finishedAt.");
  }
}

export function evidenceHash(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

export function contractError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = code.includes("QUOTA") ? 507 : 409;
  error.details = details;
  return error;
}

function loadSchema(name) {
  const path = fileURLToPath(new URL(name, resourceDirectory));
  const schema = JSON.parse(readFileSync(path, "utf8"));
  if (!ajvValidateSchema(schema)) throw new Error(`Invalid JSON Schema 2020-12 resource: ${name}`);
  return Object.freeze(schema);
}

function ajvValidateSchema(schema) {
  const validator = new Ajv2020({ strict: false });
  return validator.validateSchema(schema);
}
