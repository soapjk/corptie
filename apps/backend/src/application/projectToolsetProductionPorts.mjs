import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { canonicalJson, contractError } from "../runtime/projectToolsetCanonical.mjs";

export class ProjectToolsetCommandDescriptorPort {
  constructor() { this.values = new Map(); }

  async register({ action, validationPlanIdentity, projectRoot }) {
    const cwd = resolve(projectRoot, action.relativeCwd);
    const root = resolve(projectRoot);
    if (cwd !== root && !cwd.startsWith(`${root}${sep}`)) throw contractError("TOOLSET_DECLARATION_INVALID", "Command descriptor cwd escaped the project root.");
    const descriptorId = `project_toolset_command:${randomUUID()}`;
    this.values.set(descriptorId, Object.freeze({
      executable: action.argv[0], args: Object.freeze(action.argv.slice(1)), cwd,
      role: `project-toolset-${action.kind}`, timeoutMilliseconds: action.timeoutMs,
      captureOutput: false, validationPlanIdentity
    }));
    return Object.freeze({ descriptorId, schemaVersion: 1 });
  }

  take(reference) {
    const value = this.values.get(reference?.descriptorId);
    if (!value || reference?.schemaVersion !== 1) throw contractError("TOOLSET_RUN_PREPARE_FAILED", "Command descriptor is absent or expired.");
    this.values.delete(reference.descriptorId);
    return value;
  }
}

export class ProjectToolsetValidationPlanPort {
  constructor({ store = null } = {}) { this.store = store; this.values = new Map(); }

  async register({ plan, validationPlanIdentity, identity }) {
    const value = Object.freeze({ plan: structuredClone(plan), identity: structuredClone(identity) });
    const existing = this.store?.getValidationPlan
      ? await this.store.getValidationPlan(validationPlanIdentity)
      : this.values.get(validationPlanIdentity);
    if (existing && canonicalJson(existing) !== canonicalJson(value)) throw contractError("TOOLSET_CAS_CONFLICT", "ValidationPlan identity was reused with different content.");
    if (!existing && this.store?.putValidationPlan) await this.store.putValidationPlan(validationPlanIdentity, value);
    else if (!this.store) this.values.set(validationPlanIdentity, value);
    return Object.freeze({ testPlanId: `project_toolset_plan:${validationPlanIdentity.slice(4)}`, schemaVersion: 1 });
  }
}

// Bridges the Toolset action-level Port to the accepted production coordinator.
// The coordinator owns run ids, credentials, descriptors, fences and cleanup;
// this adapter stores only opaque contexts and immutable receipt lookups.
export class ProjectToolsetRunIsolationPort {
  constructor({ coordinator, commandDescriptors }) {
    if (!coordinator || !commandDescriptors) throw new TypeError("ProjectToolsetRunIsolationPort requires coordinator and commandDescriptors.");
    this.coordinator = coordinator; this.commandDescriptors = commandDescriptors;
    this.contexts = new Map();
  }

  async prepareRun(request, session) {
    const prepared = await this.coordinator.prepareRun({
      mode: "test", sourceAware: true, toolsetRequired: false,
      startupBindingReceiptRef: request.startupBindingReceiptRef,
      repositorySourceSnapshotReceiptRef: request.repositorySourceSnapshotReceiptRef,
      toolsetValidationReceiptPointer: request.toolsetValidationReceiptPointer,
      idempotencyKey: request.idempotencyKey, testPlanRef: request.testPlanRef,
      fixtureRef: request.fixtureRef, quotaClass: request.quotaClass
    }, authoritativeRunSession(session));
    this.contexts.set(prepared.context.runId, prepared.context);
    return prepared;
  }

  async execute(request, session) {
    const context = this.#context(request);
    const descriptor = this.commandDescriptors.take(request.commandDescriptorRef);
    return this.coordinator.execute({ runContext: context, descriptor, idempotencyKey: request.idempotencyKey }, authoritativeRunSession(session));
  }

  async cancel(request, session) {
    const context = this.contexts.get(request.runId);
    if (!context) throw contractError("TOOLSET_OUTCOME_UNKNOWN", "Prepared Run context is unavailable for cancellation.");
    return this.coordinator.cancel({
      runId: request.runId, expectedResourceVersion: request.expectedResourceVersion,
      fencingToken: request.fencingToken, idempotencyKey: request.idempotencyKey
    }, authoritativeRunSession(session));
  }

  async cleanup(request, session) {
    const existing = this.coordinator.service.store.latestCleanupReceipt?.(request.runId)
      ?? this.coordinator.service.store.latestCleanup?.(request.runId)?.receipt ?? null;
    if (existing) { this.contexts.delete(request.runId); return existing; }
    try { return await this.coordinator.cleanup(request, authoritativeRunSession(session)); }
    finally { this.contexts.delete(request.runId); }
  }

  async getRunReceipt(reference) {
    const receipt = this.coordinator.service.store.latestRunReceipt(reference.runId) ?? null;
    return receipt?.receiptHash === reference.receiptHash ? receipt : null;
  }

  async getCleanupReceipt(reference) {
    const receipt = this.coordinator.service.store.latestCleanupReceipt?.(reference.runId)
      ?? this.coordinator.service.store.latestCleanup?.(reference.runId)?.receipt ?? null;
    return receipt?.receiptHash === reference.receiptHash ? receipt : null;
  }

  #context(request) {
    const context = this.contexts.get(request.runId);
    if (!context || context.resourceVersion !== request.preparedResourceVersion || context.fencingToken !== request.fencingToken) {
      throw contractError("TOOLSET_RUN_PREPARE_FAILED", "Prepared Run version or fence mismatches.");
    }
    return context;
  }
}

export class ProjectToolsetAuthorizationPort {
  constructor({ resolveAuthority }) { this.resolveAuthority = resolveAuthority; }
  async assertProjectToolsetAccess(input) {
    if (typeof this.resolveAuthority !== "function") throw contractError("TOOLSET_PERMISSION_DENIED", "Toolset authority resolver is unavailable.");
    const authority = await this.resolveAuthority(input.logicalSessionId);
    for (const field of ["logicalSessionId", "objectiveId", "taskId", "repositoryId", "worktreeId"]) {
      if (authority?.[field] !== input[field]) throw contractError("TOOLSET_PERMISSION_DENIED", `${field} differs from authenticated Toolset authority.`);
    }
    if (authority?.capabilityClass !== input.capabilityClass) throw contractError("TOOLSET_PERMISSION_DENIED", "Toolset capability differs from authenticated authority.");
    return Object.freeze({ ...authority });
  }
}

function authoritativeRunSession(session) {
  if (!session?.logicalSessionId || !session?.taskId || !session?.repositoryId || !session?.worktreeId) throw contractError("TOOLSET_PERMISSION_DENIED", "Run Isolation requires an authenticated repository Work Session.");
  return Object.freeze({ logicalSessionId: session.logicalSessionId, taskId: session.taskId, repositoryId: session.repositoryId, worktreeId: session.worktreeId });
}
