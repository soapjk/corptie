// Owns nested transaction bookkeeping and post-commit notification coalescing.
// The current database is supplied by the Store, including after reopen.
export class StoreTransactionCoordinator {
  constructor({ readDatabase, sessionTimelineRevision }) {
    this.readDatabase = readDatabase;
    this.sessionTimelineRevision = sessionTimelineRevision;
    this.stateDirtyListener = null;
    this.timelineDirtyListener = null;
    this.transactionDepth = 0;
    this.pendingStateDirty = false;
    this.pendingTimelineDirty = new Set();
  }

  scheduleSave() {
    // Native SQLite commits each statement directly to the WAL. This method is
    // kept as a compatibility hook for callers that previously scheduled a
    // full in-memory database export.
    if (this.transactionDepth > 0) {
      this.pendingStateDirty = true;
      return;
    }
    this.stateDirtyListener?.();
  }

  setStateDirtyListener(listener) {
    this.stateDirtyListener = typeof listener === "function" ? listener : null;
  }

  setTimelineDirtyListener(listener) {
    this.timelineDirtyListener = typeof listener === "function" ? listener : null;
  }

  notifyTimelineDirty(sessionId) {
    if (!sessionId) return;
    if (this.transactionDepth > 0) {
      this.pendingTimelineDirty.add(sessionId);
      return;
    }
    this.timelineDirtyListener?.({
      sessionId,
      revision: this.sessionTimelineRevision(sessionId)
    });
  }

  runInTransaction(operation) {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return operation();
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.readDatabase().run("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    let result;
    try {
      result = operation();
      this.readDatabase().run("COMMIT");
    } catch (error) {
      this.readDatabase().run("ROLLBACK");
      this.transactionDepth = 0;
      this.pendingStateDirty = false;
      this.pendingTimelineDirty.clear();
      throw error;
    }
    this.transactionDepth = 0;
    // Listener failures happen after SQLite has committed and must never be
    // mistaken for a transactional failure (or trigger a second ROLLBACK).
    this.flushCommittedDirtyNotifications();
    return result;
  }

  flushCommittedDirtyNotifications() {
    const stateDirty = this.pendingStateDirty;
    const timelineSessionIds = [...this.pendingTimelineDirty];
    this.pendingStateDirty = false;
    this.pendingTimelineDirty.clear();
    if (stateDirty) notifyCommittedListener(this.stateDirtyListener);
    for (const sessionId of timelineSessionIds) {
      notifyCommittedListener(this.timelineDirtyListener, {
        sessionId,
        revision: this.sessionTimelineRevision(sessionId)
      });
    }
  }
}

function notifyCommittedListener(listener, payload) {
  if (typeof listener !== "function") return;
  try {
    listener(payload);
  } catch (error) {
    // Persistence has already committed. A scheduling/listener failure must
    // not report the write as rolled back or invite an unsafe Provider retry.
    console.error("Committed Store notification failed:", error);
  }
}
