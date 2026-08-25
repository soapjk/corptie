// Timeline wake events deliberately carry no message bodies. They only tell a
// connected client that one Session's durable timeline cursor advanced; the
// revision index and delta endpoint remain the correctness authorities.
export class SessionTimelineChangePublisher {
  constructor({ emit, delayMs = 20 } = {}) {
    if (typeof emit !== "function") {
      throw new TypeError("SessionTimelineChangePublisher requires emit().");
    }
    this.emit = emit;
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.pending = new Map();
    this.timer = null;
  }

  schedule(change = {}) {
    const sessionId = String(change.sessionId ?? "").trim();
    const revision = Number(change.revision ?? 0);
    if (!sessionId || !Number.isSafeInteger(revision) || revision <= 0) return;
    this.pending.set(sessionId, Math.max(revision, this.pending.get(sessionId) ?? 0));
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const changes = [...this.pending.entries()];
    this.pending.clear();
    for (const [sessionId, timelineRevision] of changes) {
      this.emit({ sessionId, timelineRevision });
    }
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
