import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { buildToolExposurePlan } from "./toolExposurePlan.mjs";
import { stableStringify } from "./hostToolCatalog.mjs";
import {
  appliedToolMaterializationReceipt,
  validateToolMaterializationReceipt
} from "../agent-provider/toolSchemaCapabilities.mjs";

export class ToolHostMaterializationCoordinator {
  constructor(options = {}) {
    this.store = options.store;
    this.catalog = options.catalog;
    this.providerPort = options.providerPort;
    this.resolveBinding = options.resolveBinding;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.onEvent = options.onEvent ?? null;
    this.singleFlights = new Map();
    if (!this.store) throw new TypeError("Tool Host Materialization Coordinator requires a Store.");
    if (!this.catalog) throw new TypeError("Tool Host Materialization Coordinator requires a Catalog.");
    if (!this.providerPort) throw new TypeError("Tool Host Materialization Coordinator requires a Provider port.");
    if (typeof this.resolveBinding !== "function") throw new TypeError("Tool Host Materialization Coordinator requires resolveBinding().");
  }

  async ensureApplied(input = {}) {
    const binding = await this.#binding(input.logicalSessionId, input.providerBindingId);
    const capability = await this.providerPort.probeToolSchemaCapabilities(binding);
    const context = catalogContext(binding);
    const desiredDomainIds = desiredDomains(binding, input.desiredDomains);
    const snapshot = this.catalog.snapshot();
    const phase = input.phase ?? "refresh";
    const plan = buildToolExposurePlan({
      catalog: this.catalog,
      context,
      desiredDomains: desiredDomainIds,
      capabilities: capability,
      phase
    });
    const domainRecords = materializedDomains(
      this.catalog,
      context,
      snapshot,
      desiredDomainIds,
      plan.surface
    );
    const desiredVersion = desiredMaterializationVersion({
      catalogVersion: snapshot.catalogVersion,
      authorizationScopeFingerprint: authorizationScopeFingerprint(binding),
      providerCapabilityRevision: capability.capabilityRevision,
      assignedSkillMcpRevision: input.assignedSkillMcpRevision ?? "none",
      desiredDomains: domainRecords,
      exposurePlanHash: plan.exposurePlanHash
    });
    let record = this.store.getSessionToolCatalogMaterialization(binding.logicalSessionId, binding.providerBindingId);
    if (!matchesDesired(record, desiredVersion, snapshot.catalogVersion, domainRecords, plan)) {
      record = this.store.writeSessionToolCatalogDesired({
        logicalSessionId: binding.logicalSessionId,
        providerBindingId: binding.providerBindingId,
        desiredVersion,
        desiredCatalogVersion: snapshot.catalogVersion,
        desiredDomains: domainRecords,
        exposurePlan: plan,
        updatedAt: this.clock()
      }, record?.resourceVersion ?? null);
      if (!record) return this.ensureApplied(input);
    }
    if (record.status === "applied" && record.appliedVersion === desiredVersion) {
      return Object.freeze({ status: "applied", record, plan, snapshot, joined: false });
    }
    if (record.status === "refreshing"
      && record.providerReceipt?.status === "awaiting_provider_observation"
      && record.providerReceipt?.requestedVersion === desiredVersion) {
      return Object.freeze({ status: "applying", record, plan, snapshot, joined: false });
    }
    if (input.activeTurn === true
      && !["generated_mcp_refresh", "restricted_gateway"].includes(plan.refreshMode)) {
      return Object.freeze({ status: "blocked", reason: "active_turn", record, plan, snapshot, joined: false });
    }
    const key = `${binding.logicalSessionId}\0${binding.providerBindingId}\0${desiredVersion}`;
    const running = this.singleFlights.get(key);
    if (running) {
      this.#emit("materialization_singleflight_join", { binding, desiredVersion });
      return Object.freeze({ ...(await running), joined: true });
    }
    const operation = this.#refresh({ binding, capability, plan, snapshot, domainRecords, desiredVersion, record, input });
    this.singleFlights.set(key, operation);
    try {
      return Object.freeze({ ...(await operation), joined: false });
    } finally {
      if (this.singleFlights.get(key) === operation) this.singleFlights.delete(key);
    }
  }

