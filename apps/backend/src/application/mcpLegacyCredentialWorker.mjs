import { parentPort, workerData } from 'node:worker_threads';
import { createLegacyMcpSecretStore } from './mcpLegacyKeychainStore.mjs';
// A synchronous system authorization prompt must not block the HTTP/SSE loop.
const legacy = createLegacyMcpSecretStore({dataRoot:workerData.sourceDataRoot});
for (const account of workerData.accounts) {
  try {
    const value = legacy.get(account);
    parentPort.postMessage({account,value});
  } catch {
    parentPort.postMessage({account,failed:true});
    break; // Declining a prompt must not produce a succession of more prompts.
  }
}
