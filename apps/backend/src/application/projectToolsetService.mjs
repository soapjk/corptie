import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { contractError } from "../runtime/projectToolsetCanonical.mjs";
import {
  STARTUP_CONTRACT, toolsetValidationReceiptPointer, validateSnapshotRef,
  validateStartupBindingReceipt, validateStartupBindingRef
} from "../runtime/projectToolsetContracts.mjs";

export class ProjectToolsetService {
  constructor(options = {}) {
    this.orchestrator = required(options.orchestrator, "orchestrator");
    this.authorities = required(options.authorityResolver, "authorityResolver");
    this.declarations = required(options.declarationStore, "declarationStore");
    this.operations = required(options.operationStore, "operationStore");
  }

  async initialize(workingDirectory, options = {}) {
    const context = await this.authorities.resolveProjectContext({ workingDirectory, authenticatedSession: options.authenticatedSession });
    const stored = await this.declarations.read(workingDirectory);
    const projectFacts = await detectSafeProjectFacts(workingDirectory);
    const declaration = options.declaration ?? stored.declaration ?? null;
    const idempotencyKey = options.idempotencyKey ?? `project-toolset:${context.repositoryId}:${context.worktreeId}:${options.force === true ? "update" : "initialize"}`;
    return this.orchestrator.run({
      ...context,
      projectRoot: workingDirectory,
      projectFacts,
      declaration,
      idempotencyKey,
      capabilityClass: context.capabilityClass ?? "full_required",
      expiresAt: context.expiresAt ?? null
    });
  }

  async cancel(operationId) { return this.orchestrator.cancel(operationId); }

  async recoverAll() {
    const recovered = [];
    for (const operation of await this.operations.listRecoverable()) recovered.push(await this.orchestrator.recover(operation.id));
    return recovered;
  }
}

// This is the Toolset-owned adapter seam for RunIsolationAuthorityResolver.
// It performs read-only joins across authoritative owners; it never persists a
// second authority view and never accepts repository/worktree identity claims.
export class ProjectToolsetAuthorityResolver {
  constructor(options = {}) {
    this.sessions = required(options.sessionAuthorityPort, "sessionAuthorityPort");
    this.startupReceipts = required(options.startupBindingReceiptStore, "startupBindingReceiptStore");
    this.snapshots = required(options.repositorySourceSnapshotStore, "repositorySourceSnapshotStore");
    this.toolsetReceipts = required(options.toolsetValidationReceiptStore, "toolsetValidationReceiptStore");
  }

  async resolveProjectContext({ workingDirectory, authenticatedSession }) {
    const authority = await this.#authority(authenticatedSession, workingDirectory);
    const startupReceipt = await this.startupReceipts.getCurrent(authority);
    const startupBindingRef = validateStartupBindingRef({ artifactId: STARTUP_CONTRACT.artifactId, artifactVersion: 1, artifactContentHash: STARTUP_CONTRACT.contentHash, startupOperationId: startupReceipt?.startupOperationId, startupReceiptHash: startupReceipt?.receiptHash });
    validateStartupBindingReceipt(startupReceipt, authority, startupBindingRef);
    const snapshotReceipt = await this.snapshots.getCurrent(authority);
    assertAuthorityIdentity(snapshotReceipt, authority, "SNAPSHOT_STALE");
    const repositorySourceSnapshotReceiptRef = validateSnapshotRef(snapshotReference(snapshotReceipt));
    if (!snapshotReceipt.startupBindingRef || snapshotReceipt.startupBindingRef.startupReceiptHash !== startupBindingRef.startupReceiptHash
      || snapshotReceipt.startupBindingRef.startupOperationId !== startupBindingRef.startupOperationId) fail("SNAPSHOT_STALE", "Snapshot is not bound to the current Startup receipt.");
    return Object.freeze({
      ...authority,
      startupBindingRef,
      startupBindingReceiptRef: runIsolationStartupReference(startupReceipt),
      repositorySourceSnapshotReceiptRef
    });
  }

  async resolveRunIsolationAuthorities({ workingDirectory, authenticatedSession, toolsetReceiptId = null }) {
    const context = await this.resolveProjectContext({ workingDirectory, authenticatedSession });
    let pointer = null;
    if (toolsetReceiptId !== null) {
      const receipt = await this.toolsetReceipts.getReceipt(toolsetReceiptId);
      if (!receipt) fail("RECEIPT_INVALID", "Toolset receipt does not exist in the authoritative Store.");
      pointer = toolsetValidationReceiptPointer(receipt, context);
      if (pointer.sourceFingerprint !== context.repositorySourceSnapshotReceiptRef.sourceFingerprint) fail("SOURCE_FINGERPRINT_MISMATCH", "Toolset receipt is bound to another Snapshot.");
    }
    return Object.freeze({ startupBindingReceiptRef: context.startupBindingReceiptRef, repositorySourceSnapshotReceiptRef: context.repositorySourceSnapshotReceiptRef, toolsetValidationReceiptPointer: pointer });
  }

