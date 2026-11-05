import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ArtifactService } from "../src/application/artifactService.mjs";
import { ChildTaskDeliveryService } from "../src/application/childTaskDeliveryService.mjs";
import { TaskCompletionService } from "../src/application/taskCompletionService.mjs";
import { TaskDeletionService } from "../src/application/taskDeletionService.mjs";
import { handleChildTaskDeliveryHttp } from "../src/application/childTaskDeliveryHttp.mjs";
import { ClientDeviceGateway } from "../src/application/clientDeviceGateway.mjs";

const actor={type:"user",id:"user:local-macos"};
async function fixture(t,provider="codex-app-server") {
  const directory=await mkdtemp(join(tmpdir(),"corptie-child-closeout-"));
  const options={dbPath:join(directory,"db.sqlite"),configPath:join(directory,"config.json"),manageProcessEnvironment:false};
  const store=new CorptieStore(options);await store.initialize({resolveDataPath:false});
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
  const agent=store.createAgent({name:"Delivery",provider});
  const work=store.createWork({name:"Delivery",contributorAgentIds:[agent.agentId]});
  const parent=store.createTask({workId:work.id,title:"Parent",mainAgentId:agent.agentId});
  const child=store.createTask({workId:work.id,title:"Child",parentTaskId:parent.id,mainAgentId:agent.agentId},{},
    {expectedParentResourceVersion:store.getTask(parent.id).resource_version});
  store.upsertSession({id:"session:child",title:"Child",provider,status:"idle",sessionKind:"worker",workId:work.id,taskId:child.id,agentId:agent.agentId});
  store.bindSessionToTask("session:child",child.id,work.id);
  const artifacts=new ArtifactService({store,contentRoot:join(directory,"artifacts")});await artifacts.initialize();
  let service;
  const deletion=new TaskDeletionService({store,
    authorize:({actor,task})=>actor?.type==="child_delivery" && service.authorizesCleanup(task.id,actor.id),
    inspectWorktree:async()=>({status:"none",worktree:null,blocker:null}),
    removeWorktree:async()=>assert.fail("Gitless child must not remove a Worktree"),
    deleteSession:async id=>store.deleteSession(id),
    handleArtifacts:async({artifacts,disposition})=>{assert.equal(disposition,"retain");return {artifactIds:artifacts.map(a=>a.artifactId)};}});
  service=new ChildTaskDeliveryService({store,gitWorkspaces:{},jobs:{},artifactService:artifacts,deletionService:deletion});
  const completion=new TaskCompletionService({store});completion.childDelivery=service;
  const context={kind:"local_user",actorId:actor.id,workId:work.id};
  const issue=async(suffix="one",user=actor)=>completion.issueUserIntent(child.id,{requestId:`request:${suffix}`,interactionId:`click:${suffix}`,
    uiSurface:"task_completion_confirmation",displayedTaskId:child.id,displayedTaskTitle:store.getTask(child.id).title},user);
  const accept=async(receipt,user=actor)=>completion.completeFromUser(child.id,{requestId:receipt.requestId,intentToken:receipt.intentToken,idempotencyKey:`accept:${receipt.requestId}`},user);
  return {store,options,directory,parent,child,agent,work,artifacts,service,deletion,completion,context,issue,accept};
}
async function settled(f,id) {
  await f.service.inFlight.get(id);
  return f.service.repository.getOperation(id);
}

