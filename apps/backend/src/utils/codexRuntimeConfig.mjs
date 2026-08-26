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

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
