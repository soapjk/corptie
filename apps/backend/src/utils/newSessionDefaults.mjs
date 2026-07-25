import {
  normalizeCodexApprovalPolicy,
  normalizeCodexSandbox
} from "./codexPermissions.mjs";

export function normalizeNewSessionDefaults(input = {}) {
  return {
    sandbox: normalizeCodexSandbox(input.sandbox),
    approvalPolicy: normalizeCodexApprovalPolicy(input.approvalPolicy),
    codexModel: nonEmptyText(input.codexModel),
    codexReasoningLevel: nonEmptyText(input.codexReasoningLevel)?.toLowerCase() ?? null,
    claudeModel: nonEmptyText(input.claudeModel)
  };
}

export function resolveNewCodexRuntimeConfig({
  request = {},
  defaults = {},
  currentConfig = {},
  models = []
} = {}) {
  const normalizedDefaults = normalizeNewSessionDefaults(defaults);
  const model = firstText(
    request.model,
    normalizedDefaults.codexModel,
    currentConfig.model,
    models[0]?.id
  );
  const selectedModel = models.find((candidate) => candidate?.id === model) ?? null;
  const reasoningLevels = Array.isArray(selectedModel?.reasoningLevels)
    ? selectedModel.reasoningLevels.map((level) => nonEmptyText(level)?.toLowerCase()).filter(Boolean)
    : [];
  const requestedReasoning = firstText(
    request.reasoningLevel,
    normalizedDefaults.codexReasoningLevel,
    currentConfig.reasoningLevel
  )?.toLowerCase() ?? null;
  const defaultReasoning = nonEmptyText(selectedModel?.defaultReasoningLevel)?.toLowerCase() ?? null;

  let reasoningLevel = requestedReasoning;
  if (reasoningLevels.length > 0 && !reasoningLevels.includes(reasoningLevel)) {
    reasoningLevel = reasoningLevels.includes(defaultReasoning)
      ? defaultReasoning
      : (reasoningLevels.includes("medium") ? "medium" : reasoningLevels[0]);
  } else if (!reasoningLevel) {
    reasoningLevel = defaultReasoning;
  }

  return {
    model,
    reasoningLevel
  };
}

function firstText(...values) {
  for (const value of values) {
    const normalized = nonEmptyText(value);
    if (normalized) return normalized;
  }
  return null;
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