for(const provider of ["codex-app-server","claude-code"]) {
  test(`one native acceptance moves all Artifact versions and retires only its child (${provider})`,async t=>{
    const f=await fixture(t,provider);
    const owned=await f.artifacts.create(f.context,{scope:"task",boundTaskId:f.child.id,title:"Delivery",content:"v1"});
    await f.artifacts.publishVersion(f.context,owned.artifactId,{content:"v2"});
    const privateFile=await f.artifacts.create(f.context,{scope:"session",visibility:"session_private",boundSessionId:"session:child",title:"Private",content:"private"});
    const shared=await f.artifacts.create(f.context,{scope:"work",title:"Shared",content:"shared"});
    const before=f.store.listArtifactVersions(owned.artifactId).map(v=>[v.version,v.contentHash]);
    const receipt=await f.issue(); const result=await f.accept(receipt);
    const final=await settled(f,result.childDelivery.operationId);
    assert.equal(final.state,"completed",final.errorMessage);
    assert.equal(f.store.getTask(f.child.id),null);
    assert.ok(f.store.getTask(f.parent.id));
    assert.equal(f.store.getArtifact(owned.artifactId).boundTaskId,f.parent.id);
    assert.equal(f.store.getArtifact(privateFile.artifactId).boundTaskId,f.parent.id);
    assert.equal(f.store.getArtifact(shared.artifactId).scope,"work");
    assert.deepEqual(f.store.listArtifactVersions(owned.artifactId).map(v=>[v.version,v.contentHash]),before);
    assert.ok(f.store.listArtifactReferences({artifactId:owned.artifactId}).some(r=>r.taskId===f.parent.id && r.versionPolicy==="fixed"));
    assert.equal(f.service.listParentDeliveries(f.parent.id).items[0].state,"completed");
    assert.equal(f.store.listTaskCompletionOperations(f.child.id).filter(op=>op.result==="succeeded").length,1);
    const replay=await f.accept(receipt);
    assert.equal(replay.idempotentReplay,true);
    assert.equal(replay.childDelivery.operationId,final.operationId);
    assert.deepEqual(f.store.selectAll("PRAGMA foreign_key_check"),[]);
  });
}
test("empty child can be retired without a Git Job or Artifact",async t=>{
  const f=await fixture(t);const result=await f.accept(await f.issue());
  assert.equal((await settled(f,result.childDelivery.operationId)).state,"completed");
});
test("changed Artifact inventory is captured at the actual approval click and delivered",async t=>{
  const f=await fixture(t),receipt=await f.issue();
  const artifact=await f.artifacts.create(f.context,{scope:"task",boundTaskId:f.child.id,title:"New",content:"new"});
  const accepted=await f.accept(receipt);
  const final=await settled(f,accepted.childDelivery.operationId);
  assert.equal(final.state,"completed",final.errorMessage);
  assert.equal(f.store.getArtifact(artifact.artifactId).boundTaskId,f.parent.id);
  assert.equal(f.store.getTask(f.child.id),null);
});
test("ownership write followed by a coordinator crash recovers without duplicating ownership or references",async t=>{
  const f=await fixture(t);
  const artifact=await f.artifacts.create(f.context,{scope:"task",boundTaskId:f.child.id,title:"File",content:"data"});
  const transfer=f.artifacts.transferChildDeliveryArtifact.bind(f.artifacts);let failOnce=true;
  f.artifacts.transferChildDeliveryArtifact=async(...args)=>{const result=await transfer(...args);if(failOnce){failOnce=false;throw new Error("simulated crash");}return result;};
  const accepted=await f.accept(await f.issue()),id=accepted.childDelivery.operationId;
  assert.equal((await settled(f,id)).state,"blocked");assert.ok(f.store.getTask(f.child.id));
  assert.equal(f.store.getArtifact(artifact.artifactId).boundTaskId,f.parent.id);
  f.service.retry(id);
  assert.equal((await settled(f,id)).state,"completed");
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifact_ownership_operations").count,1);
});
test("failed cleanup retries using the same approval and exact deletion target",async t=>{
  const f=await fixture(t);const original=f.deletion.deleteSession;let failOnce=true;
  f.deletion.deleteSession=async(...args)=>{if(failOnce){failOnce=false;throw new Error("temporary failure");}return original(...args);};
  const result=await f.accept(await f.issue()),id=result.childDelivery.operationId;
  assert.equal((await settled(f,id)).state,"blocked");
  f.service.retry(id);const final=await settled(f,id);
  assert.equal(final.state,"completed",final.errorMessage);
  assert.equal(f.store.listTaskCompletionOperations(f.child.id).filter(op=>op.result==="succeeded").length,1);
});
test("paired native acceptance is actor-bound and device revocation is revalidated",async t=>{
  const f=await fixture(t),paired={type:"user",id:"user:paired-device:phone"};
  const receipt=await f.issue("paired",paired);
  await assert.rejects(()=>f.accept(receipt,actor),{code:"COMPLETION_INTENT_TARGET_MISMATCH"});
  await assert.rejects(()=>f.completion.completeFromUser(f.child.id,{requestId:receipt.requestId,intentToken:receipt.intentToken,idempotencyKey:"revoked"},paired,
    {revalidate:()=>{throw Object.assign(new Error("revoked"),{code:"DEVICE_REVOKED"});}}),{code:"DEVICE_REVOKED"});
  const accepted=await f.completion.completeFromUser(f.child.id,{requestId:receipt.requestId,intentToken:receipt.intentToken,idempotencyKey:"paired:actual"},paired);
  assert.equal((await settled(f,accepted.childDelivery.operationId)).state,"completed");
});
test("machine assessment and historical done tasks never enqueue automatic retirement",async t=>{
  const f=await fixture(t);const completion=new TaskCompletionService({store:f.store});
  const receipt=await completion.issueMacOSIntent(f.child.id,{requestId:"legacy",interactionId:"legacy",uiSurface:"task_completion_confirmation",
    displayedTaskId:f.child.id,displayedTaskTitle:f.child.title},actor);
  await completion.completeFromMacOS(f.child.id,{requestId:"legacy",intentToken:receipt.intentToken,idempotencyKey:"legacy"});
  await f.service.recover();assert.equal(f.service.repository.listRecoverableOperations().length,0);assert.ok(f.store.getTask(f.child.id));
});
test("approval and durable enqueue roll back together",async t=>{
  const f=await fixture(t),receipt=await f.issue();
  f.service.recordApproval=()=>{throw new Error("enqueue unavailable");};
  await assert.rejects(()=>f.accept(receipt),/enqueue unavailable/);
  assert.notEqual(f.store.getTask(f.child.id).lifecycle_state,"done");
  assert.equal(f.store.getTaskCompletionIntentByRequest("direct_macos_ui_action",receipt.requestId).consumedOperationId,null);
});
test("new Artifact writes into an approved child are frozen, but parent writes are not",async t=>{
  const f=await fixture(t);const wake=f.service.wake;f.service.wake=()=>{};
  const accepted=await f.accept(await f.issue());
  await assert.rejects(()=>f.artifacts.create(f.context,{scope:"task",boundTaskId:f.child.id,title:"Late",content:"late"}),{code:"CHILD_DELIVERY_IN_PROGRESS"});
  const parentArtifact=await f.artifacts.create(f.context,{scope:"task",boundTaskId:f.parent.id,title:"Parent",content:"safe"});
  assert.equal(parentArtifact.boundTaskId,f.parent.id);
  f.service.wake=wake;await f.service.wake(accepted.childDelivery.operationId);
});
test("native route rejects unknown approval fields and does not accept a caller-supplied actor",async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>handleChildTaskDeliveryHttp({request:{method:"POST"},response:{},url:new URL(`http://local/client/v1/tasks/${f.child.id}/completion-intents`),
    prefix:"/client/v1",service:f.service,completion:f.completion,actor,revalidate:()=>{},readJson:async()=>({actor:{type:"user"}}),sendJson:()=>{}}),{code:"INVALID_INPUT"});
  await assert.rejects(()=>handleChildTaskDeliveryHttp({request:{method:"POST"},response:{},url:new URL("http://local/child-deliveries/id/retry"),
    writesAllowed:false,service:f.service,completion:f.completion,actor,revalidate:()=>{},readJson:async()=>({}),sendJson:()=>{}}),{code:"DEVELOPMENT_PREVIEW_READ_ONLY"});
});

