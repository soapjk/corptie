import { cosineSimilarity, localBagOfWordsEmbedder } from "./hubService.mjs";
import { MEMORY_TOPICS, MEMORY_CONTEXTS } from "./memoryTaxonomy.mjs";

const TOPICS = new Set(MEMORY_TOPICS);
const CONTEXTS = new Set(MEMORY_CONTEXTS);

// Session topic state is an aid to ranking, never an authorization or hard filter.
export class MemoryTopicService {
  constructor({ store, classify = null, clock = () => Date.now() } = {}) {
    this.store = store;
    this.classify = classify;
    this.clock = clock;
    this.inFlight = new Set();
  }

  async update(session, message) {
    if (!session?.id) return { topics: [], contexts: [], keywords: [] };
    const text = String(message ?? "").trim();
    const previous = this.store.getSessionMemoryTopics(session.id)?.profile ?? null;
    if (!text || text === previous?.lastMessage) {
      return { topics: previous?.topics ?? [], contexts: previous?.contexts ?? [],
        keywords: previous?.keywords ?? [] };
    }
    const similarity = previous?.lastClassifiedMessage
      ? cosineSimilarity(localBagOfWordsEmbedder(text), localBagOfWordsEmbedder(previous.lastClassifiedMessage)) : 0;
    const turns = Number(previous?.turnsSinceClassification ?? 0) + 1;
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    const classifiedToday = previous?.classificationDay === day
      ? Number(previous.classificationCount ?? 0) : 0;
    const shortFollowUp = text.length < 4 && previous?.lastClassifiedMessage;
    const changedTopic = !shortFollowUp && similarity < 0.25;
    const shouldClassify = classifiedToday < 6 && (!previous || turns >= 12 || changedTopic);
    let classification = null;
    if (shouldClassify && typeof this.classify === "function" && !this.inFlight.has(session.id)) {
      const task = session.taskId ? this.store.getTask(session.taskId) : null;
      const work = session.workId ? this.store.getWork(session.workId) : null;
      this.inFlight.add(session.id);
      try {
        classification = await this.classify({ message: text, previous, taskTitle: task?.title ?? "",
          workName: work?.name ?? "" });
      } catch { /* Unknown applicability must not become a Global active preference. */ }
      finally { this.inFlight.delete(session.id); }
    }
    const classifiedTopics = validList(classification?.topics, TOPICS, 3);
    const classifiedContexts = validList(classification?.contexts, CONTEXTS, 4);
    if (!classifiedTopics || !classifiedContexts) classification = null;
    const uncertainSwitch = changedTopic && !classification;
    const topics = classifiedTopics ?? (uncertainSwitch ? [] : previous?.topics ?? []);
    const contexts = classifiedContexts ?? (uncertainSwitch ? [] : previous?.contexts ?? []);
    const keywords = Array.isArray(classification?.keywords)
      ? classification.keywords.filter((value) => typeof value === "string" && value.length <= 64).slice(0, 8)
      : uncertainSwitch ? [] : previous?.keywords ?? [];
    const profile = { topics, contexts, keywords, lastMessage: text.slice(0, 500),
      lastClassifiedMessage: classification ? text.slice(0, 500) : previous?.lastClassifiedMessage ?? null,
      turnsSinceClassification: classification ? 0 : turns,
      classificationDay: day,
      classificationCount: classifiedToday + (shouldClassify && typeof this.classify === "function" ? 1 : 0),
      updatedAt: this.clock() };
    this.store.upsertSessionMemoryTopics(session.id, profile);
    return profile;
  }
}

export function createMemoryTopicClassifier({ backgroundAgent, cwd = process.cwd() } = {}) {
  return async (input) => {
    const providerId = backgroundAgent.capabilityProviderId?.() ?? null;
    backgroundAgent.selectProvider?.(providerId, "read-only", { allowFallback: false, executionPolicy: "no-tools" });
    const result = await backgroundAgent.run({ purpose: "memory-topic-classification", cwd,
      allowedRoots: [], permissionProfile: "read-only", executionPolicy: "no-tools",
      preferredProviderId: providerId, allowProviderFallback: false, preferredReasoning: "low", timeoutMs: 20_000,
      developerInstructions: `Classify the CURRENT user message using prior topic, Task title and Work name as context. `
        + `Do not infer topic from rigid keywords. Return JSON only: {"topics":[],"contexts":[],"keywords":[]}. `
        + `Topics: ${MEMORY_TOPICS.join(", ")}. Contexts: ${MEMORY_CONTEXTS.join(", ")}. `
        + `Keep up to 3 topics and 4 contexts; use empty arrays when uncertain.`,
      prompt: JSON.stringify(input),
      validateOutput: (text) => {
        const value = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
        if (!validList(value.topics, TOPICS, 3) || !validList(value.contexts, CONTEXTS, 4)
          || !Array.isArray(value.keywords)) throw new Error("Invalid Memory topic classification.");
        return value;
      }
    });
    return result.validatedOutput;
  };
}

function validList(value, allowed, limit) {
  return Array.isArray(value) && value.length <= limit && value.every((item) => allowed.has(item))
    ? [...new Set(value)] : null;
}
