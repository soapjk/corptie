const TRUSTED_SOURCE_TYPES = new Set(["user", "system", "consolidated", "pre_compaction"]);
const DEFAULT_STARTUP_LIMIT = 8;
const DEFAULT_TURN_LIMIT = 5;
const AUDIT_CANDIDATE_PREVIEW_LIMIT = 20;

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
    const intent = String(options.intent ?? "").trim();
    const visible = this.#visible(scope).filter((memory) => !options.excludeIds?.has(memory.id));
    const candidates = visible.filter(isRecallableMemory);
    const ranked = intent ? await this.hubService.rankMemory(intent, candidates,
      { allowEmbedding: options.deepRecall === true, profile: options.profile }) : [];
    const selected = ranked.filter((entry) => entry.score >= 0.18).slice(0, limit).map((entry) => entry.memory);
    return this.#record({
      sessionId: scope.sessionId,
      phase: "startup",
      mode: "bounded_trusted",
      reason: selected.length ? "relevant_startup_memory" : "no_relevant_startup_memory",
      candidates,
      selected,
      scope,
      diagnostics: { pendingReviewCount: pendingReviewCount(visible), profile: options.profile ?? null },
      touch: false
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
    const visible = this.#visible(scope).filter((memory) => !options.excludeIds?.has(memory.id));
    const candidates = visible.filter(isRecallableMemory);
    const ranked = await this.hubService.rankMemory(intent, candidates,
      { allowEmbedding, profile: options.profile });
    const selected = ranked.filter((entry) => entry.score >= 0.18)
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
      diagnostics: { ...trigger, deepRequested, degraded, pendingReviewCount: pendingReviewCount(visible),
        profile: options.profile ?? null },
      touch: false
    });
  }

  async explicitSearch(intent, scope = {}, options = {}) {
    return this.turn(intent, scope, {
      limit: options.limit ?? 20,
      deepRecall: options.deepRecall === true,
      profile: null,
      explicit: true
    });
  }

  applicablePreferences(scope = {}, profile = {}) {
    const contexts = new Set(profile.contexts ?? []);
    const selected = this.#visible(scope).filter((memory) =>
      memory.owner_type === "global" && memory.kind === "preference"
      && memory.delivery_mode === "applicable_preference" && isRecallableMemory(memory)
      && safeArray(memory.applies_to_json).some((context) => context === "all" || contexts.has(context)));
    if (!selected.length) return null;
    selected.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))
      || left.id.localeCompare(right.id));
    return this.#record({
      sessionId: scope.sessionId,
      phase: "global_preference",
      mode: "always_on",
      reason: "applicable_global_preference",
      candidates: selected,
      selected,
      scope,
      touch: false
    });
  }

  globalPreferences(scope = {}, profile = {}) {
    return this.applicablePreferences(scope, profile);
  }

  markInjection(recall, status) {
    if (!recall?.id) return false;
    const updated = this.store.updateMemoryRecallAuditInjection(recall.id, status);
    if (updated && status === "provider_accepted") {
      for (const id of recall.selectedIds ?? []) this.store.touchMemory(id);
    }
    return updated;
  }

  hasStartupRecall(sessionId) {
    return this.store.hasMemoryStartupRecall(sessionId);
  }

  #visible(scope) {
    const now = Date.parse(this.clock());
    const memories = [];
    // Order is intentional and is retained as a stable tie-breaker by rankMemory.
    if (scope.taskId) memories.push(...this.store.listMemoriesByOwner("task", scope.taskId));
    if (scope.workId) memories.push(...this.store.listMemoriesByOwner("work", scope.workId));
    memories.push(...this.store.listMemoriesByOwner("global", "user:local"));
    if (scope.agentId) memories.push(...this.store.listMemoriesByOwner("agent", scope.agentId));
    return memories.filter((memory) => !memory.revoked_at)
      .filter((memory) => !memory.expires_at || Date.parse(memory.expires_at) > now);
  }

  #record({ sessionId, phase, mode, reason, candidates, selected, scope, diagnostics = {}, touch }) {
    void touch;
    const selectedEntries = selected.map((memory) => memoryRecallEntry(memory, true));
    const candidateEntries = candidates.slice(0, AUDIT_CANDIDATE_PREVIEW_LIMIT)
      .map((memory) => memoryRecallEntry(memory, true));
    const record = this.store.createMemoryRecallAudit({
      sessionId: sessionId ?? null,
      phase,
      mode,
      reason,
      scope,
      candidateIds: candidates.map((memory) => memory.id),
      selectedIds: selected.map((memory) => memory.id),
      diagnostics: { ...diagnostics, selectedEntries, candidateEntries }
    });
    return { ...record, memories: selected.map((memory) => this.store.getMemory(memory.id) ?? memory) };
  }
}

