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
  "For each item provide eventSequence, exact evidence, content, kind, scope, scopeRationale, rationale, confidence in [0,1], conflict boolean, primaryTopic, secondaryTopics, keywords, appliesTo, deliveryMode.",
  "Allowed topics: personal, life, fitness_health, work_project, programming, communication, product, finance, learning_creative, other. Pick one primary topic and at most two secondary topics. Keywords are project or technology names, not topics.",
  "Allowed applicability: all, development, fitness, personal, work, finance, creative. Use applicable_preference only for a durable Global preference explicitly stated by the user with a clear applicable context. All other memories use on_demand.",
  "High confidence means the source unambiguously supports a durable memory, not merely that the wording is plausible.",
  "Reply with JSON only: {\"memories\":[{\"eventSequence\":1,\"evidence\":\"...\",\"content\":\"...\",\"kind\":\"preference\",\"scope\":\"global\",\"scopeRationale\":\"...\",\"rationale\":\"...\",\"confidence\":0.99,\"conflict\":false,\"primaryTopic\":\"programming\",\"secondaryTopics\":[],\"keywords\":[],\"appliesTo\":[\"development\"],\"deliveryMode\":\"applicable_preference\"}]}"
].join("\n");

export function createMemoryModelClassifier({ backgroundAgent, cwd = process.cwd(),
  claimBudget = () => true, refundBudget = () => {} } = {}) {
  if (!backgroundAgent || typeof backgroundAgent.run !== "function") {
    throw new TypeError("Memory classifier requires the provider-neutral background Agent service.");
  }
  return async (events, { scope, existing }) => {
    const providerId = backgroundAgent.capabilityProviderId?.() ?? null;
    backgroundAgent.selectProvider?.(providerId, "read-only", {
      allowFallback: false, executionPolicy: "no-tools"
    });
    const budgetDay = new Date().toISOString().slice(0, 10);
    if (!claimBudget(budgetDay)) {
      throw Object.assign(new Error("Daily Memory model call budget reached."),
        { code: "MEMORY_DAILY_CALL_BUDGET" });
    }
    let result;
    try {
      result = await backgroundAgent.run({
        purpose: "memory-extraction", cwd, allowedRoots: [],
        permissionProfile: "read-only", executionPolicy: "no-tools",
        preferredProviderId: providerId, allowProviderFallback: false,
        preferredReasoning: "low", timeoutMs: 90_000,
        developerInstructions: INSTRUCTIONS,
        prompt: JSON.stringify({ scope, events,
          existing: compactMemories(existing.filter((memory) =>
            memory.promotion_status === "active" && !memory.revoked_at), 6000),
          suppressed: compactMemories(existing.filter((memory) => memory.revoked_at
            || ["archived", "rolled_back"].includes(memory.promotion_status)), 4000) }),
        validateOutput: (text) => parseMemoryModelOutput(text)
      });
    } catch (error) {
      // These failures occur before a model request can be dispatched. Keep the
      // daily counter for requests whose dispatch status is uncertain.
      if (["BACKGROUND_NO_TOOLS_RUNTIME_UNVERIFIED", "BACKGROUND_AGENT_UNAVAILABLE",
        "BACKGROUND_EXECUTION_DISABLED"].includes(error?.code)) refundBudget(budgetDay);
      throw error;
    }
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

export function createLegacyMemoryClassifier({ backgroundAgent, cwd = process.cwd(),
  claimBudget = () => true, refundBudget = () => {} } = {}) {
  return async (memories) => {
    const providerId = backgroundAgent.capabilityProviderId?.() ?? null;
    backgroundAgent.selectProvider?.(providerId, "read-only", {
      allowFallback: false, executionPolicy: "no-tools"
    });
    const day = new Date().toISOString().slice(0, 10);
    if (!claimBudget(day)) throw Object.assign(new Error("Daily Memory model call budget reached."),
      { code: "MEMORY_DAILY_CALL_BUDGET" });
    let result;
    try {
      result = await backgroundAgent.run({ purpose: "memory-legacy-classification", cwd,
        allowedRoots: [], permissionProfile: "read-only", executionPolicy: "no-tools",
        preferredProviderId: providerId, allowProviderFallback: false,
        preferredReasoning: "low", timeoutMs: 90_000,
        developerInstructions: `Classify existing memories without changing their content or scope. `
          + `Return one result per id, JSON only: {"items":[{"id":"...","primaryTopic":"personal",`
          + `"secondaryTopics":[],"keywords":[],"appliesTo":[],"deliveryMode":"on_demand",`
          + `"confidence":0.99}]}. Topics: personal, life, fitness_health, work_project, programming, `
          + `communication, product, finance, learning_creative, other. Contexts: all, development, `
          + `fitness, personal, work, finance, creative. Use applicable_preference only if this is a `
          + `Global preference directly supported by user evidence. All other entries must be on_demand.`,
        prompt: JSON.stringify(memories.map((memory) => ({ id: memory.id, content: memory.content,
          kind: memory.kind, scope: memory.owner_type, sourceType: memory.source_type,
          evidence: (() => { try { return JSON.parse(memory.structured_json || "{}").extraction?.evidence ?? null; }
            catch { return null; } })() }))),
        validateOutput: (text) => {
          const parsed = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
          if (!Array.isArray(parsed.items) || parsed.items.length !== memories.length
            || new Set(parsed.items.map((item) => item.id)).size !== memories.length) {
            throw new Error("Invalid legacy Memory classification set.");
          }
          return parsed.items;
        }
      });
    } catch (error) {
      if (["BACKGROUND_NO_TOOLS_RUNTIME_UNVERIFIED", "BACKGROUND_AGENT_UNAVAILABLE",
        "BACKGROUND_EXECUTION_DISABLED"].includes(error?.code)) refundBudget(day);
      throw error;
    }
    return result.validatedOutput;
  };
}
