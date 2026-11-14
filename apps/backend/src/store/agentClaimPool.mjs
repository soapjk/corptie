import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const failure = code => Object.assign(new Error(code), { code, statusCode: 503 });

// One bounded writer for named claims, not arbitrary SQL or serialized callbacks.
export class AgentClaimPool {
  constructor({ dbPath, timeoutMs = 10000, maxQueue = 64, workerURL = new URL('./agentClaimWorker.mjs', import.meta.url) }) {
    this.options = { dbPath, timeoutMs, maxQueue, workerURL };
    this.queue = []; this.current = null; this.closed = false; this.ready = false;
  }
  spawn() {
    const worker = new Worker(this.options.workerURL, { workerData: { dbPath: this.options.dbPath } });
    this.worker = worker; this.ready = false;
    this.startupTimer = setTimeout(() => { void this.retire(worker, 'CLAIM_WORKER_UNAVAILABLE'); }, this.options.timeoutMs);
    this.startupTimer.unref?.();
    worker.on('message', message => {
      if (this.worker !== worker) return;
      if (message.type === 'ready') { clearTimeout(this.startupTimer); this.ready = true; this.drain(); return; }
      if (message.type === 'fatal') { void this.retire(worker, message.code); return; }
      if (message.id !== this.current?.id) return;
      const request = this.current; this.current = null; clearTimeout(request.timer);
      if (request.queueWaitMs + message.executionMs >= 250) console.info('[database-operation]', JSON.stringify({ timestamp: new Date().toISOString(), requestId: request.input.requestId ?? request.id,
        operation: request.operation, queueWaitMs: request.queueWaitMs, executionMs: message.executionMs }));
      if (message.code) request.reject(failure(message.code)); else request.resolve(message.result);
      this.drain();
    });
    worker.on('error', () => { void this.retire(worker, 'CLAIM_WORKER_FAILED'); });
    worker.on('exit', () => { if (!this.closed) void this.retire(worker, 'CLAIM_WORKER_EXITED'); });
  }
  retire(worker, code) {
    if (!worker || this.worker !== worker) return this.retiring;
    this.worker = null; this.ready = false;
    clearTimeout(this.startupTimer);
    const pending = this.current; this.current = null;
    if (pending) clearTimeout(pending.timer);
    const queued = this.queue.splice(0);
    // No replacement writer can start until the old connection has closed.
    this.retiring = worker.terminate().catch(() => {}).then(() => {
      this.retiring = null;
      if (pending) pending.reject(failure(code));
      for (const request of queued) {
        clearTimeout(request.queueTimer);
        request.reject(failure('CLAIM_WORKER_UNAVAILABLE'));
      }
    });
    return this.retiring;
  }
  request(operation, input) {
    if (this.closed) return Promise.reject(failure('CLAIM_POOL_CLOSED'));
    if (this.retiring) return Promise.reject(failure('CLAIM_WORKER_UNAVAILABLE'));
    if (this.queue.length >= this.options.maxQueue) return Promise.reject(failure('CLAIM_QUEUE_FULL'));
    if (!this.worker) this.spawn();
    return new Promise((resolve,reject) => {
      const request = { id: randomUUID(), operation, input, resolve, reject, queuedAt: performance.now() };
      request.queueTimer = setTimeout(() => {
        const index = this.queue.indexOf(request);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(failure('CLAIM_QUEUE_TIMEOUT')); // never submitted to SQLite
      }, this.options.timeoutMs);
      request.queueTimer.unref?.();
      this.queue.push(request);
      this.drain();
    });
  }
  drain() {
    if (!this.ready || this.current || this.closed || !this.queue.length) return;
    const request = this.current = this.queue.shift();
    clearTimeout(request.queueTimer);
    request.queueWaitMs = performance.now() - request.queuedAt;
    request.timer = setTimeout(() => { void this.retire(this.worker, 'CLAIM_RESULT_UNKNOWN'); }, this.options.timeoutMs);
    request.timer.unref?.();
    this.worker.postMessage({ id: request.id, operation: request.operation, input: request.input });
  }
  async claim(item) {
    const input = { taskId: item.taskId, sessionId: item.sessionId, updatedAt: item.updatedAt, requestId: randomUUID() };
    try { return await this.request('claim', input); }
    catch (error) {
      if (!['CLAIM_RESULT_UNKNOWN','CLAIM_WORKER_EXITED','CLAIM_WORKER_FAILED'].includes(error.code)) throw error;
      // Read-only reconciliation. Never replay an outcome-unknown mutation.
      return this.request('inspect', input);
    }
  }
  async close() {
    this.closed = true;
    for (const request of this.queue.splice(0)) { clearTimeout(request.queueTimer); request.reject(failure('CLAIM_POOL_CLOSED')); }
    if (this.worker) await this.retire(this.worker, 'CLAIM_POOL_CLOSED');
    else await this.retiring;
  }
}
