export const MEMORY_TOPICS = Object.freeze([
  "personal", "life", "fitness_health", "work_project", "programming",
  "communication", "product", "finance", "learning_creative", "other"
]);
export const MEMORY_CONTEXTS = Object.freeze([
  "all", "development", "fitness", "personal", "work", "finance", "creative"
]);

const TOPICS = new Set(MEMORY_TOPICS);
const CONTEXTS = new Set(MEMORY_CONTEXTS);

export function validateMemoryClassification(input = {}, { extracted = false } = {}) {
  const topic = input.primaryTopic ?? null;
  const secondaryTopics = input.secondaryTopics ?? [];
  const keywords = input.keywords ?? [];
  const appliesTo = input.appliesTo ?? [];
  const deliveryMode = input.deliveryMode ?? "on_demand";
  if (topic !== null && !TOPICS.has(topic)) throw invalid("Invalid primary Memory topic.");
  if (!Array.isArray(secondaryTopics) || secondaryTopics.length > 2
    || secondaryTopics.some((value) => !TOPICS.has(value) || value === topic)
    || new Set(secondaryTopics).size !== secondaryTopics.length) throw invalid("Invalid secondary Memory topics.");
  if (!Array.isArray(keywords) || keywords.length > 8
    || keywords.some((value) => typeof value !== "string" || !value.trim() || value.length > 64)) {
    throw invalid("Invalid Memory keywords.");
  }
  if (!Array.isArray(appliesTo) || appliesTo.length > 4
    || appliesTo.some((value) => !CONTEXTS.has(value))
    || new Set(appliesTo).size !== appliesTo.length) throw invalid("Invalid Memory applicability.");
  if (!["on_demand", "applicable_preference"].includes(deliveryMode)) throw invalid("Invalid Memory delivery mode.");
  if (deliveryMode === "applicable_preference"
    && (input.kind !== "preference" || input.ownerType !== "global" || appliesTo.length === 0)) {
    throw invalid("Only scoped Global preferences can be actively applied.");
  }
  if (extracted && deliveryMode === "applicable_preference" && input.userEvidence !== true) {
    throw invalid("Extracted active preferences require direct user evidence.");
  }
  return { primaryTopic: topic, secondaryTopics, keywords: [...new Set(keywords.map((s) => s.trim()))],
    appliesTo, deliveryMode };
}

export function parseMemoryClassification(memory) {
  const parse = (value) => { try { return JSON.parse(value || "[]"); } catch { return []; } };
  return {
    primaryTopic: memory.primary_topic ?? null,
    secondaryTopics: parse(memory.secondary_topics_json),
    keywords: parse(memory.keywords_json),
    appliesTo: parse(memory.applies_to_json),
    deliveryMode: memory.delivery_mode ?? "on_demand"
  };
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_MEMORY_CLASSIFICATION", status: 400 });
}
