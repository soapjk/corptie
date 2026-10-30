import { cosineSimilarity, localBagOfWordsEmbedder } from "./hubService.mjs";
import { MEMORY_TOPICS, MEMORY_CONTEXTS } from "./memoryTaxonomy.mjs";

const TOPICS = new Set(MEMORY_TOPICS);
const CONTEXTS = new Set(MEMORY_CONTEXTS);

// Session topic state is an aid to ranking, never an authorization or hard filter.
export class MemoryTopicService {
  constructor({ store, classify = null, clock = () => Date.now(), concurrency = 2, pendingLimit = 64 } = {}) {
    Object.assign(this, { store, classify, clock, concurrency, pendingLimit });
    this.inFlight = new Map();
    this.pending = new Map();
    this.scheduled = false;
    this.closed = false;
  }

  // Read-only and bounded: ordinary dispatch must never invoke a model here.
  profileForMessage(session, message) {
    const text = String(message ?? "").trim().slice(0, 8192);
    const previous = session?.id ? this.store.getSessionMemoryTopics(session.id)?.profile : null;
    return this.#decision(text, previous).profile;
  }

  requestUpdate(session, message, requestId = null) {
    if (this.closed || !session?.id) return;
    // Copy the bounded text so a small pending job cannot retain a huge input string.
    const text = Buffer.from(String(message ?? "").trim().slice(0, 8192)).toString();
    if (!text) {
      this.inFlight.get(session.id)?.controller.abort();
      this.pending.get(session.id)?.resolve(null);
      this.pending.delete(session.id);
      return;
    }
    const route = this.#route(session.id);
    const old = this.pending.get(session.id);
    if (old?.text === text && this.#sameRoute(old.route, route)
      && (requestId ? old.requestId === requestId : !old.requestId && !this.inFlight.has(session.id))
      && ["agentId", "workId", "taskId", "sessionKind"].every(key => old.session[key] === session[key])) return;
    old?.resolve(null);
    this.inFlight.get(session.id)?.controller.abort();
    if (!old && this.pending.size >= this.pendingLimit) {
      const evicted = [...this.pending.values()].find(job => !this.inFlight.has(job.session.id));
      if (!evicted) return;
      this.pending.delete(evicted.session.id);
      evicted.resolve(null);
    }
    let resolve;
    const completion = new Promise(done => { resolve = done; });
    this.pending.set(session.id, { session, text, route, requestId, ready: false, resolve, completion,
      turns: (old?.turns ?? this.store.getSessionMemoryTopics(session.id)?.profile?.turnsSinceClassification ?? 0) + 1,
      controller: new AbortController() });
  }

  // Called after committed settlement. Never await it from event projection.
  flushPending(sessionId) {
    const job = this.pending.get(sessionId);
    if (!job || this.closed) return Promise.resolve(null);
    job.ready = true;
    this.#schedule();
    return job.completion;
  }

  // Retained for explicit callers/tests; normal message assembly uses the read-only path.
  async update(session, message) {
    this.requestUpdate(session, message);
    return await this.flushPending(session?.id) ?? this.profileForMessage(session, message);
  }

  close() {
    this.closed = true;
    for (const job of this.pending.values()) { job.controller.abort(); job.resolve(null); }
    this.pending.clear();
  }

