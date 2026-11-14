import { DatabaseWorkerPool } from './databaseWorkerPool.mjs';
// Single writer for atomic message admission. Never apply read deadlines to a
// write: loss of the response means unknown commit outcome, not safe retry.
export class SessionWritePool extends DatabaseWorkerPool {
  constructor(options) {
    super({...options,size:1,maxQueueDepth:128,workerURL:new URL('./sessionWriteWorker.mjs',import.meta.url)});
    this.pendingWrites = new Set();
    this.stopping = false;
  }
  claimSessionWork(input) {
    return this.trackWrite(() => super.claimSessionWork(input));
  }
  admitUserMessage(input) {
    return this.trackWrite(() => super.admitUserMessage(input));
  }
  trackWrite(start) {
    if(this.stopping) return Promise.reject(Object.assign(new Error('Session writer is closing.'),{code:'SESSION_WRITER_CLOSED'}));
    const operation=start();
    this.pendingWrites.add(operation);
    operation.finally(()=>this.pendingWrites.delete(operation)).catch(()=>{});
    return operation;
  }
  async close() {
    this.stopping=true;
    await Promise.allSettled([...this.pendingWrites]);
    await super.close();
  }
}
