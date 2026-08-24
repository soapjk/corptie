const DEFAULT_CAPACITY = 256;

export class SessionStateDiagnostics {
  constructor({ capacity = DEFAULT_CAPACITY, clock = () => new Date().toISOString() } = {}) {
    this.capacity = Math.max(1, Number(capacity) || DEFAULT_CAPACITY);
    this.clock = clock;
    this.entries = new Map();
  }

  record(sessionId, stage, detail = {}) {
    if (!sessionId || !stage) return null;
    const timestamp = this.clock();
    const current = this.entries.get(sessionId) ?? { sessionId, stages: {}, history: [] };
    const event = { stage, timestamp, ...detail };
    current.stages[stage] = event;
    current.history.push(event);
    if (current.history.length > 32) current.history.splice(0, current.history.length - 32);
    this.entries.delete(sessionId);
    this.entries.set(sessionId, current);
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return event;
  }

  get(sessionId) {
    const entry = this.entries.get(sessionId);
    return entry ? structuredClone(entry) : null;
  }

  list() {
    return [...this.entries.values()].reverse().map((entry) => structuredClone(entry));
  }
}