  #decision(text, previous) {
    const same = !text || text === previous?.lastMessage;
    const short = text.length < 4 && previous?.lastClassifiedMessage;
    const changed = !same && !short && (!previous?.lastClassifiedMessage
      || cosineSimilarity(localBagOfWordsEmbedder(text), localBagOfWordsEmbedder(previous.lastClassifiedMessage)) < 0.25);
    const profile = { topics: changed ? [] : previous?.topics ?? [],
      contexts: changed ? [] : previous?.contexts ?? [], keywords: changed ? [] : previous?.keywords ?? [] };
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    const count = previous?.classificationDay === day ? Number(previous.classificationCount ?? 0) : 0;
    return { profile, changed, same, day, count };
  }

  #route(id) {
    const route = this.store.getLogicalSessionByLegacySessionId?.(id);
    return route ? { id: route.id, threadId: route.activeThreadId, version: route.routingVersion } : null;
  }

  #sameRoute(a, b) {
    return a?.id === b?.id && a?.threadId === b?.threadId && a?.version === b?.version;
  }

  #current(job) {
    if (this.closed) return false;
    const current = this.store.getSession ? this.store.getSession(job.session.id) : job.session;
    return !this.closed && this.pending.get(job.session.id) === job && current && current.archived !== true
      && ["agentId", "workId", "taskId", "sessionKind"].every(key => current[key] === job.session[key])
      && this.#sameRoute(job.route, this.#route(job.session.id));
  }

  #idle(job) {
    const current = this.store.getSession?.(job.session.id) ?? job.session;
    return current.status !== "running" && !this.store.getRunningAgentTaskForSession?.(job.session.id)
      && !(this.store.listQueuedAgentTasksForSession?.(job.session.id, 1)?.length > 0);
  }

  #schedule() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      for (const job of this.pending.values()) {
        if (this.inFlight.size >= this.concurrency) break;
        if (!job.ready || this.inFlight.has(job.session.id)) continue;
        if (!this.#current(job)) { this.pending.delete(job.session.id); job.resolve(null); continue; }
        if (!this.#idle(job)) continue;
        this.inFlight.set(job.session.id, job);
        void this.#run(job).catch(() => {
          console.warn("[memory-topic] background update failed");
        }).finally(() => {
          if (this.inFlight.get(job.session.id) === job) this.inFlight.delete(job.session.id);
          if (this.pending.get(job.session.id) === job) this.pending.delete(job.session.id);
          job.resolve(null);
          this.#schedule();
        });
      }
    });
  }

  async #run(job) {
    const startedAt = this.clock();
    const previous = this.store.getSessionMemoryTopics(job.session.id)?.profile ?? null;
    const text = job.text.slice(0, 500);
    const decision = this.#decision(job.text, previous);
    const shouldClassify = !decision.same && decision.count < 6 && typeof this.classify === "function"
      && (!previous || job.turns >= 12 || decision.changed);
    // Keep the existing profile writer and daily attempt accounting, even if
    // a later message supersedes a slow classifier. No new durable queue.
    const profile = { ...decision.profile, lastMessage: text,
      lastClassifiedMessage: previous?.lastClassifiedMessage ?? null,
      turnsSinceClassification: job.turns, classificationDay: decision.day,
      classificationCount: decision.count + Number(shouldClassify), updatedAt: this.clock() };
    this.store.upsertSessionMemoryTopics(job.session.id, profile);
    if (!shouldClassify) { job.resolve(profile); return; }
    let classification;
    try {
      classification = await this.classify({ message: job.text, previous,
        taskTitle: job.session.taskId ? this.store.getTask(job.session.taskId)?.title ?? "" : "",
        workName: job.session.workId ? this.store.getWork(job.session.workId)?.name ?? "" : "" },
      { signal: job.controller.signal });
    } catch { /* Optional enrichment cannot fail an ordinary message. */ }
    const topics = validList(classification?.topics, TOPICS, 3);
    const contexts = validList(classification?.contexts, CONTEXTS, 4);
    if (!this.#current(job) || !this.#idle(job) || job.controller.signal.aborted) {
      console.info(`[memory-topic] ${JSON.stringify({ sessionId: job.session.id, outcome: "superseded", durationMs: this.clock() - startedAt })}`);
      return;
    }
    if (topics && contexts) {
      Object.assign(profile, { topics, contexts, keywords: Array.isArray(classification.keywords)
        ? classification.keywords.filter(value => typeof value === "string" && value.length <= 64).slice(0, 8) : [],
      lastClassifiedMessage: text, turnsSinceClassification: 0, updatedAt: this.clock() });
      this.store.upsertSessionMemoryTopics(job.session.id, profile);
    }
    console.info(`[memory-topic] ${JSON.stringify({ sessionId: job.session.id,
      outcome: topics && contexts ? "completed" : "unavailable", durationMs: this.clock() - startedAt })}`);
    job.resolve(profile);
  }
}

export function createMemoryTopicClassifier({ backgroundAgent, cwd = process.cwd() } = {}) {
  return async (input, { signal } = {}) => {
    const providerId = backgroundAgent.capabilityProviderId?.() ?? null;
    backgroundAgent.selectProvider?.(providerId, "read-only", { allowFallback: false, executionPolicy: "no-tools" });
    const result = await backgroundAgent.run({ purpose: "memory-topic-classification", cwd,
      signal, allowedRoots: [], permissionProfile: "read-only", executionPolicy: "no-tools",
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
