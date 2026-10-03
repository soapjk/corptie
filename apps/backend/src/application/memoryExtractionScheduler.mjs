// One durable, coalescing queue for extraction across all Tasks and Sessions.
export class MemoryExtractionScheduler {
  constructor({ store, extractor, onMemories = () => {}, clock = () => Date.now(),
    retryBaseMs = 60_000 } = {}) {
    if (!store || !extractor) throw new TypeError("MemoryExtractionScheduler requires store and extractor.");
    Object.assign(this, { store, extractor, onMemories, clock, retryBaseMs });
    this.running = false;
    this.closed = false;
    this.timer = null;
    this.wakeAt = null;
    this.activeDrain = null;
  }

  request(sessionId, reason = "session_end", { delayMs = 0 } = {}) {
    if (this.closed) return;
    const boundedDelay = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(delayMs) || 0));
    this.store.enqueueMemoryExtraction(sessionId, reason,
      new Date(this.clock() + boundedDelay).toISOString());
    this.#wake(boundedDelay);
  }

  requestForTurn(sessionId) {
    const stats = this.store.memoryExtractionWindowStats(sessionId);
    const intervalMs = stats.lastExtractedAt
      ? Math.max(0, this.clock() - Date.parse(stats.lastExtractedAt)) : Infinity;
    if (stats.userMessages >= 50 && intervalMs >= 2 * 60 * 60 * 1000) {
      this.request(sessionId, "long_session_window");
    } else {
      this.request(sessionId, "idle_window", { delayMs: 2 * 60 * 60 * 1000 });
    }
  }

  start() { this.#wake(); }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.wakeAt = null;
    await this.activeDrain;
  }

  get pendingCount() {
    return this.store.listMemoryExtractionJobs(500)
      .filter((job) => job.state !== "done").length;
  }

  #wake(delay = 0) {
    if (this.closed || this.running) return;
    const nextWakeAt = this.clock() + delay;
    if (this.timer && this.wakeAt <= nextWakeAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.wakeAt = nextWakeAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wakeAt = null;
      const operation = this.#drain();
      this.activeDrain = operation;
      void operation.catch((error) => {
        console.error(`[memory-extraction] scheduler failed: ${error?.message ?? error}`);
      }).finally(() => {
        if (this.activeDrain === operation) this.activeDrain = null;
      });
    }, delay);
    this.timer.unref?.();
  }

  async #drain() {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      while (!this.closed) {
        const now = new Date(this.clock()).toISOString();
        const job = this.store.nextMemoryExtractionJob(now);
        if (!job) break;
        try {
          const result = await this.extractor.extractPageFromSession(job.session_id);
          this.store.finishMemoryExtractionJob(job.session_id, {
            hasMore: result.hasMore, expectedUpdatedAt: job.updated_at });
          if (result.memories.length) this.onMemories(job.session_id, result.memories);
        } catch (error) {
          const attempts = Number(job.attempts ?? 0) + 1;
          const day = now.slice(0, 10);
          const tomorrow = new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000;
          const delay = error.code === "MEMORY_DAILY_CALL_BUDGET"
            ? Math.max(60_000, tomorrow - this.clock())
            : Math.min(3_600_000, this.retryBaseMs * 2 ** Math.min(attempts - 1, 6));
          this.store.finishMemoryExtractionJob(job.session_id, {
            error: String(error.code ?? error.message ?? error).slice(0, 500),
            retryAt: new Date(this.clock() + delay).toISOString(),
            expectedUpdatedAt: job.updated_at
          });
        }
      }
    } finally {
      this.running = false;
      if (!this.closed) {
        const jobs = this.store.listMemoryExtractionJobs(500).filter((job) => job.state !== "done");
        if (jobs.length) {
          const next = Math.min(...jobs.map((job) => Date.parse(job.retry_at ?? new Date(this.clock()).toISOString())));
          this.#wake(Math.max(0, next - this.clock()));
        }
      }
    }
  }
}
