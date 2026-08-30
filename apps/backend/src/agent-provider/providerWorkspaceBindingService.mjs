import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { AGENT_PROVIDER_CAPABILITIES } from "./contracts.mjs";

/** Public Provider-neutral workspace binding port used by startup only. */
export class ProviderWorkspaceBindingService {
  constructor({ registry } = {}) {
    if (!registry) throw new TypeError("ProviderWorkspaceBindingService requires an Agent Provider registry.");
    this.registry = registry;
  }

  bindWorkspace(input) {
    const providerId = required(input?.providerId, "providerId");
    try {
      return this.registry.invoke(providerId, AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND, input);
    } catch (error) {
      if (error?.code === "CAPABILITY_UNSUPPORTED") {
        error.code = "START_PROVIDER_BIND_UNSUPPORTED";
        error.statusCode = 409;
        error.retryable = false;
      }
      throw error;
    }
  }

  inspectBinding(input) {
    const providerId = required(input?.providerId, "providerId");
    const provider = this.registry.get(providerId);
    if (!this.registry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND)
      || typeof provider.inspectWorkspaceBinding !== "function") {
      const error = new Error(`Agent Provider ${providerId} does not support workspace.bind inspection.`);
      error.code = "START_PROVIDER_BIND_UNSUPPORTED";
      error.statusCode = 409;
      error.retryable = false;
      throw error;
    }
    return provider.inspectWorkspaceBinding(input);
  }
}

/**
 * Shared proof constructor for adapters whose createSession call already
 * accepted the cwd. Each concrete adapter exposes this through its own public
 * method; product code never branches on Provider identity.
 */
export function persistedProviderWorkspaceProof(store, input) {
  const logical = store.getLogicalSession(required(input?.logicalSessionId, "logicalSessionId"));
  const active = logical?.activeBinding;
  const providerBindingId = required(input?.providerBindingId, "providerBindingId");
  const bindingGeneration = positiveInteger(input?.bindingGeneration, "bindingGeneration");
  const expectedCwd = absolute(input?.workingDirectory);
  const actualCwd = active?.boundCwd ? absolute(active.boundCwd) : null;
  const startupBinding = store.selectOne(
    "SELECT * FROM work_session_startup_bindings WHERE provider_binding_id=?",
    [providerBindingId]
  );
  if (!logical || !active || actualCwd !== expectedCwd
    || !startupBinding
    || startupBinding.logical_session_id !== logical.logicalSessionId
    || startupBinding.binding_generation !== bindingGeneration
    || startupBinding.provider_id !== active.providerId
    || absolute(startupBinding.canonical_worktree_path) !== expectedCwd) {
    const error = new Error("Provider Session binding does not prove the requested working directory.");
    error.code = "START_PROVIDER_CWD_MISMATCH";
    error.statusCode = 409;
    error.retryable = true;
    throw error;
  }
  const trustedContextHash = required(input.trustedContextHash, "trustedContextHash");
  if (sha256(canonicalJson(input.trustedContext)) !== trustedContextHash
    || trustedContextHash !== startupBinding.provider_context_hash) {
    const error = new Error("Provider trusted context does not match the authoritative startup binding.");
    error.code = "START_PROVIDER_CONTEXT_MISMATCH";
    error.statusCode = 409;
    error.retryable = false;
    throw error;
  }
  return {
    providerBindingId,
    bindingGeneration,
    providerResourceId: required(active.providerSessionId, "providerResourceId"),
    canonicalWorkingDirectory: actualCwd,
    trustedContextHash,
    acceptedAt: new Date().toISOString()
  };
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(value, field) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${field} is required.`);
  return result;
}

function absolute(value) {
  const path = required(value, "workingDirectory");
  if (!path.startsWith("/")) throw new TypeError("workingDirectory must be absolute.");
  return resolve(path);
}

function positiveInteger(value, field) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new TypeError(`${field} must be a positive integer.`);
  return result;
}
