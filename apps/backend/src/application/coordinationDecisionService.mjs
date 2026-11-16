import { randomUUID } from 'node:crypto';
import { validateInteractionAnswers } from './interactionInput.mjs';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code,statusCode:409});};
const meaningful=text=>typeof text==='string'&&text.trim().length>4&&!/^\/?(?:not[-_ ]?used|none|null|n\/?a|无|无需|不需要)[.!。\s]*$/iu.test(text.trim());
export class CoordinationDecisionService {
  constructor({store,shadow,mailbox,continuations=null,emitEvent=()=>{}}){Object.assign(this,{store,shadow,mailbox,continuations,emitEvent});}
  get(id){const row=this.store.selectOne('SELECT * FROM coordination_decisions WHERE decision_id=?',[id]);return row?{...JSON.parse(row.body_json),id:row.decision_id,status:row.status,revision:row.revision}:null;}
  pending(mainId,planId=null){return this.store.selectAll(`SELECT decision_id FROM coordination_decisions WHERE main_session_id=? AND status='pending' ${planId?'AND plan_id=?':''} ORDER BY created_at`,[mainId,...(planId?[planId]:[])]).map(row=>this.get(row.decision_id));}
  propose({mainId,shadowId,planId=null},input){
    if(!input)return null;
    const candidate=typeof input==='string'?{question:input,category:'legacy',topicKey:input.trim()}:input;
    if(!meaningful(candidate.question)||candidate.category==='engineering')return null;
    const delegation=this.shadow.assertDelegate(shadowId,'publish_reports');
    if(delegation.main_session_id!==mainId)fail('SHADOW_DECISION_SCOPE_INVALID','问题不属于当前汇总会话。');
    if(planId&&!this.store.selectOne('SELECT plan_id FROM execution_checklist_plans WHERE plan_id=? AND task_id=?',[planId,delegation.parent_task_id]))fail('SHADOW_DECISION_SCOPE_INVALID','问题不属于当前执行计划。');
    let old=candidate.existingDecisionId&&this.get(candidate.existingDecisionId);
    if(old&&!this.store.selectOne("SELECT 1 FROM coordination_decisions WHERE decision_id=? AND main_session_id=? AND status='pending'",[old.id,mainId]))old=null;
    let topicKey=JSON.stringify([planId??delegation.parent_task_id,(candidate.topicKey?.trim()||candidate.question).trim().replace(/^(?:仍需|请)\s*/u,'').replace(/\s+/gu,' ')]);
    old??=this.get(this.store.selectOne('SELECT decision_id FROM coordination_decisions WHERE main_session_id=? AND topic_key=?',[mainId,topicKey])?.decision_id);
    if(old?.status==='answered')return old;
    if(old)topicKey=old.topicKey;
    if([candidate.question,candidate.recommendation?`建议：${candidate.recommendation}`:'',candidate.impact?`影响：${candidate.impact}`:''].filter(Boolean).join('\n\n').length>2000)fail('SHADOW_DECISION_INVALID','请用简短问题、建议和影响描述需要用户选择的内容。');
    const now=new Date().toISOString();
    const options=(candidate.options??[]).slice(0,12).filter(o=>meaningful(o.label)||typeof o.label==='string'&&o.label.trim()).map((o,i)=>({id:o.id??`option:${i}`,label:o.label.trim(),description:o.description??''}));
    if(options.some(o=>o.label.length>200)||new Set(options.map(o=>o.label)).size!==options.length)fail('SHADOW_DECISION_INVALID','问题选项需要简短且不重复。');
    const decision={id:old?.id??`coordination-decision:${randomUUID()}`,planId,mainId,shadowId,revision:(old?.revision??0)+1,status:'pending',
      question:candidate.question.trim(),recommendation:candidate.recommendation??null,impact:candidate.impact??null,options,
      allowsText:candidate.allowsText!==false||!options.length,answer:null,stepIds:candidate.stepIds??[],topicKey,createdAt:old?.createdAt??now,
      questionRevision:(old?.questionRevision??0)+1};
    if(old&&JSON.stringify({...old,revision:0,questionRevision:0})===JSON.stringify({...decision,revision:0,questionRevision:0}))return old;
    this.store.db.run(`INSERT INTO coordination_decisions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(decision_id) DO UPDATE SET
      status=excluded.status,revision=excluded.revision,body_json=excluded.body_json,updated_at=excluded.updated_at`,
    [decision.id,mainId,planId,topicKey,'pending',decision.revision,JSON.stringify(decision),decision.createdAt,now]);
    this.publish(decision);return decision;
  }
  publish(decision){
    const main=this.store.getLogicalSession(decision.mainId);if(!main?.legacySessionId)return;
    const question=[decision.question,decision.recommendation?`建议：${decision.recommendation}`:'',decision.impact?`影响：${decision.impact}`:''].filter(Boolean).join('\n\n');
    const questionId=`${decision.id}:${decision.questionRevision??1}`;
    const userInput={schemaVersion:1,kind:'coordination_decision',isBlocking:false,responseMode:'answers',canCancel:false,
      questions:[{id:questionId,header:'需要你决定',question,isOther:decision.allowsText,isSecret:false,selectionMode:'single',required:true,
        ...(decision.options.length?{options:decision.options.map(o=>({label:o.label,description:o.description??''}))}:{})}],
      ...(decision.answer?{submittedAnswers:{[questionId]:[decision.answer]}}:{})};
    const item={id:decision.id,turnId:decision.id,type:'userInput',title:'需要你决定',text:question,status:decision.status==='answered'?'submitted':decision.status==='pending'?'pending':'cancelled',turnStatus:'completed',createdAt:decision.createdAt,
      userInput,rawMetadataJSON:JSON.stringify({executionMode:'coordination_decision',coordinationDecision:decision,userInput})};
    this.store.upsertTimelineItemProjection(main.legacySessionId,item);this.store.scheduleSave();
    this.emitEvent('SessionCoordinationMilestone',{turnId:item.id,item,hasAgentMessage:false},{sessionId:main.legacySessionId});
  }
  async answer(sessionId,id,answers,source){
    const decision=this.get(id),main=this.store.getLogicalSession(decision?.mainId);
    if(!decision||main?.legacySessionId!==sessionId)fail('SHADOW_DECISION_NOT_FOUND','待回答的问题不存在。');
    if(!['desktop','remote-client','user','local_user'].includes(source?.type))fail('SHADOW_DECISION_USER_REQUIRED','只有用户可以回答此问题。');
    if(decision.status==='answered')return {messageId:decision.answerMessageId,reused:true};
    const item=this.store.getSessionItem(sessionId,id);
    if(!validateInteractionAnswers(item?.userInput,answers))fail('INVALID_USER_INPUT_ANSWER','请回答卡片中的问题。');
    const target=await this.shadow.readyRecipient(decision.mainId),answer=answers[item.userInput.questions[0].id][0];
    const now=new Date().toISOString();let message;
      this.store.runInTransaction(()=>{
        const live=this.get(id);if(live.status==='answered'){decision.answerMessageId=live.answerMessageId;return;}
        if(live.questionRevision!==decision.questionRevision)fail('SHADOW_DECISION_CHANGED','问题已更新，请回答最新卡片。');
        message=this.mailbox.receiveEvent({recipientSessionId:target.sessionId,sourceType:'background',sourceId:id,intent:'response_required',priority:50,idempotencyKey:`decision-answer:${id}`,
          body:`用户已回答当前问题。继续受影响事项，不发送收件确认。\n问题：${decision.question}\n答复：${answer}`,
          authorization:{ownerLogicalSessionId:target.sessionId,sourceId:id,purpose:'checklist_decision_answer',decisionId:id}});
        this.continuations?.bindDecisionAnswer(decision,message,target);
        Object.assign(decision,{status:'answered',revision:live.revision+1,answer,answerMessageId:message.messageId,answeredBy:source.type,answerSourceTurnId:source.turnId??null});
        this.store.db.run("UPDATE coordination_decisions SET status='answered',revision=?,body_json=?,updated_at=? WHERE decision_id=?",[decision.revision,JSON.stringify(decision),now,id]);
        this.publish(decision);
      });
    this.continuations?.onDependencyChanged('decision',id);
    return {messageId:message?.messageId??decision.answerMessageId,reused:!message};
  }
  reconcilePlan(plan){
    for(const decision of this.pending(plan.logicalSessionId,plan.planId)){
      if(!decision.stepIds?.length||decision.stepIds.some(id=>plan.steps.some(s=>s.stepId===id&&s.status!=='completed')))continue;
      const updated={...decision,status:'superseded',revision:decision.revision+1};
      this.store.db.run("UPDATE coordination_decisions SET status='superseded',revision=?,body_json=?,updated_at=? WHERE decision_id=? AND status='pending'",[updated.revision,JSON.stringify(updated),new Date().toISOString(),updated.id]);
      this.publish(updated);this.continuations?.onDependencyChanged('decision',updated.id);
    }
  }
  async recoverLegacy(mainId=null){
    let after='';
    while(this.store.db){
      const rows=this.store.selectAll(`SELECT * FROM coordination_shadow_reports WHERE report_id>? AND decision_json IS NOT NULL
        AND json_extract(decision_json,'$.legacyMigration') IS NULL ${mainId?'AND main_session_id=?':''} ORDER BY report_id LIMIT 100`,[after,...(mainId?[mainId]:[])]);
      if(!rows.length)return;
      for(const row of rows){
        let old;try{old=JSON.parse(row.decision_json);}catch{continue;}
        const shadow=this.shadow.forMain?.(row.main_session_id),main=this.store.getLogicalSession(row.main_session_id);
        let decision=null;
        if(meaningful(old?.question)&&!old.answerMessageId&&shadow?.requirement_revision===row.requirement_revision){
          // Missing delegation remains historical until its exact owner recovers.
          if(!shadow.shadow_session_id||shadow.state!=='ready')continue;
          try{decision=this.propose({mainId:row.main_session_id,shadowId:shadow.shadow_session_id},{question:old.question,category:'legacy',topicKey:old.question});}
          catch{continue;}
        }
        this.store.db.run('UPDATE coordination_shadow_reports SET decision_json=? WHERE report_id=?',[JSON.stringify({...old,legacyMigration:decision?.id??'historical'}),row.report_id]);
        const item=main&&this.store.getSessionItem(main.legacySessionId,row.report_id);
        if(item){let raw={};try{raw=JSON.parse(item.rawMetadataJSON??'{}');}catch{}
          this.store.upsertTimelineItemProjection(main.legacySessionId,{...item,coordinationEvent:{...raw.coordinationEvent,kind:'summary'},rawMetadataJSON:JSON.stringify({...raw,coordinationEvent:{...raw.coordinationEvent,kind:'summary'},decision:null})});
        }
      }
      this.store.scheduleSave();after=rows.at(-1).report_id;
      if(rows.length<100)return;await new Promise(r=>setImmediate(r));
    }
  }
  validate(row,authorization){
    const decision=this.get(authorization.decisionId);
    if(!decision||decision.status!=='answered'||row.source_id!==decision.id)this.invalid();
    this.shadow.assertRecipient(row,decision.mainId);
    const operation=this.store.getAgentTask(row.operation_id),link=operation?.source?.checklistContinuation;
    if(link)this.continuations?.validate(row,{...authorization,planId:link.planId,generation:link.generation});
  }
  invalid(){fail('SHADOW_DECISION_SCOPE_INVALID','决策答复已失效。');}
}
