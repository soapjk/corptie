import { randomUUID } from "node:crypto";
import {
  canonicalJson, contractError, operationIdentity, sha256, toolsetVersion,
  validationCacheKey, validationPlanIdentity, validationReceiptHash
} from "./projectToolsetCanonical.mjs";
import {
  CAPABILITY_CLASSES, FIXED_DEPENDENCY_MANIFEST_IDENTITY, TOOLSET_RECEIPT_SCHEMA, resolvedRunReceiptRef,
  validateCleanupReceipt, validateRunReceipt, validateSnapshotRef, validateStartupBindingReceipt,
  validateStartupBindingReceiptRef, validateStartupBindingRef, validateToolsetReceipt
} from "./projectToolsetContracts.mjs";
import { validateDeclaration } from "./projectToolsetDeclarationStore.mjs";

const STATES = Object.freeze(["detect", "plan", "generate", "update", "validate", "ready", "failed"]);

export class ProjectToolsetOrchestrator {
  constructor(options) {
    this.declarations = requiredPort(options, "declarationStore");
    this.authorization = requiredPort(options, "authorizationPort");
    this.operations = requiredPort(options, "operationStore");
    this.receipts = requiredPort(options, "validationReceiptStore");
    this.cache = requiredPort(options, "validationCacheStore");
    this.snapshotPort = requiredPort(options, "repositorySourceSnapshotPort");
    this.startupReader = requiredPort(options, "startupBindingReceiptReader");
    this.runIsolation = requiredPort(options, "runIsolationPort");
    this.commandDescriptors = requiredPort(options, "commandDescriptorPort");
    this.validationPlans = requiredPort(options, "validationPlanPort");
    this.backgroundAgent = options.backgroundAgentPort ?? null;
    this.observability = options.observabilityPort ?? { emit() {} };
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    this.dependencyManifestIdentity = options.dependencyManifestIdentity ?? FIXED_DEPENDENCY_MANIFEST_IDENTITY;
    if (this.dependencyManifestIdentity !== FIXED_DEPENDENCY_MANIFEST_IDENTITY) throw contractError("TOOLSET_DEPENDENCY_CONTRACT_MISMATCH", "Dependency manifest identity is not the fixed approved revision.");
    this.generatorPolicyVersion = options.generatorPolicyVersion ?? "project-toolset-generator-v1";
    this.validationPolicyVersion = options.validationPolicyVersion ?? "project-toolset-validation-v1";
    this.retentionPolicyRef = options.retentionPolicyRef ?? "project-toolset-validation-ephemeral-v1";
    this.quotaClass = options.quotaClass ?? "toolset_validation_small";
    this.singleFlight = new Map();
    this.cancelled = new Set();
  }

  async run(input) {
    validateInput(input);
    const authority = await this.authorization.assertProjectToolsetAccess({
      logicalSessionId: input.logicalSessionId,
      objectiveId: input.objectiveId,
      workItemId: input.workItemId,
      repositoryId: input.repositoryId,
      worktreeId: input.worktreeId,
      capabilityClass: input.capabilityClass
    });
    for (const field of ["logicalSessionId", "objectiveId", "workItemId", "repositoryId", "worktreeId", "capabilityClass"]) {
      if (authority?.[field] !== input[field]) throw contractError("TOOLSET_PERMISSION_DENIED", "Session authority does not match the requested Toolset resources.");
    }
    const key = `${input.repositoryId}\0${input.worktreeId}`;
    const declarationHash = sha256(canonicalJson(input.declaration ?? null));
    const id = operationIdentity({ repositoryId: input.repositoryId, worktreeId: input.worktreeId, declarationHash, idempotencyKey: input.idempotencyKey });
    const keyed = await this.operations.findByIdempotency?.(input.repositoryId, input.worktreeId, input.idempotencyKey);
    if (keyed && keyed.requestHash !== requestHash(input)) throw contractError("TOOLSET_CAS_CONFLICT", "Idempotency key was reused with different input.");
    const existing = await this.operations.get(id);
    if (existing && existing.requestHash !== requestHash(input)) throw contractError("TOOLSET_CAS_CONFLICT", "Idempotency key was reused with different input.");
    if (existing?.state === "ready" || existing?.state === "failed") return existing.result;
    const active = this.singleFlight.get(key);
    if (active) {
      if (active.operationId !== id) throw contractError("TOOLSET_CAS_CONFLICT", "Another Project Toolset operation is already active for this Worktree.");
      return active.promise;
    }
    const task = this.#execute(id, input, existing).finally(() => this.singleFlight.delete(key));
    this.singleFlight.set(key, { operationId: id, promise: task });
    return task;
  }