  async loadDomain(input = {}) {
    const binding = await this.#binding(input.logicalSessionId, input.providerBindingId);
    const snapshot = this.catalog.snapshot();
    if (input.expectedCatalogVersion !== snapshot.catalogVersion) {
      throw toolError("TOOL_CATALOG_STALE", "The Tool Host catalog changed; search again before loading a domain.", 409);
    }
    const domains = this.catalog.domains(catalogContext(binding));
    if (!domains.has(input.domainId)) {
      const globallyExists = snapshot.domains.some((domain) => domain.domainId === input.domainId);
      throw toolError(
        globallyExists ? "TOOL_DOMAIN_FORBIDDEN" : "TOOL_DOMAIN_NOT_FOUND",
        globallyExists ? "The requested Tool domain is not available in this Session." : "Tool domain not found.",
        globallyExists ? 403 : 404
      );
    }
    const current = this.store.getSessionToolCatalogMaterialization(binding.logicalSessionId, binding.providerBindingId);
    const desired = new Set((current?.desiredDomains ?? []).map((domain) => domain.domainId));
    desired.add(input.domainId);
    return this.ensureApplied({
      logicalSessionId: binding.logicalSessionId,
      providerBindingId: binding.providerBindingId,
      desiredDomains: [...desired],
      activeTurn: input.activeTurn === true,
      phase: "refresh"
    });
  }

  async search(input = {}) {
    const started = performance.now();
    const binding = await this.#binding(input.logicalSessionId, input.providerBindingId);
    const snapshot = this.catalog.snapshot();
    const query = String(input.intent ?? "").trim().toLocaleLowerCase();
    const hint = String(input.domainHint ?? "").trim().toLocaleLowerCase();
    const domains = [];
    for (const [domainId, entries] of this.catalog.domains(catalogContext(binding))) {
      if (hint && !domainId.toLocaleLowerCase().includes(hint)) continue;
      const tools = entries.filter((entry) => !query
        || `${entry.canonicalName} ${entry.definition.description ?? ""} ${domainId}`.toLocaleLowerCase().includes(query));
      if (query && tools.length === 0) continue;
      const snapshotDomain = snapshot.domains.find((domain) => domain.domainId === domainId);
      domains.push({
        domainId,
        domainRevision: snapshotDomain?.domainRevision ?? "1",
        toolCount: tools.length,
        tools: tools.slice(0, 20).map((entry) => ({
          canonicalName: entry.canonicalName,
          description: entry.definition.description ?? ""
        }))
      });
    }
    const durationMs = performance.now() - started;
    this.#emit("catalog_search", { binding, durationMs, resultCount: domains.length });
    return { catalogVersion: snapshot.catalogVersion, domains, durationMs };
  }

  assertCanonicalToolApplied(logicalSessionId, providerBindingId, canonicalName, requiredSurface = null) {
    const record = this.store.getSessionToolCatalogMaterialization(logicalSessionId, providerBindingId);
    if (!record || record.status !== "applied" || record.appliedVersion !== record.desiredVersion) {
      throw toolError("TOOL_DOMAIN_NOT_APPLIED", "The Tool domain is not applied for this Session.", 409);
    }
    const owner = record.exposurePlan?.ownership?.[canonicalName];
    const domainApplied = record.appliedDomains.some((domain) => domain.canonicalToolNames?.includes(canonicalName));
    if (!owner || !domainApplied || (requiredSurface && owner.surface !== requiredSurface)) {
      throw toolError("TOOL_DOMAIN_NOT_APPLIED", "The Tool is not applied for this Session.", 409);
    }
    return { record, owner };
  }

  cancelBinding(logicalSessionId, providerBindingId) {
    return this.store.cancelSessionToolCatalogMaterialization(logicalSessionId, providerBindingId);
  }

