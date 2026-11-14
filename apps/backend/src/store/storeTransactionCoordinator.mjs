// Owns nested transaction bookkeeping and post-commit notification coalescing.
// The current database is supplied by the Store, including after reopen.
export class StoreTransactionCoordinator {
  constructor({ readDatabase, sessionTimelineRevision }) {
    this.readDatabase = readDatabase;
    this.sessionTimelineRevision = sessionTimelineRevision;
    this.stateDirtyListener = null;
    this.timelineDirtyListener = null;
    this.transactionDepth = 0;
    this.commitCallbacks = [];
    this.pendingStateDirty = false;
    this.pendingTimelineDirty = new Set();
    this.pendingQuickMessagesDirty = new Set();
    this.pendingQuickMessagesGlobalDirty = new Set();
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

  notifyTimelineDirty(sessionId, { quickMessagesChanged = false, quickMessagesGlobalChanged = false } = {}) {
    if (!sessionId) return;
    if (this.transactionDepth > 0) {
      this.pendingTimelineDirty.add(sessionId);
      if (quickMessagesChanged) this.pendingQuickMessagesDirty.add(sessionId);
      if (quickMessagesGlobalChanged) this.pendingQuickMessagesGlobalDirty.add(sessionId);
      return;
    }
    this.timelineDirtyListener?.({
      sessionId,
      revision: this.sessionTimelineRevision(sessionId),
      ...(quickMessagesChanged ? { quickMessagesChanged: true } : {}),
      ...(quickMessagesGlobalChanged ? { quickMessagesGlobalChanged: true } : {})
    });
  }

  afterCommit(callback) {
    if (this.transactionDepth > 0) this.commitCallbacks.push(callback);
    else callback();
  }

  runInTransaction(operation) {
    if (operation?.constructor?.name === "AsyncFunction") throw new TypeError("Store transactions require synchronous operations.");
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        const result = operation();
        if (result && typeof result.then === "function") {
          Promise.resolve(result).catch(() => {});
          throw new TypeError("Store transactions cannot return a Promise.");
        }
        return result;
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.readDatabase().run("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    let result;
    try {
      result = operation();
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
        throw new TypeError("Store transactions cannot return a Promise.");
      }
      this.readDatabase().run("COMMIT");
    } catch (error) {
      this.readDatabase().run("ROLLBACK");
      this.transactionDepth = 0;
      this.commitCallbacks = [];
      this.pendingStateDirty = false;
      this.pendingTimelineDirty.clear();
      this.pendingQuickMessagesDirty.clear();
      this.pendingQuickMessagesGlobalDirty.clear();
      throw error;
    }
    this.transactionDepth = 0;
    // Listener failures happen after SQLite has committed and must never be
    // mistaken for a transactional failure (or trigger a second ROLLBACK).
    this.flushCommittedDirtyNotifications();
    const callbacks = this.commitCallbacks.splice(0);
    for (const callback of callbacks) notifyCommittedListener(callback);
    return result;
  }

  flushCommittedDirtyNotifications() {
    const stateDirty = this.pendingStateDirty;
    const timelineSessionIds = [...this.pendingTimelineDirty];
    const quickMessagesSessionIds = new Set(this.pendingQuickMessagesDirty);
    const globalQuickMessageIds = new Set(this.pendingQuickMessagesGlobalDirty);
    this.pendingStateDirty = false;
    this.pendingTimelineDirty.clear();
    this.pendingQuickMessagesDirty.clear();
    this.pendingQuickMessagesGlobalDirty.clear();
    if (stateDirty) notifyCommittedListener(this.stateDirtyListener);
    for (const sessionId of timelineSessionIds) {
      notifyCommittedListener(this.timelineDirtyListener, {
        sessionId,
        revision: this.sessionTimelineRevision(sessionId),
        ...(quickMessagesSessionIds.has(sessionId) ? { quickMessagesChanged: true } : {}),
        ...(globalQuickMessageIds.has(sessionId) ? { quickMessagesGlobalChanged: true } : {})
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