  async cancel(operationId) {
    this.cancelled.add(operationId);
    const operation = await this.operations.get(operationId);
    if (!operation || ["ready", "failed"].includes(operation.state)) return operation;
    return this.operations.requestCancel(operationId);
  }

  async recover(operationId) {
    const operation = await this.operations.get(operationId);
    if (!operation || ["ready", "failed"].includes(operation.state)) return operation?.result ?? null;
    if (!operation.input) throw contractError("TOOLSET_OUTCOME_UNKNOWN", "Recovery has no fixed operation input.");
    return this.run({ ...operation.input, recovery: true });
  }

  async #execute(operationId, input, previous) {
    let operation = previous ?? await this.operations.create({ id: operationId, requestHash: requestHash(input), input, state: "detect", resourceVersion: 1, cancelRequested: false });
    try {
      await this.#checkCancelled(operationId);
      const detection = detectProject(input.projectFacts, input.declaration);
      this.#event(operation, "detect", { outcome: detection.outcome });
      if (detection.outcome !== "supported") return this.#finish(operation, detection.outcome, null, detection.errorCode);

      operation = await this.#transition(operation, "plan", { detection });
      const snapshotRef = validateSnapshotRef(input.repositorySourceSnapshotReceiptRef);
      const startupBindingRef = validateStartupBindingRef(input.startupBindingRef);
      const startupBindingReceiptRef = validateStartupBindingReceiptRef(input.startupBindingReceiptRef);
      if (startupBindingReceiptRef.startupOperationId !== startupBindingRef.startupOperationId || startupBindingReceiptRef.receiptHash !== startupBindingRef.startupReceiptHash) throw contractError("STARTUP_BINDING_INVALID", "Startup references do not identify the same receipt.");
      validateStartupBindingReceipt(await this.startupReader.get(startupBindingRef), authoritativeIdentity(input), startupBindingRef);
      const currentSnapshot = await this.snapshotPort.get(snapshotRef);
      if (currentSnapshot?.stale === true || !snapshotMatches(snapshotRef, currentSnapshot)) throw contractError("TOOLSET_SNAPSHOT_STALE", "Snapshot is stale.");
      const declaration = validateDeclaration(input.declaration ?? detection.declaration);
      const plan = createValidationPlan(declaration, input.capabilityClass, this.dependencyManifestIdentity, this.validationPolicyVersion);
      await this.#checkCancelled(operationId);

      const stored = await this.declarations.read(input.projectRoot);
      const phase = stored.declaration ? "update" : "generate";
      operation = await this.#transition(operation, phase, { snapshotRef, plan });
      let generatedConfigManifest = detection.generatedConfigManifest;
      if (!generatedConfigManifest && this.backgroundAgent) generatedConfigManifest = await this.#generateCandidate(input, declaration, snapshotRef, phase);
      generatedConfigManifest ??= { schemaVersion: 1, adapter: detection.adapter, configuration: {} };
      validateCandidate(generatedConfigManifest);
      const version = toolsetVersion({ schemaVersion: 1, declaration, generatedConfigManifest, generatorPolicyVersion: this.generatorPolicyVersion, dependencyManifestIdentity: this.dependencyManifestIdentity });
      const identity = validationPlanIdentity({ schemaVersion: 1, toolsetVersion: version, actions: plan.actions, assertions: plan.assertions, requiredCapabilityClass: plan.requiredCapabilityClass, validationPolicyVersion: this.validationPolicyVersion, dependencyManifestIdentity: this.dependencyManifestIdentity });
      const testPlanRef = await this.validationPlans.register({ plan, validationPlanIdentity: identity, identity: authoritativeIdentity(input) });
      const cacheKey = validationCacheKey({ schemaVersion: 1, repositoryId: input.repositoryId, worktreeId: input.worktreeId, snapshotReceiptHash: snapshotRef.receiptHash, sourceFingerprint: snapshotRef.sourceFingerprint, toolsetVersion: version, validationPlanIdentity: identity, validationPolicyVersion: this.validationPolicyVersion });
      await this.declarations.writeDeclaration(input.projectRoot, declaration);
      await this.declarations.stageGenerated(input.projectRoot, version, generatedConfigManifest);

      operation = await this.#transition(operation, "validate", { toolsetVersion: version, validationPlanIdentity: identity, validationCacheKey: cacheKey });
      const context = { logicalSessionId: input.logicalSessionId, objectiveId: input.objectiveId, workItemId: input.workItemId, repositoryId: input.repositoryId, worktreeId: input.worktreeId, snapshotRef, startupBindingReceiptRef: input.startupBindingReceiptRef, toolsetVersion: version, validationPlanIdentity: identity, validationPolicyVersion: this.validationPolicyVersion };
      const cached = await this.cache.get(cacheKey);
      if (cached && !cached.corrupt) {
        try {
          await validateToolsetReceipt(cached, context, this.#receiptPorts());
          const reused = { ...cached, cacheDisposition: "reused" };
          reused.receiptHash = validationReceiptHash(reused);
          return this.#activate(operation, input, reused);
        } catch { await this.cache.invalidate(cacheKey); }
      }

      const validation = await this.#validateActions({ input, operation, operationId, plan, testPlanRef, snapshotRef, version, planIdentity: identity, cacheKey });
      operation = validation.operation;
      const receipt = validation.receipt;
      await validateToolsetReceipt(receipt, context, this.#receiptPorts());
      if (receipt.outcome !== "passed") return this.#finish(operation, receipt.outcome, receipt, receipt.error?.code ?? "TOOLSET_RUN_FAILED");
      await this.receipts.put(receipt);
      await this.cache.put(cacheKey, receipt);
      return this.#activate(operation, input, receipt);
    } catch (error) {
      if (error?.fatalProcessCrash === true) throw error;
      const outcome = error.code === "TOOLSET_CANCELLED" ? "cancelled" : error.code === "TOOLSET_UNSUPPORTED" ? "unsupported" : error.code === "TOOLSET_NEEDS_CONFIGURATION" ? "needs_configuration" : "failed";
      return this.#finish(operation, outcome, null, error.code ?? "TOOLSET_OUTCOME_UNKNOWN");
    }
  }

  async #validateActions({ input, operation, operationId, plan, testPlanRef, snapshotRef, version, planIdentity, cacheKey }) {
    const startedAt = operation.validationStartedAt ?? this.now();
    const actionReceipts = structuredClone(operation.completedActionReceipts ?? []);
    const assertionReceipts = structuredClone(operation.completedAssertionReceipts ?? []);
    let currentOperation = operation;
    for (let ordinal = 0; ordinal < actionReceipts.length; ordinal += 1) {
      const checkpoint = actionReceipts[ordinal]; const planned = plan.actions[ordinal];
      if (!planned || checkpoint.id !== planned.id || checkpoint.ordinal !== ordinal || checkpoint.outcome !== "passed") throw contractError("TOOLSET_OUTCOME_UNKNOWN", "Crash checkpoint is not reusable.");
      const run = validateRunReceipt(await this.runIsolation.getRunReceipt(checkpoint.runReceiptRef), runContext(input, snapshotRef));
      validateCleanupReceipt(await this.runIsolation.getCleanupReceipt(checkpoint.cleanupReceiptRef), runContext(input, snapshotRef), run);
    }
    for (let ordinal = actionReceipts.length; ordinal < plan.actions.length; ordinal += 1) {
      const action = plan.actions[ordinal]; await this.#checkCancelled(operationId); const actionStartedAt = this.now();
      let prepared = null; let run = null; let runRef = null; let cleanupRef = null; let outcome = "unknown"; let evidenceHash = null; let error = null;
      try {
        const commandDescriptorRef = await this.commandDescriptors.register({ action, validationPlanIdentity: planIdentity, projectRoot: input.projectRoot });
        prepared = await this.runIsolation.prepareRun({
          startupBindingReceiptRef: input.startupBindingReceiptRef,
          repositorySourceSnapshotReceiptRef: snapshotRef,
          toolsetValidationReceiptPointer: null,
          testPlanRef,
          fixtureRef: null,
          baseSnapshotRef: null,
          retentionPolicyRef: this.retentionPolicyRef,
          quotaClass: this.quotaClass,
          idempotencyKey: `${input.idempotencyKey}:prepare:${action.id}`
        }, authenticatedSession(input));
        const preparedContext = validatePreparedRun(prepared);
        run = await this.runIsolation.execute({
          runId: preparedContext.runId,
          preparedResourceVersion: preparedContext.resourceVersion,
          fencingToken: preparedContext.fencingToken,
          commandDescriptorRef,
          toolsetValidationReceiptPointer: null,
          idempotencyKey: `${input.idempotencyKey}:execute:${action.id}`
        }, authenticatedSession(input));
        validateRunReceipt(run, runContext(input, snapshotRef), { requirePassed: false });
        runRef = resolvedRunReceiptRef(run, "Run"); outcome = run.outcome === "passed" ? "passed" : "failed"; evidenceHash = run.receiptHash;
        if (outcome !== "passed") error = businessError("TOOLSET_RUN_FAILED", action.id, "validate");
      } catch (cause) {
        outcome = cause.code === "TOOLSET_CANCELLED" ? "cancelled" : "failed"; error = businessError(cause.code ?? "TOOLSET_RUN_FAILED", action.id, "validate");
        if (!run && prepared?.context) {
          try {
            run = await this.runIsolation.cancel({
              runId: prepared.context.runId,
              expectedResourceVersion: prepared.context.resourceVersion,
              fencingToken: prepared.context.fencingToken,
              idempotencyKey: `${input.idempotencyKey}:cancel:${action.id}`
            }, authenticatedSession(input));
            validateRunReceipt(run, runContext(input, snapshotRef), { requirePassed: false });
            runRef = resolvedRunReceiptRef(run, "Run"); evidenceHash = run.receiptHash;
          } catch { outcome = "unknown"; error = businessError("TOOLSET_OUTCOME_UNKNOWN", action.id, "validate"); }
        }
      }
      finally {
        if (run) {
          try {
            const cleanup = await this.runIsolation.cleanup({
              runId: run.runId,
              policy: "success_default",
              expectedResourceVersion: run.resourceVersion,
              fencingToken: run.fencingToken,
              idempotencyKey: `${input.idempotencyKey}:cleanup:${action.id}`
            }, authenticatedSession(input));
            validateCleanupReceipt(cleanup, runContext(input, snapshotRef), run);
            cleanupRef = resolvedRunReceiptRef(cleanup, "Cleanup");
          }
          catch { outcome = "unknown"; error = businessError("TOOLSET_CLEANUP_UNKNOWN", action.id, "validate"); }
        }
      }
      await this.#checkCancelled(operationId);
      actionReceipts.push({ id: action.id, kind: action.kind, ordinal, executionDisposition: runRef ? "executed" : "not_started", outcome, runReceiptRef: runRef, cleanupReceiptRef: cleanupRef, startedAt: actionStartedAt, finishedAt: this.now(), evidenceHash, error });
      for (const assertion of plan.assertions.filter((item) => item.actionId === action.id)) assertionReceipts.push({ id: assertion.id, actionId: action.id, assertionType: assertion.assertionType, outcome, startedAt: actionStartedAt, finishedAt: this.now(), evidenceHash, error });
      currentOperation = await this.operations.compareAndSwap(currentOperation.id, currentOperation.resourceVersion, {
        resourceVersion: currentOperation.resourceVersion + 1,
        validationStartedAt: startedAt,
        completedActionReceipts: actionReceipts,
        completedAssertionReceipts: assertionReceipts
      });
      if (outcome !== "passed" && action.required) break;
    }
    const passed = actionReceipts.length === plan.actions.length && actionReceipts.every((item) => item.outcome === "passed") && assertionReceipts.every((item) => item.outcome === "passed");
    const receipt = {
      receiptId: `toolset_validation_receipt:${this.idFactory().replaceAll("-", "_")}`, receiptHash: "0".repeat(64), schemaVersion: 3, resourceVersion: 1,
      artifactRef: { artifactId: TOOLSET_RECEIPT_SCHEMA.artifactId, version: TOOLSET_RECEIPT_SCHEMA.version, contentHash: TOOLSET_RECEIPT_SCHEMA.contentHash, relation: "implementation_spec", receiptType: "ToolsetValidationReceipt", schemaVersion: 3 },
      identity: { logicalSessionId: input.logicalSessionId, objectiveId: input.objectiveId, workItemId: input.workItemId, repositoryId: input.repositoryId, worktreeId: input.worktreeId, startupBindingRef: input.startupBindingRef },
      snapshotRef, toolsetVersion: version, validationPlanIdentity: planIdentity, validationCacheKey: cacheKey, actionReceipts, assertionReceipts,
      cacheDisposition: passed ? "stored" : "rejected", outcome: passed ? "passed" : actionReceipts.at(-1)?.outcome ?? "unknown", startedAt, finishedAt: this.now(), expiresAt: input.expiresAt ?? null,
      error: passed ? null : actionReceipts.at(-1)?.error ?? businessError("TOOLSET_OUTCOME_UNKNOWN", null, "validate")
    };
    receipt.receiptHash = validationReceiptHash(receipt); return { receipt, operation: currentOperation };
  }

