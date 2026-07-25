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

export function readLatestCodexRuntimeConfigFromRollout(text) {
  let model = null;
  let reasoningLevel = null;

  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes('"turn_context"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "turn_context") continue;
      model = nonEmptyText(entry.payload?.model) ?? model;
      reasoningLevel = nonEmptyText(
        entry.payload?.effort
          ?? entry.payload?.reasoning_effort
          ?? entry.payload?.model_reasoning_effort
          ?? entry.payload?.reasoningEffort
      )?.toLowerCase() ?? reasoningLevel;
    } catch {
      // Ignore partially written rollout lines and keep the latest valid context.
    }
  }

  return model || reasoningLevel ? { model, reasoningLevel } : null;
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
