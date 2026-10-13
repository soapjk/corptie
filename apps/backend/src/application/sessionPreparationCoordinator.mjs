import { randomUUID } from "node:crypto";
import { sessionReadinessStamp } from "./sessionReadinessStamp.mjs";

const TERMINAL = new Set(["ready", "failed", "cancelled", "superseded"]);
const identity = reference => JSON.stringify([
  reference.logicalSessionId ?? reference.sessionId,
  reference.bindingId ?? reference.providerBindingId ?? reference.providerSessionId,
  reference.providerId
]);

// Durable preparation, not Delivery and not Provider cancellation.
// Unknown remote outcomes remain quarantined until binding/runtime invalidation.
export class SessionPreparationCoordinator {
  constructor({ resolveReference, verify, reconcile = null, invalidate, onChanged = () => {},
    concurrency = 2, queueLimit = 16, recordLimit = 64, deadlineMs = 120000,
    persistence = null, deferRestore = false }) {
    this.resolveReference = resolveReference;
    this.verify = verify;
    this.reconcile = reconcile;
    this.invalidate = reference => {
      try { invalidate(reference); }
      catch (error) { this.storageError = error; }
    };
    this.onChanged = onChanged;
    this.concurrency = concurrency;
    this.queueLimit = queueLimit;
    this.recordLimit = recordLimit;
    this.deadlineMs = deadlineMs;
    this.records = new Map();
    this.queue = [];
    this.active = 0;
    this.persistence = persistence;
    this.storageError = null;
    this.restored = false;
    if (!deferRestore) this.#restore();
  }

