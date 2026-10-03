const INSTRUCTIONS = [
  "Extract only durable, reusable memories from this Session window.",
  "Decide semantically; do not infer durability from keywords or event names.",
  "Ignore tool execution, progress chatter, temporary requests, quotes offered as examples, and unsupported claims.",
  "Do not retain credentials, tokens, one-time codes, or sensitive personal details as automatic memories.",
  "Return zero items when nothing deserves long-term recall. Keep each item atomic.",
  "Choose scope independently of kind: task, work, or global. Global is only for a user's durable cross-project preferences or other genuinely cross-project knowledge.",
  "Do not turn assistant statements into user preferences. Assistant-derived claims should be conservative.",
  "Compare proposed content with existing memories. Set conflict=true if it might contradict an active memory or you are unsure.",
  "Never re-propose a memory equivalent to a revoked, rejected or archived item; those are explicit suppression evidence.",
  "For each item provide eventSequence, an exact evidence substring from that event, concise content, kind, scope, scopeRationale, rationale, confidence in [0,1], conflict boolean.",
  "High confidence means the source unambiguously supports a durable memory, not merely that the wording is plausible.",
  "Reply with JSON only: {\"memories\":[{\"eventSequence\":1,\"evidence\":\"...\",\"content\":\"...\",\"kind\":\"preference\",\"scope\":\"global\",\"scopeRationale\":\"...\",\"rationale\":\"...\",\"confidence\":0.99,\"conflict\":false}]}"
].join("\n");

export function createMemoryModelClassifier({ backgroundAgent, cwd = process.cwd(),
  claimBudget = () => true } = {}) {
  if (!backgroundAgent || typeof backgroundAgent.run !== "function") {
    throw new TypeError("Memory classifier requires the provider-neutral background Agent service.");
  }
  return async (events, { scope, existing }) => {
    const providerId = backgroundAgent.resolveProviderId?.(scope.providerId) ?? scope.providerId;
    backgroundAgent.selectProvider?.(providerId, "read-only", {
      allowFallback: false, executionPolicy: "no-tools"
    });
    if (!claimBudget()) {
      throw Object.assign(new Error("Daily Memory model call budget reached."),
        { code: "MEMORY_DAILY_CALL_BUDGET" });
    }
    const result = await backgroundAgent.run({
      purpose: "memory-extraction", cwd, allowedRoots: [],
      permissionProfile: "read-only", executionPolicy: "no-tools",
      preferredProviderId: scope.providerId, allowProviderFallback: false,
      preferredReasoning: "low", timeoutMs: 90_000,
      developerInstructions: INSTRUCTIONS,
      prompt: JSON.stringify({ scope, events,
        existing: compactMemories(existing.filter((memory) =>
          memory.promotion_status === "active" && !memory.revoked_at), 6000),
        suppressed: compactMemories(existing.filter((memory) => memory.revoked_at
          || ["archived", "rolled_back"].includes(memory.promotion_status)), 4000) }),
      validateOutput: (text) => parseMemoryModelOutput(text)
    });
    return result.validatedOutput;
  };
}

function compactMemories(memories, maxChars) {
  const output = [];
  let used = 0;
  for (const memory of memories) {
    const content = String(memory.content ?? "").slice(0, 250);
    if (used + content.length > maxChars) break;
    output.push({ scope: memory.owner_type, content });
    used += content.length;
  }
  return output;
}

export function parseMemoryModelOutput(text) {
  const raw = String(text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw Object.assign(new Error("Memory model returned invalid JSON."), { code: "MEMORY_MODEL_INVALID_OUTPUT" });
  }
  if (!Array.isArray(parsed?.memories) || parsed.memories.length > 20) {
    throw Object.assign(new Error("Memory model returned an invalid proposal set."), { code: "MEMORY_MODEL_INVALID_OUTPUT" });
  }
  return parsed.memories;
}