  async #authority(authenticatedSession, workingDirectory) {
    if (!authenticatedSession || typeof authenticatedSession.logicalSessionId !== "string" || typeof authenticatedSession.workItemId !== "string") fail("TOOLSET_PERMISSION_DENIED", "An authenticated Session is required.");
    const authority = await this.sessions.resolve({ authenticatedSession, workingDirectory });
    for (const key of ["logicalSessionId", "objectiveId", "workItemId", "repositoryId", "worktreeId"]) if (typeof authority?.[key] !== "string" || !authority[key]) fail("TOOLSET_PERMISSION_DENIED", "Session authority is incomplete.");
    if (authority.logicalSessionId !== authenticatedSession.logicalSessionId || authority.workItemId !== authenticatedSession.workItemId) fail("TOOLSET_PERMISSION_DENIED", "Session authority changed while resolving Toolset context.");
    return Object.freeze({ logicalSessionId: authority.logicalSessionId, objectiveId: authority.objectiveId, workItemId: authority.workItemId, repositoryId: authority.repositoryId, worktreeId: authority.worktreeId });
  }
}

export class ProjectToolsetBackgroundAgentPort {
  constructor(options = {}) { this.service = required(options.service, "BackgroundAgentService"); }
  async generate(input) {
    const result = await this.service.run({
      purpose: "project-toolset-generation",
      cwd: input.readOnlyRoots[0],
      allowedRoots: input.readOnlyRoots,
      permissionProfile: "read-only",
      developerInstructions: [
        "Return one JSON object only; do not use Markdown.",
        "Do not install dependencies, access the network, execute project scripts, write files, use connectors, collaboration, subagents, or skills.",
        "The JSON object is closed: {schemaVersion:1,adapter:string,configuration:object}."
      ].join(" "),
      prompt: `Create a declarative Project Toolset candidate for this already-approved declaration:\n${JSON.stringify(input.declaration)}`
    });
    let candidate;
    try { candidate = JSON.parse(result.text); }
    catch { throw contractError("TOOLSET_DECLARATION_INVALID", "Background Agent returned a non-JSON Toolset candidate."); }
    return { candidate, operationId: result.operationId, providerId: result.providerId, historyPolicy: result.historyPolicy };
  }
}

async function detectSafeProjectFacts(root) {
  const [packageJson, packageSwift] = await Promise.all([existsJson(join(root, "package.json")), existsText(join(root, "Package.swift"))]);
  const declaredActions = packageSwift ? [
    { id: "swift-build", kind: "build", argv: ["swift", "build"], relativeCwd: ".", required: true, timeoutMs: 600_000 },
    { id: "swift-test", kind: "test", argv: ["swift", "test"], relativeCwd: ".", required: true, timeoutMs: 600_000 }
  ] : [];
  const assertions = declaredActions.map((action) => ({ id: `${action.id}-exit`, actionId: action.id, assertionType: "exit_code", required: true }));
  return { packageJson, packageSwift, declaredActions, assertions };
}
async function existsJson(path) { try { JSON.parse(await readFile(path, "utf8")); return true; } catch { return false; } }
async function existsText(path) { try { await readFile(path, "utf8"); return true; } catch { return false; } }
function required(value, name) { if (!value) throw new TypeError(`ProjectToolsetService requires ${name}.`); return value; }
function snapshotReference(receipt) { return { receiptId: receipt?.receiptId, receiptHash: receipt?.receiptHash, sourceFingerprint: receipt?.sourceFingerprint, schemaVersion: receipt?.schemaVersion, resourceVersion: receipt?.resourceVersion, artifactRef: receipt?.artifactRef }; }
function runIsolationStartupReference(receipt) { if (!Number.isInteger(receipt?.resourceVersion) || receipt.resourceVersion < 1) fail("STARTUP_BINDING_INVALID", "Startup resourceVersion is invalid."); return Object.freeze({ startupOperationId: receipt.startupOperationId, receiptHash: receipt.receiptHash, schemaVersion: 2, resourceVersion: receipt.resourceVersion, artifactRef: { artifactId: STARTUP_CONTRACT.artifactId, version: 1, contentHash: STARTUP_CONTRACT.contentHash, relation: "implementation_spec", receiptType: "StartupBindingReceipt", schemaVersion: 2 } }); }
function assertAuthorityIdentity(value, authority, code) { for (const key of ["logicalSessionId", "objectiveId", "workItemId", "repositoryId", "worktreeId"]) if (value?.[key] !== authority[key]) fail(code, `${key} does not match authenticated authority.`); }
function fail(code, message) { throw contractError(code, message); }
