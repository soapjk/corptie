const encoder = new TextEncoder();
const UPDATE_NOTICE = "<corptie_context_update>Updated sections below supersede their earlier snapshots. Previously supplied sections omitted from this update remain applicable.</corptie_context_update>";

// Process-local receipts for append-only Provider histories. No persistent
// state or hashes: an unknown binding always receives a complete baseline.
export class SessionContextDelivery {
  constructor({ maxSessions = 256, maxBytes = 8 * 1024 * 1024,
    ttlMs = 6 * 60 * 60 * 1000, clock = () => Date.now() } = {}) {
    Object.assign(this, { maxSessions, maxBytes, ttlMs, clock });
    this.entries = new Map();
    this.bytes = 0;
  }

  invalidate(sessionId) {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId || entry.logicalSessionId === sessionId) this.#remove(key);
    }
  }

  prepare(reference, context, policy) {
    const sections = context?.contextSections;
    if (policy?.mode !== "append" || !Array.isArray(sections)
      || sections.filter(section => section.prompt).map(section => section.prompt).join("\n\n") !== context.prompt
      || sections.some(section => !/^[a-z0-9-]+$/.test(section.id) || typeof section.prompt !== "string")
      || new Set(sections.map(section => section.id)).size !== sections.length) {
      return { context, commit() {}, reject() {} };
    }
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      if (now - entry.touchedAt >= this.ttlMs) this.#remove(key);
    }
    const key = JSON.stringify([reference.logicalSessionId ?? reference.sessionId,
      reference.providerId, reference.bindingId ?? null, reference.providerSessionId ?? null,
      reference.routingVersion ?? null]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { sessionId: reference.sessionId, logicalSessionId: reference.logicalSessionId,
        sections: new Map(), bytes: 0, turns: 0, sequence: 0, committedSequence: 0, touchedAt: now };
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.#trim();
    entry.touchedAt = now;
    const sequence = ++entry.sequence;
    const full = entry.turns === 0 || entry.turns >= (policy.maxDeltaTurns ?? 32);
    const reused = [], sent = [], updates = [];
    for (const section of sections) {
      if (section.reusable && !full && entry.sections.get(section.id) === section.prompt) {
        reused.push(section.id);
      } else {
        sent.push(section.id);
        if (section.prompt) updates.push(section.prompt);
        else if (section.reusable && entry.sections.get(section.id)) {
          updates.push(`<corptie_context_removed section="${section.id}">This section is no longer supplied as current Corptie context. Do not treat its earlier snapshot as current.</corptie_context_removed>`);
        }
      }
    }
    for (const [id, previous] of entry.sections) {
      if (previous && !sections.some(section => section.id === id)) {
        sent.push(id);
        updates.push(`<corptie_context_removed section="${id}">This section is no longer supplied as current Corptie context. Do not treat its earlier snapshot as current.</corptie_context_removed>`);
      }
    }
    const delta = !full && reused.length > 0;
    let prompt = updates.join("\n\n");
    if (delta && sections.some(section => section.reusable && sent.includes(section.id))) {
      prompt = [UPDATE_NOTICE, prompt].filter(Boolean).join("\n\n");
    }
    // Extra change markers must never overflow the already validated budget.
    if (encoder.encode(prompt).byteLength > (context.contextBudget?.maxTurnUtf8Bytes
      ?? Math.max(encoder.encode(context.prompt).byteLength, 20_480))) {
      prompt = context.prompt;
      reused.length = 0;
    }
    const actualDelta = prompt !== context.prompt;
    const { contextSections: _sections, ...outgoing } = context;
    const sentBytes = encoder.encode(prompt).byteLength;
    const canonicalBytes = encoder.encode(context.prompt).byteLength;
    outgoing.prompt = prompt;
    outgoing.contextDelivery = { mode: actualDelta ? "delta" : "full",
      sentSectionIds: actualDelta ? sent : sections.map(section => section.id),
      reusedSectionIds: reused, canonicalUtf8Bytes: canonicalBytes,
      sentUtf8Bytes: sentBytes, savedUtf8Bytes: canonicalBytes - sentBytes };
    const remove = () => { if (this.entries.get(key) === entry) this.#remove(key); };
    return { context: outgoing,
      commit: () => {
        if (this.entries.get(key) !== entry || sequence < entry.committedSequence) return;
        const next = new Map(sections.filter(section => section.reusable)
          .map(section => [section.id, section.prompt]));
        const bytes = [...next.values()].reduce((sum, value) => sum + encoder.encode(value).byteLength, 0);
        this.bytes += bytes - entry.bytes;
        Object.assign(entry, { sections: next, bytes, turns: full ? 1 : entry.turns + 1,
          committedSequence: sequence, touchedAt: this.clock() });
        this.#trim();
      },
      reject: remove
    };
  }

  #remove(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  #trim() {
    while (this.entries.size > this.maxSessions || this.bytes > this.maxBytes) {
      this.#remove(this.entries.keys().next().value);
    }
  }
}
