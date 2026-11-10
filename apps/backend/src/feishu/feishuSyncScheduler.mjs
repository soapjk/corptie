import { formatFeishuFailureForLog } from "./feishuCliRuntime.mjs";

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
    this.failureState = new Map();
    this.syncInterval = null;
  }

  start() {
    this.syncInterval = this.scheduleInterval(() => {
      for (const assignment of this.store.listFeishuAssignments()) {
        if (this.store.getFeishuBot(assignment.botId)?.enabled) {
          this.runPeriodicSync(assignment.botId);
        }
      }
    }, 2000);
    this.syncInterval.unref?.();
  }

  // A rejected payload used to be replayed every 2s forever, with the full
  // lark-cli command line (including the card JSON) written to stderr each
  // time. Back off per bot and log an identical failure only once.
  runPeriodicSync(botId) {
    const state = this.failureState.get(botId) ?? { consecutive: 0, nextAllowedAt: 0, lastSignature: null };
    this.failureState.set(botId, state);
    if (Date.now() < state.nextAllowedAt) return Promise.resolve();
    return Promise.resolve()
      .then(() => this.requestSync(botId))
      .then(() => {
        state.consecutive = 0;
        state.nextAllowedAt = 0;
        state.lastSignature = null;
      })
      .catch((error) => {
        state.consecutive += 1;
        const backoff = Math.min(2000 * (2 ** Math.min(state.consecutive - 1, 5)), 60000);
        state.nextAllowedAt = Date.now() + backoff;
        const signature = `${error?.name ?? "Error"}|${error?.feishuCode ?? ""}|${String(error?.message ?? "").slice(0, 200)}`;
        if (signature === state.lastSignature) return;
        state.lastSignature = signature;
        console.error(`[feishu] bot=${botId} periodic sync failed: ${formatFeishuFailureForLog(error)} (backoff ${backoff}ms)`);
      });
  }

  close() {
    for (const timer of this.syncTimers.values()) {
      this.cancelTimeout(timer);
    }
    this.syncTimers.clear();
    this.failureState.clear();
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
        console.error(`[feishu] bot=${assignment.botId} sync failed: ${formatFeishuFailureForLog(error)}`);
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
