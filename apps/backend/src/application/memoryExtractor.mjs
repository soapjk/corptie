// A model decides which conversational statements deserve durable memory.
// The application only validates provenance, scope, lifecycle and budgets.
const MEMORY_KINDS = new Set([
  "skill", "procedure", "dev_experience", "fact", "lesson", "preference", "feedback", "episodic"
]);
const CONVERSATION_EVENTS = new Set([
  "SessionUserMessageCreated", "user.message.accepted", "assistant.message.completed"
]);
const GLOBAL_OWNER_ID = "user:local";
const MAX_WINDOW_EVENTS = 500;
const MAX_CONVERSATION_ITEMS = 60;
const MAX_CONVERSATION_CHARS = 20_000;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function parse(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

export function ownerForKind(_kind, scope, requestedScope = "task") {
  switch (requestedScope) {
    case "global": return { ownerType: "global", ownerId: GLOBAL_OWNER_ID };
    case "work": return scope.workId ? { ownerType: "work", ownerId: scope.workId } : null;
    case "task": return scope.taskId ? { ownerType: "task", ownerId: scope.taskId } : null;
    default: return null;
  }
}

export class MemoryExtractor {
  constructor({ store, classifyMany = null, clock = () => new Date().toISOString() }) {
    if (!store) throw new TypeError("MemoryExtractor requires a store.");
    this.store = store;
    this.classifyMany = classifyMany;
    this.clock = clock;
  }

  async extractFromSession(sessionId, claimedScope = {}, { reprocess = false } = {}) {
    const result = await this.extractPageFromSession(sessionId, claimedScope, { reprocess });
    return result.memories;
  }

  async extractPageFromSession(sessionId, claimedScope = {}, { reprocess = false } = {}) {
    return this.#extract(sessionId, claimedScope, {
      afterSequence: reprocess ? 0 : this.store.getMemoryExtractionProgress(sessionId),
      maxEvents: MAX_WINDOW_EVENTS, reprocess, backfill: false
    });
  }

  async backfillSession(sessionId, claimedScope = {}, { afterSequence = null, maxEvents = MAX_WINDOW_EVENTS } = {}) {
    afterSequence ??= this.store.getMemoryBackfillProgress(sessionId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0
      || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000) {
      throw failure("INVALID_INPUT", "Invalid Memory extraction page.");
    }
    return this.#extract(sessionId, claimedScope, { afterSequence, maxEvents, reprocess: true, backfill: true });
  }

  async #extract(sessionId, claimedScope, { afterSequence, maxEvents, reprocess, backfill }) {
    const scope = this.resolveExecutionScope(sessionId, claimedScope);
    const events = this.store.listSessionEvents(sessionId, afterSequence, maxEvents);
    if (!events.length) return { memories: [], scannedEvents: 0, nextSequence: afterSequence, hasMore: false };
    const conversational = [];
    const seenItems = new Set();
    let totalChars = 0;
    let endSequence = events.at(-1).sequence;
    for (const event of events) {
      const item = conversationItem(this.store, sessionId, event);
      if (!item) continue;
      const itemKey = item.itemId ? `${item.role}:${item.itemId}` : null;
      if (itemKey && seenItems.has(itemKey)) continue;
      if (conversational.length >= MAX_CONVERSATION_ITEMS
        || totalChars + item.text.length > MAX_CONVERSATION_CHARS) {
        endSequence = conversational.at(-1)?.sequence ?? event.sequence;
        break;
      }
      conversational.push(item);
      if (itemKey) seenItems.add(itemKey);
      totalChars += item.text.length;
    }
    // Even an empty model result is a meaningful extraction decision; persist it.
    // A missing or failed model must leave the cursor untouched for retry.
    if (conversational.length && typeof this.classifyMany !== "function") {
      throw failure("MEMORY_MODEL_UNAVAILABLE", "A background Memory model is required for extraction.");
    }
    const existing = this.#existing(scope);
    const raw = conversational.length
      ? await this.classifyMany(conversational, { scope, existing }) : [];
    if (!Array.isArray(raw)) throw failure("MEMORY_MODEL_INVALID_OUTPUT", "Memory model output must be an array.");
    const bySequence = new Map(conversational.map((item) => [item.sequence, item]));
    const validated = raw.map((item) => validateCandidate(item, bySequence, scope));
    const memories = this.store.runInTransaction(() => {
      const created = [];
      const known = new Set(existing.map((item) => memoryKey(item.owner_type, item.owner_id, item.content)));
      const seenEventOwners = new Set(existing.filter((item) => item.source_session_id === sessionId
        && item.source_event_sequence != null).map((item) =>
        `${item.owner_type}:${item.owner_id}:${item.source_event_sequence}`));
      for (const candidate of validated) {
        const key = memoryKey(candidate.owner.ownerType, candidate.owner.ownerId, candidate.content);
        if (known.has(key) || this.store.findMemoryByContent(
          candidate.owner.ownerType, candidate.owner.ownerId, candidate.content)) continue;
        known.add(key);
        const eventOwnerKey = `${candidate.owner.ownerType}:${candidate.owner.ownerId}:${candidate.event.sequence}`;
        const sourceEventSequence = seenEventOwners.has(eventOwnerKey)
          || this.store.getMemoryBySourceEvent({
            ownerType: candidate.owner.ownerType, ownerId: candidate.owner.ownerId,
            sourceSessionId: sessionId, sourceEventSequence: candidate.event.sequence
          }) ? null : candidate.event.sequence;
        seenEventOwners.add(eventOwnerKey);
        // Auto activation requires grounded user evidence, the model's explicit
        // no-conflict judgment, and a stricter threshold for Global scope.
        const threshold = candidate.owner.ownerType === "global" ? 0.99 : 0.97;
        const autoApplied = candidate.event.role === "user"
          && candidate.confidence >= threshold && candidate.conflict === false;
        const memory = this.store.createMemory({
          ownerType: candidate.owner.ownerType, ownerId: candidate.owner.ownerId,
          taskId: candidate.owner.ownerType === "task" ? scope.taskId : null,
          kind: candidate.kind, content: candidate.content,
          sourceType: "extracted", sourceSessionId: sessionId,
          sourceEventSequence,
          sourceEventSeqs: [candidate.event.sequence],
          structuredJson: { extraction: {
            evidence: candidate.evidence, rationale: candidate.rationale,
            eventId: candidate.event.eventId ?? null, eventSequence: candidate.event.sequence,
            role: candidate.event.role, scopeRationale: candidate.scopeRationale,
            modelConfidence: candidate.confidence, conflict: candidate.conflict
          } },
          baseConfidence: candidate.confidence, confidence: candidate.confidence,
          promotionStatus: autoApplied ? "active" : "candidate",
          trustLevel: autoApplied ? "trusted" : "untrusted",
          autoApplied, appliedAt: autoApplied ? this.clock() : null
        });
        this.store.createMemoryAudit({
          memoryId: memory.id, action: autoApplied ? "extract_auto_apply" : "extract_candidate",
          actorType: "system", actorId: sessionId, after: memory,
          reason: candidate.rationale
        });
        created.push(memory);
      }
      if (!reprocess) this.store.setMemoryExtractionProgress(sessionId, endSequence);
      if (backfill) this.store.setMemoryBackfillProgress(sessionId, endSequence);
      return created;
    });
    return { memories, scannedEvents: events.filter((event) => event.sequence <= endSequence).length,
      nextSequence: endSequence,
      hasMore: this.store.listSessionEvents(sessionId, endSequence, 1).length > 0 };
  }

  #existing(scope) {
    return [scope.taskId && ["task", scope.taskId], scope.workId && ["work", scope.workId],
      ["global", GLOBAL_OWNER_ID]].filter(Boolean)
      .flatMap(([type, id]) => this.store.listMemoriesForExtraction(type, id, 100));
  }

  resolveExecutionScope(sessionId, claimedScope = {}) {
    const session = this.store.getSession(sessionId);
    if (!session) throw failure("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
    if (!["worker", "workChat", "assistantChat"].includes(session.sessionKind)) {
      throw failure("MEMORY_SESSION_KIND_UNSUPPORTED", "Unsupported Session kind for Memory extraction.");
    }
    const task = session.taskId ? this.store.getTask(session.taskId) : null;
    if (session.sessionKind === "worker" && (!task || task.work_id !== session.workId)) {
      throw failure("INVALID_TASK_SESSION", "Session is not bound to its Task and Work.");
    }
    if (session.workId && !this.store.getWork(session.workId)) {
      throw failure("WORK_NOT_FOUND", "Session references a missing Work.");
    }
    const derived = { workId: session.workId ?? null,
      taskId: session.sessionKind === "worker" ? session.taskId : null,
      agentId: session.agentId ?? task?.main_agent_id ?? null,
      providerId: session.provider ?? null };
    for (const key of ["workId", "taskId", "agentId"]) {
      const claimed = typeof claimedScope[key] === "string" ? claimedScope[key].trim() : "";
      if (claimed && claimed !== derived[key]) throw failure("MEMORY_SCOPE_MISMATCH", `${key} does not match Session binding.`);
    }
    return derived;
  }
}

