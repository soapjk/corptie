import { snapshotBaseForWorktree } from "../runtime/workspaceSnapshotIntegration.mjs";
import { ChildTaskDeliveryRepository } from "../store/repositories/childTaskDeliveryRepository.mjs";
import { TaskWorktreeHierarchyService } from "./taskWorktreeHierarchyService.mjs";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";

export class ChildTaskDeliveryService {
  constructor({ store, gitWorkspaces, jobs, artifactService, deletionService, prepareProtection, onEvent = () => {} }) {
    Object.assign(this,{store,gitWorkspaces,jobs,artifactService,deletionService,onEvent});
    this.repository = new ChildTaskDeliveryRepository(store);
    this.hierarchy = new TaskWorktreeHierarchyService({store});
    this.inFlight = new Map(); this.pending = new Set();
    this.prepareProtection=prepareProtection;
    this.deletionService.prepareChildDelivery = id => this.prepareCleanup(id);
  }
  async prepareVersion(taskId,{revalidate=()=>{},operationId=null}={}) {
    revalidate();
    const binding=this.store.getTaskDeliveryBinding(taskId);
    if(binding) {
      const tree=this.store.getGitWorktree(binding.worktree_id),path=tree?.canonicalPath || tree?.path;
      if(path && (await this.gitWorkspaces.gitOutput(path,["status","--porcelain=v1"])).trim()) {
        this.assertChildIdle(taskId);
        if(!this.prepareProtection) throw failure("CHILD_DELIVERY_NEEDS_COMMIT","请先在 Worktree 卡片提交修改，再验收交付。");
        const task=this.store.getTask(taskId);
        if(!task?.parent_task_id) throw failure("CHILD_DELIVERY_SCOPE_INVALID","只有子任务可以准备交付版本。");
        await this.gitWorkspaces.prepareChildDeliveryCommit({taskId,parentTaskId:task.parent_task_id,
          repositoryId:binding.repository_id,worktreeId:binding.worktree_id,bindingRevision:binding.binding_revision,
          path,prepareProtection:this.prepareProtection,operationId,
          verifyPromotion:fixed=>this.artifactService.verifyRepositoryPromotion(fixed),
          revalidate:()=>{revalidate();this.hierarchy.assertIdle([binding.worktree_id],true);}});
      }
    }
    return this.captureVersion(taskId);
  }
  async captureVersion(taskId) {
    const task = this.store.getTask(taskId), parent = task?.parent_task_id && this.store.getTask(task.parent_task_id);
    if (!task || !parent || parent.work_id !== task.work_id || parent.deletion_status || parent.archived
      || task.deletion_status || task.archived) throw failure("CHILD_DELIVERY_SCOPE_INVALID","子任务或父任务已不可用。");
    const sessions = this.store.listSessionsByTask(taskId);
    const sessionIds = sessions.flatMap(session => [session.id,this.store.getLogicalSessionByLegacySessionId(session.id)?.logicalSessionId]).filter(Boolean);
    const binding = this.store.getTaskDeliveryBinding(taskId);
    const workspace = this.store.getTaskWorkspaceContext(task);
    let git = null;
    if (binding) {
      const parentBinding = this.store.getTaskDeliveryBinding(parent.id), tree = this.store.getGitWorktree(binding.worktree_id);
      if (!parentBinding || parentBinding.repository_id !== binding.repository_id || !tree || tree.isMain) throw failure("TASK_DELIVERY_BINDING_CHANGED","无法确认父子工作区绑定。");
      const path = tree.canonicalPath || tree.path;
      if ((await this.gitWorkspaces.gitOutput(path,["status","--porcelain=v1"])).trim()) throw failure("CHILD_DELIVERY_NEEDS_COMMIT","子任务仍有未提交内容，请先完成交付版本准备。");
      if (await this.gitWorkspaces.integrationOperationState(path)) throw failure("GIT_OPERATION_IN_PROGRESS","子工作区仍有未完成 Git 操作。");
      git = { repositoryId: binding.repository_id, worktreeId: binding.worktree_id, bindingRevision: binding.binding_revision,
        parentWorktreeId: parentBinding.worktree_id, parentBindingRevision: parentBinding.binding_revision,
        path, branchName: (await this.gitWorkspaces.gitOutput(path,["symbolic-ref","--short","HEAD"])).trim(),
        headOid: (await this.gitWorkspaces.gitOutput(path,["rev-parse","--verify","HEAD"])).trim() };
    } else if (workspace?.repository) throw failure("TASK_DELIVERY_BINDING_CHANGED","仓库任务缺少可证明的交付绑定。");
    const artifacts = this.ownedArtifacts(taskId,sessionIds).filter(artifact=>artifact?.status==="active").map(artifact => ({ artifactId: artifact.artifactId,
      title: artifact.title, resourceVersion: artifact.resourceVersion, currentVersion: artifact.currentVersion,
      status: artifact.status, boundTaskId: artifact.boundTaskId, boundSessionId: artifact.boundSessionId,
      versions: this.store.listArtifactVersions(artifact.artifactId).map(version => ({ version:version.version,contentHash:version.contentHash })) }));
    return { version:1,taskId,parentTaskId:parent.id,workId:task.work_id,title:task.title,taskRevision:task.revision,
      acceptanceCriteria:task.acceptance_criteria ?? "",verificationCriteria:task.verification_criteria ?? "",git,artifacts,sessionIds };
  }
  ownedArtifacts(taskId,sessionIds) {
    const ids=new Set(this.store.selectAll("SELECT artifact_id FROM artifacts WHERE bound_task_id=?",[taskId]).map(row=>row.artifact_id));
    for(let offset=0;offset<sessionIds.length;offset+=400) {
      const batch=sessionIds.slice(offset,offset+400);
      for(const row of this.store.selectAll(`SELECT artifact_id FROM artifacts WHERE bound_session_id IN (${batch.map(()=>"?").join(",")})`,batch)) ids.add(row.artifact_id);
    }
    return [...ids].sort().map(id=>this.store.getArtifact(id));
  }
  recordApproval(approval,snapshot,actor) { return this.repository.createFromApproval(approval,snapshot,actor); }
  async requestShadowDelivery(taskId) {
    const review = this.store.selectOne("SELECT * FROM coordination_shadow_reclamation WHERE task_id=?", [taskId]);
    if (!review || review.phase !== "delivery") throw failure("SHADOW_REVIEW_REQUIRED", "缺少影子会话的技术验收记录。");
    const existing = this.store.selectOne("SELECT operation_id FROM child_task_delivery_operations WHERE approval_operation_id=?", [review.report_id + ":" + taskId]);
    if (existing) { this.wake(existing.operation_id); return this.repository.getOperation(existing.operation_id); }
    const snapshot = await this.prepareVersion(taskId);
    const operation = this.repository.createFromApproval({ operationId: review.report_id + ":" + taskId }, snapshot,
      { type: "shadow_session", id: review.shadow_session_id });
    this.wake(operation.operationId);
    return operation;
  }
  assertChildIdle(taskId) {
    for(const session of this.store.listSessionsByTask(taskId)) {
      if(sessionHasActiveRun(session) || this.store.getSessionRuntimeBlocker?.(session.id,{includeQueued:true})) {
        throw failure("TASK_HIERARCHY_BUSY","子会话尚未结束；结束后会自动继续交付。");
      }
    }
  }
  wake(operationId) {
    if(this.inFlight.has(operationId)) { this.pending.add(operationId); return this.inFlight.get(operationId); }
    const promise=Promise.resolve().then(()=>this.drive(operationId)).finally(()=>{
      this.inFlight.delete(operationId);
      if(this.pending.delete(operationId)) setImmediate(()=>this.wake(operationId));
    });
    this.inFlight.set(operationId,promise); return promise;
  }
  advance(operation,patch) {
    const current = this.repository.getOperation(operation.operationId);
    if (current?.state === "superseded") return current;
    const next=this.repository.advanceOperation(operation,patch);
    this.onEvent("TaskChanged",{action:"child-delivery-state",entity:this.store.getTask(operation.taskId)
      ?? {id:operation.taskId,parentTaskId:operation.parentTaskId,workId:operation.workId},delivery:this.present(next)});
    return next;
  }
  async assertVersion(operation) {
    this.assertAuthority(operation.operationId);
    return this.refreshDeliveryInputs(operation);
  }
  async refreshDeliveryInputs(operation) {
    const task=this.store.getTask(operation.taskId),parent=this.store.getTask(operation.parentTaskId);
    if(!task || !parent || task.parent_task_id!==parent.id || task.work_id!==operation.workId
      || parent.work_id!==operation.workId || parent.archived || parent.deletion_status)
      throw failure("CHILD_DELIVERY_SCOPE_INVALID","父子任务已不存在或不在当前交付范围。");
    if(task.deletion_status && operation.progress.previousDeletionOperationId || task.deletion_status==="deleting" || task.deletion_worktree_removed_at || operation.progress.deletionOperationId
      || operation.progress.previousDeletionOperationId && this.deletionService.getOperation(operation.progress.previousDeletionOperationId)?.result?.cleanup?.worktreeRemoved) return operation;
    this.assertChildIdle(task.id);
    const current=await this.prepareVersion(task.id,{operationId:operation.operationId});
    const progress={...operation.progress};
    const moved=new Map((progress.artifacts ?? []).map(item=>[item.artifactId,item]));
    // A transfer receipt already owns all versions at the destination. Keep its
    // original input for idempotent replay; never claim a resource moved elsewhere.
    for(const pin of operation.snapshot.artifacts) {
      const artifact=this.store.getArtifact(pin.artifactId);
      const saved=this.store.selectOne("SELECT receipt_json FROM artifact_ownership_operations WHERE session_id=? AND idempotency_key=?",
        [`local-actor:${operation.actor.id}`,`child-delivery:${operation.operationId}:${pin.artifactId}`]);
      if(artifact?.boundTaskId===parent.id && (moved.has(pin.artifactId) || saved)) {
        if(!moved.has(pin.artifactId)) {
          const receipt=JSON.parse(saved.receipt_json);moved.set(pin.artifactId,{artifactId:pin.artifactId,resourceVersion:receipt.resourceVersion});
        }
        if(!current.artifacts.some(item=>item.artifactId===pin.artifactId)) current.artifacts.push(pin);
      }
    }
    progress.artifacts=[...moved.values()].filter(item=>current.artifacts.some(pin=>pin.artifactId===item.artifactId));
    const gitChanged=JSON.stringify(current.git)!==JSON.stringify(operation.snapshot.git);
    const artifactsChanged=JSON.stringify(current.artifacts)!==JSON.stringify(operation.snapshot.artifacts);
    if(gitChanged) progress.codeDelivered=false;
    if(artifactsChanged) progress.artifactsDelivered=false;
    if(JSON.stringify(current)===JSON.stringify(operation.snapshot) && JSON.stringify(progress)===JSON.stringify(operation.progress)) return operation;
    // snapshot_json is the existing mutable delivery input; approval_operation_id
    // still points to the immutable original human completion evidence.
    return this.advance(operation,{snapshot:current,progress,
      phase:gitChanged ? "code" : artifactsChanged ? "artifacts" : operation.phase});
  }
  async ensureCodeDelivered(operation) {
    if(!operation.snapshot.git) return true;
    const git=operation.snapshot.git;
    const parent=this.store.getGitWorktree(git.parentWorktreeId), path=parent?.canonicalPath || parent?.path;
    if(!path) throw failure("TASK_DELIVERY_BINDING_CHANGED","父工作区不可用。");
    const snapshotBase=snapshotBaseForWorktree(this.store,git.worktreeId);
    if(snapshotBase && (await this.gitWorkspaces.gitOutput(path,["rev-parse",`${git.headOid}^{tree}`])).trim()===snapshotBase.baseTreeOid) return true;
    const verifyReceipt=async job=>{
      const receipt=job?.plan?.items?.find(item=>item.worktreeId===git.worktreeId)?.snapshotReceipt;
      if(!receipt || receipt.childHead!==git.headOid || receipt.baseCommitOid!==snapshotBase.baseCommitOid) return false;
      if(!await this.gitWorkspaces.gitSucceeds(path,["merge-base","--is-ancestor",receipt.parentAfter,"HEAD"])) return false;
      const tree=(await this.gitWorkspaces.gitOutput(path,["rev-parse",`${receipt.parentAfter}^{tree}`])).trim();
      return receipt.resultTree ? tree===receipt.resultTree : receipt.resolvedHead
        && tree===(await this.gitWorkspaces.gitOutput(path,["rev-parse",`${receipt.resolvedHead}^{tree}`])).trim();
    };
    if(!snapshotBase && await this.gitWorkspaces.gitSucceeds(path,["merge-base","--is-ancestor",git.headOid,"HEAD"])) return true;

    let job=operation.progress.gitJobId && this.jobs.get(operation.progress.gitJobId);
    if(job && ["queued","running","cancellation_requested","replanning"].includes(job.status)) return false;
    if(job?.status==="completed") {
      const source=job.plan?.items?.find(item=>item.worktreeId===git.worktreeId);
      if((source?.commitHead ?? source?.sourceHeadBefore)!==git.headOid) job=null;
    }
    if(!job) {
      this.hierarchy.assertIdle([git.worktreeId,git.parentWorktreeId],true);
      job=await this.jobs.createAcceptedChildDelivery(operation);
      operation=this.advance(operation,{progress:{...operation.progress,gitJobId:job.id}});
      job=this.jobs.get(job.id);
    }
    if(["failed","canceled"].includes(job.status) || job.status==="paused") throw failure("CHILD_DELIVERY_GIT_PAUSED","代码交付已暂停，请处理对应 Git 作业后重试。");
    if(job.status==="completed") {
      if(snapshotBase ? !await verifyReceipt(job) : !await this.gitWorkspaces.gitSucceeds(path,["merge-base","--is-ancestor",git.headOid,"HEAD"])) throw failure("CHILD_DELIVERY_GIT_UNPROVEN","Git 作业未证明子版本已进入父分支。");
      return true;
    }
    return false;
  }
  async ensureArtifactsDelivered(operation) {
    for(const pin of operation.snapshot.artifacts) {
      // Ownership and the parent reference are separate durable writes. Replay
      // both, even when ownership was checkpointed before a process crash.
      const receipt=await this.artifactService.transferChildDeliveryArtifact(operation,pin,()=>this.assertAuthority(operation.operationId));
      operation=this.advance(operation,{progress:{...operation.progress,artifacts:[...(operation.progress.artifacts ?? []).filter(item=>item.artifactId!==pin.artifactId),receipt]}});
    }
    return operation;
  }
  assertAuthority(id) {
    const operation=this.repository.getOperation(id), approval=operation && this.store.getTaskCompletionOperation(operation.approvalOperationId);
    if (operation?.actor?.type === "shadow_session" && ["running", "waiting"].includes(operation.state)) {
      const amendment = this.store.selectOne(`SELECT pending.request_id FROM coordination_requests pending
        JOIN coordination_requests original ON original.request_id=pending.related_request_id
        JOIN json_each(COALESCE(original.dispatch_json,'[]')) dispatched
        WHERE pending.parent_task_id=? AND pending.status IN ('accepted','preparing','running','waiting')
          AND pending.relation IN ('supplement','depends_on','cancel')
          AND json_extract(dispatched.value,'$.taskId')=? LIMIT 1`, [operation.parentTaskId, operation.taskId]);
      if (amendment) throw failure("CHILD_REQUEST_PENDING", `该子任务仍有用户请求 ${amendment.request_id} 待处理，处理后再交付回收。`);
      const review = this.store.selectOne(`SELECT r.* FROM coordination_shadow_reclamation r
        JOIN coordination_shadow_sessions sh ON sh.shadow_session_id=r.shadow_session_id
        JOIN coordination_shadow_reports report ON report.report_id=r.report_id
        WHERE r.task_id=? AND r.shadow_session_id=? AND sh.parent_task_id=?`, [operation.taskId, operation.actor.id, operation.parentTaskId]);
      const latestDispatchId = this.store.selectOne("SELECT dispatch_id FROM task_coordination_dispatches WHERE target_task_id=? ORDER BY created_at DESC,dispatch_id DESC LIMIT 1", [operation.taskId])?.dispatch_id ?? null;
      if (review && `${review.report_id}:${operation.taskId}` === operation.approvalOperationId
        && (JSON.parse(review.recovery_json).latestDispatchId ?? null) === latestDispatchId) return operation;
      throw failure("SHADOW_REVIEW_CHANGED", "影子验收依据已变化，等待重新核对。");
    }
    if(!operation || !["running","waiting"].includes(operation.state) || approval?.result!=="succeeded"
      || approval.details?.childDelivery?.taskId!==operation.taskId) throw failure("CHILD_DELIVERY_APPROVAL_INVALID","自动收尾凭据已失效。");
    return operation;
  }
  authorizesCleanup(taskId,id) {
    try { const op=this.assertAuthority(id); return op.taskId===taskId && op.phase==="cleanup"; } catch { return false; }
  }
  async prepareCleanup(id, { insideDrive = false } = {}) {
    let operation = this.repository.getOperation(id);
    if (!operation || operation.state === "superseded") throw failure("CHILD_DELIVERY_APPROVAL_INVALID", "自动交付记录不存在或已被替代。");
    if (!insideDrive && this.inFlight.has(id)) return operation;
    if (!["running", "waiting"].includes(operation.state)) operation = this.repository.claimOperation(operation);
    operation=await this.assertVersion(operation);
    this.assertChildIdle(operation.taskId);
    if (!operation.progress.codeDelivered) {
      operation = this.advance(operation, { phase: "code" });
      if (!await this.ensureCodeDelivered(operation)) {
        operation = this.repository.getOperation(id);
        return this.advance(operation, { state: "waiting" });
      }
      operation = this.repository.getOperation(id);
      operation = this.advance(operation, { progress: { ...operation.progress, codeDelivered: true } });
    }
    if (!operation.progress.artifactsDelivered) {
      operation = this.advance(operation, { phase: "artifacts" });
      operation = await this.ensureArtifactsDelivered(operation);
      operation=await this.assertVersion(operation);
      if(operation.phase==="code" || operation.snapshot.artifacts.some(pin=>!operation.progress.artifacts?.some(receipt=>receipt.artifactId===pin.artifactId))) {
        this.pending.add(operation.operationId);return this.advance(operation,{state:"waiting"});
      }
      operation = this.advance(operation, { progress: { ...operation.progress, artifactsDelivered: true } });
    }
    return this.advance(operation, { phase: "cleanup" });
  }