  async failPendingApplication(logicalSessionId, providerBindingId, errorCode, errorSummary) {
    const binding = await this.#binding(logicalSessionId, providerBindingId);
    const current = this.store.getSessionToolCatalogMaterialization(logicalSessionId, providerBindingId);
    if (!current || current.status !== "refreshing") return current;
    const failed = this.store.failSessionToolCatalogRefresh({
      logicalSessionId,
      providerBindingId,
      errorCode,
      errorSummary,
      updatedAt: this.clock()
    }, current.resourceVersion);
    if (failed) this.#emit("provider_application_failed", { binding, desiredVersion: current.desiredVersion });
    return failed;
  }

  async reconcile(logicalSessionId, providerBindingId) {
    const binding = await this.#binding(logicalSessionId, providerBindingId);
    const record = this.store.getSessionToolCatalogMaterialization(logicalSessionId, providerBindingId);
    if (!record || record.status !== "refreshing" || !record.providerReceipt?.receiptId) return record;
    const result = await this.providerPort.reconcileToolReceipt(binding, record.providerReceipt.receiptId);
    if (result?.status !== "applied") return record;
    return this.#commitReceipt({ binding, record, receipt: result.receipt });
  }

  async observeGeneratedMcpToolsList(input = {}) {
    const binding = await this.#binding(input.logicalSessionId, input.providerBindingId);
    const current = this.store.getSessionToolCatalogMaterialization(
      binding.logicalSessionId, binding.providerBindingId
    );
    if (!current || current.status !== "refreshing") {
      if (current?.status === "applied" && current.appliedVersion === current.desiredVersion) {
        if (input.desiredVersion && input.desiredVersion !== current.desiredVersion) {
          throw toolError("PROVIDER_TOOL_OBSERVATION_STALE", "The generated MCP observation belongs to an old applied generation.", 409);
        }
        return current;
      }
      throw toolError("PROVIDER_TOOL_OBSERVATION_STALE", "The generated MCP tools/list observation has no active application.", 409);
    }
    if (current.exposurePlan?.refreshMode !== "generated_mcp_refresh") {
      throw toolError("PROVIDER_TOOL_OBSERVATION_CONFLICT", "Generated MCP cannot acknowledge another delivery surface.", 409);
    }
    if (input.desiredVersion && input.desiredVersion !== current.desiredVersion) {
      throw toolError("PROVIDER_TOOL_OBSERVATION_STALE", "The generated MCP observation belongs to an old desired generation.", 409);
    }
    const observationId = requiredText(input.observationId, "observationId");
    const receipt = appliedToolMaterializationReceipt({
      providerBindingId: binding.providerBindingId,
      providerCapabilityRevision: current.exposurePlan.capabilityRevision,
      requestedVersion: current.desiredVersion,
      appliedCatalogVersion: current.desiredCatalogVersion,
      appliedDomains: current.desiredDomains,
      appliedExposurePlanHash: current.exposurePlan.exposurePlanHash,
      refreshMode: current.exposurePlan.refreshMode,
      providerRevision: `mcp-tools-list:${observationId}`,
      receiptId: `mcp-tools-list:${binding.providerBindingId}:${current.desiredVersion}:${observationId}`
    });
    const applied = await this.#commitReceipt({ binding, record: current, receipt });
    if (!applied || applied.status !== "applied") {
      throw toolError("PROVIDER_TOOL_OBSERVATION_STALE", "The generated MCP observation lost its CAS generation.", 409);
    }
    this.#emit("provider_tools_list_observed", {
      binding, desiredVersion: current.desiredVersion, receiptId: receipt.receiptId
    });
    return applied;
  }

  async #refresh(state) {
    let refreshing = this.store.beginSessionToolCatalogRefresh(
      state.binding.logicalSessionId,
      state.binding.providerBindingId,
      state.record.resourceVersion,
      this.clock()
    );
    if (!refreshing) {
      const winner = this.store.getSessionToolCatalogMaterialization(
        state.binding.logicalSessionId,
        state.binding.providerBindingId
      );
      if (winner?.status === "applied" && winner.appliedVersion === state.desiredVersion) {
        return { status: "applied", record: winner, plan: state.plan, snapshot: state.snapshot };
      }
      return this.ensureApplied(state.input);
    }
    const started = performance.now();
    try {
      const receipt = await this.providerPort.applyToolPlanAtTurnBoundary({
        binding: state.binding,
        plan: state.plan,
        requestedVersion: state.desiredVersion,
        catalogVersion: state.snapshot.catalogVersion,
        appliedDomains: state.domainRecords,
        capability: state.capability,
        phase: state.input.phase ?? "refresh"
      });
      if (receipt?.status === "awaiting_provider_observation") {
        const pending = this.store.recordSessionToolCatalogPendingReceipt({
          logicalSessionId: state.binding.logicalSessionId,
          providerBindingId: state.binding.providerBindingId,
          providerReceipt: {
            status: receipt.status,
            observationKind: receipt.observationKind,
            requestedVersion: state.desiredVersion,
            providerBindingId: state.binding.providerBindingId,
            providerCapabilityRevision: state.capability.capabilityRevision,
            requestedAt: this.clock()
          },
          updatedAt: this.clock()
        }, refreshing.resourceVersion);
        if (!pending) {
          return { status: "stale", record: this.store.getSessionToolCatalogMaterialization(
            state.binding.logicalSessionId, state.binding.providerBindingId
          ), plan: state.plan, snapshot: state.snapshot };
        }
        this.#emit("provider_application_awaiting_observation", {
          binding: state.binding, desiredVersion: state.desiredVersion
        });
        return { status: "applying", record: pending, plan: state.plan, snapshot: state.snapshot };
      }
      const record = await this.#commitReceipt({ binding: state.binding, record: refreshing, receipt });
      this.#emit("materialization_applied", {
        binding: state.binding,
        desiredVersion: state.desiredVersion,
        receiptId: receipt.receiptId,
        durationMs: performance.now() - started,
        toolCount: Object.keys(state.plan.ownership).length
      });
      return { status: record?.status === "applied" ? "applied" : "stale", record, plan: state.plan, snapshot: state.snapshot };
    } catch (error) {
      if (error?.code === "TOOL_MATERIALIZATION_OUTCOME_UNKNOWN") {
        if (error.receipt && typeof error.receipt === "object") {
          this.store.recordSessionToolCatalogPendingReceipt({
            logicalSessionId: state.binding.logicalSessionId,
            providerBindingId: state.binding.providerBindingId,
            providerReceipt: error.receipt,
            updatedAt: this.clock()
          }, refreshing.resourceVersion);
        }
        this.#emit("materialization_outcome_unknown", { binding: state.binding, desiredVersion: state.desiredVersion });
        throw error;
      }
      this.store.failSessionToolCatalogRefresh({
        logicalSessionId: state.binding.logicalSessionId,
        providerBindingId: state.binding.providerBindingId,
        errorCode: error?.code ?? "SESSION_TOOL_CATALOG_REFRESH_FAILED",
        errorSummary: safeErrorSummary(error),
        updatedAt: this.clock()
      }, refreshing.resourceVersion);
      const failure = toolError(
        "SESSION_TOOL_CATALOG_REFRESH_FAILED",
        "Session Tool catalog refresh failed before the next Turn.",
        503,
        error
      );
      // A Provider that can only install a Tool schema while creating its
      // physical Session must recover by replacing that binding. This failure
      // occurs before turn/start, so the user's message is safe to retry once
      // after the shared Session route commits the replacement.
      if (state.capability.bindingReplacement === true
        && error?.code === "PROVIDER_TOOL_APPLICATION_UNCONFIRMED") {
        failure.dispatchState = "not_sent";
        failure.recoveryAction = "replace_provider_binding";
        failure.replacementReason = error.code;
      }
      throw failure;
    }
  }

  async #commitReceipt({ binding, record, receipt }) {
    const current = this.store.getSessionToolCatalogMaterialization(binding.logicalSessionId, binding.providerBindingId);
    if (!current || current.status === "canceled" || current.desiredVersion !== record.desiredVersion) {
      this.#emit("MATERIALIZATION_RECEIPT_STALE", { binding, receiptId: receipt?.receiptId ?? null });
      return current;
    }
    validateToolMaterializationReceipt(receipt, {
      providerBindingId: binding.providerBindingId,
      providerCapabilityRevision: current.exposurePlan.capabilityRevision,
      requestedVersion: current.desiredVersion,
      catalogVersion: current.desiredCatalogVersion,
      exposurePlanHash: current.exposurePlan.exposurePlanHash,
      appliedDomains: current.desiredDomains
    });
    const applied = this.store.applySessionToolCatalogReceipt({
      logicalSessionId: binding.logicalSessionId,
      providerBindingId: binding.providerBindingId,
      appliedVersion: receipt.appliedVersion,
      appliedCatalogVersion: receipt.appliedCatalogVersion,
      appliedDomains: receipt.appliedDomains,
      providerReceipt: receipt,
      appliedAt: receipt.appliedAt
    }, current.resourceVersion);
    if (applied) return applied;
    const winner = this.store.getSessionToolCatalogMaterialization(binding.logicalSessionId, binding.providerBindingId);
    if (winner?.status === "applied" && winner.appliedVersion === receipt.appliedVersion) return winner;
    this.#emit("MATERIALIZATION_RECEIPT_STALE", { binding, receiptId: receipt.receiptId });
    return winner;
  }

  async #binding(logicalSessionId, providerBindingId) {
    const binding = await this.resolveBinding(logicalSessionId, providerBindingId);
    if (!binding || binding.logicalSessionId !== logicalSessionId || binding.providerBindingId !== providerBindingId) {
      throw toolError("SESSION_BINDING_CHANGED", "The authenticated Session binding changed.", 409);
    }
    if (binding.tombstoned || binding.state !== "active" || binding.isCurrent === false) {
      this.cancelBinding(logicalSessionId, providerBindingId);
      throw toolError("SESSION_BINDING_TOMBSTONED", "The Session binding is no longer active.", 410);
    }
    if (binding.sessionKind === "worker") {
      if (!binding.sessionId || !binding.objectiveId || !binding.workItemId) {
        throw toolError("ACTOR_NOT_BOUND", "Worker Session binding is incomplete.", 403);
      }
      if (binding.currentWorkItemSessionId !== binding.sessionId) {
        throw toolError("ACTOR_NOT_BOUND", "Worker Session is not the WorkItem current Session.", 403);
      }
    }
    return binding;
  }

  #emit(type, details) {
    if (typeof this.onEvent !== "function") return;
    this.onEvent(type, {
      logicalSessionId: details.binding?.logicalSessionId ?? null,
      providerBindingId: details.binding?.providerBindingId ?? null,
      desiredVersion: details.desiredVersion ?? null,
      receiptId: details.receiptId ?? null,
      durationMs: details.durationMs ?? null,
      toolCount: details.toolCount ?? null,
      resultCount: details.resultCount ?? null
    });
  }
}

