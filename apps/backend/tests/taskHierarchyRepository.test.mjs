import test from "node:test";
import assert from "node:assert/strict";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { readTaskHierarchyPage } from "../src/application/taskHierarchyService.mjs";
import { validateTaskInput } from "../src/domain/workTaskValidation.mjs";
import { handleEntityHttpRequest } from "../src/application/entityHttpApi.mjs";
import { ClientDeviceGateway } from "../src/application/clientDeviceGateway.mjs";
import { TaskCompletionService } from "../src/application/taskCompletionService.mjs";
import { classifyTaskDeliveryParticipation, startupHasNoDeliveryResources } from "../src/store/repositories/taskHierarchyRepository.mjs";

test("only a compensated child failure before parent-base capture proves no allocation",()=>{
  const operation={state:"failed_compensated",error_stage:"worktree_preparation",compensation_state:"completed",
    compensation_result_json:JSON.stringify({status:"completed",completedSteps:["task_claim_released"],failedStep:null})};
  assert.equal(startupHasNoDeliveryResources(operation,true),true);
  assert.equal(startupHasNoDeliveryResources(operation,false),false);
  for(const field of ["worktree_id","allocation_json","logical_session_id","legacy_session_id","provider_binding_id",
    "binding_generation","worktree_prepared_at","session_bound_at","provider_bound_at","ready_at","worktree_base_context_json"])
    assert.equal(startupHasNoDeliveryResources({...operation,[field]:"evidence"},true),false,field);
  for(const patch of [{state:"allocated"},{state:"failed_manual_cleanup"},{error_stage:"session_creation"},
    {compensation_state:"manual_required"},{compensation_result_json:"invalid"},{initial_turn_state:"accepted"}])
    assert.equal(startupHasNoDeliveryResources({...operation,...patch},true),false);
});

test("delivery classification excludes only fully observed empty failures",()=>{
  const empty={creation_state:"failed",evidence_complete:true};
  assert.equal(classifyTaskDeliveryParticipation(empty),"ignored_failed");
  assert.equal(classifyTaskDeliveryParticipation({creation_state:"failed"}),"pending");
  for(const field of ["has_delivery","has_session","has_startup_binding","has_receipt","has_allocation","current_session_id"])
    assert.equal(classifyTaskDeliveryParticipation({...empty,[field]:1}),"required",field);
  for(const field of ["has_startup","has_workspace_request"])
    assert.equal(classifyTaskDeliveryParticipation({...empty,[field]:1}),"uncertain",field);
  assert.equal(classifyTaskDeliveryParticipation({...empty,creation_state:"ready"}),"required");
  assert.equal(classifyTaskDeliveryParticipation({...empty,creation_state:"pending"}),"pending");
  assert.equal(classifyTaskDeliveryParticipation({...empty,deletion_status:"deleted",has_delivery:1}),"excluded_deleted");
});

test("repository counts share delivery participation and retain failed tasks with historical Sessions",async t=>{
  const f=await fixture(t),child=f.child();
  f.store.db.run("UPDATE tasks SET creation_state='failed' WHERE id=?",[child.id]);
  const read=()=>f.store.readTaskDeliveryParticipation({taskIds:[child.id],parentTaskIds:[f.root.id]});
  assert.equal(read().byTaskId.get(child.id).participation,"ignored_failed");
  assert.equal(read().byParentTaskId.get(f.root.id).length,1);
  assert.equal(f.store.hasTaskChildren(f.root.id),false);
  assert.equal(f.store.hierarchySummaries([f.root.id]).get(f.root.id).childCount,0);
  f.store.upsertSession({id:"session:historical-child",title:"History",provider:"provider:test",status:"complete",workId:f.work.id,taskId:child.id});
  assert.equal(read().byTaskId.get(child.id).participation,"required");
  assert.equal(f.store.hasTaskChildren(f.root.id),true);
  assert.equal(f.store.hierarchySummaries([f.root.id]).get(f.root.id).childCount,1);
  assert.equal(f.store.getTask(child.id).creation_state,"failed");
});

async function fixture(t) {
  const store = new CorptieStore({dbPath:":memory:",configPath:"/unused-task-hierarchy",manageProcessEnvironment:false});
  await store.initialize({resolveDataPath:false});
  t.after(()=>store.close());
  const agent = store.createAgent({name:"Hierarchy",role:"independentContributor"});
  const service = new WorkApplicationService({store});
  const work = service.createWork({name:"Hierarchy",contributorAgentIds:[agent.agentId]});
  const root = store.createTask({workId:work.id,title:"Parent",mainAgentId:agent.agentId});
  const child = (title="Child", parent=root) => store.createTask({workId:work.id,title,parentTaskId:parent.id}, {}, {expectedParentResourceVersion:store.getTask(parent.id).resource_version});
  return {store,service,work,root,child};
}

