import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";
import { performance } from "node:perf_hooks";
import { providerToolSchemaCapabilities } from "../agent-provider/toolSchemaCapabilities.mjs";
import {
  TOOL_CATALOG_SEARCH,
  TOOL_DOMAIN_LOAD,
  TOOL_RESTRICTED_GATEWAY
} from "./hostToolCatalog.mjs";
import { buildToolExposurePlan } from "./toolExposurePlan.mjs";

export class ToolHostService {
  constructor(options = {}) {
    this.registry = options.registry;
    this.catalog = options.catalog;
    this.coordinator = options.coordinator ?? null;
    this.materializationPort = options.materializationPort ?? null;
    this.resolveMcpServers = options.resolveMcpServers ?? null;
    this.recordRuntimeEvent = options.recordRuntimeEvent ?? null;
    if (!this.registry) throw new TypeError("ToolHostService requires an Agent Provider Registry.");
    if (!this.catalog) throw new TypeError("ToolHostService requires a Host Tool Catalog.");
  }

  ensureDomainsApplied(logicalSessionId, domains, turnBoundary) {
    if (!this.materializationPort) {
      throw toolError("TOOL_MATERIALIZATION_OUTCOME_UNKNOWN", "The authoritative Tool materialization Port is unavailable.");
    }
    return this.materializationPort.ensureDomainsApplied(logicalSessionId, domains, turnBoundary);
  }

  assertCanonicalToolApplied(logicalSessionId, canonicalName) {
    if (!this.materializationPort) {
      throw toolError("TOOL_MATERIALIZATION_OUTCOME_UNKNOWN", "The authoritative Tool materialization Port is unavailable.");
    }
    return this.materializationPort.assertCanonicalToolApplied(logicalSessionId, canonicalName);
  }

