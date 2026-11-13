// Provider-neutral scheduling. Running slots are released only when the
// underlying execution settles, never merely because its caller cancels.
export class BackgroundOperationQueue {
  constructor({ concurrency = 2, maxPending = 64, interactiveReserve = 0 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("Invalid background concurrency.");
    if (!Number.isInteger(interactiveReserve) || interactiveReserve < 0) throw new TypeError("Invalid interactive reserve.");
    this.concurrency = concurrency;
    this.maxPending = maxPending;
    this.running = 0;
    this.runningBackground = 0;
    this.interactiveReserve = Math.min(Math.max(0, interactiveReserve), concurrency - 1);
    this.pending = [];
    this.closed = false;
  }

  run(operation, { signal, priority = 0 } = {}) {
    if (this.closed) return Promise.reject(queueError("BACKGROUND_QUEUE_CLOSED"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? queueError("BACKGROUND_CANCELLED"));
    if (this.pending.length >= this.maxPending) return Promise.reject(queueError("BACKGROUND_QUEUE_FULL"));
    return new Promise((resolve, reject) => {
      const entry = { operation, signal, priority, resolve, reject };
      entry.onAbort = () => {
        const index = this.pending.indexOf(entry);
        if (index < 0) return;
        this.pending.splice(index, 1);
        signal.removeEventListener("abort", entry.onAbort);
        reject(signal.reason ?? queueError("BACKGROUND_CANCELLED"));
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.pending.push(entry);
      this.pending.sort((left, right) => right.priority - left.priority);
      this.drain();
    });
  }

  drain() {
    while (!this.closed && this.running < this.concurrency && this.pending.length) {
      if (this.pending[0].priority < 1 && this.runningBackground >= this.concurrency - this.interactiveReserve) break;
      const entry = this.pending.shift();
      entry.signal?.removeEventListener("abort", entry.onAbort);
      this.running += 1;
      if (entry.priority < 1) this.runningBackground += 1;
      Promise.resolve().then(() => {
        entry.signal?.throwIfAborted();
        return entry.operation();
      }).then((result) => {
        entry.signal?.throwIfAborted();
        return result;
      }).then(entry.resolve, entry.reject).finally(() => {
        this.running -= 1;
        if (entry.priority < 1) this.runningBackground -= 1;
        this.drain();
      });
    }
  }

  close() {
    this.closed = true;
    for (const entry of this.pending.splice(0)) {
      entry.signal?.removeEventListener("abort", entry.onAbort);
      entry.reject(queueError("BACKGROUND_QUEUE_CLOSED"));
    }
  }
}

function queueError(code) { return Object.assign(new Error(code), { code }); }