export class RegistryToolMaterializationPort {
  constructor(options = {}) {
    this.registry = options.registry;
    if (!this.registry) throw new TypeError("Registry Tool Materialization Port requires a Provider Registry.");
  }

  probeToolSchemaCapabilities(binding) {
    const provider = this.registry.get(binding.providerId);
    if (typeof provider.probeToolSchemaCapabilities !== "function") {
      throw toolError("PROVIDER_CAPABILITY_UNSUPPORTED", "Provider did not expose Tool Schema capability probing.", 422);
    }
    return provider.probeToolSchemaCapabilities(binding);
  }

  async applyToolPlanAtTurnBoundary(input) {
    const provider = this.registry.get(input.binding.providerId);
    if (typeof provider.applyToolPlanAtTurnBoundary === "function") {
      return provider.applyToolPlanAtTurnBoundary(input.binding, input.plan, {
        requestedVersion: input.requestedVersion,
        catalogVersion: input.catalogVersion,
        appliedDomains: input.appliedDomains,
        capabilityRevision: input.capability.capabilityRevision
      });
    }
    if (input.plan.refreshMode === "generated_mcp_refresh") {
      return {
        status: "awaiting_provider_observation",
        observationKind: "mcp_tools_list"
      };
    }
    throw toolError("PROVIDER_CAPABILITY_UNSUPPORTED", "Provider cannot apply the Tool Schema plan at a Turn boundary.", 422);
  }

