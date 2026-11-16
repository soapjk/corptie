import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {CorptieStore} from '../src/store/corptieStore.mjs';
import {WorkApplicationService} from '../src/application/workApplicationService.mjs';
import {SessionMailboxService} from '../src/application/sessionMailboxService.mjs';
import {ExecutionChecklistService} from '../src/application/executionChecklistService.mjs';
import {ExecutionChecklistContinuationService} from '../src/application/executionChecklistContinuationService.mjs';
import {CoordinationDecisionService} from '../src/application/coordinationDecisionService.mjs';
import {CoordinationProgressService} from '../src/application/coordinationProgressService.mjs';
import {coordinationProgressSchema} from '../src/application/coordinationProgressProjection.mjs';
import {publicUserInput} from '../src/application/interactionInput.mjs';
import {VerificationBudgetService} from '../src/application/verificationBudgetService.mjs';

const tick=()=>new Promise(r=>setImmediate(r));
async function fixture(t,provider='codex-app-server'){
  const store=new CorptieStore({dbPath:':memory:',configPath:'/unused-continuation',manageProcessEnvironment:false});
  await store.initialize({resolveDataPath:false});
  t.after(async()=>{await tick();await store.close();});
  const agent=store.createAgent({name:'Worker'}),work=new WorkApplicationService({store}).createWork({name:'Plans',contributorAgentIds:[agent.agentId]});
  const task=store.createTask({workId:work.id,title:'Plan',mainAgentId:agent.agentId});
  const sessionId='provider:plan',logicalId='logical:plan';
  store.createSession({id:sessionId,agentId:agent.agentId,title:'Plan',provider,workId:work.id,taskId:task.id,sessionKind:'worker'});
  store.createLogicalSessionRoute({logicalSessionId:logicalId,legacySessionId:sessionId,providerId:provider,providerThreadId:'plan',providerSessionId:sessionId,boundCwd:'/tmp',sessionName:'Plan'});
  store.db.run('UPDATE tasks SET current_session_id=? WHERE id=?',[sessionId,task.id]);
  const route=store.getLogicalSession(logicalId),events=[],mailbox=new SessionMailboxService({store});
  const checklists=new ExecutionChecklistService({store}),repository=checklists.repository;
  const continuation=new ExecutionChecklistContinuationService({store,checklists,mailbox,emitEvent:(...e)=>events.push(e)});
  continuation.coordinator={shadow:{readyRecipient:async()=>({sessionId:logicalId})}};
  const context={model:true,logicalSessionId:logicalId,turnId:'initial',bindingId:route.activeBinding.bindingId,instructionId:'instruction:initial'};
  let serial=0;
  const create=(steps=[{text:'Implement'}],ctx={})=>checklists.mutate(task.id,{action:'create',operationId:`create:${++serial}`,expectedRevision:checklists.read(task.id)?.revision??0,steps},{...context,...ctx}).checklist;
  const change=(plan,input)=>checklists.mutate(task.id,{planId:plan.planId,expectedRevision:checklists.read(task.id,{planId:plan.planId}).revision,operationId:`change:${++serial}`,...input},context).checklist;
  return {store,agent,work,task,sessionId,logicalId,route,events,mailbox,checklists,repository,continuation,create,change};
}

for(const provider of ['codex-app-server','claude-sdk','openclacky'])test(`${provider}: hidden unfinished plans enqueue once and never replay after recovery`,async t=>{
  const f=await fixture(t,provider),plan=f.create();f.change(plan,{action:'close'});
  await Promise.all([f.continuation.reconcile(plan.planId),f.continuation.reconcile(plan.planId)]);
  const runtime=f.repository.runtime(plan.planId),op=f.store.getAgentTask(runtime.operationId);
  assert.equal(op.status,'queued');assert.equal(op.localVisibility,'status_only');
  assert.equal(op.source.checklistContinuation.planId,plan.planId);
  const row=f.store.selectOne('SELECT * FROM session_mailbox_messages WHERE operation_id=?',[op.taskId]);
  f.continuation.validate(row,JSON.parse(row.authorization_json));
  f.continuation.recover();await tick();
  assert.equal(f.store.listAgentTasksForSession(f.sessionId).length,1);
  const current=f.checklists.read(f.task.id,{planId:plan.planId});
  f.checklists.control(f.task.id,{planId:plan.planId,action:'pause',expectedRevision:current.revision},{authenticated:true});
  assert.throws(()=>f.continuation.validate(row,JSON.parse(row.authorization_json)),{code:'CHECKLIST_CONTINUATION_RETIRED'});
  await f.continuation.reconcile(plan.planId);
  assert.equal(f.repository.runtime(plan.planId).state,'paused_user');
});

