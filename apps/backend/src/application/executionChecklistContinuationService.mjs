import { selectChecklistWork } from "../domain/executionChecklistPolicy.mjs";
import { coordinationDelegation } from "../domain/coordinationDelegation.mjs";

const fault=(code,message)=>Object.assign(new Error(message),{code,statusCode:409});
const progressKey=plan=>JSON.stringify(plan.steps.map(step=>[step.stepId,step.status,step.executionRevision??0,step.assignment??null]));

export class ExecutionChecklistContinuationService {
  constructor({store,checklists,mailbox,coordinator=null,budget=null,emitEvent=()=>{},readOnly=false}) {
    Object.assign(this,{store,checklists,mailbox,coordinator,budget,emitEvent,readOnly});
    this.repository=checklists.repository;this.pending=new Map();this.scheduled=new Set();
  }
  changed(plan) {
    if(this.readOnly)return;
    const completed=plan.steps.filter(s=>s.status==='completed').map(s=>s.stepId);
    if(completed.length)for(const row of this.store.selectAll("SELECT DISTINCT plan_id FROM execution_checklist_waits WHERE kind='step' AND resource_id IN (SELECT value FROM json_each(?))",[JSON.stringify(completed)])){
      const dependent=this.store.selectOne('SELECT body_json FROM execution_checklist_plans WHERE plan_id=?',[row.plan_id]);
      if(dependent&&row.plan_id!==plan.planId)this.schedule(row.plan_id);
    }
    this.schedule(plan.planId);
  }
  schedule(planId){
    if(this.scheduled.has(planId))return;this.scheduled.add(planId);
    setImmediate(()=>{this.scheduled.delete(planId);if(!this.store.db)return;
      if(this.pending.has(planId)){void this.pending.get(planId).finally(()=>{if(this.store.db)this.schedule(planId);}).catch(()=>{});return;}
      void this.reconcile(planId).catch(error=>console.warn('[checklist-continuation]',error.code??error.message));
    });
  }
  owner(plan) {
    const route=this.store.getLogicalSession(plan.logicalSessionId),session=route&&this.store.getSession(route.legacySessionId),task=this.store.getTask(plan.taskId);
    if(!route||route.activeBinding?.state!=='active'||route.archived||!session||session.archived||session.deletedAt||!task||task.archived||task.deletion_status||task.current_session_id!==session.id)
      throw fault('CHECKLIST_OWNER_UNAVAILABLE','清单所属会话当前不可执行，恢复会话后可继续。');
    return {route,session,task};
  }
  operationFact(operation,stepIds,revision=0) {
    let status=operation?.status;
    if(operation?.targetTurnId) {
      const turn=this.store.selectOne('SELECT execution_status FROM session_turns WHERE session_id=? AND turn_id=? ORDER BY started_at DESC LIMIT 1',[operation.sessionId,operation.targetTurnId]);
      if(turn&&['completed','failed','cancelled'].includes(turn.execution_status))status=turn.execution_status;
    }
    return operation?{operationId:operation.taskId,status,stepIds,authorized:true,executionRevision:revision}:null;
  }
  coverage(plan,runtime) {
    const result=[];
    const original=!runtime.operationId&&runtime.sourceOperationId&&this.store.getAgentTask(runtime.sourceOperationId);
    if(original)for(const step of plan.steps)result.push(this.operationFact(original,[step.stepId],0));
    const own=runtime.operationId&&this.store.getAgentTask(runtime.operationId);
    if(own&&own.source?.checklistContinuation?.generation===runtime.generation) {
      const ids=own.source.checklistContinuation.stepIds;
      for(const id of ids)result.push(this.operationFact(own,[id],own.source.checklistContinuation.stepRevisions?.[id]??0));
    }
    for(const step of plan.steps) {
      if(!step.assignment)continue;
      const d=step.assignment.dispatchId?this.store.selectOne('SELECT * FROM task_coordination_dispatches WHERE dispatch_id=? AND parent_task_id=?',[step.assignment.dispatchId,plan.taskId])
        :this.store.selectOne('SELECT * FROM task_coordination_dispatches WHERE target_task_id=? AND parent_task_id=? ORDER BY created_at DESC,dispatch_id DESC LIMIT 1',[step.assignment.taskId,plan.taskId]);
      if(!d)continue;
      const work=d.operation_id&&this.store.getAgentTask(d.operation_id);
      const childResume=d.target_task_id&&this.store.selectOne(`SELECT r.operation_id FROM execution_checklist_runtime r JOIN execution_checklist_plans p USING(plan_id)
        WHERE p.task_id=? AND r.enabled=1 AND r.state IN ('queued','running') AND json_extract(r.body_json,'$.sourceOperationId')=? LIMIT 1`,[d.target_task_id,d.operation_id]);
      const currentWork=childResume?.operation_id?this.store.getAgentTask(childResume.operation_id):work;
      result.push(currentWork?this.operationFact(currentWork,[step.stepId],step.assignment.executionRevision??0):{operationId:d.dispatch_id,status:d.status,stepIds:[step.stepId],authorized:true,executionRevision:step.assignment.executionRevision??0});
    }
    return result.filter(Boolean);
  }
  resolveWait(wait) {
    if(wait.kind==='decision')return ['answered','superseded'].includes(this.store.selectOne('SELECT status FROM coordination_decisions WHERE decision_id=?',[wait.resourceId])?.status);
    if(wait.kind==='operation')return ['completed','failed','cancelled'].includes(this.store.getAgentTask(wait.resourceId)?.status);
    if(wait.kind==='dispatch')return ['completed','failed','cancelled'].includes(this.store.selectOne('SELECT status FROM task_coordination_dispatches WHERE dispatch_id=?',[wait.resourceId])?.status);
    if(wait.kind==='step')return this.checklists.read(wait.taskId,{planId:wait.dependencyPlanId})?.steps.find(s=>s.stepId===wait.resourceId)?.status==='completed';
    return false;
  }
  async reconcile(planId) {
    if(this.readOnly)return null;
    if(this.pending.has(planId))return this.pending.get(planId);
    const run=this.drive(planId).catch(error=>{
      const runtime=this.repository.runtime(planId);
      const row=this.store.selectOne('SELECT task_id FROM execution_checklist_plans WHERE plan_id=?',[planId]);
      const plan=row&&this.checklists.read(row.task_id,{planId});
      if(runtime&&plan&&runtime.pauseReason!=='user'&&runtime.state!=='cancelled')this.update(plan,{...runtime,state:'needs_attention',reason:error.message});
      throw error;
    }).finally(()=>this.pending.delete(planId));this.pending.set(planId,run);return run;
  }
  async drive(planId) {
    let runtime=this.repository.runtime(planId);
    if(!runtime?.enabled)return null;
    const row=this.store.selectOne('SELECT task_id FROM execution_checklist_plans WHERE plan_id=?',[planId]);
    const plan=row&&this.checklists.read(row.task_id,{planId});if(!plan)return null;
    const owner=this.owner(plan);
    this.coordinator?.shadow?.decisions?.reconcilePlan(plan);
    let delivered=false;
    for(const step of plan.steps)if(step.assignment&&step.status!=='completed'){
      const child=step.assignment.taskId??this.store.selectOne('SELECT target_task_id FROM task_coordination_dispatches WHERE dispatch_id=?',[step.assignment.dispatchId])?.target_task_id;
      const delivery=child&&this.store.selectOne("SELECT operation_id FROM child_task_delivery_operations WHERE child_task_id=? AND parent_task_id=? AND state='completed' AND created_at>=? ORDER BY updated_at DESC LIMIT 1",[child,plan.taskId,step.assignment.assignedAt??plan.createdAt]);
      if(delivery&&(step.assignment.executionRevision??0)===(step.executionRevision??0)){step.status='completed';step.reason='已交付至父任务';step.completionEvidence={deliveryOperationId:delivery.operation_id};delivered=true;}
    }
    if(delivered){plan.revision++;this.checklists.save(plan);}
    const budget=this.budget?.read(runtime.instructionId);
    if(runtime.pauseReason==='budget'&&!budget?.paused)runtime={...runtime,state:'idle',pauseReason:null,lastNoProgress:null,lastCompletedKey:null};
    if(runtime.pauseReason!==this.repository.runtime(planId).pauseReason)this.repository.saveRuntime(planId,runtime);
    const waits=this.repository.waits(planId).map(wait=>({...wait,satisfied:this.resolveWait(wait)}));
    for(const wait of waits)if(wait.satisfied)this.repository.clearWait(planId,wait.stepId);
    if(waits.some(w=>w.satisfied)){runtime={...runtime,lastNoProgress:null,lastCompletedKey:null};this.repository.saveRuntime(planId,runtime);}
    const selection=selectChecklistWork({plan,runtime,operations:this.coverage(plan,runtime),waits,budgetPaused:budget?.paused===true});
    if(selection.kind==='progress_only')return selection;
    if(selection.kind==='execute') {
      // Native work and direct user input have priority. Its terminal callback
      // revisits the plan; no status-check model call or polling is introduced.
      const source=this.store.getLogicalSession(runtime.responsibleSessionId);
      const current=source&&this.store.getRunningAgentTaskForSession(source.legacySessionId);
      if(current||source&&this.store.listUnsettledSessionTurns(source.legacySessionId).length)return selection;
      let target=owner.route;
      if(owner.task.coordination_enabled===1||plan.steps.some(step=>step.assignment)) {
        const resolved=await this.coordinator?.shadow?.readyRecipient(plan.logicalSessionId);
        if(!resolved)throw fault('CHECKLIST_SHADOW_UNAVAILABLE','尚未恢复负责推进的汇总影子。');
        target=this.store.getLogicalSession(resolved.sessionId);
      }else if(source&&(!coordinationDelegation(this.store,source.logicalSessionId)||this.coordinator?.shadow?.forShadow(source.logicalSessionId)))target=source;
      const fresh=this.repository.runtime(planId);
      if(fresh.generation!==runtime.generation||fresh.pauseReason==='user')return null;
      const latest=this.checklists.read(plan.taskId,{planId});if(latest.revision!==plan.revision){this.changed(latest);return null;}
      if(this.store.getRunningAgentTaskForSession(target.legacySessionId)||this.store.listUnsettledSessionTurns(target.legacySessionId).length)return selection;
      const signature=progressKey(plan);
      if(runtime.lastNoProgress===signature&&runtime.lastCompletedKey===signature) {
        return this.update(plan,{...runtime,state:'needs_attention',reason:'连续执行未推进清单事项。请查看当前结果与阻塞；不会重复执行相同指令。',nextStepIds:selection.stepIds});
      }
      const sequence=(runtime.sequence??0)+1,id=`checklist-run:${planId}:${runtime.generation}:${sequence}`;
      this.store.runInTransaction(()=>{
        const live=this.repository.runtime(planId);if(live.generation!==runtime.generation||live.pauseReason==='user')return;
        const session=this.store.getSession(target.legacySessionId);
        const result=this.mailbox.enqueueExternalOperation({taskId:id,sessionId:session.id,agentId:session.agentId,kind:'user',priority:5,localVisibility:'status_only',
          text:`继续执行原指令的未完成清单。先读取 planId=${planId}，从事项 ${selection.stepIds.join('、')} 继续；更新实际完成情况。不要重复已完成的工作、测试或Git操作。若仍未完成，落实后续执行、具体依赖或真正的用户问题，不能只汇报便结束。`,
          source:{type:'mailbox_event',executionPlanId:planId,checklistContinuation:{planId,generation:runtime.generation,stepIds:selection.stepIds,stepRevisions:Object.fromEntries(plan.steps.map(s=>[s.stepId,s.executionRevision??0])),instructionId:runtime.instructionId,sourceOperationId:runtime.sourceOperationId}}},
          {sourceType:'system',authorization:{sourceId:id,purpose:'checklist_continuation',ownerLogicalSessionId:target.logicalSessionId,planId,generation:runtime.generation}});
        this.repository.saveRuntime(planId,{...runtime,state:'queued',operationId:result.task.taskId,responsibleSessionId:target.logicalSessionId,sequence,nextStepIds:selection.stepIds,queuedProgressKey:signature,reason:null});
        this.mailbox.wakeAfterCommit(target.legacySessionId,result.task.taskId);
      });
      return this.publish(plan);
    }
    const state={complete:'completed',covered:'running',waiting_user:'waiting_user',waiting_dependency:'waiting_dependency',paused_user:'paused_user',paused_budget:'paused_budget',needs_attention:'needs_attention'}[selection.kind]??runtime.state;
    const old=this.repository.runtime(planId);
    const updated={...old,state,reason:selection.reason??null,nextStepIds:selection.stepIds,
      ...(state==='paused_budget'?{pauseReason:'budget'}:{})};
    const finalizing=state==='completed'&&!old.finalized;if(finalizing)updated.finalized=true;
    let result,notice;
    this.store.runInTransaction(()=>{
      result=this.update(plan,updated);
      if(finalizing){
        const operation=updated.operationId&&this.store.getAgentTask(updated.operationId);
        const visible=operation?.sessionId===owner.session.id&&operation.targetTurnId&&this.store.selectOne("SELECT 1 FROM session_items WHERE session_id=? AND turn_id=? AND type='agentMessage' AND COALESCE(presentation_role,'') NOT IN ('commentary','reasoning') LIMIT 1",[owner.session.id,operation.targetTurnId]);
        if(!visible)notice=this.notice(plan,'delivery','本轮清单已全部完成。交付与验证结果请查看任务进展。',updated.generation);
      }
    });
    if(notice)this.emitEvent('SessionCoordinationMilestone',{turnId:notice.id,item:notice,hasAgentMessage:true},{sessionId:owner.session.id});
    if(finalizing)this.emitEvent('ExecutionChecklistCompleted',{taskId:plan.taskId,planId},{sessionId:owner.session.id});
    return result;
  }
  update(plan,runtime) {
    const old=this.repository.runtime(plan.planId);
    if(JSON.stringify(old)===JSON.stringify(runtime))return null;
    this.repository.saveRuntime(plan.planId,runtime);
    if(runtime.state==='needs_attention'&&(old?.state!==runtime.state||old?.reason!==runtime.reason)){
      const item=this.notice(plan,'failure',runtime.reason??'当前执行需要处理，请查看执行清单。',runtime.generation);
      const route=this.store.getLogicalSession(plan.logicalSessionId);
      if(item)this.emitEvent('SessionCoordinationMilestone',{turnId:item.id,item,hasAgentMessage:false},{sessionId:route?.legacySessionId});
    }
    return this.publish(plan);
  }
  notice(plan,kind,text,generation){
    const route=this.store.getLogicalSession(plan.logicalSessionId);if(!route?.legacySessionId)return null;
    const id=`checklist-notice:${plan.planId}:${kind}:${generation}`;
    const createdAt=this.store.getSessionItem(route.legacySessionId,id)?.createdAt??new Date().toISOString();
    const item={id,turnId:id,type:'agentMessage',presentationRole:'final_answer',text,status:'completed',turnStatus:'completed',createdAt,
      rawMetadataJSON:JSON.stringify({coordinationEvent:{kind,batchId:plan.planId,instructionId:plan.instructionId}})};
    this.store.upsertTimelineItemProjection(route.legacySessionId,item);return item;
  }
  publish(plan) {
    this.checklists.save(plan);this.checklists.publish(plan);this.coordinator?.progress?.refreshGroup(plan.planId);return this.checklists.display(plan);
  }
  validate(row,authorization) {
    const operation=this.store.getAgentTask(row.operation_id),link=operation?.source?.checklistContinuation;
    const runtime=link&&this.repository.runtime(link.planId),plan=link&&this.store.selectOne('SELECT task_id FROM execution_checklist_plans WHERE plan_id=?',[link.planId]);
    const logical=this.store.getLogicalSessionByLegacySessionId(operation?.sessionId);
    if(!runtime||!plan||!runtime.enabled||runtime.generation!==link.generation||runtime.pauseReason==='user'||runtime.operationId!==operation.taskId
      ||authorization.planId!==link.planId||authorization.generation!==link.generation||logical?.logicalSessionId!==row.recipient_session_id)
      throw fault('CHECKLIST_CONTINUATION_RETIRED','原清单续作已暂停、被替换或会话发生变化。');
    const current=this.checklists.read(plan.task_id,{planId:link.planId});this.owner(current);
    if(!link.stepIds.some(id=>current.steps.some(s=>s.stepId===id&&s.status!=='completed'&&(s.executionRevision??0)===(link.stepRevisions?.[id]??0))))throw fault('CHECKLIST_CONTINUATION_RETIRED','原续作事项已完成或定义已更新。');
  }
  onTurnSettled({event,session}) {
    if(this.readOnly)return;
    const route=this.store.getLogicalSessionByLegacySessionId(session.id);if(!route)return;
    for(const plan of this.repository.activeForSession(route.logicalSessionId)) {
      const runtime=this.repository.runtime(plan.planId),operation=runtime.operationId&&this.store.getAgentTask(runtime.operationId);
      if(event.type==='turn.cancelled'&&(runtime.pauseReason==='user'||event.payload?.reason==='user')) {
        this.repository.saveRuntime(plan.planId,{...runtime,state:'paused_user',pauseReason:'user',generation:runtime.generation+1});
      }else if(operation&&operation.targetTurnId===event.turnId) {
        const key=progressKey(plan),noProgress=key===runtime.queuedProgressKey;
        this.repository.saveRuntime(plan.planId,{...runtime,state:'idle',lastCompletedKey:key,lastNoProgress:noProgress?key:null,
          ...(event.type==='turn.failed'?{state:'needs_attention',reason:'执行失败，请查看原执行记录；不会盲目重放可能已发生的操作。'}:{})});
      }
      this.changed(plan);
    }
    this.onDependencyChanged('operation',this.store.getAgentTaskForTurn(session.id,event.turnId)?.taskId);
    const task=session.taskId&&this.store.getTask(session.taskId);
    if(task?.parent_task_id)for(const row of this.store.selectAll(`SELECT p.body_json FROM execution_checklist_plans p JOIN execution_checklist_runtime r USING(plan_id)
      WHERE p.task_id=? AND r.enabled=1 AND r.state NOT IN ('completed','cancelled')`,[task.parent_task_id]))this.changed(JSON.parse(row.body_json));
  }
  onDependencyChanged(kind,id) {
    if(this.readOnly||!id)return;
    for(const row of this.store.selectAll('SELECT DISTINCT plan_id FROM execution_checklist_waits WHERE kind=? AND resource_id=?',[kind,id]))void this.reconcile(row.plan_id).catch(()=>{});
  }
  bindInstructionResume(instructionId,operation){
    const session=this.store.getSession(operation.sessionId),target=this.store.getLogicalSessionByLegacySessionId(operation.sessionId);
    if(!session||!target)return;
    const row=this.store.selectOne(`SELECT p.body_json FROM execution_checklist_plans p JOIN execution_checklist_runtime r USING(plan_id)
      WHERE p.task_id=? AND r.enabled=1 AND r.state NOT IN ('completed','cancelled') AND json_extract(r.body_json,'$.instructionId')=? ORDER BY p.updated_at DESC LIMIT 1`,[session.taskId,instructionId]);
    if(row)this.bindDecisionAnswer({planId:JSON.parse(row.body_json).planId},{operationId:operation.taskId},{sessionId:target.logicalSessionId});
  }
  retargetOperation(operationId,logicalId){
    for(const row of this.store.selectAll('SELECT plan_id FROM execution_checklist_runtime WHERE operation_id=?',[operationId])){
      const runtime=this.repository.runtime(row.plan_id);
      this.repository.saveRuntime(row.plan_id,{...runtime,responsibleSessionId:logicalId,
        ...(runtime.pauseReason!=='user'?{state:'queued',reason:null}:{})});
    }
  }
  bindDecisionAnswer(decision,message,target){
    if(!decision.planId)return;
    const runtime=this.repository.runtime(decision.planId),row=this.store.selectOne('SELECT task_id FROM execution_checklist_plans WHERE plan_id=?',[decision.planId]);
    const plan=row&&this.checklists.read(row.task_id,{planId:decision.planId});
    const mailbox=message.operationId?{operation_id:message.operationId}:this.store.selectOne('SELECT operation_id FROM session_mailbox_messages WHERE message_id=?',[message.messageId]);
    const operation=mailbox&&this.store.getAgentTask(mailbox.operation_id);
    if(!runtime?.enabled||!plan||!operation)return;
    const stepIds=(decision.stepIds?.length?decision.stepIds:plan.steps.filter(s=>s.status!=='completed').map(s=>s.stepId));
    this.store.updateAgentTask(operation.taskId,{localVisibility:'status_only',source:{...operation.source,executionPlanId:plan.planId,
      checklistContinuation:{planId:plan.planId,generation:runtime.generation,stepIds,stepRevisions:Object.fromEntries(plan.steps.map(s=>[s.stepId,s.executionRevision??0])),instructionId:runtime.instructionId,sourceOperationId:runtime.sourceOperationId}}});
    this.repository.saveRuntime(plan.planId,{...runtime,operationId:operation.taskId,responsibleSessionId:target.sessionId,
      state:runtime.pauseReason==='user'?'paused_user':'queued',queuedProgressKey:progressKey(plan),lastCompletedKey:null,lastNoProgress:null});
  }
  recordDeliveredChild(childId){
    if(this.readOnly)return;
    const delivery=this.store.selectOne("SELECT * FROM child_task_delivery_operations WHERE child_task_id=? AND state='completed' ORDER BY updated_at DESC LIMIT 1",[childId]);
    if(!delivery)return;
    const rows=this.store.selectAll('SELECT body_json FROM execution_checklist_plans WHERE task_id=?',[delivery.parent_task_id]);
    for(const row of rows){
      const plan=JSON.parse(row.body_json);let changed=false;
      for(const step of plan.steps){
        if(!step.assignment||step.status==='completed'||(step.assignment.executionRevision??0)!==(step.executionRevision??0)||delivery.created_at<(step.assignment.assignedAt??plan.createdAt))continue;
        const target=this.checklists.resolveAssignment(plan.taskId,step.assignment).taskId;
        if(target!==childId)continue;
        step.status='completed';step.reason='已交付至父任务';step.completionEvidence={deliveryOperationId:delivery.operation_id};changed=true;
      }
      if(changed){plan.revision++;this.checklists.save(plan);this.checklists.publish(plan);this.coordinator?.progress?.refreshGroup(plan.planId);}
    }
  }
  pauseTurn(sessionId,turnId){
    const route=this.store.getLogicalSessionByLegacySessionId(sessionId);if(!route)return;
    for(const plan of this.repository.activeForSession(route.logicalSessionId)){
      const runtime=this.repository.runtime(plan.planId),operation=runtime.operationId&&this.store.getAgentTask(runtime.operationId);
      if(plan.anchorTurnId!==turnId&&operation?.targetTurnId!==turnId)continue;
      this.repository.saveRuntime(plan.planId,{...runtime,state:'paused_user',pauseReason:'user',generation:runtime.generation+1});this.publish(plan);
    }
  }
  recover(after='') {
    if(this.readOnly)return;
    const page=this.repository.activePage(after);
    for(const plan of page){
      const runtime=this.repository.runtime(plan.planId),operation=runtime.operationId&&this.store.getAgentTask(runtime.operationId);
      const original=!runtime.operationId&&runtime.sourceOperationId&&this.store.getAgentTask(runtime.sourceOperationId);
      if(runtime.pauseReason==='user'||runtime.state==='cancelled')continue;
      if(operation&&['failed','cancelled','unknown'].includes(operation.status)||original&&['failed','cancelled','unknown'].includes(original.status))
        this.update(plan,{...runtime,state:'needs_attention',reason:'原执行已失败、中断或结果不确定。请先核对已有结果，再明确继续；不会自动重放。'});
      else this.changed(plan);
    }
    if(page.length===100)setImmediate(()=>this.recover(page.at(-1).planId));
  }
  onRuntimeEvent(type,payload){
    if(this.readOnly)return;
    if(type==='SessionCoordinationRequestChanged'&&payload.status==='cancelled'){
      const request=this.store.selectOne('SELECT operation_id FROM coordination_requests WHERE request_id=?',[payload.requestId]);
      if(request)for(const row of this.store.selectAll("SELECT p.body_json,r.body_json AS runtime_json FROM execution_checklist_plans p JOIN execution_checklist_runtime r USING(plan_id) WHERE r.enabled=1 AND json_extract(r.body_json,'$.sourceOperationId')=?",[request.operation_id])){
        const plan=JSON.parse(row.body_json),runtime=this.repository.runtime(plan.planId);
        this.update(plan,{...runtime,state:'paused_user',pauseReason:'user',generation:runtime.generation+1});
      }
    }
    if(type==='SessionCoordinationCompleted'||type==='AgentWorkFailed'||type==='AgentWorkCompleted'){
      const sessionId=payload.sessionId??payload.task?.sessionId;
      const turnId=payload.turnId??payload.task?.targetTurnId;
      const session=sessionId&&this.store.getSession(sessionId);
      const terminal=session&&turnId&&this.store.selectOne('SELECT execution_status FROM session_turns WHERE session_id=? AND turn_id=? ORDER BY started_at DESC LIMIT 1',[session.id,turnId]);
      const operation=payload.task??(sessionId&&turnId&&this.store.getAgentTaskForTurn(sessionId,turnId));
      if(payload.continuationOperationId)return;
      if(session&&turnId)this.onTurnSettled({session,event:{type:terminal?.execution_status==='failed'||operation?.status==='failed'||payload.item?.status==='failed'?'turn.failed':terminal?.execution_status==='cancelled'||operation?.status==='cancelled'?'turn.cancelled':'turn.completed',turnId,payload}});
      else if(operation?.taskId)this.onDependencyChanged('operation',operation.taskId);
    }
    if(type==='VerificationBudgetChanged')for(const row of this.store.selectAll("SELECT p.body_json FROM execution_checklist_plans p JOIN execution_checklist_runtime r USING(plan_id) WHERE r.enabled=1 AND r.state='paused_budget' AND json_extract(r.body_json,'$.instructionId')=?",[payload.instructionId??null]))this.changed(JSON.parse(row.body_json));
    if(type.startsWith('ChildTaskDelivery')||type==='TaskChanged'){
      const parent=payload.operation?.parentTaskId??payload.task?.parentTaskId??payload.parentTaskId??payload.entity?.parent_task_id??payload.entity?.parentTaskId??payload.delivery?.parentTaskId??this.store.getTask(payload.taskId??payload.entity?.id??'')?.parent_task_id;
      if(parent)for(const row of this.store.selectAll("SELECT p.body_json FROM execution_checklist_plans p JOIN execution_checklist_runtime r USING(plan_id) WHERE p.task_id=? AND r.enabled=1 AND r.state NOT IN ('completed','cancelled')",[parent]))this.changed(JSON.parse(row.body_json));
    }
  }
}
