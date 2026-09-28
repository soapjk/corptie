import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export function createProjectToolsetAuthority({
  getRunIsolationCoordinator,
  getProjectToolsetProduction,
  startupReceipts,
  authorityResolver,
  requireSessionReference,
  store
}) {
  function authenticatedSession(sessionId) {
    const reference = requireSessionReference(sessionId);
    const logical = reference.logicalSessionId
      ? store.getLogicalSession(reference.logicalSessionId)
      : store.getLogicalSessionByLegacySessionId(reference.sessionId);
    if (!logical?.logicalSessionId) throw Object.assign(new Error("Project Toolset requires an authenticated logical Session."), { code: "TOOLSET_PERMISSION_DENIED", statusCode: 403 });
    const ownership = store.assertLogicalWorkSessionBinding(logical.logicalSessionId);
    if (!ownership?.taskId) throw Object.assign(new Error("Project Toolset requires a Task-bound Session."), { code: "TOOLSET_PERMISSION_DENIED", statusCode: 403 });
    return Object.freeze({ logicalSessionId: logical.logicalSessionId, taskId: ownership.taskId });
  }

  async function runIsolationOptions(sessionId, cwd, action) {
    if (!getRunIsolationCoordinator()) throw Object.assign(new Error("RunIsolation production execution is disabled."), { code: "DEPENDENCY_CONTRACT_UNRESOLVED", statusCode: 409 });
    const production = getProjectToolsetProduction();
    if (!production) throw Object.assign(new Error("Project Toolset production composition is unavailable."), { code: "DEPENDENCY_CONTRACT_UNRESOLVED", statusCode: 409 });
    const authenticated = authenticatedSession(sessionId);
    const runtime = await production.runtimeAuthority(authenticated.logicalSessionId);
    const startup = startupReceipts.require(authenticated.logicalSessionId);
    if (resolve(cwd) !== resolve(startup.canonicalWorktreePath)) throw Object.assign(new Error("Toolset action Worktree differs from authoritative Startup."), { code: "RUN_UNAUTHORIZED", statusCode: 403 });
    const authority = await authorityResolver.resolve({
      logicalSessionId: runtime.logicalSessionId,
      taskId: runtime.taskId,
      repositoryId: runtime.repositoryId,
      worktreeId: runtime.worktreeId,
      action,
      bindingId: runtime.bindingId,
      bindingGeneration: runtime.bindingGeneration
    });
    return {
      prepare: { mode: "development", sourceAware: true, toolsetRequired: true, startupBindingReceiptRef: authority.startupBindingReceiptRef, repositorySourceSnapshotReceiptRef: authority.repositorySourceSnapshotReceiptRef, toolsetValidationReceiptPointer: authority.toolsetValidationReceiptPointer, idempotencyKey: `toolset:${action}:${runtime.logicalSessionId}:${randomUUID()}` },
      session: { logicalSessionId: runtime.logicalSessionId, taskId: runtime.taskId, repositoryId: runtime.repositoryId, worktreeId: runtime.worktreeId },
      sourceIdentity: runtimeSourceIdentity(runtime.snapshot)
    };
  }

  return Object.freeze({ authenticatedSession, runIsolationOptions });
}

export function runtimeSourceIdentity(snapshot) {
  if (!snapshot?.sourceCommitOid || !snapshot?.sourceFingerprint) throw Object.assign(new Error("Authoritative Snapshot source identity is unavailable."), { code: "SOURCE_SNAPSHOT_REQUIRED", statusCode: 409 });
  return Object.freeze({
    revision: snapshot.sourceCommitOid,
    fingerprint: snapshot.sourceFingerprint,
    dirty: Number(snapshot.dirtyOverlayRef?.entryCount ?? 0) > 0,
    worktreePath: null
  });
}

export function disabledProjectToolsetInitializer() {
  const unavailable = () => { throw Object.assign(new Error("Project Toolset production composition is disabled."), { code: "DEPENDENCY_CONTRACT_UNRESOLVED", statusCode: 409 }); };
  return Object.freeze({ schedule: unavailable, cancel: unavailable, recoverAll: async () => [], status: async () => ({ state: "failed", outcome: "unknown", operationId: null, error: "DEPENDENCY_CONTRACT_UNRESOLVED" }) });
}
