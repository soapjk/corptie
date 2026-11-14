import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkChatReadOnlyTurnService, conversationWorktreeBlocker } from '../src/application/workChatReadOnlyTurnService.mjs';
function fixture({ provider = 'codex-app-server', kind = 'workChat', supported = true } = {}) {
  let job = {id:'merge',status:'paused',phase:'conflict',details:{dispatchSafety:{blockedWorktreeIds:['main']}}};
  let session = {id:'session',sessionKind:kind,provider,cwd:'/tmp',external:{provider}};
  const reference={sessionId:'session',logicalSessionId:'logical',bindingId:'binding',routingVersion:1,providerId:provider};
  const turns=new Map(),items=[],calls=[],terminal=[];
  let delivery={status:'dispatching',sessionId:'session',bindingId:'binding',routingVersion:1};
  const store={getSession:()=>session,getLogicalSessionByLegacySessionId:()=>({legacySessionId:'session',repositoryId:'repo',activeWorkspaceId:'main'}),
    listWorktreeIntegrationJobsForWorktree:()=>job?[job]:[],getSessionTurn:(_s,_b,id)=>turns.get(id),listUnsettledSessionTurns:()=>[],
    upsertSessionTurn:t=>turns.set(t.turnId,{execution_status:t.executionStatus}),upsertSession:s=>session=s,
    upsertTimelineItemProjection:(_s,item)=>items.push(item),getSessionTimelineHistoryPage:()=>({items:[{type:'userMessage',text:'earlier discussion'}]}),
    getMessageDelivery:()=>delivery,updateMessageDelivery:(_id,patch)=>delivery={...delivery,...patch}};
  const registry={supports:()=>supported,get:()=>({descriptor:{metadata:{backgroundExecutionPolicies:supported?['no-tools']:[]}}})};
  const planner={run:async request=>{calls.push(request);return {text:'Discussion reply'};}};
  const service=new WorkChatReadOnlyTurnService({store,registry,planner,onTerminal:t=>terminal.push(t)});
  return {store,registry,reference,service,calls,items,turns,terminal,planner,release:()=>job=null,delivery:()=>delivery};
}
for(const provider of ['codex-app-server','claude-agent-sdk']) test(`${provider}: conflict Work Chat uses isolated no-tools turn, normal mode resumes after release`,async()=>{
  const f=fixture({provider});
  assert.equal(conversationWorktreeBlocker(f.store,f.registry,f.reference),null);
  await f.service.send(f.reference,{text:'Explain this'},{idempotencyKey:'delivery'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].executionPolicy,'no-tools');assert.equal(f.calls[0].permissionProfile,'read-only');
  assert.equal(f.calls[0].allowProviderFallback,false);assert.equal(f.calls[0].preferredProviderId,provider);
  assert.match(f.calls[0].prompt,/earlier discussion/);
  assert.equal(f.delivery().status,'processing');assert.equal(f.terminal[0].status,'completed');
  assert.equal(f.items.at(-1).text,'Discussion reply');
  f.release();assert.equal(f.service.required(f.reference),false);
});
test('worker remains blocked and unsupported provider never silently falls back',async()=>{
  const worker=fixture({kind:'worker'});assert.equal(conversationWorktreeBlocker(worker.store,worker.registry,worker.reference).reason,'WORKTREE_CONFLICT_OR_RECOVERY');
  const f=fixture({provider:'other',supported:false});
  assert.equal(conversationWorktreeBlocker(f.store,f.registry,f.reference).reason,'WORK_CHAT_READ_ONLY_UNSUPPORTED');
  await assert.rejects(f.service.send(f.reference,'hello'),{code:'WORK_CHAT_READ_ONLY_UNSUPPORTED'});assert.equal(f.calls.length,0);
});
test('failure settles the visible turn without native fallback; interruption is propagated',async()=>{
  const f=fixture();f.planner.run=async()=>{throw new Error('failed');};
  await f.service.send(f.reference,'hello');assert.equal(f.terminal[0].status,'failed');
  const g=fixture();g.planner.run=async request=>{await g.service.interrupt(g.reference);assert.equal(request.signal.aborted,true);return {text:'late reply'};};
  await g.service.send(g.reference,'hello');assert.equal(g.terminal[0].status,'cancelled');assert.ok(!g.items.some(i=>i.text==='late reply'));
});
test('images are explicitly rejected and terminal replay does not invoke model twice',async()=>{
  const f=fixture();await assert.rejects(f.service.send(f.reference,{text:'image',images:[{}]}),{code:'WORK_CHAT_READ_ONLY_IMAGE_UNSUPPORTED'});
  await f.service.send(f.reference,'hello',{idempotencyKey:'same'});await f.service.send(f.reference,'hello',{idempotencyKey:'same'});
  assert.equal(f.calls.length,1);
});
