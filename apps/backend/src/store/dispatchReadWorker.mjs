import { parentPort, workerData } from 'node:worker_threads';
import { NativeDatabase } from './nativeDatabase.mjs';
import { configureStoreDatabase } from './storeDatabaseConnection.mjs';
import { readMailboxDispatchPage, readMemoryExtractionWindow } from './dispatchReadQueries.mjs';

let database;
try {
  database = new NativeDatabase(workerData.dbPath, { readOnly: true });
  configureStoreDatabase(database, { readOnly: true, readCacheSizeKiB: 8192, readMmapSizeBytes: 33554432 });
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  parentPort.postMessage({ type: 'fatal', error: serialize(error) });
}
parentPort.on('message', message => {
  const { requestId, operation, input } = message;
  try {
    database.run('BEGIN');
    let result;
    try {
      if (operation === 'mailboxDispatchPage') result = readMailboxDispatchPage(database, input);
      else if (operation === 'memoryExtractionWindow') result = readMemoryExtractionWindow(database, input);
      else throw Object.assign(new Error('Unsupported background read operation'), { code: 'BACKGROUND_READ_UNSUPPORTED' });
      database.run('COMMIT');
    } catch (error) { database.run('ROLLBACK'); throw error; }
    const payload = new TextEncoder().encode(JSON.stringify(result));
    parentPort.postMessage({ type: 'result', requestId, payload }, [payload.buffer]);
  } catch (error) { parentPort.postMessage({ type: 'result', requestId, error: serialize(error) }); }
});
function serialize(error) { return { name: error.name, message: error.message, code: error.code, statusCode: error.statusCode }; }
