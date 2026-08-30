export class ProviderNeutralCodeTaskExecutionService {
  constructor({ sessionService, store, observabilityService, pollIntervalMs = 25,
    timeoutMs = 30_000, delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
    if (!sessionService?.sendMessage || !sessionService?.interrupt) {
      throw new TypeError("ProviderNeutralCodeTaskExecutionService requires a Session application service.");
    }
    if (!store?.getLogicalSession) throw new TypeError("ProviderNeutralCodeTaskExecutionService requires a Store.");
    if (!observabilityService?.executionReceiptForTurn) {
      throw new TypeError("ProviderNeutralCodeTaskExecutionService requires an Observability query service.");
    }
    this.sessionService = sessionService;
    this.store = store;
    this.observability = observabilityService;
    this.pollIntervalMs = pollIntervalMs;
    this.timeoutMs = timeoutMs;
    this.delay = delay;
  }

  async execute({ logicalSessionId, prompt, attemptId }) {
    const logical = this.store.getLogicalSession(logicalSessionId);
    if (!logical?.legacySessionId || !logical.activeBinding) fail("CODE_TASK_SESSION_UNAVAILABLE", "The bound Session is unavailable.", 503);
    const result = await this.sessionService.sendMessage(logicalSessionId, prompt, {
      source: { type: "benchmark", attemptId },
      purpose: "benchmark-code-task"
    });
    const turnId = text(result?.turn?.id ?? result?.turnId);
    if (!turnId) fail("CODE_TASK_EXECUTION_RECEIPT_MISSING", "The Provider-neutral Session entry returned no turn identity.", 503);
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      const receipt = this.observability.executionReceiptForTurn(logicalSessionId, turnId, localContext());
      if (receipt?.status === "completed") return Object.freeze(receipt);
      if (receipt && ["failed", "cancelled"].includes(receipt.status)) {
        fail("CODE_TASK_EXECUTION_FAILED", "The Provider-neutral code task did not complete successfully.");
      }
      await this.delay(this.pollIntervalMs);
    }
    fail("CODE_TASK_EXECUTION_TIMEOUT", "Timed out waiting for authoritative Provider execution evidence.", 504);
  }

  query({ logicalSessionId, receiptRef }) {
    if (!receiptRef?.turnExecutionId || !receiptRef?.turnId) {
      fail("CODE_TASK_EXECUTION_RECEIPT_MISSING", "Attempt lacks an authoritative execution receipt reference.", 503);
    }
    const receipt = this.observability.executionReceipt(receiptRef.turnExecutionId, localContext());
    if (!receipt || receipt.logicalSessionId !== logicalSessionId || receipt.turnId !== receiptRef.turnId
      || receipt.receiptId !== receiptRef.receiptId || receipt.status !== "completed") {
      fail("CODE_TASK_EXECUTION_RECEIPT_MISMATCH", "Stored execution receipt reference is stale or mismatched.");
    }
    return Object.freeze(receipt);
  }

  async cancel({ logicalSessionId }) {
    const logical = this.store.getLogicalSession(logicalSessionId);
    if (!logical?.legacySessionId) return Object.freeze({ accepted: false });
    await this.sessionService.interrupt(logicalSessionId, { source: { type: "benchmark" } });
    return Object.freeze({ accepted: true });
  }
}

function localContext() { return { kind: "local_user", canReadRawObservability: true }; }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function fail(code, message, statusCode = 409) {
  const error = new Error(message); error.code = code; error.safeMessage = message; error.statusCode = statusCode; throw error;
}
