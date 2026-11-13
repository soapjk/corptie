import { randomUUID } from 'node:crypto';
import { projectCoordinationAssignment, projectCoordinationProgress } from './coordinationProgressProjection.mjs';
const instances=new WeakMap();
const fail=()=>{throw Object.assign(new Error('Coordination progress is outside this Session.'),{code:'COORDINATION_PROGRESS_NOT_FOUND',statusCode:404});};
export function coordinationProgressFor(store){
  let service=instances.get(store);if(!service){service=new CoordinationProgressService(store);instances.set(store,service);}return service;
}
export class CoordinationProgressService {
  constructor(store){this.store=store;this.pending=new Set();}
  batch(id){return this.store.selectOne('SELECT * FROM coordination_progress_batches WHERE batch_id=?',[id]);}
  latest(parentTaskId){const row=this.store.selectOne('SELECT snapshot_json FROM coordination_progress_batches WHERE parent_task_id=? AND snapshot_json IS NOT NULL ORDER BY created_at DESC,batch_id DESC LIMIT 1',[parentTaskId]);const snapshot=row?JSON.parse(row.snapshot_json):null;return snapshot?.total>0?snapshot:null;}
  ensure(scope,sourceTurnId,batchId=null){
    if(batchId){const old=this.batch(batchId);if(!old||old.parent_task_id!==scope.parent.id||old.source_session_id!==scope.logicalSessionId)fail();return old;}
    const old=this.store.selectOne('SELECT * FROM coordination_progress_batches WHERE source_session_id=? AND source_turn_id=?',[scope.logicalSessionId,sourceTurnId]);
    if(old)return old;
    const id=`progress:${randomUUID()}`,now=new Date().toISOString();
    this.store.db.run('INSERT INTO coordination_progress_batches(batch_id,parent_task_id,source_session_id,source_turn_id,created_at) VALUES(?,?,?,?,?)',[id,scope.parent.id,scope.logicalSessionId,sourceTurnId,now]);
    return this.batch(id);
  }
  attach(batch,row){
    // One assignment per child in a batch; pending creations use their durable dispatch identity.
    const assignmentId=row.target_task_id ?? row.dispatch_id;
    const old=row.target_task_id && this.store.selectOne('SELECT a.assignment_id FROM coordination_progress_assignments a LEFT JOIN task_coordination_dispatches d ON d.dispatch_id=a.dispatch_id WHERE a.batch_id=? AND (a.task_id=? OR d.target_task_id=?)',[batch.batch_id,row.target_task_id,row.target_task_id]);
    this.store.db.run(`INSERT INTO coordination_progress_assignments(batch_id,assignment_id,dispatch_id,task_id,created_at)
      VALUES(?,?,?,?,?) ON CONFLICT(batch_id,assignment_id) DO UPDATE SET
      summary=CASE WHEN dispatch_id<>excluded.dispatch_id THEN '' ELSE summary END,
      report_message_id=CASE WHEN dispatch_id<>excluded.dispatch_id THEN NULL ELSE report_message_id END,dispatch_id=excluded.dispatch_id`,[batch.batch_id,old?.assignment_id??assignmentId,row.dispatch_id,row.target_task_id,batch.created_at]);
    this.store.db.run('UPDATE task_coordination_dispatches SET progress_batch_id=COALESCE(progress_batch_id,?),source_turn_id=COALESCE(source_turn_id,?) WHERE dispatch_id=?',[batch.batch_id,batch.source_turn_id,row.dispatch_id]);
    this.schedule(batch.batch_id);
  }
  scheduleDispatch(id){for(const row of this.store.selectAll('SELECT batch_id FROM coordination_progress_assignments WHERE dispatch_id=?',[id]))this.schedule(row.batch_id);}
  schedule(batchId){if(this.pending.has(batchId))return;this.pending.add(batchId);setImmediate(()=>{this.pending.delete(batchId);if(!this.store.db)return;try{this.refresh(batchId);}catch(error){console.warn('[coordination-progress]',error.code??error.message);}});}
  facts(batch,offset=null){
    return this.store.selectAll(`SELECT a.*,d.status AS dispatch_state,d.target_task_id,d.error_message,d.error_code,d.operation_id,d.updated_at,
      t.title,t.current_session_id,t.lifecycle_state,s.status AS session_status,
      json_extract(d.request_json,'$.creation.title') AS requested_title,
      (SELECT state FROM child_task_delivery_operations delivery WHERE delivery.child_task_id=COALESCE(d.target_task_id,a.task_id)
        AND delivery.created_at>=COALESCE(d.created_at,a.created_at) ORDER BY delivery.created_at DESC LIMIT 1) AS delivery_state
      FROM coordination_progress_assignments a LEFT JOIN task_coordination_dispatches d ON d.dispatch_id=a.dispatch_id
      LEFT JOIN tasks t ON t.id=COALESCE(d.target_task_id,a.task_id) LEFT JOIN sessions s ON s.id=t.current_session_id
      WHERE a.batch_id=? AND (COALESCE(d.target_task_id,a.task_id) IS NULL OR (t.id IS NOT NULL AND t.lifecycle_state<>'done' AND COALESCE(t.archived,0)=0)) ORDER BY a.assignment_id LIMIT ? OFFSET ?`,[batch.batch_id,offset===null?10001:21,offset??0]).map(row=>({
      preparedState:row.state_json,assignmentId:row.assignment_id,taskId:row.target_task_id??row.task_id,sessionId:row.current_session_id,
      title:row.title??row.requested_title??'准备子任务',dispatchState:row.dispatch_state??(row.lifecycle_state==='done'?'completed':row.session_status),
      executionState:row.session_status,waitingInput:row.session_status==='blocked' && (!row.dispatch_state || row.dispatch_state==='running'),
      inconsistent:row.dispatch_state==='running' && ['complete','completed','failed','cancelled'].includes(row.session_status),
      deliveryVerified:row.delivery_state==='completed',acceptanceVerified:row.delivery_state==='completed'&&row.lifecycle_state==='done',
      summary:row.summary,reason:['completed','queued','running'].includes(row.dispatch_state)?'':row.error_message??'',
      reportMessageId:row.report_message_id,updatedAt:row.updated_at??row.created_at
    }));
  }
  refresh(batchId){
    const batch=this.batch(batchId);if(!batch)return null;
    const route=this.store.getLogicalSession(batch.source_session_id),session=route&&this.store.getSession(route.legacySessionId);
    if(!session||session.archived||session.deletedAt||session.taskId!==batch.parent_task_id)return null;
    const facts=this.facts(batch);
    const updatedAt=facts.reduce((value,row)=>row.updatedAt>value?row.updatedAt:value,batch.created_at);
    const snapshot=projectCoordinationProgress({batchId,parentSessionId:batch.source_session_id,revision:batch.revision,updatedAt,assignments:facts,focus:batch.focus,decision:batch.decision});
    let preparedChanged=false;
    for(const fact of facts){const data=JSON.stringify(projectCoordinationAssignment(fact));if(data!==fact.preparedState){
      this.store.db.run('UPDATE coordination_progress_assignments SET state_json=?,task_id=COALESCE(task_id,?) WHERE batch_id=? AND assignment_id=?',[data,fact.taskId,batchId,fact.assignmentId]);preparedChanged=true;}}
    if(snapshot.total===0)this.store.removeItem(session.id,`coordination-progress:${batchId}`);
    if(batch.snapshot_json===JSON.stringify(snapshot)){if(preparedChanged)this.store.scheduleSave();return snapshot;}
    snapshot.revision++;
    this.store.runInTransaction(()=>{
      this.store.db.run('UPDATE coordination_progress_batches SET revision=?,snapshot_json=? WHERE batch_id=?',[snapshot.revision,JSON.stringify(snapshot),batchId]);
      const text=['子任务进展',...snapshot.items.map(item=>`${item.title} · ${item.state}${item.summary?'：'+item.summary:''}`),snapshot.focus,snapshot.decision].filter(Boolean).join('\n');
      const item={id:`coordination-progress:${batchId}`,turnId:`coordination-progress:${batchId}`,type:'coordinationProgress',title:'子任务进展',text,
        presentationRole:'system_event',status:'completed',turnStatus:'completed',createdAt:batch.created_at,coordinationProgress:snapshot};
      if(snapshot.total>0)this.store.upsertTimelineItemProjection(session.id,{...item,rawMetadataJSON:JSON.stringify(item)});
    });
    const stage=snapshot.total>0&&snapshot.counts.accepted===snapshot.total?'accepted'
      :snapshot.total>0&&snapshot.counts.delivered+snapshot.counts.accepted===snapshot.total?'delivered':null;
    if(stage)this.milestone(batchId,stage,stage==='accepted'?'本批子任务已有验收依据；父任务整体状态以集成验收为准。':'本批子任务已交付，可以安排整体集成验证；交付不代表整体验收通过。');
    this.store.touchSessionProjectionDependency?.(session.id);this.store.scheduleSave();this.onChanged?.(batch.parent_task_id);return snapshot;
  }
  milestone(batchId,key,text){
    const batch=this.batch(batchId),seen=JSON.parse(batch.milestones_json??'[]');if(seen.includes(key))return false;
    const route=this.store.getLogicalSession(batch.source_session_id);if(!route)return false;
    let item;
    this.store.runInTransaction(()=>{
      item={id:`coordination-summary:${batchId}:${seen.length}`,turnId:`coordination-summary:${batchId}:${seen.length}`,
        type:'agentMessage',presentationRole:'final_answer',title:'子任务阶段总结',text,status:'completed',turnStatus:'completed',createdAt:new Date().toISOString()};
      this.store.upsertTimelineItemProjection(route.legacySessionId,{...item,rawMetadataJSON:JSON.stringify({...item,progressBatchId:batchId})});
      this.store.db.run('UPDATE coordination_progress_batches SET milestones_json=? WHERE batch_id=?',[JSON.stringify([...new Set([...seen.filter(value=>value==='accepted'||value==='delivered'),...seen.filter(value=>value!=='accepted'&&value!=='delivered').slice(-97),key])]),batchId]);
    });this.publishMilestone?.(route.legacySessionId,item);return true;
  }
  annotate(batchId,{updates=[],focus='',decision='',reportDispatchIds=null}={}){
    const batch=this.batch(batchId);if(!batch)fail();
    this.store.runInTransaction(()=>{
      for(const update of updates){
        if(reportDispatchIds && !this.store.selectOne(`SELECT 1 FROM coordination_progress_assignments a
          JOIN task_coordination_dispatches d ON d.dispatch_id=a.dispatch_id
          WHERE a.batch_id=? AND COALESCE(d.target_task_id,a.task_id)=? AND a.dispatch_id IN (SELECT value FROM json_each(?))`,
          [batchId,update.taskId,JSON.stringify(reportDispatchIds)]))continue;
        this.store.db.run(`UPDATE coordination_progress_assignments SET summary=? WHERE batch_id=?
          AND (task_id=? OR dispatch_id IN (SELECT dispatch_id FROM task_coordination_dispatches WHERE target_task_id=?))`,[String(update.summary).slice(0,240),batchId,update.taskId,update.taskId]);
      }
      this.store.db.run('UPDATE coordination_progress_batches SET focus=?,decision=? WHERE batch_id=?',[focus.slice(0,500),decision.slice(0,500),batchId]);
    });return this.refresh(batchId);
  }
  correlateReports(dispatchId,reportMessageId){
    this.store.db.run('UPDATE coordination_progress_assignments SET report_message_id=? WHERE dispatch_id=?',[reportMessageId,dispatchId]);this.scheduleDispatch(dispatchId);
  }
  scheduleTask(taskId){for(const row of this.store.selectAll('SELECT DISTINCT a.batch_id FROM coordination_progress_assignments a LEFT JOIN task_coordination_dispatches d ON d.dispatch_id=a.dispatch_id WHERE COALESCE(d.target_task_id,a.task_id)=?',[taskId]))this.schedule(row.batch_id);}
  adoptManualTask(taskId){
    const task=this.store.getTask(taskId);if(!task?.parent_task_id)return;
    const origin=this.store.getTaskCreationOrigin?.(taskId);
    if(origin?.operationId?.startsWith('coordination:dispatch:'))return;
    if(this.store.selectOne('SELECT 1 FROM coordination_progress_assignments WHERE task_id=?',[taskId]))return;
    const parent=this.store.getTask(task.parent_task_id),route=parent?.current_session_id&&this.store.getLogicalSessionByLegacySessionId(parent.current_session_id);
    const session=route&&this.store.getSession(route.legacySessionId);if(!session||session.archived||parent.work_id!==task.work_id)return;
    const sourceTurnId=origin?.creationContextMessageId??session.external?.activeTurnId??`manual:${taskId}`;
    const batch=this.ensure({parent,logicalSessionId:route.logicalSessionId},sourceTurnId);
    this.store.db.run('INSERT OR IGNORE INTO coordination_progress_assignments(batch_id,assignment_id,task_id,created_at) VALUES(?,?,?,?)',[batch.batch_id,taskId,taskId,task.created_at]);
    this.schedule(batch.batch_id);
  }
  reportDispatches(source){
    if(source?.type!=='mailbox_event'||!['parent_report','shadow_report'].includes(source.coordinationPurpose))return null;
    return source.mailboxMessageId
      ? this.store.selectAll('SELECT dispatch_id FROM task_coordination_dispatches WHERE report_message_id=?',[source.mailboxMessageId]).map(row=>row.dispatch_id)
      : typeof source.coordinationDispatchId==='string'?[source.coordinationDispatchId]:[];
  }
  reportBatch(source,parentSessionId){
    if(source?.type==='mailbox_event' && ['parent_report','shadow_report'].includes(source.coordinationPurpose) && typeof source.coordinationDispatchId==='string'){
      const row=this.store.selectOne('SELECT progress_batch_id,source_session_id FROM task_coordination_dispatches WHERE dispatch_id=?',[source.coordinationDispatchId]);
      return row?.source_session_id===parentSessionId?row.progress_batch_id??null:null;
    }
    if(source?.type==='session_channel' && source.senderSessionId){
      const route=this.store.getLogicalSession(source.senderSessionId),sender=route&&this.store.getSession(route.legacySessionId);
      if(!sender?.taskId)return null;
      const child=this.store.getTask(sender.taskId);
      const row=this.store.selectOne(`SELECT b.batch_id,b.parent_task_id FROM coordination_progress_batches b
        JOIN coordination_progress_assignments a ON a.batch_id=b.batch_id WHERE b.source_session_id=? AND a.task_id=?
        ORDER BY b.created_at DESC,b.batch_id DESC LIMIT 1`,[parentSessionId,child?.id??'']);
      return row && row.parent_task_id===child?.parent_task_id ? row.batch_id:null;
    }
    return null;
  }
  report(sessionId,batchId,assignmentId,offset=0){
    this.page(sessionId,batchId,0); // Reuse the exact parent Session scope check.
    if(!Number.isInteger(offset)||offset<0||offset>1000000)fail();
    const row=this.store.selectOne(`SELECT a.report_message_id,COALESCE(d.target_task_id,a.task_id) AS task_id
      FROM coordination_progress_assignments a LEFT JOIN task_coordination_dispatches d ON d.dispatch_id=a.dispatch_id
      WHERE a.batch_id=? AND a.assignment_id=?`,[batchId,assignmentId]);
    if(!row?.report_message_id)fail();
    const message=this.store.selectOne(`SELECT i.session_id,i.id FROM session_items i JOIN sessions s ON s.id=i.session_id
      WHERE i.id=? AND s.task_id=? AND i.type='agentMessage' AND COALESCE(i.presentation_role,'') NOT IN ('commentary','reasoning') LIMIT 1`,[row.report_message_id,row.task_id]);
    if(!message)fail();
    const chunk=this.store.readContextMessageChunk(message.session_id,message.id,offset,1600);if(!chunk)fail();
    const next=offset+Array.from(chunk.text).length;
    return {text:chunk.text,nextOffset:next<chunk.totalCharacters?next:null};
  }
  page(sessionId,batchId,offset=0){
    const route=this.store.getLogicalSession(sessionId)??this.store.getLogicalSessionByLegacySessionId(sessionId);
    const batch=this.batch(batchId);if(!batch||batch.source_session_id!==route?.logicalSessionId||route.archived)fail();
    const session=this.store.getSession(route.legacySessionId);if(!session||session.archived||session.deletedAt||session.taskId!==batch.parent_task_id)fail();
    if(!Number.isInteger(offset)||offset<0||offset>10000)fail();
    // Bounded persisted authority rows, not conversation-history scans.
    const rows=this.facts(batch,offset).map(projectCoordinationAssignment);
    return {items:rows.slice(0,20),nextOffset:rows.length>20?offset+20:null};
  }
}
