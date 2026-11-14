import { DatabaseWorkerPool } from './databaseWorkerPool.mjs';

// Separate capacity from interactive timeline reads. Background discovery must
// never exhaust the readers used to display/send messages.
export class BackgroundReadPool extends DatabaseWorkerPool {
  constructor(options) {
    super({ ...options, size: 1, maxQueueDepth: 32, requestTimeoutMs: 5000,
      workerURL: new URL('./dispatchReadWorker.mjs', import.meta.url) });
  }
}