test('independent inputs keep separate plans and late updates cannot steal the current pointer',async t=>{
  const f=await fixture(t),first=f.create(),second=f.create([{text:'Second'}],{instructionId:'instruction:second',turnId:'second'});
  assert.equal(f.repository.runtime(first.planId).state,'idle');
  f.change(first,{action:'status',itemId:first.steps[0].stepId,status:'inProgress'});
  assert.equal(f.checklists.read(f.task.id).planId,second.planId);
  assert.equal(f.checklists.read(f.task.id,{planId:first.planId}).steps[0].status,'inProgress');
});

test('verification waits until every implementation step is complete and cannot inherit old assignment revision',async t=>{
  const f=await fixture(t),plan=f.create([{text:'Implement'},{text:'Verify',phase:'verification'}]);
  const child=f.store.createTask({workId:f.work.id,title:'Child',mainAgentId:f.agent.agentId,parentTaskId:f.task.id});
  f.change(plan,{action:'assign',itemId:plan.steps[0].stepId,taskId:child.id});
  f.change(plan,{action:'edit',itemId:plan.steps[0].stepId,text:'Changed implementation'});
  let current=f.checklists.read(f.task.id,{planId:plan.planId});
  assert.notEqual(current.steps[0].executionRevision,current.steps[0].assignment.executionRevision);
  await f.continuation.reconcile(plan.planId);
  assert.deepEqual(f.repository.runtime(plan.planId).nextStepIds,[plan.steps[0].stepId]);
  f.store.updateAgentTask(f.repository.runtime(plan.planId).operationId,{status:'completed'});
  f.change(plan,{action:'status',itemId:plan.steps[0].stepId,status:'completed'});
  await f.continuation.reconcile(plan.planId);
  assert.deepEqual(f.repository.runtime(plan.planId).nextStepIds,[plan.steps[1].stepId]);
});

test('user and budget pauses are visible and only a fresh budget release resumes its original root',async t=>{
  const f=await fixture(t),plan=f.create();let paused=true;
  f.continuation.budget={read:()=>({paused})};await f.continuation.reconcile(plan.planId);
  assert.equal(f.repository.runtime(plan.planId).state,'paused_budget');
  const shown=f.checklists.display(f.checklists.read(f.task.id));assert.equal(shown.continuation.canResume,false);
  assert.throws(()=>f.checklists.control(f.task.id,{planId:plan.planId,action:'resume',expectedRevision:shown.revision},{authenticated:true}),{code:'VERIFICATION_BUDGET_EXHAUSTED'});
  paused=false;await f.continuation.reconcile(plan.planId);
  assert.equal(f.repository.runtime(plan.planId).pauseReason,null);
  assert.ok(f.repository.runtime(plan.planId).operationId);
});

test('old progress-only snapshots stay inactive and uncertain restart results never repeat side effects',async t=>{
  const f=await fixture(t),plan=f.create();
  f.store.db.run('DELETE FROM execution_checklist_runtime');
  assert.equal(await f.continuation.reconcile(plan.planId),null);
  assert.equal(f.checklists.display(plan).continuation,null);
  f.repository.saveRuntime(plan.planId,{enabled:true,state:'idle',generation:0,responsibleSessionId:f.logicalId,sourceOperationId:'failed:original'});
  f.store.enqueueAgentTask({taskId:'failed:original',agentId:f.agent.agentId,sessionId:f.sessionId,kind:'user',priority:0,text:'Do work'});
  f.store.updateAgentTask('failed:original',{status:'failed'});
  f.continuation.recover();await tick();
  assert.equal(f.repository.runtime(plan.planId).state,'needs_attention');
  assert.equal(f.store.listAgentTasksForSession(f.sessionId).length,1);
  assert.match(f.events.find(e=>e[0]==='SessionCoordinationMilestone')[1].item.text,/不会自动重放/);
});

