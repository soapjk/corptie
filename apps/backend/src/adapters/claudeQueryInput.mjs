// FIFO input ownership for one SDK Query. Session lifecycle remains with the
// manager; resetting the queue releases every suspended reader before close.
export class ClaudeQueryInput {
  #messages = [];
  #readers = [];

  get pendingCount() { return this.#messages.length; }

  enqueue(message) {
    if (this.#readers.length > 0) {
      this.#readers.shift()(message);
      return;
    }
    this.#messages.push(message);
  }

  dequeue(closed) {
    if (this.#messages.length > 0) return Promise.resolve(this.#messages.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#readers.push(resolve));
  }

  reset() {
    this.#messages = [];
    for (const resolve of this.#readers.splice(0)) resolve(null);
  }

  stream(isClosed) {
    const queue = this;
    return {
      async *[Symbol.asyncIterator]() {
        while (!isClosed()) {
          const next = await queue.dequeue(isClosed());
          if (next == null) break;
          yield next;
        }
      }
    };
  }
}
