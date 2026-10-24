import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { TaskWorktreeHierarchyService } from "./taskWorktreeHierarchyService.mjs";
import { taskHierarchyError as fail } from "../store/repositories/taskHierarchyRepository.mjs";
import { gitScalarOutput } from "../utils/gitScalarOutput.mjs";

const exec = promisify(execFileCallback);
export const hierarchyDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class TaskIntegrationAcceptanceService {
  constructor({store, execGit = async (path,args)=>(await exec("git",["-C",path,...args],{encoding:"utf8",timeout:15000,maxBuffer:1024*1024})).stdout}) {
    this.store=store; this.git=execGit;
    this.delivery=new TaskWorktreeHierarchyService({store,execGit});
  }
  async scalar(path,args) { return gitScalarOutput(await this.git(path,args)); }
  required(task) { return Boolean(task && this.store.hasTaskChildren?.(task.id) && this.store.getTaskWorkspaceContext(task)?.repository); }
  async graph(taskId,{requireIncluded=true}={}) {
    const task=this.store.getTask(taskId);
    if (!task || task.parent_task_id || !this.required(task)) throw fail("TASK_INTEGRATION_NOT_APPLICABLE");
    const root=this.delivery.resolveTaskDelivery(taskId,{allowAdoption:false});
    const rows=this.store.selectAll("SELECT * FROM tasks WHERE parent_task_id=? AND COALESCE(deletion_status,'')<>'deleted' ORDER BY id",[taskId]);
    const path=root.inventory.canonicalPath || root.inventory.path;
    await this.delivery.assertClean(root.inventory);
    const parentHeadOid=await this.scalar(path,["rev-parse","HEAD"]);
    const parentTreeOid=await this.scalar(path,["rev-parse",`${parentHeadOid}^{tree}`]);
    const children=[];
    for (const child of rows) {
      if(child.work_id!==task.work_id) throw fail("TASK_PARENT_INVALID");
      let item;
      try { item=this.delivery.resolveTaskDelivery(child.id,{allowAdoption:false}); }
      catch (cause) { if(requireIncluded) throw fail("CHILDREN_NOT_INTEGRATED"); children.push({taskId:child.id,worktreeId:null,sourceHeadOid:null,includedInParent:false});continue; }
      if(item.binding.repository_id!==root.binding.repository_id) throw fail("TASK_PARENT_INVALID");
      const sourceHeadOid=await this.scalar(item.inventory.canonicalPath || item.inventory.path,["rev-parse","HEAD"]);
      const includedInParent=await this.git(path,["merge-base","--is-ancestor",sourceHeadOid,parentHeadOid]).then(()=>true,cause=>{if(cause.code===1)return false;throw cause;});
      if(requireIncluded && !includedInParent) throw fail("CHILDREN_NOT_INTEGRATED");
      if(requireIncluded) await this.delivery.assertClean(item.inventory);
      children.push({taskId:child.id,worktreeId:item.binding.worktree_id,sourceHeadOid,includedInParent,
        taskRevision:child.revision,bindingRevision:item.binding.binding_revision});
    }
    const current=this.store.getTask(taskId);
    const binding=this.store.getTaskDeliveryBinding(taskId);
    if (!current || current.resource_version!==task.resource_version || current.revision!==task.revision
      || current.hierarchy_revision!==task.hierarchy_revision || binding?.binding_revision!==root.binding.binding_revision) throw fail("INTEGRATION_ACCEPTANCE_STALE");
    for (const child of children) {
      const latest=this.store.getTask(child.taskId);
      if (child.worktreeId && (latest?.revision!==child.taskRevision
        || this.store.getTaskDeliveryBinding(child.taskId)?.binding_revision!==child.bindingRevision)) throw fail("INTEGRATION_ACCEPTANCE_STALE");
      if (child.worktreeId) {
        const item=this.delivery.resolveTaskDelivery(child.taskId,{allowAdoption:false});
        if (await this.scalar(item.inventory.canonicalPath || item.inventory.path,["rev-parse","HEAD"])!==child.sourceHeadOid) throw fail("INTEGRATION_ACCEPTANCE_STALE");
      }
    }
    if(await this.scalar(path,["rev-parse","HEAD"])!==parentHeadOid) throw fail("INTEGRATION_ACCEPTANCE_STALE");
    const scope={taskRevision:current.revision,criteria:current.acceptance_criteria,verification:current.verification_criteria,
      hierarchyRevision:current.hierarchy_revision,bindingRevision:root.binding.binding_revision,children};
    const {children:excludedChildren,...rootScope}=scope;
    return {schemaVersion:1,parentTaskId:taskId,parentWorktreeId:root.binding.worktree_id,parentHeadOid,parentTreeOid,taskRevision:task.revision,
      hierarchyRevision:current.hierarchy_revision,bindingRevision:root.binding.binding_revision,
      scopeHash:hierarchyDigest(scope),rootScopeHash:hierarchyDigest(rootScope),children,root};
  }
  async captureSnapshot(taskId,input={}, {revalidate=()=>{}}={}) {
    if(Object.keys(input).some(k=>!["requestId","expectedHierarchyRevision","expectedBindingRevision"].includes(k))
      || !/^[A-Za-z0-9:_-]{8,200}$/.test(input.requestId ?? "")
      || !Number.isSafeInteger(input.expectedHierarchyRevision) || input.expectedHierarchyRevision<1
      || !Number.isSafeInteger(input.expectedBindingRevision) || input.expectedBindingRevision<1) throw fail("INVALID_INTEGRATION_SNAPSHOT","Invalid snapshot request",400);
    revalidate();
    const snapshotId=`integration_snapshot:${hierarchyDigest([taskId,input.requestId])}`;
    const existing=this.store.selectOne("SELECT * FROM task_integration_snapshots WHERE snapshot_id=?",[snapshotId]);
    if(existing) {
      const value=JSON.parse(existing.payload_json);
      if(value.hierarchyRevision!==input.expectedHierarchyRevision || value.bindingRevision!==input.expectedBindingRevision) throw fail("IDEMPOTENCY_CONFLICT");
      return value;
    }
    const graph=await this.graph(taskId);
    if(graph.hierarchyRevision!==input.expectedHierarchyRevision) throw fail("TASK_HIERARCHY_CHANGED");
    if(graph.bindingRevision!==input.expectedBindingRevision) throw fail("TASK_DELIVERY_BINDING_CHANGED");
    this.assertNoGitJob(graph.root.binding.repository_id,this.waitingAcceptanceJob(graph.root.binding.repository_id,taskId));
    const {root,...projection}=graph;
    const value={...projection,snapshotId,createdAt:new Date().toISOString()};
    const persisted=this.store.runInTransaction(()=>{
      revalidate();
      const prior=this.store.selectOne("SELECT * FROM task_integration_snapshots WHERE snapshot_id=?",[snapshotId]);
      if(prior) {
        const frozen=JSON.parse(prior.payload_json);
        if(frozen.hierarchyRevision!==input.expectedHierarchyRevision || frozen.bindingRevision!==input.expectedBindingRevision) throw fail("IDEMPOTENCY_CONFLICT");
        return frozen;
      }
      this.assertRevisions(graph);
      this.assertNoGitJob(graph.root.binding.repository_id,this.waitingAcceptanceJob(graph.root.binding.repository_id,taskId));
      this.store.db.run(`INSERT INTO task_integration_snapshots
        (snapshot_id,task_id,worktree_id,parent_head_oid,hierarchy_revision,binding_revision,scope_hash,payload_json,content_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,[snapshotId,taskId,value.parentWorktreeId,value.parentHeadOid,value.hierarchyRevision,
        value.bindingRevision,value.scopeHash,JSON.stringify(value),hierarchyDigest(value),value.createdAt]);
      return value;
    });
    this.store.scheduleSave();
    return persisted;
  }
  assertRevisions(graph) {
    const task=this.store.getTask(graph.parentTaskId);
    const binding=this.store.getTaskDeliveryBinding(graph.parentTaskId);
    if(!task || task.hierarchy_revision!==graph.hierarchyRevision || binding?.binding_revision!==graph.bindingRevision
      || graph.taskRevision!==undefined && task.revision!==graph.taskRevision) throw fail("TASK_HIERARCHY_CHANGED");
    for(const child of graph.children ?? []) if(child.worktreeId &&
      (this.store.getTask(child.taskId)?.revision!==child.taskRevision
        || this.store.getTaskDeliveryBinding(child.taskId)?.binding_revision!==child.bindingRevision)) throw fail("INTEGRATION_ACCEPTANCE_STALE");
  }
  assertNoGitJob(repositoryId, ownJobId=null) {
    const job=this.store.getLatestWorktreeIntegrationJob?.(repositoryId);
    if(job && job.id!==ownJobId && ["queued","running","paused","cancellation_requested","replanning"].includes(job.status)) throw fail("TASK_HIERARCHY_BUSY");
  }
  waitingAcceptanceJob(repositoryId,taskId) {
    const job=this.store.getLatestWorktreeIntegrationJob?.(repositoryId);
    const state=job?.details?.graphExecution;
    const step=state?.steps[state.index];
    return job?.status==="paused" && job.phase==="awaiting_integration_acceptance"
      && job.details.plan.orchestration?.version===1 && step?.kind==="acceptance"
      && step.rootTaskId===taskId ? job.id : null;
  }
  async validateSnapshotForAssessment(task,input) {
    if(!this.required(task)) return null;
    if(!input.integrationSnapshotId) throw fail("INTEGRATION_ACCEPTANCE_REQUIRED");
    const record=this.store.selectOne("SELECT * FROM task_integration_snapshots WHERE snapshot_id=? AND task_id=?",[input.integrationSnapshotId,task.id]);
    if(!record) throw fail("INTEGRATION_ACCEPTANCE_REQUIRED");
    const snapshot=JSON.parse(record.payload_json);
    const current=await this.graph(task.id);
    this.assertRevisions(current);
    this.assertNoGitJob(current.root.binding.repository_id,this.waitingAcceptanceJob(current.root.binding.repository_id,task.id));
    if(current.parentHeadOid!==snapshot.parentHeadOid || current.scopeHash!==snapshot.scopeHash) throw fail("INTEGRATION_ACCEPTANCE_STALE");
    return snapshot;
  }
  bindAssessment(snapshot,assessment) {
    if(!snapshot) return assessment;
    this.assertRevisions(snapshot);
    if(assessment.status!=="passed") return {...assessment,integrationSnapshotId:snapshot.snapshotId};
    const receiptId=`integration_acceptance:${hierarchyDigest([snapshot.snapshotId,assessment])}`;
    this.store.db.run(`INSERT OR IGNORE INTO task_integration_acceptances
      (receipt_id,snapshot_id,task_id,assessment_hash,evidence_json,created_at) VALUES (?,?,?,?,?,?)`,
    [receiptId,snapshot.snapshotId,snapshot.parentTaskId,hierarchyDigest(assessment),JSON.stringify(assessment),new Date().toISOString()]);
    return {...assessment,integrationSnapshotId:snapshot.snapshotId,integrationReceiptId:receiptId};
  }
  async readStatus(taskId,{receiptId=null,ownJobId=null}={}) {
    const task=this.store.getTask(taskId);
    if(!task) throw fail("TASK_NOT_FOUND","Task not found",404);
    const present=value=>({schemaVersion:1,taskId,currentHeadOid:null,scopeHash:null,hasUnintegratedChildren:false,...value});
    if(!this.required(task)) return present({state:"not_applicable",receiptId:null,testedHeadOid:null,canPromote:false,reason:null});
    let assessment;
    try { assessment=JSON.parse(task.acceptance_assessment_json); } catch { assessment=null; }
    const id=receiptId ?? assessment?.integrationReceiptId;
    const record=id && this.store.selectOne(`SELECT a.*,s.payload_json FROM task_integration_acceptances a
      JOIN task_integration_snapshots s ON s.snapshot_id=a.snapshot_id WHERE a.receipt_id=? AND a.task_id=?`,[id,taskId]);
    if(!record || assessment?.status!=="passed" || assessment.integrationReceiptId!==id) return present({state:"not_recorded",receiptId:null,testedHeadOid:null,canPromote:false,reason:"INTEGRATION_ACCEPTANCE_REQUIRED"});
    const snapshot=JSON.parse(record.payload_json);
    try {
      const current=await this.graph(taskId,{requireIncluded:false});
      this.assertRevisions(current);
      this.assertNoGitJob(current.root.binding.repository_id,ownJobId);
      const latest=this.store.getTask(taskId);
      if(!latest || latest.acceptance_assessment_json!==task.acceptance_assessment_json) throw fail("INTEGRATION_ACCEPTANCE_STALE");
      if(current.parentHeadOid!==snapshot.parentHeadOid || current.parentTreeOid!==snapshot.parentTreeOid
        || current.taskRevision!==snapshot.taskRevision || current.hierarchyRevision!==snapshot.hierarchyRevision
        || current.bindingRevision!==snapshot.bindingRevision || current.rootScopeHash!==snapshot.rootScopeHash
        || assessment.criteriaSnapshot!==String(latest.acceptance_criteria ?? "").trim()) throw fail("INTEGRATION_ACCEPTANCE_STALE");
      const hasUnintegratedChildren=current.children.some(child=>!child.includedInParent);
      // A receipt continues to describe its frozen tested code. New pending
      // child work is a separate delivery blocker, not retroactive test failure.
      if(hasUnintegratedChildren) return present({state:"passed",receiptId:id,testedHeadOid:snapshot.parentHeadOid,
        currentHeadOid:current.parentHeadOid,scopeHash:current.scopeHash,hasUnintegratedChildren:true,
        canPromote:false,reason:"CHILDREN_NOT_INTEGRATED"});
      for(const child of current.children) {
        const item=this.delivery.resolveTaskDelivery(child.taskId,{allowAdoption:false});
        await this.delivery.assertClean(item.inventory);
      }
      if(current.parentHeadOid!==snapshot.parentHeadOid || current.scopeHash!==snapshot.scopeHash) throw fail("INTEGRATION_ACCEPTANCE_STALE");
      this.assertRevisions(current);
      if(this.store.getTask(taskId)?.acceptance_assessment_json!==task.acceptance_assessment_json) throw fail("INTEGRATION_ACCEPTANCE_STALE");
      return present({state:"passed",receiptId:id,testedHeadOid:snapshot.parentHeadOid,testedTreeOid:snapshot.parentTreeOid,
        currentHeadOid:current.parentHeadOid,scopeHash:current.scopeHash,canPromote:true,reason:null});
    } catch(cause) { return present({state:"stale",receiptId:id,testedHeadOid:snapshot.parentHeadOid,canPromote:false,reason:cause.code ?? "INTEGRATION_ACCEPTANCE_STALE"}); }
  }
  async assertCompletionAllowed(task) {
    if(!this.required(task)) return;
    const status=await this.readStatus(task.id);
    if(status.state!=="passed" || !status.canPromote) throw fail(status.reason ?? "INTEGRATION_ACCEPTANCE_REQUIRED");
  }
}
