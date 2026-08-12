export class SessionTimelinePublishGate {
  constructor(options = {}) {
    this.read = options.read;
    this.onSettled = options.onSettled ?? (() => {});
    this.reading = false;
    this.closed = false;
    this.pending = null;
    if (typeof this.read !== "function") {
      throw new TypeError("SessionTimelinePublishGate requires read().");
    }
  }

  request({ fullConsistency = true } = {}) {
    if (this.closed) return Promise.resolve(false);
    if (this.reading) {
      this.pending = {
        fullConsistency: fullConsistency || this.pending?.fullConsistency === true
      };
      return Promise.resolve(false);
    }
    return this.run({ fullConsistency });
  }

  close() {
    this.closed = true;
    this.pending = null;
  }

  async run(options) {
    this.reading = true;
    try {
      await this.read(options);
    } finally {
      this.reading = false;
      if (!this.closed && this.pending) {
        const pending = this.pending;
        this.pending = null;
        queueMicrotask(() => void this.run(pending));
      } else {
        this.onSettled();
      }
    }
    return true;
  }
}
