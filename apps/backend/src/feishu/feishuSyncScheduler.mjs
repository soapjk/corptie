// Owns delayed, periodic and single-flight scheduling. Closing cancels future
// timers; already running delivery work retains the gateway's existing lifetime.
export class FeishuSyncScheduler {
  constructor({
    store, syncBotOnce, requestSync,
    scheduleTimeout = setTimeout, cancelTimeout = clearTimeout,
    scheduleInterval = setInterval, cancelInterval = clearInterval
  }) {
    Object.assign(this, { store, syncBotOnce, requestSync, scheduleTimeout, cancelTimeout, scheduleInterval, cancelInterval });
    this.syncTimers = new Map();
    this.syncRuns = new Map();
    this.syncInterval = null;
  }

  start() {
    this.syncInterval = this.scheduleInterval(() => {
      for (const assignment of this.store.listFeishuAssignments()) {
        if (this.store.getFeishuBot(assignment.botId)?.enabled) {
          this.requestSync(assignment.botId).catch((error) => {
            console.error(`[feishu] bot=${assignment.botId} periodic sync failed: ${error.message}`);
          });
        }
      }
    }, 2000);
    this.syncInterval.unref?.();
  }

  close() {
    for (const timer of this.syncTimers.values()) {
      this.cancelTimeout(timer);
    }
    this.syncTimers.clear();
    if (this.syncInterval) {
      this.cancelInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  handleSessionEvent(event) {
    const assignment = this.store.getFeishuAssignmentForSession(event.sessionId);
    if (!assignment || !this.store.getFeishuBot(assignment.botId)?.enabled) {
      return;
    }
    this.store.updateFeishuAssignmentCursor(assignment.botId, event.sequence);
    this.cancelTimeout(this.syncTimers.get(assignment.botId));
    const timer = this.scheduleTimeout(() => {
      this.syncTimers.delete(assignment.botId);
      this.requestSync(assignment.botId).catch((error) => {
        console.error(`[feishu] bot=${assignment.botId} sync failed: ${error.message}`);
      });
    }, 500);
    timer.unref?.();
    this.syncTimers.set(assignment.botId, timer);
  }

  async syncBot(botId) {
    const activeRun = this.syncRuns.get(botId);
    if (activeRun) {
      activeRun.rerun = true;
      return activeRun.promise;
    }

    const run = { rerun: false, promise: null };
    run.promise = Promise.resolve().then(async () => {
      try {
        do {
          run.rerun = false;
          await this.syncBotOnce(botId);
        } while (run.rerun);
      } finally {
        if (this.syncRuns.get(botId) === run) {
          this.syncRuns.delete(botId);
        }
      }
    });
    this.syncRuns.set(botId, run);
    return run.promise;
  }
}