  async #generateCandidate(input, declaration, snapshotRef, phase) {
    if (!hasGeneration(input.capabilityClass)) throw contractError("TOOLSET_BACKGROUND_CAPABILITY_UNAVAILABLE", "Restricted generation is unavailable.");
    const result = await this.backgroundAgent.generate({ purpose: "restricted_project_toolset_generation", network: false, hiddenHistory: true, readOnlyRoots: [input.projectRoot], writableStagingRoot: `${input.projectRoot}/.corptie/project-toolset/generated`, connectors: false, collaboration: false, subagents: false, skills: false, toolExecution: false, declaration, snapshotRef, phase });
    return result.candidate;
  }

  async #activate(operation, input, receipt) {
    await this.declarations.activate(input.projectRoot, { schemaVersion: 1, toolsetVersion: receipt.toolsetVersion, validationPlanIdentity: receipt.validationPlanIdentity, receiptId: receipt.receiptId, receiptHash: receipt.receiptHash, resourceVersion: 1 });
    return this.#finish(operation, "passed", receipt, null, "ready");
  }
  async #finish(operation, outcome, receipt, errorCode, state = "failed") { const result = { operationId: operation.id, state, outcome, receipt, errorCode }; await this.#transition(operation, state, { result }); return result; }
  async #transition(operation, state, patch) { if (!STATES.includes(state)) throw contractError("TOOLSET_OUTCOME_UNKNOWN", "Unknown state."); const next = await this.operations.compareAndSwap(operation.id, operation.resourceVersion, { ...patch, state, resourceVersion: operation.resourceVersion + 1 }); this.#event(next, state, { errorCode: patch.errorCode ?? null }); return next; }
  async #checkCancelled(id) { if (this.cancelled.has(id) || (await this.operations.get(id))?.cancelRequested) throw contractError("TOOLSET_CANCELLED", "Project Toolset operation was cancelled."); }
  #event(operation, state, details) { this.observability.emit({ type: "project_toolset.state", operationId: operation.id, repositoryId: operation.input?.repositoryId, worktreeId: operation.input?.worktreeId, state, ...details }); }
  #receiptPorts() { return { startupBindingReceiptReader: this.startupReader, repositorySourceSnapshotPort: this.snapshotPort, runIsolationPort: this.runIsolation }; }
}

