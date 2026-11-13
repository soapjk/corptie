import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { TaskWorktreeHierarchyService } from "./taskWorktreeHierarchyService.mjs";
import { taskHierarchyError as fail } from "../store/repositories/taskHierarchyRepository.mjs";
import { gitScalarOutput } from "../utils/gitScalarOutput.mjs";

const exec = promisify(execFileCallback);
export const hierarchyDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class TaskIntegrationAcceptanceService {
  constructor({store, now=()=>new Date(), execGit = async (path,args)=>(await exec("git",["-C",path,...args],{encoding:"utf8",timeout:15000,maxBuffer:1024*1024})).stdout}) {
    this.store=store; this.git=execGit; this.now=now;
    this.delivery=new TaskWorktreeHierarchyService({store,execGit});
  }
  async scalar(path,args) { return gitScalarOutput(await this.git(path,args)); }
  required(task) { return Boolean(task && this.store.hasTaskChildren?.(task.id) && this.store.getTaskWorkspaceContext(task)?.repository); }
  async evaluateRequirement(taskId) {
    const graph = await this.graph(taskId, { requireIncluded: false });
    return { graph, requirement: graph.children.some(child => !["no_changes", "history_only"].includes(child.changeState)) ? "required" : "none" };
  }
  async graph(taskId,{requireIncluded=false}={}) {
    const task=this.store.getTask(taskId);
    if (!task || !this.required(task)) throw fail("TASK_INTEGRATION_NOT_APPLICABLE");
    const root=this.delivery.resolveTaskDelivery(taskId,{allowAdoption:false});
    const rows=this.delivery.deliveryChildren(taskId);
    const path=root.inventory.canonicalPath || root.inventory.path;
    await this.delivery.assertClean(root.inventory);
    const parentHeadOid=await this.scalar(path,["rev-parse","HEAD"]);
    const parentTreeOid=await this.scalar(path,["rev-parse",`${parentHeadOid}^{tree}`]);
    const children=[];
    for (const child of rows) {
      if(child.work_id!==task.work_id) throw fail("TASK_PARENT_INVALID");
      let item;
      try { item=this.delivery.resolveTaskDelivery(child.id,{allowAdoption:false}); }
      catch (cause) { if(requireIncluded) throw Object.assign(fail("CHILDREN_NOT_INTEGRATED",cause.message),{diagnosis:cause.diagnosis}); children.push({taskId:child.id,worktreeId:null,sourceHeadOid:null,includedInParent:false});continue; }
      if(item.binding.repository_id!==root.binding.repository_id) throw fail("TASK_PARENT_INVALID");
      await this.delivery.assertClean(item.inventory);
      const sourceHeadOid=await this.scalar(item.inventory.canonicalPath || item.inventory.path,["rev-parse","HEAD"]);
      const changes = await this.delivery.inspectChildDeliveryChanges(child.id,{item,headOid:sourceHeadOid});
      const includedInParent=await this.git(path,["merge-base","--is-ancestor",sourceHeadOid,parentHeadOid]).then(()=>true,cause=>{if(cause.code===1)return false;throw cause;});
      if(requireIncluded && !includedInParent) throw fail("CHILDREN_NOT_INTEGRATED");
      children.push({taskId:child.id,worktreeId:item.binding.worktree_id,sourceHeadOid,includedInParent,
        taskRevision:child.revision,bindingRevision:item.binding.binding_revision,changeState:changes.changeState});
    }
    const current=this.store.getTask(taskId);
    if(!current) throw fail("TASK_NOT_FOUND","Task not found",404);
    const scope={taskRevision:current.revision,
      bindingRevision:root.binding.binding_revision,children:children.filter(child=>!["no_changes","history_only"].includes(child.changeState))};
    const {children:excludedChildren,...rootScope}=scope;
    return {schemaVersion:1,acceptancePolicyVersion:2,parentTaskId:taskId,parentWorktreeId:root.binding.worktree_id,parentHeadOid,parentTreeOid,taskRevision:task.revision,
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
      return value;
    }
    const graph=await this.graph(taskId);
    this.assertNoGitJob(graph.root.binding.repository_id,this.waitingAcceptanceJob(graph.root.binding.repository_id,taskId));
    const {root,...projection}=graph;
    const value={...projection,snapshotId,createdAt:new Date().toISOString()};
    const persisted=this.store.runInTransaction(()=>{
      revalidate();
      const prior=this.store.selectOne("SELECT * FROM task_integration_snapshots WHERE snapshot_id=?",[snapshotId]);
      if(prior) {
        const frozen=JSON.parse(prior.payload_json);
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
    if(!task) throw fail("TASK_NOT_FOUND","Task not found",404);
    return {changed:task.hierarchy_revision!==graph.hierarchyRevision
      || this.store.getTaskDeliveryBinding(task.id)?.binding_revision!==graph.bindingRevision};
  }
  assertNoGitJob() {
    // Read-only acceptance describes its captured version, without a Git lease.
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
    if ((await this.evaluateRequirement(task.id)).requirement === "none" && !input.integrationSnapshotId) return null;
    if(!input.integrationSnapshotId) throw fail("INTEGRATION_ACCEPTANCE_REQUIRED");
    const record=this.store.selectOne("SELECT * FROM task_integration_snapshots WHERE snapshot_id=? AND task_id=?",[input.integrationSnapshotId,task.id]);
    if(!record) throw fail("INTEGRATION_ACCEPTANCE_REQUIRED");
    const snapshot=JSON.parse(record.payload_json);
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
    const present=value=>({schemaVersion:1,taskId,currentHeadOid:null,scopeHash:null,hasUnintegratedChildren:false,
      parentTaskTitle:task.title,parentSessionId:task.current_session_id ?? null,hierarchyRevision:task.hierarchy_revision,
      bindingRevision:this.store.getTaskDeliveryBinding(taskId)?.binding_revision ?? null,manualAcceptance:true,...value});
    if(!this.required(task)) return present({state:"not_applicable",receiptId:null,testedHeadOid:null,canPromote:false,reason:null});
    let evaluation;
    try {
      evaluation = await this.evaluateRequirement(taskId);
      this.assertNoGitJob(evaluation.graph.root.binding.repository_id, ownJobId ?? this.waitingAcceptanceJob(evaluation.graph.root.binding.repository_id,taskId));
      if (evaluation.requirement === "none") {
        const pending = evaluation.graph.children.some(child=>!child.includedInParent);
        return present({state:"not_required",receiptId:null,testedHeadOid:null,currentHeadOid:evaluation.graph.parentHeadOid,
          canPromote:true,hasUnintegratedChildren:pending,reason:pending ? "CHILDREN_NOT_INTEGRATED" : null});
      }
    } catch(cause) {
      return present({state:"blocked",receiptId:null,testedHeadOid:null,canPromote:false,reason:cause.code ?? "WORKTREE_UNAVAILABLE"});
    }
    let assessment;
    try { assessment=JSON.parse(task.acceptance_assessment_json); } catch { assessment=null; }
    const manual = this.readUserApproval(taskId, receiptId);
    if (manual && (receiptId || assessment?.status!=="passed" || !assessment?.integrationReceiptId
      || JSON.parse(manual.evidence_json).assessmentAtApproval===(task.acceptance_assessment_json ?? null))) {
      return this.userApprovalStatus(task, manual, evaluation.graph, present);
    }
    const id=receiptId ?? assessment?.integrationReceiptId;
    const record=id && this.store.selectOne(`SELECT a.*,s.payload_json FROM task_integration_acceptances a
      JOIN task_integration_snapshots s ON s.snapshot_id=a.snapshot_id WHERE a.receipt_id=? AND a.task_id=?`,[id,taskId]);
    if(!record || assessment?.status!=="passed" || assessment.integrationReceiptId!==id) {
      const pending=evaluation.graph.children.some(child=>!child.includedInParent);
      return present({state:"not_recorded",receiptId:null,testedHeadOid:null,canPromote:true,
        hasUnintegratedChildren:pending,reason:pending ? "CHILDREN_NOT_INTEGRATED" : "INTEGRATION_ACCEPTANCE_REQUIRED"});
    }
    const snapshot=JSON.parse(record.payload_json);
    try {
      const current=evaluation.graph;
      this.assertRevisions(current);
      this.assertNoGitJob(current.root.binding.repository_id,ownJobId);
      const latest=this.store.getTask(taskId);
      if(!latest || latest.acceptance_assessment_json!==task.acceptance_assessment_json) throw fail("INTEGRATION_ACCEPTANCE_STALE");
      if(current.parentHeadOid!==snapshot.parentHeadOid || current.parentTreeOid!==snapshot.parentTreeOid
        || current.taskRevision!==snapshot.taskRevision || (snapshot.acceptancePolicyVersion!==2 && current.hierarchyRevision!==snapshot.hierarchyRevision)
        || current.bindingRevision!==snapshot.bindingRevision || current.rootScopeHash!==snapshot.rootScopeHash
        || assessment.taskRevision!==Number(latest.revision)) throw fail("INTEGRATION_ACCEPTANCE_STALE");
      const hasUnintegratedChildren=current.children.some(child=>!child.includedInParent);
      // A receipt continues to describe its frozen tested code. New pending
      // child work is a separate delivery blocker, not retroactive test failure.
      if(hasUnintegratedChildren) return present({state:"passed",receiptId:id,testedHeadOid:snapshot.parentHeadOid,
        currentHeadOid:current.parentHeadOid,scopeHash:current.scopeHash,hasUnintegratedChildren:true,
        canPromote:true,reason:null});
      for(const child of current.children) {
        const item=this.delivery.resolveTaskDelivery(child.taskId,{allowAdoption:false});
        await this.delivery.assertClean(item.inventory);
      }
      if(current.parentHeadOid!==snapshot.parentHeadOid || current.scopeHash!==snapshot.scopeHash) throw fail("INTEGRATION_ACCEPTANCE_STALE");
      this.assertRevisions(current);
      if(this.store.getTask(taskId)?.acceptance_assessment_json!==task.acceptance_assessment_json) throw fail("INTEGRATION_ACCEPTANCE_STALE");
      return present({state:"passed",approvalSource:"agent_verified",automatedVerification:"passed",receiptId:id,testedHeadOid:snapshot.parentHeadOid,testedTreeOid:snapshot.parentTreeOid,
        currentHeadOid:current.parentHeadOid,scopeHash:current.scopeHash,canPromote:true,reason:null});
    } catch(cause) { return present({state:"stale",receiptId:id,testedHeadOid:snapshot.parentHeadOid,canPromote:true,reason:cause.code ?? "INTEGRATION_ACCEPTANCE_STALE"}); }
  }
  async assertCompletionAllowed() {
    // TaskCompletionService owns lifecycle authorization; Git evidence is optional.
  }

  requireUser(context) {
    if (context?.type !== "user" || typeof context.id !== "string" || !context.id) throw fail("DIRECT_USER_INTENT_REQUIRED", "A trusted user action is required.", 403);
  }
  requireApprovalTarget(taskId) {
    const task=this.store.getTask(taskId);
    if(!task || task.archived || task.deletion_status || task.lifecycle_state==="done") throw fail("TASK_PARENT_UNAVAILABLE");
    return task;
  }
  async prepareUserApproval(taskId,input={},userContext={}, {revalidate=()=>{}}={}) {
    this.requireUser(userContext); revalidate();
    this.requireApprovalTarget(taskId);
    if((await this.evaluateRequirement(taskId)).requirement==="none") throw fail("INTEGRATION_ACCEPTANCE_NOT_REQUIRED","No child code delivery requires approval.");
    const snapshot=await this.captureSnapshot(taskId,input,{revalidate});
    const task=this.store.getTask(taskId);
    const intentId=`integration_user_intent:${hierarchyDigest([taskId,input.requestId])}`;
    const existing=this.store.selectOne("SELECT * FROM task_integration_acceptances WHERE receipt_id=? AND task_id=?",[intentId,taskId]);
    if(existing) {
      const saved=JSON.parse(existing.evidence_json);
      if(saved.kind!=="manual_approval_intent" || saved.actor.id!==userContext.id || existing.snapshot_id!==snapshot.snapshotId) throw fail("IDEMPOTENCY_CONFLICT");
      return {intentId,confirmationToken:`${intentId}.${saved.nonce}`,expiresAt:saved.expiresAt,snapshotId:snapshot.snapshotId,
        parentTaskId:taskId,parentTaskTitle:saved.parentTaskTitle,parentHeadOid:snapshot.parentHeadOid,automatedVerification:saved.automatedVerification};
    }
    const nonce=randomBytes(32).toString("base64url");
    const token=`${intentId}.${nonce}`;
    const expiresAt=new Date(this.now().getTime()+5*60_000).toISOString();
    const automated=this.automatedVerification(task);
    const evidence={kind:"manual_approval_intent",actor:userContext,nonce,parentTaskTitle:task.title,tokenHash:hierarchyDigest(token),expiresAt,
      assessmentAtPreparation:task.acceptance_assessment_json ?? null,automatedVerification:automated};
    this.store.runInTransaction(()=>{
      revalidate(); this.assertRevisions(snapshot);
      this.store.db.run(`INSERT INTO task_integration_acceptances
        (receipt_id,snapshot_id,task_id,assessment_hash,evidence_json,created_at) VALUES (?,?,?,?,?,?)`,
      [intentId,snapshot.snapshotId,taskId,hierarchyDigest(evidence),JSON.stringify(evidence),new Date().toISOString()]);
    });
    this.store.scheduleSave();
    return {intentId,confirmationToken:token,expiresAt,snapshotId:snapshot.snapshotId,parentTaskId:taskId,
      parentTaskTitle:task.title,parentHeadOid:snapshot.parentHeadOid,automatedVerification:automated};
  }
  automatedVerification(task) {
    let assessment; try { assessment=JSON.parse(task.acceptance_assessment_json); } catch { return "unknown"; }
    if(assessment?.status==="passed") return "passed";
    return assessment?.results?.some(result=>result.verdict==="failed") ? "failed" : "unknown";
  }
  async confirmUserApproval(taskId,input={},userContext={}, {revalidate=()=>{}}={}) {
    this.requireUser(userContext); revalidate();
    this.requireApprovalTarget(taskId);
    if(Object.keys(input).some(key=>!["requestId","snapshotId","confirmationToken","acknowledgedAutomatedFailure"].includes(key))
      || !/^[A-Za-z0-9:_-]{8,200}$/.test(input.requestId ?? "") || typeof input.confirmationToken!=="string"
      || input.confirmationToken.length>512 || typeof input.snapshotId!=="string" || !input.snapshotId
      || input.acknowledgedAutomatedFailure!==undefined && typeof input.acknowledgedAutomatedFailure!=="boolean") throw fail("INVALID_USER_APPROVAL","Invalid user approval",400);
    const intentId=input.confirmationToken.split(".")[0];
    const row=this.store.selectOne("SELECT * FROM task_integration_acceptances WHERE receipt_id=? AND task_id=? AND snapshot_id=?",
      [intentId,taskId,input.snapshotId]);
    if(!row) throw fail("USER_APPROVAL_INTENT_INVALID","Approval intent not found",403);
    const intent=JSON.parse(row.evidence_json);
    if(intent.kind!=="manual_approval_intent" || intent.actor.id!==userContext.id
      || intent.tokenHash!==hierarchyDigest(input.confirmationToken)) throw fail("USER_APPROVAL_INTENT_INVALID","Approval intent is invalid",403);
    const receiptId=`integration_user_approval:${hierarchyDigest([intentId,input.requestId])}`;
    const prior=this.readUserApproval(taskId,receiptId);
    if(prior) {
      if(JSON.parse(prior.evidence_json).acknowledgedAutomatedFailure!==(input.acknowledgedAutomatedFailure===true)) throw fail("IDEMPOTENCY_CONFLICT");
      return this.readStatus(taskId,{receiptId});
    }
    if(Date.parse(intent.expiresAt)<=this.now().getTime()) throw fail("USER_APPROVAL_INTENT_EXPIRED","Approval intent expired",410);
    if(intent.automatedVerification==="failed" && input.acknowledgedAutomatedFailure!==true) throw fail("AUTOMATED_FAILURE_ACKNOWLEDGEMENT_REQUIRED");
    const task=this.store.getTask(taskId);
    if((task.acceptance_assessment_json ?? null)!==intent.assessmentAtPreparation) throw fail("INTEGRATION_ACCEPTANCE_STALE");
    const snapshot=await this.validateSnapshotForAssessment(task,{integrationSnapshotId:input.snapshotId});
    const evidence={kind:"manual_approval",actor:userContext,intentId,requestId:input.requestId,
      assessmentAtApproval:task.acceptance_assessment_json ?? null,automatedVerification:intent.automatedVerification,
      acknowledgedAutomatedFailure:input.acknowledgedAutomatedFailure===true};
    this.store.runInTransaction(()=>{
      revalidate(); this.assertRevisions(snapshot);
      if(this.readUserApproval(taskId,receiptId)) return;
      if((this.store.getTask(taskId).acceptance_assessment_json ?? null)!==evidence.assessmentAtApproval) throw fail("INTEGRATION_ACCEPTANCE_STALE");
      const consumed=this.store.selectOne("SELECT 1 FROM task_integration_acceptances WHERE task_id=? AND json_extract(evidence_json,'$.kind')='manual_approval' AND json_extract(evidence_json,'$.intentId')=?",[taskId,intentId]);
      if(consumed) throw fail("USER_APPROVAL_INTENT_CONSUMED");
      this.store.db.run(`INSERT INTO task_integration_acceptances
        (receipt_id,snapshot_id,task_id,assessment_hash,evidence_json,created_at) VALUES (?,?,?,?,?,?)`,
      [receiptId,input.snapshotId,taskId,hierarchyDigest(evidence),JSON.stringify(evidence),new Date().toISOString()]);
    });
    this.store.scheduleSave();
    return this.readStatus(taskId,{receiptId});
  }
  readUserApproval(taskId,receiptId=null) {
    const row=this.store.selectOne(`SELECT a.*,s.payload_json FROM task_integration_acceptances a
      JOIN task_integration_snapshots s ON s.snapshot_id=a.snapshot_id WHERE a.task_id=?
      AND json_extract(a.evidence_json,'$.kind')='manual_approval' ${receiptId ? "AND a.receipt_id=?" : ""}
      ORDER BY a.rowid DESC LIMIT 1`,receiptId ? [taskId,receiptId] : [taskId]);
    return row ?? null;
  }
  userApprovalStatus(task,row,current,present) {
    const snapshot=JSON.parse(row.payload_json), evidence=JSON.parse(row.evidence_json);
    const pending=current.children.some(child=>!child.includedInParent);
    const stale=current.parentHeadOid!==snapshot.parentHeadOid || current.parentTreeOid!==snapshot.parentTreeOid
      || current.scopeHash!==snapshot.scopeHash || (task.acceptance_assessment_json ?? null)!==evidence.assessmentAtApproval;
    return present({state:stale ? "stale" : "passed",approvalSource:"manual_user",automatedVerification:evidence.automatedVerification,
      receiptId:row.receipt_id,acceptedHeadOid:snapshot.parentHeadOid,testedHeadOid:null,currentHeadOid:current.parentHeadOid,
      hasUnintegratedChildren:pending,canPromote:true,reason:stale ? "INTEGRATION_ACCEPTANCE_STALE" : pending ? "CHILDREN_NOT_INTEGRATED" : null});
  }
}