test("child creation is atomic, one-level, same-Work, and CAS protected", async t => {
  const f=await fixture(t);
  assert.throws(()=>f.store.createTask({workId:f.work.id,title:"MissingCAS",parentTaskId:f.root.id}),{code:"TASK_PARENT_VERSION_CONFLICT"});
  const child=f.child();
  assert.equal(child.parent_task_id,f.root.id);
  assert.equal(f.store.getTask(f.root.id).hierarchy_revision,2);
  assert.equal(f.store.getTask(f.root.id).resource_version,f.root.resource_version);
  assert.throws(()=>f.child("Grandchild",child),{code:"TASK_MAX_DEPTH_EXCEEDED"});
  const other=f.service.createWork({name:"Other",contributorAgentIds:f.work.contributorAgentIds});
  assert.throws(()=>f.store.createTask({workId:other.id,title:"Wrong",parentTaskId:f.root.id},{},{expectedParentResourceVersion:1}),{code:"TASK_PARENT_UNAVAILABLE"});
  const before=f.store.listTasks().length;
  const run=f.store.db.run;
  f.store.db.run=function(sql,...args){if(sql.includes("INSERT INTO task_creation_origins")) throw new Error("rollback");return run.call(this,sql,...args);};
  try { assert.throws(()=>f.child("Failure"),/rollback/); } finally { f.store.db.run=run; }
  assert.equal(f.store.listTasks().length,before);
  assert.equal(f.store.getTask(f.root.id).hierarchy_revision,2);
  assert.deepEqual(f.store.selectAll("PRAGMA foreign_key_check"),[]);
});

test("invalid parent state and any reparenting are rejected, including direct SQL", async t=>{
  const f=await fixture(t);
  const child=f.child();
  assert.throws(()=>validateTaskInput({parentTaskId:f.root.id},"update"),{code:"TASK_REPARENT_UNSUPPORTED"});
  assert.throws(()=>f.store.db.run("UPDATE tasks SET parent_task_id=NULL WHERE id=?",[child.id]),/TASK_REPARENT_UNSUPPORTED/);
  assert.throws(()=>f.store.setTaskArchived(f.root.id,true),{code:"TASK_HAS_CHILDREN"});
  assert.throws(()=>f.service.deleteTask(f.root.id),{code:"TASK_HIERARCHY_DEPENDENCY"});
  assert.throws(()=>f.store.deleteTask(f.root.id),/TASK_HIERARCHY_DEPENDENCY/);
  assert.throws(()=>f.store.deleteTask(child.id),/TASK_HIERARCHY_DEPENDENCY/);
  assert.throws(()=>f.store.finalizeTaskDeletion(f.root.id),/TASK_HIERARCHY_DEPENDENCY/);
  f.store.updateTask(f.root.id,{description:"Version_changed"});
  assert.throws(()=>f.store.createTask({workId:f.work.id,title:"Stale",parentTaskId:f.root.id},{},{expectedParentResourceVersion:1}),{code:"TASK_PARENT_VERSION_CONFLICT"});
});

test("hierarchy pages preserve root/child/search scope and return hidden ancestors",async t=>{
  const f=await fixture(t);
  f.child("Match_one"); f.child("Match_two");
  const query = value=>new URLSearchParams(value);
  const roots=readTaskHierarchyPage(f.store,f.work.id,query("limit=1"));
  assert.deepEqual(roots.tasks.map(t=>t.id),[f.root.id]);
  assert.equal(roots.tasks[0].hierarchy.childCount,2);
  const children=readTaskHierarchyPage(f.store,f.work.id,query(`parentTaskId=${f.root.id}&limit=1`));
  assert.equal(children.hasMore,true);
  assert.equal(children.ancestors[0].id,f.root.id);
  const next=readTaskHierarchyPage(f.store,f.work.id,query(`parentTaskId=${f.root.id}&limit=1&cursor=${children.nextCursor}`));
  assert.notEqual(next.tasks[0].id,children.tasks[0].id);
  assert.equal(next.hasMore,false);
  assert.throws(()=>readTaskHierarchyPage(f.store,f.work.id,query(`cursor=${children.nextCursor}`)),{code:"INVALID_CURSOR"});
  const search=readTaskHierarchyPage(f.store,f.work.id,query("q=Match"));
  assert.equal(search.tasks.length,2);
  assert.deepEqual(search.ancestors.map(t=>t.id),[f.root.id]);
  assert.throws(()=>readTaskHierarchyPage(f.store,f.work.id,query("limit=101")),{code:"INVALID_QUERY"});
  assert.throws(()=>readTaskHierarchyPage(f.store,f.work.id,query("q=x&q=y")),{code:"INVALID_QUERY"});
  assert.equal(roots.taskHierarchyCapabilities.worktreeOperations,true);
});