test('finished turns without progress stop with one actionable failure rather than a repeating loop',async t=>{
  const f=await fixture(t),plan=f.create();await f.continuation.reconcile(plan.planId);
  const op=f.store.getAgentTask(f.repository.runtime(plan.planId).operationId);
  f.store.updateAgentTask(op.taskId,{status:'completed',targetTurnId:'auto:turn'});
  f.continuation.onRuntimeEvent('SessionCoordinationCompleted',{sessionId:f.sessionId,turnId:'auto:turn'});await tick();
  assert.equal(f.repository.runtime(plan.planId).state,'needs_attention');
  await f.continuation.reconcile(plan.planId);
  assert.equal(f.store.listAgentTasksForSession(f.sessionId).length,1);
  assert.equal(f.store.getItems(f.sessionId).filter(i=>i.id.startsWith('checklist-notice:')).length,1);
  assert.match(f.repository.runtime(plan.planId).reason,/未推进/);
});

test('completion is finalized once and repeated reconciliation adds no delivery messages',async t=>{
  const f=await fixture(t),plan=f.create();f.change(plan,{action:'status',itemId:plan.steps[0].stepId,status:'completed'});
  await f.continuation.reconcile(plan.planId);await f.continuation.reconcile(plan.planId);
  assert.equal(f.repository.runtime(plan.planId).state,'completed');
  assert.equal(f.events.filter(e=>e[0]==='ExecutionChecklistCompleted').length,1);
  assert.equal(f.store.getItems(f.sessionId).filter(i=>i.id.startsWith('checklist-notice:')).length,1);
});

test('continuation inherits the original verification instruction identity, not a fresh quota',async t=>{
  const f=await fixture(t);
  f.store.enqueueAgentTask({taskId:'root',agentId:f.agent.agentId,sessionId:f.sessionId,kind:'user',priority:0,text:'Implement',source:{type:'desktop',messageId:'original-message'}});
  const budget=new VerificationBudgetService({store:f.store});
  f.checklists.instructionRoot=id=>budget.operationRoot(f.store.selectOne('SELECT * FROM agent_operations WHERE task_id=?',[id]));
  f.store.updateAgentTask('root',{status:'completed'});
  const plan=f.create(undefined,{sourceOperationId:'root'});
  await f.continuation.reconcile(plan.planId);
  const op=f.store.selectOne('SELECT * FROM agent_operations WHERE task_id=?',[f.repository.runtime(plan.planId).operationId]);
  assert.equal(budget.operationRoot(op).instructionId,budget.operationRoot(f.store.selectOne("SELECT * FROM agent_operations WHERE task_id='root'")).instructionId);
  assert.equal(plan.instructionId,budget.operationRoot(op).instructionId);
});

function decisionService(f){
  const shadow={assertDelegate:()=>({main_session_id:f.logicalId,parent_task_id:f.task.id}),readyRecipient:async()=>({sessionId:f.logicalId}),assertRecipient:()=>{}};
  return new CoordinationDecisionService({...f,shadow,continuations:f.continuation,emitEvent:(...e)=>f.events.push(e)});
}
const question={category:'business',question:'Which retention policy should be applied?',topicKey:'retention',options:[{id:'short',label:'Short'},{id:'long',label:'Long'}],recommendation:'Short',impact:'Storage usage',stepIds:[],allowsText:true};
test('one genuine question is visible on paired clients and an answer queues exactly one shadow action',async t=>{
  const f=await fixture(t),plan=f.create(),decisions=decisionService(f),scope={mainId:f.logicalId,shadowId:'shadow',planId:plan.planId};
  assert.equal(decisions.propose(scope,{...question,category:'engineering'}),null);
  assert.equal(decisions.propose(scope,'.'),null);
  const first=decisions.propose(scope,question),again=decisions.propose(scope,question);
  assert.equal(first.id,again.id);assert.equal(first.revision,again.revision);
  const item=f.store.getSessionItem(f.sessionId,first.id),visible=publicUserInput(item.userInput);
  assert.ok(visible);assert.match(visible.questions[0].question,/Which retention/);assert.match(visible.questions[0].question,/Storage/);
  const answer={[visible.questions[0].id]:['Short']};
  const receipt=await decisions.answer(f.sessionId,first.id,answer,{type:'remote-client'});
  assert.ok(receipt.messageId);assert.equal((await decisions.answer(f.sessionId,first.id,answer,{type:'desktop'})).reused,true);
  assert.equal(decisions.pending(f.logicalId).length,0);assert.equal(f.store.listAgentTasksForSession(f.sessionId).length,1);
  assert.equal(decisions.propose(scope,question).status,'answered');
});