function conversationItem(store, sessionId, event) {
  if (!CONVERSATION_EVENTS.has(event.type) || event.producer === "memory") return null;
  const payload = parse(event.payload ?? event.payload_json);
  const itemId = payload.itemReference?.id ?? payload.message?.id;
  const item = itemId ? store.getSessionItem(sessionId, itemId) : null;
  const role = event.type === "assistant.message.completed" ? "assistant" : "user";
  const text = [payload.message?.text, payload.message, payload.text, payload.content, item?.text]
    .find((value) => typeof value === "string" && value.trim());
  if (!text) return null;
  return { eventId: event.eventId ?? null, itemId: itemId ?? null,
    sequence: event.sequence, role,
    text: text.trim().slice(0, 3000) };
}

function validateCandidate(item, bySequence, scope) {
  if (!item || typeof item !== "object" || !MEMORY_KINDS.has(item.kind)) {
    throw failure("MEMORY_MODEL_INVALID_OUTPUT", "Invalid Memory kind.");
  }
  const event = bySequence.get(Number(item.eventSequence));
  const content = String(item.content ?? "").trim();
  const evidence = String(item.evidence ?? "").trim();
  const rationale = String(item.rationale ?? "").trim();
  const scopeRationale = String(item.scopeRationale ?? "").trim();
  const confidence = Number(item.confidence);
  const owner = ownerForKind(item.kind, scope, item.scope);
  if (!event || !owner || !content || content.length > 600 || !evidence
    || !event.text.includes(evidence) || !rationale || !scopeRationale
    || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
    || typeof item.conflict !== "boolean") {
    throw failure("MEMORY_MODEL_INVALID_OUTPUT", "Memory proposal lacks valid scope, evidence or confidence.");
  }
  return { event, owner, content, evidence, rationale, scopeRationale,
    kind: item.kind, confidence, conflict: item.conflict };
}

function memoryKey(ownerType, ownerId, content) {
  return `${ownerType}:${ownerId}:${String(content).trim().toLocaleLowerCase()}`;
}
