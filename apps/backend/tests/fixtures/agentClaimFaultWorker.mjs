import { parentPort, workerData } from 'node:worker_threads';
import { openWritableStoreDatabase } from '../../src/store/storeDatabaseConnection.mjs';
import { executeAgentClaim } from '../../src/store/agentClaimOperation.mjs';
const db = openWritableStoreDatabase(workerData.dbPath);
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', ({ id, operation, input }) => {
  if (operation === 'claim' && input.taskId === 'before-commit') {
    db.run('BEGIN IMMEDIATE');
    db.run("UPDATE agent_operations SET status='running' WHERE task_id=?", [input.taskId]);
    process.exit(0); // connection termination must roll back
  }
  const result = executeAgentClaim(db, input, { inspectOnly: operation === 'inspect' });
  if (operation === 'claim' && input.taskId === 'lost-reply') process.exit(0);
  if (operation === 'claim' && input.taskId === 'late-reply') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  parentPort.postMessage({ id, result, executionMs: 0 });
});
