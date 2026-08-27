export function hasCodexSessionRuntimeConfig(session) {
  return Boolean(
    nonEmptyText(session?.external?.currentModel ?? session?.currentModel)
    && nonEmptyText(session?.external?.currentReasoningLevel ?? session?.currentReasoningLevel)
  );
}

export function withCodexSessionRuntimeConfig(session, runtime = {}) {
  const currentModel = nonEmptyText(
    session?.external?.currentModel
      ?? session?.currentModel
      ?? runtime.model
  );
  const currentReasoningLevel = nonEmptyText(
    session?.external?.currentReasoningLevel
      ?? session?.currentReasoningLevel
      ?? runtime.reasoningLevel
  )?.toLowerCase() ?? null;

  return {
    ...session,
    external: {
      ...(session?.external ?? {}),
      currentModel,
      currentReasoningLevel
    }
  };
}

export function codexTurnRuntimeConfig(session, fallback = {}) {
  return {
    model: nonEmptyText(session?.external?.currentModel) ?? nonEmptyText(fallback.model) ?? undefined,
    reasoningEffort: nonEmptyText(session?.external?.currentReasoningLevel)?.toLowerCase()
      ?? nonEmptyText(fallback.reasoningEffort)?.toLowerCase()
      ?? undefined
  };
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
