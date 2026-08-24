export class ReplayEventLog {
  constructor({ capacity = 4096 } = {}) {
    const normalizedCapacity = Number(capacity);
    if (!Number.isSafeInteger(normalizedCapacity) || normalizedCapacity < 1) {
      throw new TypeError("ReplayEventLog capacity must be a positive integer.");
    }
    this.capacity = normalizedCapacity;
    this.nextId = 1;
    this.entries = [];
  }

  append(value) {
    const entry = { ...value, id: this.nextId++ };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    return entry;
  }

  replayAfter(cursor = 0) {
    const normalizedCursor = Number.isSafeInteger(Number(cursor))
      ? Math.max(0, Number(cursor))
      : 0;
    const oldestId = this.entries[0]?.id ?? this.nextId;
    const latestId = this.entries.at(-1)?.id ?? (this.nextId - 1);
    return {
      gap: normalizedCursor > latestId
        || (normalizedCursor > 0 && normalizedCursor < oldestId - 1),
      oldestId,
      latestId,
      entries: this.entries.filter((entry) => entry.id > normalizedCursor)
    };
  }

  get size() {
    return this.entries.length;
  }
}