export class InMemoryToolsetOperationStore {
  constructor() { this.values = new Map(); }
  async get(id) { return clone(this.values.get(id) ?? null); }
  async findByIdempotency(repositoryId, worktreeId, idempotencyKey) { return clone([...this.values.values()].find((value) => value.input?.repositoryId === repositoryId && value.input?.worktreeId === worktreeId && value.input?.idempotencyKey === idempotencyKey) ?? null); }
  async create(value) { if (this.values.has(value.id)) throw contractError("TOOLSET_CAS_CONFLICT", "Operation exists."); this.values.set(value.id, clone(value)); return clone(value); }
  async compareAndSwap(id, version, patch) { const current = this.values.get(id); if (!current || current.resourceVersion !== version) throw contractError("TOOLSET_CAS_CONFLICT", "Operation changed concurrently."); const next = { ...current, ...clone(patch) }; this.values.set(id, next); return clone(next); }
  async requestCancel(id) { const current = this.values.get(id); if (!current) return null; current.cancelRequested = true; return clone(current); }
}

export function detectProject(facts, explicitDeclaration = null) {
  if (explicitDeclaration) return { outcome: "supported", declaration: explicitDeclaration, adapter: explicitDeclaration.projectType, generatedConfigManifest: null };
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return { outcome: "unsupported", errorCode: "TOOLSET_UNSUPPORTED" };
  const marker = [facts.packageJson === true && "node", facts.packageSwift === true && "swift"].filter(Boolean);
  if (marker.length === 0) return { outcome: "unsupported", errorCode: "TOOLSET_UNSUPPORTED" };
  if (!Array.isArray(facts.declaredActions) || facts.declaredActions.length === 0) return { outcome: "needs_configuration", errorCode: "TOOLSET_NEEDS_CONFIGURATION" };
  const projectType = marker.length > 1 ? "mixed" : marker[0];
  return { outcome: "supported", adapter: projectType, declaration: { schemaVersion: 1, projectType, actions: facts.declaredActions, assertions: facts.assertions ?? [], generatorPolicyVersion: "project-toolset-generator-v1", validationPolicyVersion: "project-toolset-validation-v1" }, generatedConfigManifest: { schemaVersion: 1, adapter: projectType, configuration: {} } };
}