test('stale answers and untrusted senders cannot resolve or replace a changed decision',async t=>{
  const f=await fixture(t),plan=f.create(),decisions=decisionService(f),scope={mainId:f.logicalId,shadowId:'shadow',planId:plan.planId};
  const old=decisions.propose(scope,question),oldItem=f.store.getSessionItem(f.sessionId,old.id),answer={[oldItem.userInput.questions[0].id]:['Short']};
  await assert.rejects(decisions.answer(f.sessionId,old.id,answer,{type:'background'}),{code:'SHADOW_DECISION_USER_REQUIRED'});
  decisions.shadow.readyRecipient=async()=>{decisions.propose(scope,{...question,existingDecisionId:old.id,question:'Choose the updated retention policy now?'});return {sessionId:f.logicalId};};
  await assert.rejects(decisions.answer(f.sessionId,old.id,answer,{type:'desktop'}),{code:'SHADOW_DECISION_CHANGED'});
  assert.equal(decisions.pending(f.logicalId).length,1);assert.equal(f.store.listAgentTasksForSession(f.sessionId).length,0);
});

test('one plan card replaces updates across children and carries an honest overall state',async t=>{
  const f=await fixture(t),plan=f.create([{text:'Backend'},{text:'Client'},{text:'Validate',phase:'verification'}]);
  for(const step of plan.steps.slice(0,2)){
    const child=f.store.createTask({workId:f.work.id,title:step.text,mainAgentId:f.agent.agentId,parentTaskId:f.task.id});
    f.change(plan,{action:'assign',itemId:step.stepId,taskId:child.id});
  }
  const progress=new CoordinationProgressService(f.store);progress.checklists=f.checklists;
  progress.refreshGroup(plan.planId);f.change(plan,{action:'status',itemId:plan.steps[0].stepId,status:'completed'});progress.refreshGroup(plan.planId);
  const cards=f.store.getItems(f.sessionId).filter(i=>i.type==='coordinationProgress');assert.equal(cards.length,1);
  assert.equal(cards[0].coordinationProgress.total,2);assert.equal(cards[0].coordinationProgress.finalized,false);
  assert.ok(new Ajv({strict:false}).compile(coordinationProgressSchema)(cards[0].coordinationProgress));
  assert.equal(progress.latest(f.task.id).groupId,plan.planId);
});

test('delivery receipts reach the parent plan before destructive reclamation removes temporary evidence',async t=>{
  const f=await fixture(t),plan=f.create();
  const child=f.store.createTask({workId:f.work.id,title:'Delivered_child',mainAgentId:f.agent.agentId,parentTaskId:f.task.id});
  f.change(plan,{action:'assign',itemId:plan.steps[0].stepId,taskId:child.id});
  const now=new Date(Date.now()+1000).toISOString();
  f.store.db.run(`INSERT INTO child_task_delivery_operations(operation_id,child_task_id,parent_task_id,work_id,approval_operation_id,snapshot_json,actor_json,state,created_at,updated_at)
    VALUES(?,?,?,?,?,'{}','{}','completed',?,?)`,['delivered',child.id,f.task.id,f.work.id,'approval:delivery',now,now]);
  f.continuation.recordDeliveredChild(child.id);
  f.store.db.run('DELETE FROM child_task_delivery_operations WHERE child_task_id=?',[child.id]);
  const stored=f.checklists.read(f.task.id,{planId:plan.planId});
  assert.equal(stored.steps[0].status,'completed');assert.equal(stored.steps[0].completionEvidence.deliveryOperationId,'delivered');
});

