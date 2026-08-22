/**
 * Shares one in-flight asynchronous operation per key.
 *
 * Successful and failed operations are both removed after settling, so this
 * is request coalescing rather than a value cache. Callers retain their own
 * freshness and persistence policies.
 */
export class SingleFlight {
  #loads = new Map();

  run(key, operation) {
    const existing = this.#loads.get(key);
    if (existing) return existing;

    const loading = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.#loads.get(key) === loading) {
          this.#loads.delete(key);
        }
      });
    this.#loads.set(key, loading);
    return loading;
  }

  get size() {
    return this.#loads.size;
  }
}
