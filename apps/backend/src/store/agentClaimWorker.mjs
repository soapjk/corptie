import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { openWritableStoreDatabase } from './storeDatabaseConnection.mjs';
import { executeAgentClaim } from './agentClaimOperation.mjs';
let db;
try { db = openWritableStoreDatabase(workerData.dbPath); parentPort.postMessage({ type: 'ready' }); }
catch (error) { parentPort.postMessage({ type: 'fatal', code: error.code ?? 'CLAIM_WORKER_INIT_FAILED' }); }
parentPort.on('message', ({ id, operation, input }) => {
  const start = performance.now();
  try {
    if (!['claim','inspect'].includes(operation)) throw Object.assign(new Error('Unsupported claim operation'), { code: 'CLAIM_OPERATION_INVALID' });
    const result = executeAgentClaim(db, input, { inspectOnly: operation === 'inspect' });
    parentPort.postMessage({ id, result, executionMs: performance.now() - start });
  } catch (error) { parentPort.postMessage({ id, code: error.code ?? 'CLAIM_OPERATION_FAILED', executionMs: performance.now() - start }); }
});
