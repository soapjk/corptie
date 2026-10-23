import { Worker } from 'node:worker_threads';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function authorizeCredentialMigration(request, dataRoot) {
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket?.remoteAddress)
      || request.headers?.origin) return false;
  try {
    const expected = Buffer.from((await readFile(join(dataRoot,'client-devices','admin-token'),'utf8')).trim());
    const actual = Buffer.from(String(request.headers.authorization ?? '').replace(/^Bearer /,''));
    return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected,actual);
  } catch { return false; }
}

// Only explicit, authenticated native management routes call start(). Status
// and server startup never instantiate the legacy reader or a Worker.
export function createMcpCredentialMigration(service, { createWorker = data => new Worker(
  new URL('./mcpLegacyCredentialWorker.mjs', import.meta.url), {workerData:data}) } = {}) {
  let operation = {state:'not_requested',migrated:0,missing:0,failed:0};
  let worker;
  const status = () => structuredClone(operation);
  return {
    status,
    async start() {
      if (operation.state === 'importing') return status();
      await service.initializeCredentials();
      const accounts = service.credentialMigrationReferences().filter(ref => !service.secretStore.get(ref));
      if (accounts.length > 256) throw Object.assign(new Error('Too many legacy credentials.'),{code:'MCP_MIGRATION_LIMIT',statusCode:409});
      operation = {state:accounts.length?'importing':'completed',operationId:randomUUID(),migrated:0,missing:0,failed:0};
      if (!accounts.length) return status();
      const attempt = operation;
      let queue=Promise.resolve();
      worker = createWorker({accounts,sourceDataRoot:service.secretStore.legacySourceDataRoot?.() ?? service.store.dataDir});
      const active = worker;
      const timer=setTimeout(()=>{ if(operation===attempt && operation.state==='importing') {
        operation.state='interrupted'; void active.terminate();
      } },120000); timer.unref?.();
      worker.on('message', message => {
        queue=queue.then(async()=>{
          if (operation!==attempt || operation.state!=='importing') return;
          if (!accounts.includes(message.account)) throw new Error('Unexpected migration account');
          if(message.failed){operation.failed++;operation.state='failed';void active.terminate();return;}
          if(!message.value){operation.missing++;return;}
          await service.secretStore.put(message.account,message.value);
          operation.migrated++;
        }).catch(()=>{operation.failed++;operation.state='failed';void active.terminate();});
      });
      worker.on('error',()=>{if(operation===attempt){operation.failed++;operation.state='failed';}});
      worker.on('exit',()=>{
        clearTimeout(timer);
        void queue.then(()=>{if(operation===attempt && operation.state==='importing') operation.state='completed';});
        if(worker===active)worker=null;
      });
      return status();
    },
    cancel() { if(worker){operation.state='interrupted';void worker.terminate();worker=null;}return status(); }
  };
}