export function createValidationPlan(declaration, capabilityClass, dependencyManifestIdentity, policy) {
  if (!CAPABILITY_CLASSES.includes(capabilityClass)) throw contractError("TOOLSET_BACKGROUND_CAPABILITY_UNAVAILABLE", "Capability class is unknown.");
  if (capabilityClass === "none" || capabilityClass === "restricted_project_toolset_generation") throw contractError("TOOLSET_RUN_PREPARE_FAILED", "Run Isolation capability is required.");
  return { schemaVersion: 1, actions: declaration.actions.map((action) => ({ ...action })), assertions: declaration.assertions.map((assertion) => ({ ...assertion })), requiredCapabilityClass: "run_isolation_only", validationPolicyVersion: policy, dependencyManifestIdentity };
}

function validateCandidate(candidate) { if (!candidate || Object.keys(candidate).some((key) => !["schemaVersion", "adapter", "configuration"].includes(key)) || candidate.schemaVersion !== 1 || typeof candidate.adapter !== "string" || !candidate.adapter) throw contractError("TOOLSET_DECLARATION_INVALID", "Generated candidate is invalid."); }
function validateInput(input) { for (const key of ["logicalSessionId", "objectiveId", "workItemId", "repositoryId", "worktreeId", "projectRoot", "idempotencyKey", "capabilityClass"]) if (typeof input?.[key] !== "string" || !input[key]) throw contractError("TOOLSET_PERMISSION_DENIED", "Authenticated Toolset identity is incomplete."); if (!CAPABILITY_CLASSES.includes(input.capabilityClass) || !input.startupBindingRef || !input.startupBindingReceiptRef || !input.repositorySourceSnapshotReceiptRef) throw contractError("TOOLSET_BACKGROUND_CAPABILITY_UNAVAILABLE", "Resolved Startup and Snapshot authorities are required."); }
function requestHash(input) { const { recovery: _ignored, ...stable } = input; return sha256(canonicalJson(stable)); }
function hasGeneration(value) { return value === "restricted_project_toolset_generation" || value === "full_required"; }
function businessError(code, actionId, phase) { return { code, message: "Project Toolset validation did not complete successfully.", retryable: ["TOOLSET_CLEANUP_UNKNOWN", "TOOLSET_RUN_PREPARE_FAILED"].includes(code), details: { actionId, assertionId: null, phase } }; }
function requiredPort(options, name) { if (!options?.[name]) throw new TypeError(`ProjectToolsetOrchestrator requires ${name}.`); return options[name]; }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function authenticatedSession(input) { return Object.freeze({ logicalSessionId: input.logicalSessionId, workItemId: input.workItemId, repositoryId: input.repositoryId, worktreeId: input.worktreeId }); }
function authoritativeIdentity(input) { return Object.freeze({ logicalSessionId: input.logicalSessionId, objectiveId: input.objectiveId, workItemId: input.workItemId, repositoryId: input.repositoryId, worktreeId: input.worktreeId }); }
function runContext(input, snapshotRef) { return { logicalSessionId: input.logicalSessionId, workItemId: input.workItemId, repositoryId: input.repositoryId, worktreeId: input.worktreeId, snapshotRef, startupBindingReceiptRef: input.startupBindingReceiptRef }; }
function snapshotMatches(expected, actual) {
  if (!actual) return false;
  const projection = Object.fromEntries(["receiptId", "receiptHash", "sourceFingerprint", "schemaVersion", "resourceVersion", "artifactRef"].map((key) => [key, actual[key]]));
  try { validateSnapshotRef(projection); return canonicalJson(projection) === canonicalJson(expected); }
  catch { return false; }
}
function validatePreparedRun(prepared) {
  const context = prepared?.context;
  if (!context || typeof context.runId !== "string" || !context.runId || !Number.isInteger(context.resourceVersion) || context.resourceVersion < 1 || !Number.isInteger(context.fencingToken) || context.fencingToken < 1) throw contractError("TOOLSET_RUN_PREPARE_FAILED", "Run Isolation returned an invalid PreparedRun.");
  return context;
}