  reconcileToolReceipt(binding, receiptId) {
    const provider = this.registry.get(binding.providerId);
    if (typeof provider.reconcileToolReceipt !== "function") {
      return { status: "unknown", receiptId };
    }
    return provider.reconcileToolReceipt(binding, receiptId);
  }
}

export function desiredMaterializationVersion(input) {
  return sha256([
    input.catalogVersion,
    input.authorizationScopeFingerprint,
    input.providerCapabilityRevision,
    input.assignedSkillMcpRevision,
    stableStringify(input.desiredDomains),
    input.exposurePlanHash
  ].join("\0"));
}

export function authorizationScopeFingerprint(binding) {
  return sha256(stableStringify({
    logicalSessionId: binding.logicalSessionId,
    sessionId: binding.sessionId ?? null,
    sessionKind: binding.sessionKind,
    objectiveId: binding.objectiveId ?? null,
    workItemId: binding.workItemId ?? null,
    currentWorkItemSessionId: binding.currentWorkItemSessionId ?? null,
    providerBindingId: binding.providerBindingId,
    bindingState: binding.state,
    tombstoned: binding.tombstoned === true,
    authorizationRevision: binding.authorizationRevision ?? 1
  }));
}

function desiredDomains(binding, explicit) {
  const domains = new Set(Array.isArray(explicit) ? explicit : []);
  if (binding.sessionKind === "worker") domains.add("artifacts");
  return [...domains].sort();
}

