import { contractError, validateProjectCodeReceipt } from "./projectCodeContracts.mjs";

export class ProjectCodeSnapshotApplicationService {
  constructor(options = {}) {
    for (const field of ["store", "startupReceipts", "snapshotBuilder"]) {
      if (!options[field]) throw new TypeError(`ProjectCodeSnapshotApplicationService requires ${field}.`);
      this[field] = options[field];
    }
  }

  async createSnapshot(input = {}) {
    const context = this.#context(input.logicalSessionId);
    const snapshot = await this.snapshotBuilder.build({
      startupReceipt: context.startupReceipt,
      binding: context.binding,
      sessionContext: context.sessionContext,
      sourceDeclarations: [],
      signal: input.signal
    });
    await validateProjectCodeReceipt(snapshot.receipt, "RepositorySourceSnapshotReceipt");
    this.store.putProjectCodeReceipt({
      receiptId: snapshot.receipt.receiptId,
      receiptType: "RepositorySourceSnapshotReceipt",
      logicalSessionId: context.sessionContext.logicalSessionId,
      objectiveId: context.sessionContext.objectiveId,
      workItemId: context.sessionContext.workItemId,
      repositoryId: snapshot.receipt.repositoryId,
      worktreeId: snapshot.receipt.worktreeId,
      sourceFingerprint: snapshot.receipt.sourceFingerprint,
      receiptHash: snapshot.receipt.receiptHash,
      receipt: snapshot.receipt,
      createdAt: snapshot.receipt.createdAt
    });
    return Object.freeze({ receipt: snapshot.receipt, rejectedPaths: Object.freeze(snapshot.rejectedPaths) });
  }

  #context(logicalSessionId) {
    const id = requiredText(logicalSessionId, "logicalSessionId");
    const ownership = this.store.assertLogicalWorkSessionBinding(id);
    const logical = this.store.getLogicalSession(id);
    const session = ownership.sessionId ? this.store.getSession(ownership.sessionId) : null;
    const workItem = this.store.getWorkItem(ownership.workItemId);
    const startupReceipt = this.startupReceipts.require(id);
    if (!logical?.activeBinding || !session || !workItem
      || startupReceipt.providerBindingId !== logical.activeBinding.bindingId
      || startupReceipt.worktreeId !== logical.activeBinding.worktreeId
      || startupReceipt.canonicalWorktreePath !== logical.activeBinding.boundCwd
      || startupReceipt.objectiveId !== ownership.objectiveId
      || startupReceipt.workItemId !== ownership.workItemId) {
      throw contractError("STARTUP_BINDING_STALE", "Snapshot request does not match the active authoritative Worker Session route.");
    }
    return {
      startupReceipt,
      sessionContext: { objectiveId: ownership.objectiveId, workItemId: ownership.workItemId, logicalSessionId: id },
      binding: {
        repositoryId: startupReceipt.repositoryId,
        worktreeId: startupReceipt.worktreeId,
        canonicalWorktreePath: startupReceipt.canonicalWorktreePath,
        providerBindingId: logical.activeBinding.bindingId,
        bindingGeneration: startupReceipt.bindingGeneration,
        repositoryInventoryVersion: startupReceipt.repositoryInventoryVersion,
        workspaceResourceVersion: startupReceipt.workspaceResourceVersion,
        resourceVersion: startupReceipt.resourceVersion
      }
    };
  }
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw contractError("STARTUP_BINDING_MISMATCH", `${field} is required.`, 400);
  return text;
}
