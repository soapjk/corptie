import { SessionTimelineChangePublisher } from "./sessionTimelineChangePublisher.mjs";

// Runtime-owned timers and pending maintenance survive only as long as their
// backend lifecycle. Service shutdown ordering is controlled by the caller.
export class BackendRuntimeActivity {
  constructor({ emitEvent, tickAgentWorkQueue, updateMockProgress }) {
    this.emitEvent = emitEvent;
    this.tickAgentWorkQueue = tickAgentWorkQueue;
    this.updateMockProgress = updateMockProgress;
    this.queueTimer = null;
    this.queueFlight = null;
    this.mockTimer = null;
    this.timelinePublisher = null;
    this.maintenance = new Set();
  }

  startTimelinePublisher() {
    this.timelinePublisher = new SessionTimelineChangePublisher({
      emit: ({ sessionId, timelineRevision }) => this.emitEvent(
        "SessionTimelineChanged", { sessionId, timelineRevision },
        { sessionId, recordSessionEvent: false }
      )
    });
  }

  scheduleTimelineChange(change) { this.timelinePublisher?.schedule(change); }
  closeTimelinePublisher() { this.timelinePublisher?.close(); }

  startQueueTimer() {
    if (this.queueTimer) return;
    let expectedAt = performance.now() + 2000;
    this.queueTimer = setInterval(() => {
      const now = performance.now();
      const eventLoopDelayMs = Math.max(0, now - expectedAt);
      expectedAt = now + 2000;
      if (eventLoopDelayMs > 250) console.warn(`[backend-event-loop-delay] ${JSON.stringify({
        timestamp: new Date().toISOString(), eventLoopDelayMs: Math.round(eventLoopDelayMs)
      })}`);
      if (this.queueFlight) return;
      const flight = Promise.resolve().then(() => this.tickAgentWorkQueue({ forceDiscovery: false }));
      this.queueFlight = flight;
      flight.catch((error) => this.emitEvent("AgentWorkQueueError", { error: error.message }))
        .finally(() => { if (this.queueFlight === flight) this.queueFlight = null; });
    }, 2000);
    this.queueTimer.unref?.();
  }

  startMockTimer() {
    if (this.mockTimer) return;
    this.mockTimer = setInterval(this.updateMockProgress, 2500);
    this.mockTimer.unref?.();
  }

  stopTimers() {
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.queueTimer = null;
    this.mockTimer = null;
  }

  trackMaintenance(promise) {
    this.maintenance.add(promise);
    // Do not create an ignored rejecting finally() promise.
    promise.then(
      () => this.maintenance.delete(promise),
      () => this.maintenance.delete(promise)
    );
    return promise;
  }

  waitForMaintenance() {
    return Promise.allSettled([...this.maintenance]);
  }
}
