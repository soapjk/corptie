// One permit is retained until the underlying request settles, even after a
// timeout. A non-cancellable hung Provider cannot accumulate more requests.
export class TurnExecutionProbeScheduler {
  constructor({ probe, isCurrent, onResult, supports, now = Date.now,
    quietMs = 60_000, timeoutMs = 20_000, maxConcurrent = 4,
    schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { probe, isCurrent, onResult, supports, now, quietMs, timeoutMs, maxConcurrent, schedule, cancel });
    this.entries = new Map();
    this.inflight = 0;
    this.closed = false;
  }
  key(entry) { return `${entry.bindingId}:${entry.turnId}`; }
  request(entry) {
    this.observe({ event: { ...entry, type: "turn.started" }, binding: entry });
    const current = this.entries.get(this.key(entry));
    if (current) this.arm(current, 1000);
  }
  observe({ event, binding }) {
    if (!event?.turnId || !binding?.sessionId) return;
    const key = this.key(event);
    const previous = this.entries.get(key);
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) {
      if (previous) this.cancel(previous.timer);
      this.entries.delete(key);
      return;
    }
    if (!this.supports(event.providerId)) return;
    if (event.type === "turn.started" && !previous) {
      const entry = { sessionId: binding.sessionId, logicalSessionId: binding.logicalSessionId,
        providerId: event.providerId, providerSessionId: event.providerSessionId,
        bindingId: event.bindingId, routingVersion: event.routingVersion, turnId: event.turnId,
        generation: 0, attempts: 0, busy: false, absentCount: 0 };
      this.entries.set(key, entry);
      this.arm(entry, this.quietMs);
    } else if (previous && /^(assistant\.|tool\.|approval\.|provider\.activity|usage\.updated)/.test(event.type)) {
      previous.generation++;
      previous.attempts = 0;
      previous.absentCount = 0;
      this.arm(previous, this.quietMs);
    }
  }
  arm(entry, delay) {
    this.cancel(entry.timer);
    if (this.closed || this.entries.get(this.key(entry)) !== entry) return;
    entry.timer = this.schedule(() => { void this.run(entry); }, delay);
    entry.timer?.unref?.();
  }
  async run(entry) {
    if (this.closed || this.entries.get(this.key(entry)) !== entry) return;
    if (!this.isCurrent(entry)) { this.entries.delete(this.key(entry)); return; }
    if (entry.busy || this.inflight >= this.maxConcurrent) { this.arm(entry, 5000); return; }
    entry.busy = true;
    this.inflight++;
    const generation = entry.generation;
    let expired = false;
    const current = () => !this.closed && this.entries.get(this.key(entry)) === entry
      && generation === entry.generation && this.isCurrent(entry);
    const timer = this.schedule(() => {
      expired = true;
      if (current()) this.deliver(entry, { state: "unknown", reasonCode: "PROBE_TIMEOUT" });
    }, this.timeoutMs);
    timer?.unref?.();
    try {
      const result = await this.probe(entry);
      if (!expired && current()) {
        if (result?.turnId !== entry.turnId || result?.providerSessionId !== entry.providerSessionId) {
          this.deliver(entry, { state: "unknown", reasonCode: "PROBE_IDENTITY_MISMATCH" });
        } else this.deliver(entry, result);
      }
    } catch {
      if (!expired && current()) this.deliver(entry, { state: "unknown", reasonCode: "PROBE_FAILED" });
    } finally {
      this.cancel(timer);
      this.inflight--;
      entry.busy = false;
      this.arm(entry, Math.min(120_000, 30_000 * 2 ** Math.min(entry.attempts++, 2)));
    }
  }
  deliver(entry, result) {
    entry.absentCount = result.state === "absent" ? entry.absentCount + 1 : 0;
    // Session-idle evidence must be independently observed twice without activity.
    const confirmation = result.state !== "absent" || entry.absentCount >= 2;
    try { this.onResult(entry, { ...result, confirmed: confirmation }); }
    catch (error) { console.warn(`[turn-probe] result handler failed code=${error?.code ?? "UNKNOWN"}`); }
  }
  close() {
    this.closed = true;
    for (const entry of this.entries.values()) this.cancel(entry.timer);
    this.entries.clear();
  }
}
