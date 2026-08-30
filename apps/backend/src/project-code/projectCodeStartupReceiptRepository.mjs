import { contractError, verifyReceiptHash } from "./projectCodeContracts.mjs";

// Read-only adapter over the Startup subsystem's authoritative v2 receipts.
// Search never signs, repairs, or duplicates Startup lifecycle state.
export class ProjectCodeStartupReceiptRepository {
  constructor(options = {}) {
    if (!options.store) throw new TypeError("ProjectCodeStartupReceiptRepository requires Store.");
    this.store = options.store;
  }

  require(logicalSessionId) {
    const receipt = this.get(logicalSessionId);
    if (!receipt) {
      throw contractError("STARTUP_BINDING_NOT_READY", "The active Work Session has no authoritative ready StartupBindingReceipt.", 409);
    }
    return receipt;
  }

  get(logicalSessionId) {
    let row;
    try {
      row = this.store.selectOne(
        `SELECT r.receipt_json
         FROM work_session_startup_receipts r
         JOIN work_session_startup_bindings b
           ON b.startup_operation_id=r.startup_operation_id
          AND b.provider_binding_id=r.provider_binding_id
         WHERE b.logical_session_id=? AND b.status='ready'
         ORDER BY b.binding_generation DESC LIMIT 1`,
        [logicalSessionId]
      );
    } catch (error) {
      if (/no such table/i.test(error?.message ?? "")) return null;
      throw error;
    }
    if (!row) return null;
    const receipt = JSON.parse(row.receipt_json);
    if (receipt.logicalSessionId !== logicalSessionId || receipt.status !== "ready" || receipt.schemaVersion !== 2) {
      throw contractError("STARTUP_BINDING_IDENTITY_MISMATCH", "Stored Startup receipt does not match its authoritative ready binding.");
    }
    verifyReceiptHash(receipt, "STARTUP_RECEIPT_HASH_MISMATCH");
    return receipt;
  }

  getByReference(reference) {
    if (!reference?.startupOperationId || !reference?.startupReceiptHash) return null;
    let row;
    try {
      row = this.store.selectOne(
        "SELECT receipt_json FROM work_session_startup_receipts WHERE startup_operation_id=? AND receipt_hash=? LIMIT 1",
        [reference.startupOperationId, reference.startupReceiptHash]
      );
    } catch (error) {
      if (/no such table/i.test(error?.message ?? "")) return null;
      throw error;
    }
    if (!row) return null;
    const receipt = JSON.parse(row.receipt_json);
    verifyReceiptHash(receipt, "STARTUP_RECEIPT_HASH_MISMATCH");
    return receipt;
  }
}