  async prepareSession(providerId, context = {}) {
    const supportsAttachment = this.registry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH);
    const actorId = normalizedText(context.actorId);
    if (!supportsAttachment && !actorId) return null;
    if (!actorId) throw toolError("AGENT_REQUIRED", "A session must be bound to an existing Agent; actorId is required.");
    let mcpServers;
    try {
      mcpServers = typeof this.resolveMcpServers === "function"
        ? await this.resolveMcpServers({ actorId, providerId, context })
        : {};
    } catch (error) {
      this.#recordFailure(context, actorId, providerId, error, "MCP_LOADING_FAILED");
      throw error;
    }
    const mcpServerNames = Object.keys(mcpServers ?? {});
    if (mcpServerNames.length > 0
      && !this.registry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.SKILL_MCP_DEPENDENCIES)) {
      const error = toolError(
        "MCP_PROVIDER_UNSUPPORTED",
        `Agent Provider ${providerId} cannot materialize assigned Skill MCP dependencies.`
      );
      this.#recordFailure(context, actorId, providerId, error, error.code, mcpServerNames);
      throw error;
    }
    if (!supportsAttachment) {
      if (mcpServerNames.length > 0) {
        throw toolError("MCP_PROVIDER_UNSUPPORTED", `Agent Provider ${providerId} cannot attach assigned Skill MCP dependencies.`);
      }
      return null;
    }

    let materialization = null;
    let tools;
    const provider = this.registry.get(providerId);
    if (this.coordinator && context.logicalSessionId && context.providerBindingId) {
      materialization = await this.coordinator.ensureApplied({
        logicalSessionId: context.logicalSessionId,
        providerBindingId: context.providerBindingId,
        desiredDomains: context.desiredToolDomains,
        assignedSkillMcpRevision: context.assignedSkillMcpRevision,
        activeTurn: context.activeTurn === true,
        phase: context.purpose === "session-bootstrap" ? "create" : "refresh"
      });
      if (!["applied", "applying"].includes(materialization.status)) {
        throw toolError("SESSION_TOOL_CATALOG_REFRESH_FAILED", "Session Tool catalog is not applied at this Turn boundary.");
      }
      tools = materialization.plan.providerDefinitions;
    } else if (this.coordinator) {
      const capability = await providerToolSchemaCapabilities(provider, null);
      const desiredDomains = Array.isArray(context.desiredToolDomains)
        ? context.desiredToolDomains
        : context.sessionKind === "worker" ? ["artifacts"] : [];
      const plan = buildToolExposurePlan({
        catalog: this.catalog,
        context: { actorId, metadata: context },
        desiredDomains,
        capabilities: capability,
        phase: "create"
      });
      materialization = Object.freeze({
        status: "pending_binding",
        plan,
        snapshot: this.catalog.snapshot(),
        desiredDomains
      });
      tools = plan.providerDefinitions;
    } else {
      // Unit-only compatibility for a ToolHostService without the authoritative
      // materialization coordinator. Production always injects the coordinator.
      tools = this.catalog.definitions({ actorId, metadata: context });
    }

    const attachment = Object.freeze({
      actorId,
      tools: Object.freeze([...tools]),
      mcpServers: Object.freeze({ ...(mcpServers ?? {}) }),
      metadata: Object.freeze({
        ...context,
        purpose: context.purpose ?? "session",
        catalogVersion: materialization?.snapshot?.catalogVersion ?? null,
        exposurePlanHash: materialization?.plan?.exposurePlanHash ?? null,
        toolDeliverySurface: materialization?.plan?.surface ?? null
      })
    });
    let providerAttachment;
    try {
      providerAttachment = await this.registry.invoke(
        providerId,
        AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH,
        attachment,
        context
      );
    } catch (error) {
      this.#recordFailure(context, actorId, providerId, error, "PROVIDER_TOOL_MATERIALIZATION_FAILED", mcpServerNames);
      throw error;
    }
    this.#record({
      stage: context.purpose === "session-resume" ? "session-recovery" : "provider-materialization",
      status: materialization?.status === "applying" ? "applying" : "success",
      agentId: actorId,
      sessionId: context.sessionId ?? null,
      logicalSessionId: context.logicalSessionId ?? null,
      providerId,
      catalogVersion: materialization?.snapshot?.catalogVersion ?? null,
      desiredVersion: materialization?.record?.desiredVersion ?? null,
      appliedVersion: materialization?.record?.appliedVersion ?? null,
      surface: materialization?.plan?.surface ?? null,
      serverNames: mcpServerNames,
      reason: materialization?.status === "applying"
        ? "Provider Tool Host application is awaiting an exact Provider observation."
        : context.purpose === "session-resume"
        ? "Session recovery passed the authoritative Tool Host Turn gate."
        : "Provider Tool Host attachment materialized."
    });
    return Object.freeze({ actorId, providerAttachment, materialization });
  }

  async execute(input = {}) {
    const started = performance.now();
    try {
      const result = await this.#execute(input);
      this.#recordToolCall(input, "success", performance.now() - started);
      return result;
    } catch (error) {
      this.#recordToolCall(input, "failed", performance.now() - started, error);
      throw error;
    }
  }

  async #execute(input = {}) {
    if (input.tool === TOOL_CATALOG_SEARCH) {
      const scope = exactScope(input);
      return this.coordinator.search({
        ...scope,
        intent: input.arguments?.intent,
        domainHint: input.arguments?.domain_hint
      });
    }
    if (input.tool === TOOL_DOMAIN_LOAD) {
      const scope = exactScope(input);
      const result = await this.coordinator.loadDomain({
        ...scope,
        domainId: requiredText(input.arguments?.domain_id, "domain_id"),
        expectedCatalogVersion: requiredText(input.arguments?.expected_catalog_version, "expected_catalog_version"),
        // A domain_load invocation is itself inside a Provider Turn. Native
        // schema mutation remains blocked; generated MCP refresh and the fixed
        // restricted gateway can safely observe/apply their unchanged surface.
        activeTurn: true
      });
      return {
        status: result.status,
        catalogVersion: result.snapshot.catalogVersion,
        desiredVersion: result.record.desiredVersion,
        appliedVersion: result.record.appliedVersion,
        domains: result.record.appliedDomains,
        contract: this.catalog.domainContract({
          actorId: input.actorId,
          metadata: input.metadata
        }, input.arguments.domain_id, {
          surface: result.plan.surface,
          catalogVersion: result.snapshot.catalogVersion
        })
      };
    }
    if (input.tool === TOOL_RESTRICTED_GATEWAY) {
      const scope = exactScope(input);
      const canonicalName = requiredText(input.arguments?.tool, "tool");
      const expectedCatalogVersion = requiredText(input.arguments?.expected_catalog_version, "expected_catalog_version");
      const snapshot = this.catalog.snapshot();
      const applied = this.coordinator.assertCanonicalToolApplied(
        scope.logicalSessionId, scope.providerBindingId, canonicalName, "restricted_gateway"
      );
      // A Provider may retain the catalog version returned by an earlier Turn
      // while the Session boundary has already adopted a newer catalog. The
      // restricted gateway ABI is stable and the current canonical schema is
      // validated again below, so an unrelated catalog update must not abort
      // the business call. Fail closed only when this exact Session has not
      // applied the current catalog generation.
      if (snapshot.catalogVersion !== expectedCatalogVersion
        && applied.record?.appliedCatalogVersion !== snapshot.catalogVersion) {
        const error = toolError(
          "TOOL_CATALOG_STALE",
          "The Tool Host catalog changed and this Session has not applied the current generation; search again before calling the gateway.",
          409
        );
        error.expectedCatalogVersion = expectedCatalogVersion;
        error.currentCatalogVersion = snapshot.catalogVersion;
        throw error;
      }
      return this.catalog.execute({ ...input, tool: canonicalName, arguments: input.arguments?.arguments ?? {} });
    }
    if (this.coordinator) {
      const entry = this.catalog.entry(input.tool);
      if (entry?.exposure === "deferred") {
        const scope = exactScope(input);
        this.coordinator.assertCanonicalToolApplied(scope.logicalSessionId, scope.providerBindingId, entry.canonicalName);
      }
    }
    return this.catalog.execute(input);
  }

  #recordToolCall(input, status, durationMs, error = null) {
    this.#record({
      stage: "tool-call",
      status,
      agentId: input.actorId ?? null,
      sessionId: input.metadata?.sessionId ?? null,
      errorCode: error?.code ?? null,
      reason: error?.message ?? "Tool Host call completed.",
      toolCount: 1,
      details: {
        tool: input.tool ?? null,
        domainId: this.catalog.entry(input.tool)?.domainId ?? "tool-catalog",
        durationMs: Number(durationMs.toFixed(3)),
        schemaValidationFailureCount: error?.code === "TOOL_ARGUMENT_SCHEMA_INVALID" ? 1 : 0,
        schemaValidationIssueCount: Array.isArray(error?.issues) ? error.issues.length : 0
      }
    });
  }

  appliedDefinitions(input = {}, surface = "generated_authenticated_mcp") {
    if (!this.coordinator) throw toolError("TOOL_HOST_COORDINATOR_REQUIRED", "The authoritative Tool Host coordinator is unavailable.");
    const scope = exactScope(input);
    const record = this.coordinator.store.getSessionToolCatalogMaterialization(
      scope.logicalSessionId, scope.providerBindingId
    );
    if (!record || record.status !== "applied" || record.appliedVersion !== record.desiredVersion) {
      throw toolError("TOOL_DOMAIN_NOT_APPLIED", "The Session Tool catalog is not currently applied.", 409);
    }
    const definitions = [];
    for (const [canonicalName, owner] of Object.entries(record.exposurePlan?.ownership ?? {})) {
      if (owner.surface !== surface) continue;
      const entry = this.catalog.entry(canonicalName);
      if (entry) definitions.push(entry.definition);
    }
    return Object.freeze({
      catalogVersion: record.catalogVersion,
      desiredVersion: record.desiredVersion,
      appliedVersion: record.appliedVersion,
      surface,
      tools: Object.freeze(definitions.sort((left, right) => left.name.localeCompare(right.name)))
    });
  }

  async observeGeneratedMcpToolsList(input = {}) {
    const scope = exactScope(input);
    await this.coordinator.observeGeneratedMcpToolsList({
      ...scope,
      desiredVersion: input.desiredVersion,
      observationId: input.observationId
    });
    return this.appliedDefinitions(input, "generated_authenticated_mcp");
  }

  async confirmPreparedSession(prepared, options = {}) {
    if (!prepared?.materialization || prepared.materialization.status === "applied") return prepared;
    const logicalSessionId = prepared.materialization.record?.logicalSessionId;
    const providerBindingId = prepared.materialization.record?.providerBindingId;
    if (!logicalSessionId || !providerBindingId) {
      throw toolError("SESSION_TOOL_CATALOG_REFRESH_FAILED", "Prepared Tool Host is missing its exact Session binding.");
    }
    const timeoutMs = Number(options.timeoutMs ?? 5_000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = this.coordinator.store.getSessionToolCatalogMaterialization(logicalSessionId, providerBindingId);
      if (record?.status === "applied" && record.appliedVersion === record.desiredVersion) return { ...prepared, materialization: { ...prepared.materialization, status: "applied", record } };
      if (["error", "canceled"].includes(record?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await this.coordinator.failPendingApplication(
      logicalSessionId,
      providerBindingId,
      "PROVIDER_TOOL_APPLICATION_UNCONFIRMED",
      "Provider did not confirm the requested Tool materialization before the Turn gate timeout."
    );
    throw toolError("PROVIDER_TOOL_APPLICATION_UNCONFIRMED", "Provider did not confirm the requested Tool materialization.", 503);
  }

  #recordFailure(context, actorId, providerId, error, fallbackCode, serverNames = []) {
    this.#record({
      stage: context.purpose === "session-resume" ? "session-recovery" : "provider-materialization",
      status: "failed",
      agentId: actorId,
      sessionId: context.sessionId ?? null,
      logicalSessionId: context.logicalSessionId ?? null,
      providerId,
      serverNames,
      errorCode: error?.code ?? fallbackCode,
      reason: error?.message ?? String(error)
    });
  }

  #record(event) {
    if (typeof this.recordRuntimeEvent !== "function") return null;
    return this.recordRuntimeEvent(event);
  }
}

function exactScope(input) {
  if (!input?.metadata?.logicalSessionId) throw toolError("MISSING_SESSION_ID", "Tool Host requires an authenticated logical Session.", 403);
  if (!input?.metadata?.providerBindingId) throw toolError("MISSING_SESSION_ID", "Tool Host requires an authenticated Provider binding.", 403);
  return {
    logicalSessionId: input.metadata.logicalSessionId,
    providerBindingId: input.metadata.providerBindingId
  };
}

function requiredText(value, field) {
  const text = normalizedText(value);
  if (!text) throw toolError("TOOL_ARGUMENT_SCHEMA_INVALID", `${field} is required.`, 400);
  return text;
}

function normalizedText(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function toolError(code, message, statusCode = 503) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
