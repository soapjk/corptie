import { resolve } from "node:path";
import { ExternalValidationCacheStore, ProjectToolsetDeclarationStore } from "../runtime/projectToolsetDeclarationStore.mjs";
import { ProjectToolsetOrchestrator } from "../runtime/projectToolsetOrchestrator.mjs";
import { SqliteProjectToolsetStore } from "../runtime/projectToolsetOperationStore.mjs";
import { contractError } from "../runtime/projectToolsetCanonical.mjs";
import {
  ProjectToolsetAuthorityResolver, ProjectToolsetBackgroundAgentPort, ProjectToolsetService
} from "./projectToolsetService.mjs";
import {
  ProjectToolsetAuthorizationPort, ProjectToolsetCommandDescriptorPort,
  ProjectToolsetRunIsolationPort, ProjectToolsetValidationPlanPort
} from "./projectToolsetProductionPorts.mjs";
import { RunIsolationAuthorityResolver } from "../runIsolation/index.mjs";

export function createProjectToolsetProductionComposition(options = {}) {
  const store = required(options.store, "Store");
  const startupReceipts = required(options.startupReceipts, "Startup receipt Store");
  const projectCode = required(options.projectCodeApplicationService, "Snapshot service");
  const runCoordinator = required(options.runIsolationCoordinator, "Run Isolation coordinator");
  const backgroundAgent = required(options.backgroundAgentService, "Background Agent service");
  const dataRoot = required(options.dataRoot, "external dataRoot");
  const declarationStore = options.declarationStore ?? new ProjectToolsetDeclarationStore();
  const toolsetStore = options.toolsetStore ?? new SqliteProjectToolsetStore({
    databasePath: resolve(dataRoot, "project-toolset", "control.sqlite")
  });
  const commandDescriptors = new ProjectToolsetCommandDescriptorPort();
  const runIsolationPort = new ProjectToolsetRunIsolationPort({ coordinator: runCoordinator, commandDescriptors });
  const sessionAuthorityPort = {
    resolve: ({ authenticatedSession, workingDirectory }) => resolveSessionAuthority({
      store, startupReceipts, authenticatedSession, workingDirectory
    })
  };
  const snapshotStore = {
    async getCurrent(authority) {
      return (await projectCode.createSnapshot({ logicalSessionId: authority.logicalSessionId })).receipt;
    }
  };
  const authorityResolver = new ProjectToolsetAuthorityResolver({
    sessionAuthorityPort,
    startupBindingReceiptStore: { async getCurrent(authority) { return startupReceipts.require(authority.logicalSessionId); } },
    repositorySourceSnapshotStore: snapshotStore,
    toolsetValidationReceiptStore: toolsetStore
  });
  const snapshotPort = {
    async get(reference) {
      const stored = store.getProjectCodeReceiptById(reference?.receiptId);
      if (!stored || stored.receiptType !== "RepositorySourceSnapshotReceipt") return null;
      const current = (await projectCode.createSnapshot({ logicalSessionId: stored.logicalSessionId })).receipt;
      const stale = ["repositoryId", "worktreeId", "sourceFingerprint"].some((field) => current[field] !== stored.receipt[field])
        || current.startupBindingRef?.startupReceiptHash !== stored.receipt.startupBindingRef?.startupReceiptHash;
      return Object.freeze({ ...stored.receipt, stale });
    }
  };
  const startupReader = { async get(reference) { return startupReceipts.getByReference(reference); } };
  const authorizationPort = new ProjectToolsetAuthorizationPort({
    resolveAuthority: async (logicalSessionId) => resolveSessionAuthority({
      store, startupReceipts,
      authenticatedSession: authoritativeSession(store, logicalSessionId),
      workingDirectory: startupReceipts.require(logicalSessionId).canonicalWorktreePath
    })
  });
  const orchestrator = new ProjectToolsetOrchestrator({
    declarationStore,
    authorizationPort,
    operationStore: toolsetStore,
    validationReceiptStore: toolsetStore,
    validationCacheStore: new ExternalValidationCacheStore({ dataRoot, environment: options.environment ?? "development" }),
    repositorySourceSnapshotPort: snapshotPort,
    startupBindingReceiptReader: startupReader,
    runIsolationPort,
    commandDescriptorPort: commandDescriptors,
    validationPlanPort: new ProjectToolsetValidationPlanPort({ store: toolsetStore }),
    backgroundAgentPort: new ProjectToolsetBackgroundAgentPort({ service: backgroundAgent }),
    observabilityPort: { emit: (event) => options.onEvent?.("ProjectToolsetOperationObserved", event) }
  });
  const service = new ProjectToolsetService({
    orchestrator, authorityResolver, declarationStore, operationStore: toolsetStore
  });
  const initializer = new ProjectToolsetProductionInitializer({
    service, store: toolsetStore, onEvent: options.onEvent
  });
  const runAuthorityResolver = new RunIsolationAuthorityResolver({
    resolveAuthority: async (request) => {
      const startup = startupReceipts.require(request.logicalSessionId);
      const authority = await resolveSessionAuthority({
        store, startupReceipts,
        authenticatedSession: authoritativeSession(store, request.logicalSessionId),
        workingDirectory: startup.canonicalWorktreePath
      });
      assertRunAuthorityRequest(request, authority);
      const active = (await declarationStore.read(startup.canonicalWorktreePath)).active;
      if (!active?.receiptId) fail("RUN_TOOLSET_RECEIPT_UNRESOLVED", "No active authoritative Toolset receipt exists.");
      const refs = await authorityResolver.resolveRunIsolationAuthorities({
        workingDirectory: startup.canonicalWorktreePath,
        authenticatedSession: authoritativeSession(store, request.logicalSessionId),
        toolsetReceiptId: active.receiptId
      });
      assertActiveReceipt(active, refs.toolsetValidationReceiptPointer);
      return Object.freeze({
        logicalSessionId: authority.logicalSessionId,
        workItemId: authority.workItemId,
        repositoryId: authority.repositoryId,
        worktreeId: authority.worktreeId,
        bindingId: authority.bindingId,
        bindingGeneration: authority.bindingGeneration,
        ...refs
      });
    }
  });

  return Object.freeze({
    service, initializer, orchestrator, authorityResolver, runAuthorityResolver, toolsetStore,
    resolveToolsetReceipt: (receiptId) => toolsetStore.getReceipt(receiptId),
    async runtimeAuthority(logicalSessionId) {
      const startup = startupReceipts.require(logicalSessionId);
      const authority = await resolveSessionAuthority({
        store, startupReceipts,
        authenticatedSession: authoritativeSession(store, logicalSessionId),
        workingDirectory: startup.canonicalWorktreePath
      });
      const active = (await declarationStore.read(startup.canonicalWorktreePath)).active;
      if (!active?.receiptId) fail("RUN_TOOLSET_RECEIPT_UNRESOLVED", "No active authoritative Toolset receipt exists.");
      const refs = await authorityResolver.resolveRunIsolationAuthorities({
        workingDirectory: startup.canonicalWorktreePath,
        authenticatedSession: authoritativeSession(store, logicalSessionId),
        toolsetReceiptId: active.receiptId
      });
      assertActiveReceipt(active, refs.toolsetValidationReceiptPointer);
      const snapshot = store.getProjectCodeReceiptById(refs.repositorySourceSnapshotReceiptRef.receiptId)?.receipt;
      if (!snapshot || snapshot.sourceFingerprint !== refs.repositorySourceSnapshotReceiptRef.sourceFingerprint) fail("SOURCE_FINGERPRINT_MISMATCH", "Snapshot receipt is unavailable or mismatched.");
      return Object.freeze({ ...authority, ...refs, snapshot, toolsetReceiptId: active.receiptId });
    }
  });
}

