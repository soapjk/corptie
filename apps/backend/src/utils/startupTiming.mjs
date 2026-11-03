import { performance } from "node:perf_hooks";

// Diagnostic spans only: existing stdout logging, no files, Store writes,
// hashes, prompts, command arguments, command output or filesystem paths.
export function createStartupTiming({ startupOperationId, taskId, providerId, attempt, dispatchId, parentTaskId } = {}, {
  emit = record => console.info(`[task-startup-timing] ${JSON.stringify(record)}`),
  now = () => performance.now()
} = {}) {
  const identity = { startupOperationId, taskId, providerId, attempt, dispatchId, parentTaskId, runStartedAt: new Date().toISOString() };
  let sequence = 0;
  const publish = record => { try { emit({ ...identity, ...record }); } catch { /* Diagnostics cannot change startup outcome. */ } };
  const scope = parentSpanId => ({
    async measure(stage, operation) {
      const spanId = ++sequence, started = now();
      publish({ stage, spanId, parentSpanId, event: "start" });
      try {
        const value = await operation(scope(spanId));
        publish({ stage, spanId, parentSpanId, event: "end", outcome: "ok", durationMs: elapsed(started),
          ...(stage === "startup.total" && ["ready", "pending", "failed"].includes(value?.status) ? { startupStatus: value.status } : {}) });
        return value;
      } catch (error) {
        publish({ stage, spanId, parentSpanId, event: "end", outcome: "failed", durationMs: elapsed(started),
          errorCode: typeof error?.code === "string" && /^[A-Z0-9_:-]{1,100}$/.test(error.code) ? error.code : "ERROR" });
        throw error;
      }
    }
  });
  const elapsed = started => Math.max(0, Math.round((now() - started) * 1000) / 1000);
  return scope(null);
}

export function measureStartup(timing, stage, operation) {
  return timing ? timing.measure(stage, operation) : operation(null);
}
