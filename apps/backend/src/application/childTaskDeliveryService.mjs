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
  }
  async prepareVersion(taskId,{revalidate=()=>{}}={}) {
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
          path,prepareProtection:this.prepareProtection,
          verifyPromotion:fixed=>this.artifactService.verifyRepositoryPromotion(fixed),
          revalidate:()=>{revalidate();this.hierarchy.assertIdle([binding.worktree_id],true);}});
      }
    }
    return this.captureVersion(taskId);
  }
  async captureVersion(taskId) {
    const task = this.store.getTask(taskId), parent = task?.parent_task_id && this.store.getTask(task.parent_task_id);
    if (!task || !parent || parent.work_id !== task.work_id || parent.parent_task_id || parent.deletion_status || parent.archived
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
    const artifacts = this.ownedArtifacts(taskId,sessionIds).map(artifact => ({ artifactId: artifact.artifactId,
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
    const next=this.repository.advanceOperation(operation,patch);
    this.onEvent("TaskChanged",{action:"child-delivery-state",entity:this.store.getTask(operation.taskId)
      ?? {id:operation.taskId,parentTaskId:operation.parentTaskId,workId:operation.workId},delivery:this.present(next)});
    return next;
  }
  async assertVersion(operation) {
    const snapshot=operation.snapshot, task=this.store.getTask(operation.taskId), parent=this.store.getTask(operation.parentTaskId);
    const approval=this.store.getTaskCompletionOperation(operation.approvalOperationId);
    if(!approval || approval.result!=="succeeded" || approval.taskId!==operation.taskId
      || approval.details?.childDelivery?.taskId!==operation.taskId) throw failure("CHILD_DELIVERY_APPROVAL_INVALID","找不到有效用户验收凭据。");
    if(!task || !parent || parent.deletion_status || parent.archived || task.parent_task_id!==parent.id
      || task.work_id!==snapshot.workId || task.revision!==snapshot.taskRevision
      || (task.acceptance_criteria ?? "")!==snapshot.acceptanceCriteria || (task.verification_criteria ?? "")!==snapshot.verificationCriteria) {
      throw failure("CHILD_DELIVERY_VERSION_CHANGED","任务或验收要求已变化，请验收新版本。");
    }
    const currentSessions=this.store.listSessionsByTask(task.id);
    if(currentSessions.some(session=>!snapshot.sessionIds.includes(session.id))) throw failure("CHILD_DELIVERY_VERSION_CHANGED","子任务新增了会话，已保留资源。");
    const cleanupCheckpoint=operation.progress.previousDeletionOperationId
      && this.deletionService.getOperation(operation.progress.previousDeletionOperationId)?.result?.cleanup?.worktreeRemoved;
    if(snapshot.git && !task.deletion_worktree_removed_at && !operation.progress.deletionOperationId && !cleanupCheckpoint) {
      const binding=this.store.getTaskDeliveryBinding(task.id), parentBinding=this.store.getTaskDeliveryBinding(parent.id);
      if(binding?.worktree_id!==snapshot.git.worktreeId || binding.binding_revision!==snapshot.git.bindingRevision
        || parentBinding?.worktree_id!==snapshot.git.parentWorktreeId || parentBinding.binding_revision!==snapshot.git.parentBindingRevision) {
        throw failure("TASK_DELIVERY_BINDING_CHANGED","父子工作区绑定已变化。");
      }
      const head=(await this.gitWorkspaces.gitOutput(snapshot.git.path,["rev-parse","HEAD"])).trim();
      const dirty=(await this.gitWorkspaces.gitOutput(snapshot.git.path,["status","--porcelain=v1"])).trim();
      if(head!==snapshot.git.headOid || dirty) throw failure("CHILD_DELIVERY_VERSION_CHANGED","子分支出现新提交或文件，已保留资源。");
    }
    const moved=new Map((operation.progress.artifacts ?? []).map(item=>[item.artifactId,item]));
    for(const pin of snapshot.artifacts) {
      const artifact=this.store.getArtifact(pin.artifactId);
      let receipt=moved.get(pin.artifactId);
      if(!receipt && artifact?.boundTaskId===parent.id) {
        const recorded=this.store.selectOne("SELECT receipt_json FROM artifact_ownership_operations WHERE session_id=? AND idempotency_key=?",
          [`local-actor:${operation.actor.id}`,`child-delivery:${operation.operationId}:${pin.artifactId}`]);
        if(recorded) {
          const value=JSON.parse(recorded.receipt_json);
          receipt={artifactId:pin.artifactId,resourceVersion:value.resourceVersion};
          operation=this.advance(operation,{progress:{...operation.progress,artifacts:[...(operation.progress.artifacts ?? []),receipt]}});
          moved.set(pin.artifactId,receipt);
        }
      }
      const versions=this.store.listArtifactVersions(pin.artifactId).map(v=>({version:v.version,contentHash:v.contentHash}));
      if(!artifact || artifact.status!==pin.status || artifact.currentVersion!==pin.currentVersion
        || JSON.stringify(versions)!==JSON.stringify(pin.versions)
        || (receipt ? artifact.boundTaskId!==parent.id || artifact.resourceVersion!==receipt.resourceVersion
          : artifact.resourceVersion!==pin.resourceVersion || artifact.boundTaskId!==pin.boundTaskId || artifact.boundSessionId!==pin.boundSessionId)) {
        throw failure("CHILD_DELIVERY_ARTIFACT_CHANGED","Artifact 版本或归属已变化，已停止清理。");
      }
    }
    if(this.ownedArtifacts(task.id,snapshot.sessionIds).some(artifact=>!snapshot.artifacts.some(pin=>pin.artifactId===artifact.artifactId))) {
      throw failure("CHILD_DELIVERY_VERSION_CHANGED","子任务产生了新的 Artifact，已保留资源。");
    }
  }
  async ensureCodeDelivered(operation) {
    if(!operation.snapshot.git) return true;
    const git=operation.snapshot.git;
    const parent=this.store.getGitWorktree(git.parentWorktreeId), path=parent?.canonicalPath || parent?.path;
    if(!path) throw failure("TASK_DELIVERY_BINDING_CHANGED","父工作区不可用。");
    if(await this.gitWorkspaces.gitSucceeds(path,["merge-base","--is-ancestor",git.headOid,"HEAD"])) return true;
    let job=operation.progress.gitJobId && this.jobs.get(operation.progress.gitJobId);
    if(!job) {
      this.hierarchy.assertIdle([git.worktreeId,git.parentWorktreeId],true);
      job=await this.jobs.createAcceptedChildDelivery(operation);
      operation=this.advance(operation,{progress:{...operation.progress,gitJobId:job.id}});
      job=this.jobs.get(job.id);
    }
    if(["failed","canceled"].includes(job.status) || job.status==="paused") throw failure("CHILD_DELIVERY_GIT_PAUSED","代码交付已暂停，请处理对应 Git 作业后重试。");
    if(job.status==="completed") {
      if(!await this.gitWorkspaces.gitSucceeds(path,["merge-base","--is-ancestor",git.headOid,"HEAD"])) throw failure("CHILD_DELIVERY_GIT_UNPROVEN","Git 作业未证明子版本已进入父分支。");
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
    if(!operation || !["running","waiting"].includes(operation.state) || approval?.result!=="succeeded"
      || approval.details?.childDelivery?.taskId!==operation.taskId) throw failure("CHILD_DELIVERY_APPROVAL_INVALID","自动收尾凭据已失效。");
    return operation;
  }
  authorizesCleanup(taskId,id) {
    try { const op=this.assertAuthority(id); return op.taskId===taskId && op.phase==="cleanup"; } catch { return false; }
  }
  async ensureCleanup(operation) {
    const existing=operation.progress.deletionOperationId && this.deletionService.getOperation(operation.progress.deletionOperationId);
    if(existing?.state==="succeeded") return operation;
    if(existing?.state==="failed") throw failure("CHILD_DELIVERY_CLEANUP_FAILED",existing.errorMessage || "资源清理失败。");
    const accepted=existing ? {operation:existing} : await this.deletionService.requestAfterChildDelivery(operation);
    if(!existing) operation=this.advance(operation,{progress:{...operation.progress,deletionOperationId:accepted.operation.operationId}});
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
        await this.assertVersion(operation);
        operation=this.advance(operation,{phase:"cleanup",progress:{...operation.progress,artifactsDelivered:true}});
      }
      if(operation.phase==="cleanup") operation=await this.ensureCleanup(operation);
      return this.advance(operation,{state:"completed",phase:"completed",progress:{...operation.progress,completedAt:new Date().toISOString()}});
    } catch(error) {
      operation=this.repository.getOperation(id);
      return this.advance(operation,{state:error.code==="TASK_HIERARCHY_BUSY" ? "waiting" : "blocked",
        errorCode:error.code ?? "CHILD_DELIVERY_FAILED",errorMessage:String(error.message).slice(0,1000)});
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
  }
  onRuntimeEvent(type,payload) {
    if(type==="TaskChanged" && payload?.action==="child-delivery-state") return;
    // Never scan durable deliveries for token deltas or timeline updates.
    if(!["WorktreeIntegrationJobChanged","SessionRunCompleted","SessionRunFailed","SessionRunInterrupted",
      "SessionTurnCompleted","TurnCompleted","AgentTurnCompleted","CodexThreadCompleted","AgentTurnFailed",
      "AgentWorkCompleted","MessageDeliveryChanged"].includes(type)) return;
    const id=payload?.job?.id ?? payload?.entity?.id ?? payload?.jobId ?? payload?.id;
    const sessionId=payload?.sessionId ?? payload?.session?.id ?? id;
    const session=sessionId ? this.store.getSession(sessionId) : null;
    for(const op of this.repository.listRecoverableOperations()) {
      if((id && op.progress.gitJobId===id) || session?.taskId===op.taskId || session?.taskId===op.parentTaskId) void this.wake(op.operationId);
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
      gitJobId:op.progress.gitJobId ?? null,acceptedHeadOid:op.snapshot.git?.headOid ?? null,
      artifacts:op.snapshot.artifacts.map(pin=>({artifactId:pin.artifactId,title:pin.title,version:pin.currentVersion})),
      canRetry:op.state==="blocked" || op.state==="waiting"};
  }
}
function failure(code,message) { return Object.assign(new Error(message),{code,statusCode:409}); }