export class ProjectToolsetProductionInitializer {
  constructor({ service, store, onEvent = null }) {
    this.service = service; this.store = store; this.onEvent = onEvent ?? (() => {});
    this.active = new Map(); this.errors = new Map();
  }

  schedule(workingDirectory, options = {}) {
    const key = `${options.authenticatedSession?.logicalSessionId ?? "unknown"}\0${resolve(workingDirectory)}`;
    const existing = this.active.get(key);
    if (existing) return existing;
    const operation = this.initialize(workingDirectory, options).finally(() => this.active.delete(key));
    this.active.set(key, operation); return operation;
  }

  async initialize(workingDirectory, options = {}) {
    const logicalSessionId = options.authenticatedSession?.logicalSessionId;
    if (!logicalSessionId) fail("TOOLSET_PERMISSION_DENIED", "Initialization requires an authenticated logical Session.");
    this.errors.delete(logicalSessionId);
    this.onEvent("ProjectToolsetInitializationStarted", { logicalSessionId, workingDirectory, update: options.force === true });
    try {
      const result = await this.service.initialize(workingDirectory, options);
      this.onEvent("ProjectToolsetInitializationCompleted", { logicalSessionId, workingDirectory, operationId: result.operationId, state: result.state, outcome: result.outcome });
      return result;
    } catch (error) {
      this.errors.set(logicalSessionId, error.message);
      this.onEvent("ProjectToolsetInitializationFailed", { logicalSessionId, workingDirectory, code: error.code ?? null, error: error.message });
      throw error;
    }
  }

