const DEFAULT_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

// Archives are persistence boundaries, not Provider deletion boundaries. This
// service waits for committed work to settle and then releases only the live
// Provider runtime/subscription. The logical route and Provider Thread remain
// available for a later resume.
export class SessionRuntimeReleaseService {
  constructor({ store, sessionService, schedule = setTimeout, cancel = clearTimeout, logger = console } = {}) {
    if (!store || !sessionService) {
      throw new TypeError("SessionRuntimeReleaseService requires a Store and Session application service.");
    }
    this.store = store;
    this.sessionService = sessionService;
    this.schedule = schedule;
    this.cancel = cancel;
    this.logger = logger;
    this.pending = new Map();
  }

  request(sessionId, reason = "archived") {
    if (!sessionId) return Promise.resolve({ status: "skipped", reason: "session_missing" });
    const current = this.pending.get(sessionId);
    if (current) return current.promise;
    const state = { attempts: 0, timer: null, resolve: null };
    state.promise = new Promise((resolve) => { state.resolve = resolve; });
    this.pending.set(sessionId, state);
    void this.#attempt(sessionId, reason, state);
    return state.promise;
  }

  cancelPending(sessionId) {
    const state = this.pending.get(sessionId);
    if (!state) return false;
    if (state.timer) this.cancel(state.timer);
    this.pending.delete(sessionId);
    state.resolve({ status: "cancelled", reason: "session_unarchived" });
    return true;
  }

  async restore(sessionId) {
    this.cancelPending(sessionId);
    return this.sessionService.resumeSession(sessionId, {
      source: "session-unarchive-runtime-restore",
      purpose: "session-unarchive"
    });
  }

  reconcileArchivedSessions() {
    const sessions = this.store.listSessions({ archived: true });
    for (const session of sessions) void this.request(session.id, session.archiveReason ?? "startup-reconcile");
    return sessions.length;
  }

  releaseCompletedWorkItemSessions(workItemId) {
    const sessions = this.store.listSessions({ archived: true })
      .filter((session) => session.workItemId === workItemId);
    for (const session of sessions) void this.request(session.id, "work-item-completed");
    return sessions.length;
  }

  async #attempt(sessionId, reason, state) {
    if (this.pending.get(sessionId) !== state) return;
    const session = this.store.getSession(sessionId);
    if (!session || session.archived !== true) {
      this.#finish(sessionId, state, { status: "skipped", reason: session ? "session_not_archived" : "session_missing" });
      return;
    }
    if (this.store.hasUnsettledSessionRuntimeWork(sessionId)) {
      this.#retry(sessionId, reason, state);
      return;
    }
    try {
      const result = await this.sessionService.disconnectSession(sessionId, {
        source: "session-archive-runtime-release",
        reason
      });
      this.#finish(sessionId, state, { status: "released", result });
    } catch (error) {
      // Provider startup races and a just-settled native Turn are transient.
      // Keep retrying in the background without delaying archive/API readiness.
      this.logger.warn?.(`[session-runtime-release] retry session=${sessionId} reason=${reason} code=${error?.code ?? "unknown"} error=${error?.message ?? error}`);
      this.#retry(sessionId, reason, state);
    }
  }

  #retry(sessionId, reason, state) {
    state.attempts += 1;
    const delay = Math.min(MAX_RETRY_MS, DEFAULT_RETRY_MS * (2 ** Math.min(5, state.attempts - 1)));
    state.timer = this.schedule(() => {
      state.timer = null;
      void this.#attempt(sessionId, reason, state);
    }, delay);
    state.timer?.unref?.();
  }

  #finish(sessionId, state, result) {
    if (this.pending.get(sessionId) !== state) return;
    this.pending.delete(sessionId);
    state.resolve(result);
  }
}