  #restore() {
    if (this.restored) return;
    this.restored = true;
    if (!this.persistence) return;
    try {
      const snapshot = this.persistence.read();
      if (snapshot == null) return;
      if (snapshot.version !== 1 || !Array.isArray(snapshot.records)
          || snapshot.records.length > this.recordLimit) throw new Error("Invalid preparation snapshot");
      for (const saved of snapshot.records) {
        if (typeof saved.id !== "string" || typeof saved.reference?.sessionId !== "string"
            || !Number.isFinite(saved.createdAt) || saved.createdAt < 0
            || !["queued", "verifying", ...TERMINAL].includes(saved.state)
            || !["not_sent", "unknown", "settled"].includes(saved.remoteDisposition)
            || saved.stamp != null && !/^[a-f0-9]{64}$/.test(saved.stamp)
            || saved.deadlineAtMs != null && !Number.isFinite(saved.deadlineAtMs)
            || saved.key !== identity(saved.reference) || this.records.has(saved.key)) {
          throw new Error("Invalid preparation record");
        }
        const record = { ...saved, running: false,
          stamp: saved.stamp ?? saved.reference.preparationStamp ?? sessionReadinessStamp(saved.reference) };
        // Never trust pre-crash ready state or replay an interrupted sent RPC.
        if (["queued", "ready", "verifying"].includes(record.state)) {
          record.remoteDisposition = record.state === "verifying" || record.remoteDisposition === "unknown"
            ? "unknown" : "not_sent";
          record.state = "failed";
          record.reasonCode = "SESSION_PREPARATION_RESTARTED";
        }
        this.records.set(record.key, record);
      }
      this.#persist();
    } catch (error) {
      this.records.clear();
      this.storageError = error;
    }
  }

  #persist() {
    if (!this.persistence) return true;
    if (this.storageError) return false;
    try {
      this.persistence.write({ version: 1, records: [...this.records.values()].map(record => ({
        id: record.id, key: record.key, stamp: record.stamp,
        reference: {
          sessionId: record.reference.sessionId, logicalSessionId: record.reference.logicalSessionId,
          bindingId: record.reference.bindingId, providerBindingId: record.reference.providerBindingId,
          providerSessionId: record.reference.providerSessionId, providerId: record.reference.providerId,
          preparationStamp: record.stamp
        },
        state: record.state, reasonCode: record.reasonCode,
        remoteDisposition: record.remoteDisposition, createdAt: record.createdAt,
        deadlineAtMs: record.deadlineAtMs
      })) });
      return true;
    } catch (error) {
      this.storageError = error;
      return false;
    }
  }

  #assertStorage() {
    if (this.storageError) throw Object.assign(new Error("Session preparation storage is unavailable."), {
      code: "SESSION_PREPARATION_STORAGE_UNAVAILABLE", statusCode: 503
    });
  }

  #changed(sessionId) {
    try { this.onChanged(sessionId); }
    catch (error) { this.storageError = error; }
  }

  resumeAtStartup({ sleep = milliseconds => new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds); timer.unref?.();
  }) } = {}) {
    this.#restore();
    if (this.startupTask) return this.startupTask;
    // Only recover attempts that the user previously requested, not all
    // historical Sessions. Cancellation is deliberately never auto-resumed.
    const candidates = [...this.records.values()].filter(record =>
      ["failed", "superseded"].includes(record.state)
      && (record.remoteDisposition === "unknown"
        || record.reasonCode === "SESSION_PREPARATION_RESTARTED"));
    this.startupTask = (async () => {
      const summary = { candidates: candidates.length, scheduled: 0, skipped: 0 };
      if (!candidates.length) return summary;
      for (const backoff of [0, 30000, 60000]) {
        if (backoff) await sleep(backoff);
        for (const candidate of candidates) {
          const currentRecord = this.records.get(candidate.key);
          if (!currentRecord || currentRecord.running || !["failed", "superseded"].includes(currentRecord.state)) continue;
          // Only proven not-sent work may enter the normal preparation path.
          if (currentRecord.remoteDisposition !== "unknown"
              && !(currentRecord.remoteDisposition === "not_sent"
                && currentRecord.reasonCode === "SESSION_PREPARATION_RESTARTED")) continue;
          try {
            const reference = await this.resolveReference(candidate.reference.sessionId);
            if (identity(reference) !== candidate.key) { summary.skipped++; continue; }
            await this.start(candidate.reference.sessionId);
            summary.scheduled++;
          } catch { summary.skipped++; }
        }
      }
      return summary;
    })();
    this.startupTask.catch(() => {});
    return this.startupTask;
  }

  async start(sessionId) {
    this.#restore();
    const reference = await this.resolveReference(sessionId);
    this.#assertStorage();
    const key = identity(reference);
    const existing = this.records.get(key);
    if (existing?.state === "ready" && existing.stamp !== sessionReadinessStamp(reference)) {
      this.#finish(existing, "superseded", "SESSION_BINDING_CHANGED", "not_sent");
    }
    if (existing?.remoteDisposition === "unknown" && !existing.running && this.reconcile) {
      if (existing.reconcileAfter > Date.now()) return this.#view(existing);
      if (this.active >= this.concurrency && this.queue.length >= this.queueLimit) return this.#view(existing);
      existing.mode = "reconcile";
      existing.reference = reference;
      existing.stamp = sessionReadinessStamp(reference);
      existing.state = "queued";
      existing.reconcileAfter = Date.now() + 5000;
      existing.deadlineAtMs = Date.now() + this.deadlineMs;
      existing.timer = setTimeout(() => {
        if (TERMINAL.has(existing.state)) return;
        this.#finish(existing, "failed", "SESSION_PREPARATION_DEADLINE", "unknown");
        this.queue = this.queue.filter(value => value !== existing);
        if (existing.running) this.invalidate(reference);
      }, this.deadlineMs);
      existing.timer.unref?.();
      this.queue.push(existing);
      this.#persist();
      this.#assertStorage();
      this.#drain();
      return this.#view(existing);
    }
    if (existing && (!TERMINAL.has(existing.state) || existing.running
        || existing.remoteDisposition === "unknown" || existing.state === "ready")) {
      return this.#view(existing);
    }
    if (this.active >= this.concurrency && this.queue.length >= this.queueLimit) {
      throw Object.assign(new Error("Session preparation queue is full."), {
        code: "SESSION_PREPARATION_BUSY", statusCode: 429
      });
    }
    if (!existing && this.records.size >= this.recordLimit) {
      const evictable = [...this.records].find(([, record]) =>
        TERMINAL.has(record.state) && !record.running && record.remoteDisposition !== "unknown");
      if (!evictable) throw Object.assign(new Error("Session preparation capacity is full."), {
        code: "SESSION_PREPARATION_BUSY", statusCode: 429
      });
      this.records.delete(evictable[0]);
    }
    const record = { id: randomUUID(), key, reference, state: "queued", reasonCode: null,
      stamp: sessionReadinessStamp(reference),
      remoteDisposition: "not_sent", running: false, createdAt: Date.now() };
    this.records.set(key, record);
    record.timer = setTimeout(() => {
      if (TERMINAL.has(record.state)) return;
      this.#finish(record, "failed", "SESSION_PREPARATION_DEADLINE", record.running ? "unknown" : "not_sent");
      this.queue = this.queue.filter(value => value !== record);
      if (record.running) this.invalidate(reference);
    }, this.deadlineMs);
    record.timer.unref?.();
    this.queue.push(record);
    this.#persist();
    this.#assertStorage();
    this.#changed(reference.sessionId);
    this.#drain();
    return this.#view(record);
  }

  async current(sessionId) {
    this.#restore();
    const reference = await this.resolveReference(sessionId);
    this.#assertStorage();
    const record = this.records.get(identity(reference));
    if (record?.state === "ready" && record.stamp !== sessionReadinessStamp(reference)) {
      this.#finish(record, "superseded", "SESSION_BINDING_CHANGED", "not_sent");
      this.invalidate(reference);
    }
    return record ? this.#view(record) : null;
  }

  async cancel(sessionId, attemptId) {
    this.#restore();
    const reference = await this.resolveReference(sessionId);
    const record = this.records.get(identity(reference));
    if (!record || record.id !== attemptId) throw Object.assign(new Error("Preparation attempt changed."), {
      code: "SESSION_PREPARATION_CHANGED", statusCode: 409
    });
    if (!TERMINAL.has(record.state)) {
      this.#finish(record, "cancelled", "SESSION_PREPARATION_CANCELLED", record.running ? "unknown" : "not_sent");
      this.queue = this.queue.filter(value => value !== record);
      if (record.running) this.invalidate(reference);
    }
    return this.#view(record);
  }

  // Called by the same authoritative invalidation that retires readiness.
  invalidateWhere(matches, { runtimeChanged = false } = {}) {
    for (const record of this.records.values()) {
      if (!matches(record.reference)) continue;
      if (record.state === "cancelled") {
        if (runtimeChanged && !record.running) this.records.delete(record.key);
        continue;
      }
      this.#finish(record, "superseded", "BINDING_VERIFICATION_SUPERSEDED",
        record.running || record.remoteDisposition === "unknown" ? "unknown" : "not_sent");
      // A dispatch failure invalidating readiness is not proof that the remote
      // runtime changed. Only the Provider runtime invalidation clears unknowns.
      const releasable = runtimeChanged || record.remoteDisposition !== "unknown";
      if (!record.running && releasable) this.records.delete(record.key);
      else if (releasable) record.retired = true;
    }
    this.queue = this.queue.filter(record => !TERMINAL.has(record.state));
    this.#persist();
  }

  #view(record) {
    return Object.freeze({ id: record.id, state: record.state, reasonCode: record.reasonCode,
      remoteDisposition: record.remoteDisposition,
      retryable: TERMINAL.has(record.state) && record.state !== "ready"
        && !record.running && record.remoteDisposition !== "unknown",
      createdAt: new Date(record.createdAt).toISOString(),
      deadlineAt: new Date(record.deadlineAtMs ?? record.createdAt + this.deadlineMs).toISOString() });
  }

  #finish(record, state, reasonCode, remoteDisposition) {
    clearTimeout(record.timer);
    Object.assign(record, { state, reasonCode, remoteDisposition });
    if (!this.#persist()) {
      Object.assign(record, { state: "failed", reasonCode: "SESSION_PREPARATION_STORAGE_UNAVAILABLE",
        remoteDisposition: record.running ? "unknown" : remoteDisposition });
      this.invalidate(record.reference);
    }
    this.#changed(record.reference.sessionId);
  }

  #drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const record = this.queue.shift();
      if (TERMINAL.has(record.state)) continue;
      this.active++;
      record.running = true;
      record.state = "verifying";
      record.remoteDisposition = "unknown";
      // Commit intent with FULL-synchronous Store before any Provider RPC.
      if (!this.#persist()) {
        record.running = false;
        this.active--;
        this.#finish(record, "failed", "SESSION_PREPARATION_STORAGE_UNAVAILABLE", "not_sent");
        continue;
      }
      this.#changed(record.reference.sessionId);
      // Keep the slot occupied until the underlying operation actually settles,
      // even after local timeout/cancel; otherwise concurrency is only cosmetic.
      this.#run(record).finally(() => {
        record.running = false;
        this.active--;
        if (record.retired && this.records.get(record.key) === record) this.records.delete(record.key);
        this.#persist();
        this.#drain();
      }).catch(() => {});
    }
  }

  async #run(record) {
    try {
      const current = await this.resolveReference(record.reference.sessionId);
      if (TERMINAL.has(record.state)) return;
      if (identity(current) !== record.key || sessionReadinessStamp(current) !== record.stamp) {
        this.#finish(record, "superseded", "SESSION_BINDING_CHANGED", "not_sent");
        return;
      }
      const result = await (record.mode === "reconcile" ? this.reconcile : this.verify)(record.reference.sessionId);
      if (TERMINAL.has(record.state)) return;
      const latest = await this.resolveReference(record.reference.sessionId);
      if (TERMINAL.has(record.state)) return;
      const proved = { ...current, readinessRuntimeEpoch: result.outcome?.runtimeEpoch ?? current.readinessRuntimeEpoch };
      if (identity(latest) !== record.key || sessionReadinessStamp(latest) !== sessionReadinessStamp(proved)) {
        this.#finish(record, "superseded", "SESSION_BINDING_CHANGED", "unknown");
      } else {
        record.stamp = sessionReadinessStamp(latest);
        const reason = result.readiness?.reasonCode ?? null;
        this.#finish(record, result.ready ? "ready" : "failed", reason,
          reason === "PROVIDER_RPC_TIMEOUT" || reason === "PROVIDER_RESUME_OUTCOME_UNKNOWN"
            || record.mode === "reconcile" && !result.ready ? "unknown" : "settled");
      }
    } catch {
      if (!TERMINAL.has(record.state)) {
        this.#finish(record, "failed", "SESSION_PREPARATION_FAILED", "unknown");
      }
    }
  }
}
