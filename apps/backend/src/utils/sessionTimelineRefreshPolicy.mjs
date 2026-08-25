export const timelineRefreshIntervals = Object.freeze({
  legacyMilliseconds: 400,
  activeMilliseconds: 750,
  consistencyMilliseconds: 30_000,
  eventDebounceMilliseconds: 50
});

export class SessionTimelineRefreshScheduler {
  constructor(options = {}) {
    this.sessionId = options.sessionId;
    this.supportsDelta = options.supportsDelta === true;
    this.onRefresh = options.onRefresh;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.intervals = { ...timelineRefreshIntervals, ...options.intervals };
    this.refreshTimer = null;
    this.eventTimer = null;
    this.consistencyTimer = null;
    this.closed = false;
    if (typeof this.onRefresh !== "function") {
      throw new TypeError("SessionTimelineRefreshScheduler requires onRefresh().");
    }
  }

  schedule(session) {
    if (this.closed) return;
    // Revisioned Provider/product events are the only refresh authority. SSE
    // reconnect already emits a stored snapshot, so periodic sampling adds no
    // correctness and previously multiplied Session/Binding/Worktree/Timeline
    // queries every 750ms per active view.
    this.clearTimer(this.refreshTimer);
    this.clearTimer(this.consistencyTimer);
    this.refreshTimer = null;
    this.consistencyTimer = null;
  }

  wake(event) {
    if (this.closed || !sessionEventMatchesTimeline(event, this.sessionId)) {
      return false;
    }
    this.clearTimer(this.eventTimer);
    this.eventTimer = this.setTimer(
      () => this.onRefresh({ fullConsistency: true }),
      this.intervals.eventDebounceMilliseconds
    );
    this.eventTimer?.unref?.();
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer(this.refreshTimer);
    this.clearTimer(this.eventTimer);
    this.clearTimer(this.consistencyTimer);
    this.refreshTimer = null;
    this.eventTimer = null;
    this.consistencyTimer = null;
  }
}

export function timelineRefreshInterval(session, options = {}) {
  const intervals = { ...timelineRefreshIntervals, ...options };
  return timelineSessionIsActive(session)
    ? intervals.activeMilliseconds
    : intervals.consistencyMilliseconds;
}

export function timelineSessionIsActive(session) {
  if (["running", "blocked"].includes(session?.status)) return true;
  if (typeof session?.activityStatus === "string" && session.activityStatus.trim()) return true;
  return session?.capabilities?.canInterrupt === true;
}

export function sessionEventMatchesTimeline(event, sessionId) {
  return Boolean(event?.sessionId) && String(event.sessionId) === String(sessionId);
}