  async cancel(operationId) { return this.service.cancel(operationId); }
  async recoverAll() { return this.service.recoverAll(); }
  async status(repositoryId, logicalSessionId = null) {
    const operation = await this.store.latestForRepository(repositoryId);
    return Object.freeze({
      state: operation?.state ?? "notConfigured",
      outcome: operation?.result?.outcome ?? null,
      operationId: operation?.id ?? null,
      error: logicalSessionId ? this.errors.get(logicalSessionId) ?? null : null
    });
  }
}

function resolveSessionAuthority({ store, startupReceipts, authenticatedSession, workingDirectory }) {
  if (!authenticatedSession?.logicalSessionId || !authenticatedSession?.workItemId) fail("TOOLSET_PERMISSION_DENIED", "Authenticated Work Session identity is required.");
  const ownership = store.assertLogicalWorkSessionBinding(authenticatedSession.logicalSessionId);
  const logical = store.getLogicalSession(authenticatedSession.logicalSessionId);
  const startup = startupReceipts.require(authenticatedSession.logicalSessionId);
  const binding = logical?.activeBinding;
  if (!ownership?.objectiveId || ownership.workItemId !== authenticatedSession.workItemId
    || !binding || binding.state !== "active"
    || binding.worktreeId !== startup.worktreeId || resolve(binding.boundCwd) !== resolve(startup.canonicalWorktreePath)
    || resolve(workingDirectory) !== resolve(startup.canonicalWorktreePath)) {
    fail("TOOLSET_PERMISSION_DENIED", "Authenticated Session, Startup receipt and active Worktree differ.");
  }
  return Object.freeze({
    logicalSessionId: authenticatedSession.logicalSessionId,
    objectiveId: ownership.objectiveId,
    workItemId: ownership.workItemId,
    repositoryId: startup.repositoryId,
    worktreeId: startup.worktreeId,
    // StartupBindingReceipt owns the execution binding generation. The
    // Provider route has its own opaque binding id; comparing those two ids
    // would conflate separate authorities and reject every real Work Session.
    bindingId: startup.providerBindingId,
    bindingGeneration: startup.bindingGeneration,
    providerBindingId: binding.bindingId,
    providerBindingGeneration: binding.routingVersion,
    capabilityClass: "full_required"
  });
}

function authoritativeSession(store, logicalSessionId) {
  const ownership = store.assertLogicalWorkSessionBinding(logicalSessionId);
  if (!ownership?.workItemId) fail("TOOLSET_PERMISSION_DENIED", "Logical Session is not a Work Session.");
  return Object.freeze({ logicalSessionId, workItemId: ownership.workItemId });
}

function assertRunAuthorityRequest(request, authority) {
  for (const field of ["logicalSessionId", "workItemId", "repositoryId", "worktreeId", "bindingId", "bindingGeneration"]) {
    if (request[field] !== authority[field]) fail(field === "bindingGeneration" ? "STARTUP_BINDING_STALE" : "RUN_UNAUTHORIZED", `${field} differs from authoritative Toolset composition.`);
  }
}

function assertActiveReceipt(active, pointer) {
  for (const field of ["receiptId", "receiptHash", "toolsetVersion", "validationPlanIdentity", "resourceVersion"]) {
    if (active?.[field] !== pointer?.[field]) fail("RECEIPT_INVALID", `Active Toolset ${field} differs from its authoritative receipt.`);
  }
}

function required(value, name) { if (!value) throw new TypeError(`Project Toolset production composition requires ${name}.`); return value; }
function fail(code, message) { throw contractError(code, message); }