test("authenticated paired gateway exposes the same records and rejects unauthorized requests",async t=>{
  const f=await fixture(t);
  const authority={authenticate(token){if(token!=="a".repeat(43)) throw Object.assign(new Error("denied"),{code:"DEVICE_AUTH_REQUIRED",status:401});return {deviceId:"phone"};}};
  const gateway=new ClientDeviceGateway(authority,{readAPI:{store:f.store},sessionAPI:{entityCommands:{childDelivery:{service:()=>f.service,completion:()=>f.completion}}}});
  const call=async(token="a".repeat(43))=>{
    let result;
    await gateway.handle({method:"GET",url:`/client/v1/tasks/${f.parent.id}/child-deliveries?limit=5`,headers:{authorization:`Bearer ${token}`},
      socket:{encrypted:true,remoteAddress:"127.0.0.1"}}, {writeHead(status){this.status=status;},end(text){result={status:this.status,body:JSON.parse(text)};}});
    return result;
  };
  assert.deepEqual((await call()).body,{items:[],nextCursor:null});
  assert.equal((await call("b".repeat(43))).status,401);
});

test("active child waits for a completion event without polling or another acceptance",async t=>{
  const f=await fixture(t);
  f.store.upsertSession({...f.store.getSession("session:child"),status:"running"});
  const accepted=await f.accept(await f.issue()),id=accepted.childDelivery.operationId;
  assert.equal((await settled(f,id)).state,"waiting");assert.ok(f.store.getTask(f.child.id));
  f.store.upsertSession({...f.store.getSession("session:child"),status:"idle"});
  f.service.onRuntimeEvent("AgentTurnCompleted",{sessionId:"session:child"});
  assert.equal((await settled(f,id)).state,"completed");
});