function materializedDomains(catalog, context, snapshot, desiredDomainIds, surface) {
  return desiredDomainIds.map((domainId) => {
    const domain = snapshot.domains.find((candidate) => candidate.domainId === domainId);
    if (!domain) throw toolError("TOOL_DOMAIN_NOT_FOUND", `Tool domain not found: ${domainId}`, 404);
    const entries = catalog.entries(context, { domains: [domainId] });
    const canonicalToolNames = entries.map((entry) => entry.canonicalName).sort();
    const authorizedSchemaHash = sha256(stableStringify(entries.map((entry) => entry.definition)));
    return Object.freeze({
      domainId: domain.domainId,
      domainRevision: domain.domainRevision,
      schemaHash: authorizedSchemaHash,
      canonicalToolNames: Object.freeze(canonicalToolNames),
      deliverySurface: surface
    });
  });
}

function matchesDesired(record, version, catalogVersion, domains, plan) {
  return record
    && record.desiredVersion === version
    && record.desiredCatalogVersion === catalogVersion
    && stableStringify(record.desiredDomains) === stableStringify(domains)
    && record.exposurePlan?.exposurePlanHash === plan.exposurePlanHash;
}

function catalogContext(binding) {
  return {
    actorId: binding.agentId ?? null,
    metadata: {
      logicalSessionId: binding.logicalSessionId,
      sessionId: binding.sessionId ?? null,
      sessionKind: binding.sessionKind,
      objectiveId: binding.objectiveId ?? null,
      workItemId: binding.workItemId ?? null,
      providerBindingId: binding.providerBindingId
    }
  };
}

function safeErrorSummary(error) {
  return String(error?.message ?? error ?? "Tool materialization failed.")
    .replace(/\b(?:token|secret|password|authorization)\s*[:=]\s*\S+/gi, "credential=<redacted>")
    .slice(0, 500);
}

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw toolError("PROVIDER_TOOL_OBSERVATION_INVALID", `${field} is required.`, 400);
  return normalized;
}

function toolError(code, message, statusCode, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
