import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseWorkerPool } from './databaseWorkerPool.mjs';

export class CoordinationCleanupPool extends DatabaseWorkerPool {
  constructor(options) {
    super({...options,size:1,maxQueueDepth:32,workerURL:new URL('./coordinationCleanupWorker.mjs',import.meta.url)});
  }
  async reclaimSessionRows(sessionId) {
    for(const table of ['session_items','session_events','session_logs','provider_event_inbox','event_outbox',
      'message_deliveries','session_turns','session_execution_plan_state','session_memory_topics',
      'memory_extraction_progress','memory_backfill_progress','memory_extraction_jobs','session_context_references']) {
      while(true) {
        const result=await this.cleanupCoordinationPage({sessionId,table});
        if(result.deleted<200) break;
        await delay(10);
      }
    }
  }
}