test('pause and resume requests retain retry identity and cannot consume a changed question as an unrelated answer',async t=>{
  const f=await fixture(t),plan=f.create(),input={action:'pause',planId:plan.planId,expectedRevision:plan.revision,operationId:'control:pause'};
  const first=f.checklists.control(f.task.id,input,{authenticated:true}),second=f.checklists.control(f.task.id,input,{authenticated:true});
  assert.equal(first.receipt.revision,second.receipt.revision);assert.equal(f.repository.runtime(plan.planId).generation,1);
  assert.throws(()=>f.checklists.control(f.task.id,{...input,action:'resume'},{authenticated:true}),{code:'CHECKLIST_OPERATION_CONFLICT'});
});

test('answering a dependency is the continuation itself, not a second queued planner turn',async t=>{
  const f=await fixture(t),plan=f.create(),decisions=decisionService(f);
  const decision=decisions.propose({mainId:f.logicalId,shadowId:'shadow',planId:plan.planId},{...question,stepIds:[plan.steps[0].stepId]});
  f.repository.wait(plan.planId,{stepId:plan.steps[0].stepId,kind:'decision',resourceId:decision.id});
  await f.continuation.reconcile(plan.planId);assert.equal(f.repository.runtime(plan.planId).state,'waiting_user');
  const item=f.store.getSessionItem(f.sessionId,decision.id);
  await decisions.answer(f.sessionId,decision.id,{[item.userInput.questions[0].id]:['Short']},{type:'desktop'});await tick();
  assert.equal(f.store.listAgentTasksForSession(f.sessionId).length,1);
  assert.ok(f.repository.runtime(plan.planId).operationId);
  assert.equal(f.repository.waits(plan.planId).length,0);
  assert.equal(f.repository.runtime(plan.planId).state,'running');
});

test('a budget resume binds to the existing plan without creating a second automatic operation',async t=>{
  const f=await fixture(t),plan=f.create();
  const runtime=f.repository.runtime(plan.planId);f.repository.saveRuntime(plan.planId,{...runtime,state:'paused_budget',pauseReason:'budget'});
  const queued=f.mailbox.enqueueExternalOperation({taskId:'budget:resume',agentId:f.agent.agentId,sessionId:f.sessionId,kind:'user',priority:10,text:'Continue original work',source:{verificationContinuation:{instructionId:runtime.instructionId}}},{sourceType:'system',authorization:{sourceId:'budget:resume',ownerLogicalSessionId:f.logicalId}});
  f.continuation.bindInstructionResume(runtime.instructionId,queued.task);
  await f.continuation.reconcile(plan.planId);
  assert.equal(f.repository.runtime(plan.planId).operationId,'budget:resume');
  assert.equal(f.store.listAgentTasksForSession(f.sessionId).length,1);
  assert.equal(f.store.getAgentTask('budget:resume').source.executionPlanId,plan.planId);
});

test('legacy question duplicates become one visible decision while placeholders stay historical',async t=>{
  const f=await fixture(t),decisions=decisionService(f);
  decisions.shadow.forMain=()=>({shadow_session_id:'shadow',state:'ready',requirement_revision:1});
  for(const [id,question] of [['legacy:a','Choose a retention policy?'],['legacy:b','Choose a retention policy?'],['legacy:placeholder','/not-used']]){
    f.store.db.run(`INSERT INTO coordination_shadow_reports VALUES(?,?,? ,?,1,?,?,?)`,[id,f.logicalId,'old:shadow',id,'Progress update',JSON.stringify({question}),'2026-11-01']);
    f.store.upsertTimelineItemProjection(f.sessionId,{id,turnId:id,type:'agentMessage',text:'Progress update',status:'completed',turnStatus:'completed',rawMetadataJSON:JSON.stringify({coordinationEvent:{kind:'decision'},decision:{question}})});
  }
  await decisions.recoverLegacy();await decisions.recoverLegacy();
  assert.equal(decisions.pending(f.logicalId).length,1);
  assert.equal(JSON.parse(f.store.getSessionItem(f.sessionId,'legacy:placeholder').rawMetadataJSON).coordinationEvent.kind,'summary');
  const rows=f.store.selectAll("SELECT decision_json FROM coordination_shadow_reports WHERE report_id IN ('legacy:a','legacy:b')");
  assert.equal(JSON.parse(rows[0].decision_json).legacyMigration,JSON.parse(rows[1].decision_json).legacyMigration);
});
