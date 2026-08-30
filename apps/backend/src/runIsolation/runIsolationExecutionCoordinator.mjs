import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { RunIsolationService } from "./runIsolationService.mjs";

// Provider-neutral production boundary. Callers provide authoritative receipts and
// a server-owned descriptor; they never choose a runId, path, port, PID, or fence.
export class RunIsolationExecutionCoordinator {
  constructor({ service, dataRoot, serviceOptions = {} } = {}) {
    this.descriptors = new Map();
    this.toolsetResolverScope = new AsyncLocalStorage();
    const commandResolver = async (reference) => {
      const descriptor = this.descriptors.get(reference);
      if (!descriptor) throw Object.assign(new Error("Run command descriptor is absent or expired."), { code: "RUN_CONTEXT_REQUIRED" });
      return descriptor;
    };
    const toolsetReceiptResolver = async (receiptId) => this.toolsetResolverScope.getStore()?.(receiptId) ?? null;
    this.service = service ?? new RunIsolationService({ dataRoot, ...serviceOptions, commandResolver, toolsetReceiptResolver });
    if (service && !service.commandResolver) service.commandResolver = commandResolver;
    if (service && !service.toolsetReceiptResolver) service.toolsetReceiptResolver = toolsetReceiptResolver;
  }

  async initialize() { await this.service.initialize(); return this; }
  async close() { await this.service.close(); }

  // Stable production Port shared by Toolset and Search consumers. RunIsolation
  // remains the only component that creates run ids, descriptors and fences.
  async prepareRun(prepare, session, { toolsetReceiptResolver } = {}) {
    return this.#withToolsetResolver(prepare?.toolsetValidationReceiptPointer, toolsetReceiptResolver, () => this.service.prepareRun(prepare, session));
  }

  async execute({ runContext, descriptor, idempotencyKey, toolsetReceiptResolver }, session) {
    if (!runContext?.runId || !descriptor?.executable || !descriptor?.cwd) throw new TypeError("RunContext and a server-owned executable descriptor are required.");
    const descriptorRef = `run_command:${randomUUID()}`;
    this.descriptors.set(descriptorRef, Object.freeze({ ...descriptor }));
    try {
      return await this.#withToolsetResolver(runContext.toolsetValidationReceiptPointer, toolsetReceiptResolver, () => this.service.execute({
        runId: runContext.runId,
        expectedResourceVersion: runContext.resourceVersion,
        fencingToken: runContext.fencingToken,
        commandDescriptorRef: descriptorRef,
        idempotencyKey
      }, session));
    } finally {
      this.descriptors.delete(descriptorRef);
    }
  }

  async cancel(request, session) { return this.service.cancel(request, session); }
  async cleanup(request, session) { return this.service.cleanup(request, session); }

  async runCommand({ prepare, descriptor, session, toolsetReceiptResolver }) {
    if (!descriptor?.executable || !descriptor?.cwd) throw new TypeError("A server-owned executable and cwd are required.");
    const prepared = await this.prepareRun(prepare, session, { toolsetReceiptResolver });
    const runReceipt = await this.execute({ runContext: prepared.context, descriptor, idempotencyKey: `${prepare.idempotencyKey}:execute`, toolsetReceiptResolver }, session);
    const commandOutput = descriptor.captureOutput === true ? this.service.takeCommandOutput(prepared.context.runId) : null;
    const run = this.service.inspect(prepared.context.runId, session);
    const cleanupReceipt = this.service.store.latestCleanupReceipt?.(prepared.context.runId)
      ?? this.service.store.latestCleanup?.(prepared.context.runId)?.receipt
      ?? null;
    return Object.freeze({ runContext: prepared.context, runReceipt, cleanupReceipt, finalState: run.state, commandOutput });
  }

  async #withToolsetResolver(pointer, resolver, operation) {
    if (!pointer || typeof resolver !== "function") return operation();
    return this.toolsetResolverScope.run(resolver, operation);
  }
}
