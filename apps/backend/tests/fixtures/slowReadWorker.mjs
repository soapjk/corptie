import { parentPort, workerData } from 'node:worker_threads';
import { NativeDatabase } from '../../src/store/nativeDatabase.mjs';
const db = new NativeDatabase(workerData.dbPath, { readOnly: true });
db.database.function('test_slow_read', milliseconds => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  return 1;
});
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', ({ requestId, input }) => {
  const result = db.get('SELECT test_slow_read(?) AS complete', [input.delay ?? 0]);
  const payload = new TextEncoder().encode(JSON.stringify(result));
  parentPort.postMessage({ type: 'result', requestId, payload }, [payload.buffer]);
});