export function presentMemoryRecallAudit(store, audit) {
  const snapshots = Array.isArray(audit.diagnostics?.selectedEntries)
    ? new Map(audit.diagnostics.selectedEntries.map((entry) => [entry.id, entry]))
    : new Map();
  return {
    ...audit,
    injectionStatus: audit.diagnostics?.injection?.status ?? "not_recorded",
    pendingReviewCount: Number(audit.diagnostics?.pendingReviewCount ?? 0),
    candidateEntries: Array.isArray(audit.diagnostics?.candidateEntries)
      ? audit.diagnostics.candidateEntries
      : audit.candidateIds.slice(0, AUDIT_CANDIDATE_PREVIEW_LIMIT).map((id) => {
        const current = store.getMemory(id);
        return current ? memoryRecallEntry(current, false)
          : { id, kind: null, content: null, ownerType: null, ownerId: null, snapshotAtRecall: false };
      }),
    selectedEntries: audit.selectedIds.map((id) => {
      const snapshot = snapshots.get(id);
      if (snapshot) return snapshot;
      const current = store.getMemory(id);
      return current ? memoryRecallEntry(current, false)
        : { id, kind: null, content: null, ownerType: null, ownerId: null, snapshotAtRecall: false };
    })
  };
}

export function presentSessionMemoryHits(store, sessionId) {
  return store.listSessionMemoryHits(sessionId).map(hit => ({ ...presentSessionMemoryHit(store, hit),
    lastHitAt: hit.lastHitAt, hitReason: hit.reason ?? null }));
}

export function presentSessionMemoryHit(store, hit) {
    const snapshot = Array.isArray(hit.diagnostics?.selectedEntries)
      ? hit.diagnostics.selectedEntries.find((entry) => entry.id === hit.memoryId)
      : null;
    if (snapshot) return snapshot;
    const current = store.getMemory(hit.memoryId);
    return current ? memoryRecallEntry(current, false)
      : { id: hit.memoryId, kind: null, content: null,
        ownerType: null, ownerId: null, snapshotAtRecall: false };
}

export function presentSessionMemoryHitsPage(store, sessionId, options) {
  const page = store.listSessionMemoryHitsPage(sessionId, options);
  return { ...page, items: page.items.map(hit => {
    const entry = presentSessionMemoryHit(store, hit), current = store.getMemory(hit.memoryId);
    const unavailable = !current || Boolean(current.revoked_at);
    return { ...entry, content: unavailable ? null : entry.content, unavailable,
      lastHitAt: hit.lastHitAt, hitReason: hit.reason ?? null };
  }) };
}

function isRecallableMemory(memory) {
  return memory.promotion_status === "active" && isTrustedMemory(memory);
}

function pendingReviewCount(memories) {
  return memories.filter((memory) => memory.source_type === "extracted"
    && memory.promotion_status === "candidate").length;
}

function memoryRecallEntry(memory, snapshotAtRecall) {
  return {
    id: memory.id,
    kind: memory.kind,
    content: memory.content,
    ownerType: memory.owner_type,
    ownerId: memory.owner_id,
    primaryTopic: memory.primary_topic ?? null,
    snapshotAtRecall
  };
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
  const routine = true;
  const score = Math.min(1, (recallCue ? 0.65 : 0) + (taskCue ? 0.25 : 0) + (routine ? 0.15 : 0));
  return {
    triggered: routine || recallCue,
    reason: recallCue ? "explicit_recall_cue" : taskCue ? "task_context_cue" : routine ? "routine_context" : "no_recall_cue",
    score,
    termCount: terms.length
  };
}

function boundedLimit(value, fallback, ceiling) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(ceiling, Math.floor(parsed))) : fallback;
}

function safeArray(value) {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