test("creation replay compares null parent as well as child parent",async t=>{
  const f=await fixture(t); const child=f.child();
  assert.throws(()=>f.service.createTask({id:child.id,workId:f.work.id,title:child.title}),{code:"ENTITY_CREATION_CONFLICT"});
  const summary=f.store.hierarchySummaries([f.root.id,child.id]);
  assert.equal(summary.get(child.id).actions.createChild.available,false);
  assert.equal(summary.get(f.root.id).childCount,1);
});

test("local and authenticated device hierarchy routes share pagination and reject writes",async t=>{
  const f=await fixture(t); f.child();
  const local=await new Promise(resolve=>{
    const response={headersSent:false,writeHead(status){this.status=status;},end(text){resolve({status:this.status,body:JSON.parse(text)});}};
    handleEntityHttpRequest({request:{method:"GET",headers:{}},response,
      url:new URL(`http://localhost/works/${encodeURIComponent(f.work.id)}/task-hierarchy?parentTaskId=${f.root.id}`),workService:f.service});
  });
  assert.equal(local.status,200);
  assert.equal(local.body.tasks[0].parentTaskId,f.root.id);
  const authority={authenticate(token){if(token!=="a".repeat(43)) throw Object.assign(new Error("denied"),{code:"DEVICE_AUTH_REQUIRED",status:401});return {deviceId:"device:test"};}};
  const gateway=new ClientDeviceGateway(authority,{readAPI:{store:f.store}});
  const device=async (method,token="a".repeat(43))=>{
    let output;
    const response={writeHead(status){this.status=status;},end(text){output={status:this.status,body:JSON.parse(text)};}};
    await gateway.handle({method,url:`/client/v1/works/${encodeURIComponent(f.work.id)}/task-hierarchy?parentTaskId=${f.root.id}`,
      headers:{authorization:`Bearer ${token}`},socket:{encrypted:true,remoteAddress:"127.0.0.1"}},response);
    return output;
  };
  assert.deepEqual((await device("GET")).body,local.body);
  assert.equal((await device("POST")).status,405);
  assert.equal((await device("GET","b".repeat(43))).status,401);
});

test("Git parent completion requires integration acceptance but audit remains readable",async t=>{
  const f=await fixture(t);
  f.store.createWorkspace({workspaceId:"workspace:hierarchy",kind:"linkedLocal",ownership:"userManaged",rootPath:"/unused-hierarchy-repo"});
  const now=new Date().toISOString();
  f.store.db.run("INSERT INTO git_repositories (repository_id,workspace_id,common_git_dir,discovered_at,last_validated_at) VALUES ('repository:hierarchy','workspace:hierarchy','/unused-hierarchy-repo/.git',?,?)",[now,now]);
  const work=f.service.createWork({name:"Code",workspaceId:"workspace:hierarchy",contributorAgentIds:f.work.contributorAgentIds});
  const root=f.store.createTask({workId:work.id,title:"Code_parent"});
  f.store.createTask({workId:work.id,title:"Code_child",parentTaskId:root.id},{},{expectedParentResourceVersion:root.resource_version});
  const completion=new TaskCompletionService({store:f.store});
  assert.deepEqual(completion.listAudit(root.id),[]);
  const input={requestId:"test:hierarchy",interactionId:"interaction:hierarchy",uiSurface:"task_completion_confirmation",displayedTaskId:root.id,displayedTaskTitle:root.title};
  await assert.rejects(()=>completion.issueMacOSIntent(root.id,input,{type:"user",id:"user:local-macos"}),{code:"INTEGRATION_ACCEPTANCE_REQUIRED"});
  const guard=completion.integrationAcceptance.assertCompletionAllowed;
  completion.integrationAcceptance.assertCompletionAllowed=async()=>{};
  const receipt=await completion.issueMacOSIntent(root.id,input,{type:"user",id:"user:local-macos"});
  completion.integrationAcceptance.assertCompletionAllowed=guard;
  await assert.rejects(()=>completion.completeFromMacOS(root.id,{intentToken:receipt.intentToken,requestId:input.requestId,idempotencyKey:"complete:hierarchy"}),{code:"INTEGRATION_ACCEPTANCE_REQUIRED"});
  await assert.rejects(()=>completion.completeFromSession({targetTaskId:root.id},{}),{code:"WORK_ID_REQUIRED"});
  assert.notEqual(f.store.getTask(root.id).lifecycle_state,"done");
});