test("persisted approval and records survive database reload and startup recovery",async t=>{
  const f=await fixture(t);f.service.wake=()=>{};
  const accepted=await f.accept(await f.issue()),id=accepted.childDelivery.operationId;
  await f.store.save();
  const restored=new CorptieStore(f.options);await restored.initialize({resolveDataPath:false});
  t.after(()=>restored.close());
  let resumed;
  const deletion=new TaskDeletionService({store:restored,authorize:({actor,task})=>actor?.type==="child_delivery" && resumed.authorizesCleanup(task.id,actor.id),
    inspectWorktree:async()=>({status:"none",worktree:null}),removeWorktree:async()=>assert.fail("no Git"),
    deleteSession:async sessionId=>restored.deleteSession(sessionId),handleArtifacts:async()=>({disposition:"retain"})});
  resumed=new ChildTaskDeliveryService({store:restored,gitWorkspaces:{},jobs:{},artifactService:f.artifacts,deletionService:deletion});
  await resumed.recover();await resumed.inFlight.get(id);
  assert.equal(resumed.read(id).state,"completed");
  assert.equal(resumed.listParentDeliveries(f.parent.id).items[0].operationId,id);
  assert.deepEqual(restored.selectAll("PRAGMA foreign_key_check"),[]);
});

test("an Artifact create already preparing bytes cannot land in a retired child",async t=>{
  const f=await fixture(t);
  const creating=f.artifacts.create(f.context,{scope:"task",boundTaskId:f.child.id,title:"Concurrent",content:"data"}).then(value=>({value}),error=>({error}));
  const result=await f.accept(await f.issue());
  const created=await creating;const final=await settled(f,result.childDelivery.operationId);
  if(final.state==="completed") {
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM artifacts WHERE bound_task_id=?",[f.child.id]).count,0);
  } else {
    assert.ok(f.store.getTask(f.child.id));
    assert.equal(final.state,"blocked");
  }
  if(created.error) assert.ok(["CHILD_DELIVERY_IN_PROGRESS","ARTIFACT_TASK_NOT_FOUND","ARTIFACT_SCOPE_INVALID","ARTIFACT_CROSS_WORK_FORBIDDEN"].includes(created.error.code),created.error.message);
});


test("cleanup recovery delivers missing Artifacts before deleting, using the original approval", async t => {
  const f=await fixture(t);
  const artifact=await f.artifacts.create(f.context,{scope:"task",boundTaskId:f.child.id,title:"Pending",content:"deliver me"});
  const wake=f.service.wake.bind(f.service);
  f.service.wake=()=>Promise.resolve();
  const accepted=await f.accept(await f.issue("incomplete"));
  const id=accepted.childDelivery.operationId;
  let operation=f.service.repository.getOperation(id);
  operation=f.service.advance(operation,{state:"running",phase:"cleanup",progress:{codeDelivered:true,artifactsDelivered:false}});
  f.service.wake=wake;
  const result=await f.deletion.requestAfterChildDelivery(operation);
  assert.equal(result.accepted,true);
  assert.ok(result.operation);
  await f.deletion.resumeChildDeliveryDeletion(result.operation.operationId,id);
  assert.equal(f.deletion.getOperation(result.operation.operationId).state,"succeeded");
  assert.equal(f.store.getArtifact(artifact.artifactId).boundTaskId,f.parent.id);
  assert.equal(f.store.getTask(f.child.id),null);
});

test("cleanup recovery starts pending code delivery and does not delete until its job finishes", async t => {
  const f=await fixture(t);
  const wake=f.service.wake.bind(f.service);
  f.service.wake=()=>Promise.resolve();
  const accepted=await f.accept(await f.issue("pending-code"));
  const id=accepted.childDelivery.operationId;
  let operation=f.service.repository.getOperation(id);
  operation=f.service.advance(operation,{state:"running",phase:"cleanup",progress:{codeDelivered:false,artifactsDelivered:false}});
  let attempts=0,ready=false;
  f.service.ensureCodeDelivered=async()=>{attempts++;return ready;};
  f.service.wake=wake;
  const pending=await f.deletion.requestAfterChildDelivery(operation);
  assert.equal(pending.pendingDelivery,true);
  assert.equal(pending.operation,null);
  assert.equal(attempts,1);
  assert.ok(f.store.getTask(f.child.id));
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM task_deletion_operations").n,0);
  ready=true;
  f.service.onRuntimeEvent("SessionRunCompleted",{sessionId:"session:child"});
  const final=await settled(f,id);
  assert.equal(final.state,"completed",final.errorMessage);
  assert.equal(f.store.getTask(f.child.id),null);
  assert.equal(attempts,2);
});
