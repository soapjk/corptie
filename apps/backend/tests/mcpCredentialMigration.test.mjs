import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpCredentialMigration, authorizeCredentialMigration } from '../src/application/mcpCredentialMigration.mjs';
import { createMcpSecretStore } from '../src/application/mcpSecretStore.mjs';
const ref='mcp:00000000-0000-4000-8000-000000000001:1';
const tick=()=>new Promise(r=>setImmediate(r));
test('only an explicit migration creates a worker; successful references persist and retry never reimports', async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcp-migration-'));
 try{
  const store=createMcpSecretStore({dataRoot:root});let calls=0,worker;
  const service={secretStore:store,initializeCredentials:()=>store.initialize(),credentialMigrationReferences:()=>[ref]};
  const migration=createMcpCredentialMigration(service,{createWorker:data=>{
   calls++;assert.deepEqual(data.accounts,[ref]);worker=new EventEmitter();worker.terminate=()=>{};return worker;
  }});
  assert.equal(migration.status().state,'not_requested');assert.equal(calls,0);
  await migration.start();worker.emit('message',{account:ref,value:{headers:{Authorization:'synthetic'}}});
  worker.emit('exit',0);await tick();await store.flush();await tick();
  assert.equal(migration.status().state,'completed');assert.equal(migration.status().migrated,1);
  const reopened=createMcpSecretStore({dataRoot:root});await reopened.initialize();assert.equal(reopened.get(ref).headers.Authorization,'synthetic');
  await migration.start();assert.equal(calls,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('declined or interrupted migration does not silently retry', async()=>{
 let calls=0,worker;
 const service={secretStore:{get:()=>null},store:{dataDir:'/unused'},initializeCredentials:async()=>{},credentialMigrationReferences:()=>[ref]};
 const migration=createMcpCredentialMigration(service,{createWorker:()=>{calls++;worker=new EventEmitter();worker.terminate=()=>{};return worker;}});
 await migration.start();worker.emit('message',{account:ref,failed:true});await tick();
 assert.equal(migration.status().state,'failed');assert.equal(calls,1);assert.equal(migration.status().failed,1);
 migration.status();assert.equal(calls,1);
});
test('migration admin authentication rejects browsers, remote callers and missing tokens', async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcp-migration-admin-'));
 try{
  await mkdir(join(root,'client-devices'));await writeFile(join(root,'client-devices','admin-token'),'synthetic-admin');
  const request={socket:{remoteAddress:'127.0.0.1'},headers:{authorization:'Bearer synthetic-admin'}};
  assert.equal(await authorizeCredentialMigration(request,root),true);
  assert.equal(await authorizeCredentialMigration({...request,headers:{...request.headers,origin:'https://example.test'}},root),false);
  assert.equal(await authorizeCredentialMigration({...request,socket:{remoteAddress:'192.0.2.1'}},root),false);
  assert.equal(await authorizeCredentialMigration({...request,headers:{}},root),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