  async ensureCleanup(operation) {
    const existing=operation.progress.deletionOperationId && this.deletionService.getOperation(operation.progress.deletionOperationId);
    if(existing?.state==="succeeded") return operation;
    if(existing?.state==="failed") throw failure("CHILD_DELIVERY_CLEANUP_FAILED",existing.errorMessage || "资源清理失败。");
    const accepted=existing ? {operation:existing} : await this.deletionService.requestAfterChildDelivery(operation);
    if (accepted.pendingDelivery) return null;
    if(!existing) {
      operation=this.repository.getOperation(operation.operationId);
      operation=this.advance(operation,{progress:{...operation.progress,deletionOperationId:accepted.operation.operationId}});
    }
    await this.deletionService.resumeChildDeliveryDeletion(accepted.operation.operationId, operation.operationId);
    const result=this.deletionService.getOperation(accepted.operation.operationId);
    if(result.state!=="succeeded") throw failure("CHILD_DELIVERY_CLEANUP_FAILED",result.errorMessage || "资源清理尚未完成。");
    return operation;
  }
  async drive(id) {
    let operation=this.repository.getOperation(id);
    if(!operation || ["completed","blocked","superseded"].includes(operation.state)) return operation;
    operation=this.repository.claimOperation(operation);
    try {
      if(operation.phase!=="cleanup" || !operation.progress.deletionOperationId) await this.assertVersion(operation);
      operation=this.repository.getOperation(id);
      this.assertChildIdle(operation.taskId);
      if(operation.phase==="code") {
        if(!await this.ensureCodeDelivered(operation)) {
          operation=this.repository.getOperation(id);
          return this.advance(operation,{state:"waiting"});
        }
        operation=this.repository.getOperation(id);
        operation=this.advance(operation,{phase:"artifacts",progress:{...operation.progress,codeDelivered:true}});
      }
      if(operation.phase==="artifacts") {
        operation=await this.ensureArtifactsDelivered(operation);
        operation=await this.assertVersion(operation);
        if(operation.phase==="code" || operation.snapshot.artifacts.some(pin=>!operation.progress.artifacts?.some(receipt=>receipt.artifactId===pin.artifactId))) {
        this.pending.add(operation.operationId);return this.advance(operation,{state:"waiting"});
      }
        operation=this.advance(operation,{phase:"cleanup",progress:{...operation.progress,artifactsDelivered:true}});
      }
      if (operation.phase === "cleanup" && (!operation.progress.codeDelivered || !operation.progress.artifactsDelivered)) {
        operation = await this.prepareCleanup(id, { insideDrive: true });
        if (operation.phase !== "cleanup") return operation;
      }
      if(operation.phase==="cleanup") {
        operation=await this.ensureCleanup(operation);
        if (!operation) return this.repository.getOperation(id);
      }
      const completed = this.advance(operation,{state:"completed",phase:"completed",progress:{...operation.progress,completedAt:new Date().toISOString()}});
      if (operation.actor.type === "shadow_session") await this.reclaimChild?.(operation.taskId);
      return completed;
    } catch(error) {
      operation=this.repository.getOperation(id);
      if (operation?.state === "superseded") return operation;
      const failed = this.advance(operation,{state:error.code==="TASK_HIERARCHY_BUSY" ? "waiting" : "blocked",
        errorCode:error.code ?? "CHILD_DELIVERY_FAILED",errorMessage:String(error.message).slice(0,1000)});
      if (failed.state === "blocked" && failed.actor.type === "shadow_session") this.onShadowBlocked?.(failed);
      return failed;
    }
  }
  retry(id) {
    let operation=this.repository.getOperation(id);
    if(!operation) throw failure("CHILD_DELIVERY_NOT_FOUND","收尾记录不存在。");
    if(operation.state==="completed") return this.present(operation);
    if(operation.state==="superseded") throw failure("CHILD_DELIVERY_APPROVAL_INVALID","此版本已被新的验收取代。");
    if(this.inFlight.has(id)) return this.present(operation);
    const progress={...operation.progress};
    if(progress.deletionOperationId && this.deletionService.getOperation(progress.deletionOperationId).state==="failed") {
      progress.previousDeletionOperationId=progress.deletionOperationId;
      delete progress.deletionOperationId; progress.cleanupAttempt=(progress.cleanupAttempt ?? 0)+1;
    }
    operation=this.advance(operation,{state:"queued",progress,errorCode:null,errorMessage:null});
    void this.wake(id); return this.present(operation);
  }
  async recover() {
    for(const operation of this.repository.listRecoverableOperations()) void this.wake(operation.operationId);
    for (const row of this.store.selectAll(`SELECT r.task_id FROM coordination_shadow_reclamation r
      JOIN tasks t ON t.id=r.task_id WHERE t.deletion_status='deleted'`)) {
      await this.reclaimChild?.(row.task_id);
    }
    for (const row of this.store.selectAll(`SELECT r.task_id FROM coordination_shadow_reclamation r
      JOIN tasks t ON t.id=r.task_id WHERE COALESCE(t.deletion_status,'')<>'deleted' AND r.phase='delivery'
      AND NOT EXISTS(SELECT 1 FROM child_task_delivery_operations d WHERE d.child_task_id=r.task_id)`)) {
      try { await this.requestShadowDelivery(row.task_id); }
      catch (error) { console.warn(`[shadow-delivery-recovery] ${error.code ?? error.message}`); }
    }
  }
  onRuntimeEvent(type,payload) {
    if(type==="TaskChanged" && payload?.action==="child-delivery-state") return;
    // Never scan durable deliveries for token deltas or timeline updates.
    if(!["WorktreeIntegrationJobChanged","SessionRunCompleted","SessionRunFailed","SessionRunInterrupted",
      "SessionTurnCompleted","TurnCompleted","AgentTurnCompleted","CodexThreadCompleted","AgentTurnFailed",
      "AgentWorkCompleted","MessageDeliveryChanged","ArtifactChanged"].includes(type)) return;
    const id=payload?.job?.id ?? payload?.entity?.id ?? payload?.jobId ?? payload?.id;
    const sessionId=payload?.sessionId ?? payload?.session?.id ?? id;
    const session=sessionId ? this.store.getSession(sessionId) : null;
    const resource=payload?.artifact ?? payload?.entity;
    const artifactTaskId=resource?.boundTaskId ?? (resource?.boundSessionId ? this.store.getSession(resource.boundSessionId)?.taskId : null);
    for(const op of this.repository.listRecoverableOperations()) {
      if((id && op.progress.gitJobId===id) || session?.taskId===op.taskId || session?.taskId===op.parentTaskId || artifactTaskId===op.taskId) void this.wake(op.operationId);
    }
  }
  read(id) { const op=this.repository.getOperation(id); return op && this.present(op); }
  listParentDeliveries(id,cursor,limit) {
    const page=this.repository.listParentDeliveries(id,cursor,limit);
    return {...page,items:page.items.map(op=>this.present(op))};
  }
  present(op) {
    return {operationId:op.operationId,taskId:op.taskId,parentTaskId:op.parentTaskId,title:op.snapshot.title,
      state:op.state,phase:op.phase,errorCode:op.errorCode,errorMessage:op.errorMessage,createdAt:op.createdAt,updatedAt:op.updatedAt,
      gitJobId:op.progress.gitJobId ?? null,acceptedHeadOid:this.store.getTaskCompletionOperation(op.approvalOperationId)?.details?.childDelivery?.git?.headOid ?? null,
      artifacts:op.snapshot.artifacts.map(pin=>({artifactId:pin.artifactId,title:pin.title,version:pin.currentVersion})),
      canRetry:op.state==="blocked" || op.state==="waiting"};
  }
}
function failure(code,message) { return Object.assign(new Error(message),{code,statusCode:409}); }
