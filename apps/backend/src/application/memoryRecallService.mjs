const TRUSTED_SOURCE_TYPES = new Set(["user", "system", "consolidated", "pre_compaction"]);
const DEFAULT_STARTUP_LIMIT = 8;
const DEFAULT_TURN_LIMIT = 5;

export class MemoryRecallService {
  constructor({ store, hubService, clock = () => new Date().toISOString() } = {}) {
    if (!store) throw new TypeError("MemoryRecallService requires a store.");
    if (!hubService) throw new TypeError("MemoryRecallService requires a hubService.");
    this.store = store;
    this.hubService = hubService;
    this.clock = clock;
  }

  async startup(scope = {}, options = {}) {
    const limit = boundedLimit(options.limit, DEFAULT_STARTUP_LIMIT, 12);
    const candidates = this.#visibleActive(scope).filter(isTrustedMemory)
      .filter((memory) => Number(memory.confidence ?? 0) >= 0.7);
    const ranked = await this.hubService.rankMemory("", candidates, { allowEmbedding: false });
    return this.#record({
      sessionId: scope.sessionId,
      phase: "startup",
      mode: "bounded_trusted",
      reason: ranked.length ? "trusted_high_confidence" : "no_trusted_high_confidence_memory",
      candidates,
      selected: ranked.slice(0, limit).map((entry) => entry.memory),
      scope,
      touch: true
    });
  }

  async turn(message, scope = {}, options = {}) {
    const intent = String(message ?? "").trim();
    const trigger = options.explicit === true
      ? { triggered: true, reason: "explicit_memory_search", score: 1, termCount: intent.length ? 1 : 0 }
      : lightweightTrigger(intent);
    if (!trigger.triggered) {
      return this.#record({
        sessionId: scope.sessionId,
        phase: "turn",
        mode: "skipped",
        reason: trigger.reason,
        candidates: [],
        selected: [],
        scope,
        diagnostics: trigger,
        touch: false
      });
    }

    const deepRequested = options.deepRecall === true;
    const allowEmbedding = deepRequested && typeof this.hubService.embedder === "function";
    const candidates = this.#visibleActive(scope).filter(isTrustedMemory);
    const ranked = await this.hubService.rankMemory(intent, candidates, { allowEmbedding });
    const selected = ranked.filter((entry) => entry.score > 0)
      .slice(0, boundedLimit(options.limit, DEFAULT_TURN_LIMIT, 12))
      .map((entry) => entry.memory);
    const degraded = deepRequested && !allowEmbedding;
    return this.#record({
      sessionId: scope.sessionId,
      phase: "turn",
      mode: allowEmbedding ? "deep" : "lightweight",
      reason: degraded ? "deep_recall_unavailable_fell_back_to_lexical"
        : selected.length ? trigger.reason : "triggered_but_no_relevant_memory",
      candidates,
      selected,
      scope,
      diagnostics: { ...trigger, deepRequested, degraded },
      touch: true
    });
  }

  async explicitSearch(intent, scope = {}, options = {}) {
    return this.turn(intent, scope, {
      limit: options.limit ?? 20,
      deepRecall: options.deepRecall === true,
      explicit: true
    });
  }

  #visibleActive(scope) {
    const now = Date.parse(this.clock());
    const memories = [];
    // Order is intentional and is retained as a stable tie-breaker by rankMemory.
    if (scope.taskId) memories.push(...this.store.listMemoriesByOwner("task", scope.taskId));
    if (scope.workId) memories.push(...this.store.listMemoriesByOwner("work", scope.workId));
    if (scope.agentId) memories.push(...this.store.listMemoriesByOwner("agent", scope.agentId));
    return memories.filter((memory) => memory.promotion_status === "active" && !memory.revoked_at)
      .filter((memory) => !memory.expires_at || Date.parse(memory.expires_at) > now);
  }

  #record({ sessionId, phase, mode, reason, candidates, selected, scope, diagnostics = {}, touch }) {
    if (touch) {
      for (const memory of selected) this.store.touchMemory(memory.id);
    }
    const record = this.store.createMemoryRecallAudit({
      sessionId: sessionId ?? null,
      phase,
      mode,
      reason,
      scope,
      candidateIds: candidates.map((memory) => memory.id),
      selectedIds: selected.map((memory) => memory.id),
      diagnostics
    });
    return { ...record, memories: selected.map((memory) => this.store.getMemory(memory.id) ?? memory) };
  }
}

export function isTrustedMemory(memory) {
  const trust = String(memory?.trust_level ?? "").trim();
  if (trust) return trust === "trusted";
  return TRUSTED_SOURCE_TYPES.has(String(memory?.source_type ?? ""));
}

export function lightweightTrigger(message) {
  const text = String(message ?? "").trim();
  if (!text) return { triggered: false, reason: "empty_message", score: 0 };
  const terms = text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const recallCue = /\b(remember|recall|again|previous|preference|convention|before)\b|记得|回忆|之前|上次|偏好|惯例|约定/u.test(text);
  const taskCue = /\b(how|why|fix|implement|build|test|debug|continue|resume)\b|如何|为什么|修复|实现|测试|调试|继续|恢复/u.test(text);
  const score = Math.min(1, (recallCue ? 0.65 : 0) + (taskCue ? 0.25 : 0) + (terms.length >= 4 ? 0.15 : 0));
  return {
    triggered: recallCue || (taskCue && terms.length >= 4),
    reason: recallCue ? "explicit_recall_cue" : taskCue && terms.length >= 4 ? "task_context_cue" : "no_recall_cue",
    score,
    termCount: terms.length
  };
}

function boundedLimit(value, fallback, ceiling) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(ceiling, Math.floor(parsed))) : fallback;
}
