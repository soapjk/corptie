import { validateDependencyGate } from "./dependencyContractManifest.mjs";
import { contractError } from "./receiptContracts.mjs";

const REQUEST_FIELDS = Object.freeze([
  "logicalSessionId", "taskId", "repositoryId", "worktreeId", "action",
  "bindingId", "bindingGeneration"
]);
const AUTHORITY_FIELDS = Object.freeze([
  "logicalSessionId", "taskId", "repositoryId", "worktreeId",
  "bindingId", "bindingGeneration", "startupBindingReceiptRef",
  "repositorySourceSnapshotReceiptRef", "toolsetValidationReceiptPointer"
]);
const ISOLATED_ACTIONS = new Set(["build", "start", "restart", "stop", "verify"]);

// Provider-neutral composition seam. Startup, Snapshot and Toolset owners inject
// their authoritative lookup here; RunIsolation never mirrors those receipts or
// creates a second projection under its dataRoot.
export class RunIsolationAuthorityResolver {
  constructor({ resolveAuthority = null } = {}) {
    this.resolveAuthority = resolveAuthority;
  }

  async resolve(request) {
    assertClosedObject(request, REQUEST_FIELDS, "RUN_AUTHORITY_SCHEMA_INVALID", "RunIsolation authority request");
    for (const field of ["logicalSessionId", "taskId", "repositoryId", "worktreeId", "bindingId"]) {
      if (typeof request[field] !== "string" || request[field].length === 0) {
        throw contractError("RUN_AUTHORITY_SCHEMA_INVALID", `${field} is required by the authenticated authority request.`);
      }
    }
    if (!ISOLATED_ACTIONS.has(request.action) || !Number.isSafeInteger(request.bindingGeneration) || request.bindingGeneration < 1) {
      throw contractError("RUN_AUTHORITY_SCHEMA_INVALID", "Action and positive bindingGeneration are required by the authority request.");
    }
    if (typeof this.resolveAuthority !== "function") {
      throw contractError("DEPENDENCY_CONTRACT_UNRESOLVED", "No authoritative Startup/Snapshot/Toolset resolver is composed.");
    }

    const authority = await this.resolveAuthority(Object.freeze({ ...request }));
    if (authority == null) {
      throw contractError("DEPENDENCY_CONTRACT_UNRESOLVED", "Authoritative Startup/Snapshot/Toolset receipt references are unavailable.");
    }
    assertClosedObject(authority, AUTHORITY_FIELDS, "RUN_AUTHORITY_SCHEMA_INVALID", "RunIsolation authority result");
    for (const field of ["logicalSessionId", "taskId", "repositoryId", "worktreeId"]) {
      if (authority[field] !== request[field]) throw contractError("RUN_UNAUTHORIZED", `${field} differs from the authenticated Session and active Worktree.`);
    }
    if (authority.bindingId !== request.bindingId || authority.bindingGeneration !== request.bindingGeneration) {
      throw contractError("STARTUP_BINDING_STALE", "RunIsolation authority was issued for a stale Session binding generation.");
    }
    assertClosedObject(authority.startupBindingReceiptRef, ["startupOperationId", "receiptHash", "schemaVersion", "resourceVersion", "artifactRef"], "RUN_AUTHORITY_SCHEMA_INVALID", "StartupBindingReceiptRef");
    assertClosedObject(authority.repositorySourceSnapshotReceiptRef, ["receiptId", "receiptHash", "sourceFingerprint", "schemaVersion", "resourceVersion", "artifactRef"], "RUN_AUTHORITY_SCHEMA_INVALID", "RepositorySourceSnapshotReceiptRef");
    validateDependencyGate({
      sourceAware: true,
      toolsetRequired: true,
      startupBindingReceiptRef: authority.startupBindingReceiptRef,
      repositorySourceSnapshotReceiptRef: authority.repositorySourceSnapshotReceiptRef,
      toolsetValidationReceiptPointer: authority.toolsetValidationReceiptPointer
    });
    return Object.freeze({
      startupBindingReceiptRef: authority.startupBindingReceiptRef,
      repositorySourceSnapshotReceiptRef: authority.repositorySourceSnapshotReceiptRef,
      toolsetValidationReceiptPointer: authority.toolsetValidationReceiptPointer
    });
  }
}

function assertClosedObject(value, fields, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) {
    throw contractError(code, `${label} must use its exact closed field set.`);
  }
}
