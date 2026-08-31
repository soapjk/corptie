export class SerializedOperationQueue {
  constructor() {
    this.tail = Promise.resolve();
    this.pending = 0;
  }

  run(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("SerializedOperationQueue.run requires an operation.");
    }
    this.pending += 1;
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {}).finally(() => {
      this.pending -= 1;
    });
    return result;
  }
}
