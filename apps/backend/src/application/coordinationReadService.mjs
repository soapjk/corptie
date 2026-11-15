import { coordinationDelegation } from "../domain/coordinationDelegation.mjs";
const tools=["list_children","read_task","list_sessions","read_messages","read_message","read_dispatches","read_execution","read_mailbox","read_resource","search_resources"];
export const COORDINATION_READ_QUERY_SCHEMA={type:"object",additionalProperties:false,
  required:["tool","taskId","sessionId","query","cursor","messageId","offset","limit","targetType","targetId","section"],properties:{
    tool:{enum:tools},taskId:{type:["string","null"],maxLength:512},sessionId:{type:["string","null"],maxLength:512},
    query:{type:["string","null"],maxLength:200},cursor:{type:["string","null"],maxLength:2000},
    messageId:{type:["string","null"],maxLength:512},offset:{type:"integer",minimum:0,maximum:1000000},
    targetType:{enum:["work","task","session","agent","artifact",null]},targetId:{type:["string","null"],maxLength:512},
    section:{type:["string","null"],maxLength:32},
    limit:{type:"integer",minimum:1,maximum:12}}};
export const COORDINATION_READ_TOOLS=tools;
const fail=code=>{throw Object.assign(new Error(code),{code,statusCode:403});};
function position(value){
  if(!value)return null;
  let p;try{p=JSON.parse(value);}catch{fail("COORDINATION_READ_CURSOR_INVALID");}
  if(!p || typeof p.id!=="string" || p.id.length>512 || typeof p.createdAt!=="string" || p.createdAt.length>64)fail("COORDINATION_READ_CURSOR_INVALID");
  return {id:p.id,createdAt:p.createdAt};
}
const page=(items,limit)=>({items:items.slice(0,limit),truncated:items.length>limit,
  nextCursor:items.length>limit ? JSON.stringify({id:items[limit-1].id,createdAt:items[limit-1].createdAt}):null});
const bounded=(value,n=2000)=>String(value??"").slice(0,n);

// Application-owned read port of the authenticated parent Session. It has no
// shell, Provider calls, lifecycle mutations, read acknowledgements or polling.
export class CoordinationReadService {
  constructor({store,mailbox,contextRead=null}){Object.assign(this,{store,mailbox,contextRead});}
  execute(reference,rootTaskId,input){
    const {source,route,root}=this.scope(reference,rootTaskId);
    if(!tools.includes(input.tool))fail("COORDINATION_READ_TOOL_UNSUPPORTED");
    if(input.tool==="read_resource" || input.tool==="search_resources") {
      if(!this.contextRead)fail("COORDINATION_RESOURCE_READ_UNAVAILABLE");
      return this.contextRead.execute({metadata:{sessionId:source.id,logicalSessionId:route.logicalSessionId},
        tool:input.tool==="read_resource" ? "corptie_context_read" : "corptie_context_search",
        arguments:input.tool==="read_resource" ? {target_type:input.targetType ?? "task",target_id:input.targetId ?? root.id,
          ...(input.section ? {section:input.section} : {}),...(input.messageId ? {item_id:input.messageId} : {}),
          ...(input.query ? {query:input.query} : {}),...(input.cursor ? {cursor:input.cursor} : {}),limit:Math.min(input.limit ?? 6,10)}
          : {target_work_id:input.targetId ?? root.work_id,...(input.query ? {query:input.query} : {}),
            ...(input.cursor ? {cursor:input.cursor} : {}),limit:Math.min(input.limit ?? 6,10)}});
    }
    const task=this.task(root,input.taskId??root.id);
    const limit=Math.max(1,Math.min(12,input.limit??6));
    const before=input.tool === "read_mailbox" ? null : position(input.cursor);
    let result;
    if(input.tool==="list_children"){
      const query=bounded(input.query,200).replaceAll("\\","\\\\").replaceAll("%","\\%").replaceAll("_","\\_");
      result=page(this.store.selectAll(`SELECT id,title,lifecycle_state AS state,execution_status AS executionStatus,
        creation_state AS creationState,current_session_id AS sessionId,archived,created_at AS createdAt
        FROM tasks WHERE parent_task_id=? AND work_id=? AND COALESCE(deletion_status,'')<>'deleted'
        ${query?"AND title LIKE ? ESCAPE '\\'":""}
        ${before?"AND (created_at < ? OR (created_at=? AND id<?))":""}
        ORDER BY created_at DESC,id DESC LIMIT ?`,[task.id,root.work_id,...(query?[`%${query}%`]:[]),
        ...(before?[before.createdAt,before.createdAt,before.id]:[]),limit+1]),limit);
    }else if(input.tool==="read_task"){
      result={task:{id:task.id,parentTaskId:task.parent_task_id??null,title:task.title,

        state:task.lifecycle_state,executionStatus:task.execution_status,creationState:task.creation_state,
        archived:Boolean(task.archived),deletionStatus:task.deletion_status,sessionId:task.current_session_id},
        truncated:false};
    }else if(input.tool==="read_execution"){
      const session=this.session(root,task,input.sessionId);
      result=this.executionSnapshot(task,session);
    }else if(input.tool==="list_sessions"){
      result=page(this.store.selectAll(`SELECT id,title,status,archived,created_at AS createdAt FROM sessions
        WHERE task_id=? AND work_id=? AND deleted_at IS NULL
        ${before?"AND (created_at < ? OR (created_at=? AND id<?))":""}
        ORDER BY created_at DESC,id DESC LIMIT ?`,[task.id,root.work_id,
        ...(before?[before.createdAt,before.createdAt,before.id]:[]),limit+1]),limit);
    }else if(input.tool==="read_dispatches"){
      result=page(this.store.selectAll(`SELECT dispatch_id AS id,target_task_id AS targetTaskId,status,error_code AS errorCode,
        progress_batch_id AS batchId,json_extract(request_json,'$.action') AS action,json_extract(request_json,'$.creation.title') AS title,
        substr(error_message,1,500) AS errorMessage,created_at AS createdAt,updated_at AS updatedAt
        FROM task_coordination_dispatches WHERE parent_task_id=? ${task.id!==root.id?"AND target_task_id=?":""}
        ${before?"AND (created_at < ? OR (created_at=? AND dispatch_id<?))":""}
        ORDER BY created_at DESC,dispatch_id DESC LIMIT ?`,[root.id,...(task.id!==root.id?[task.id]:[]),
        ...(before?[before.createdAt,before.createdAt,before.id]:[]),limit+1]),limit);
    }else{
      const session=this.session(root,task,input.sessionId);
      if(input.tool==="read_messages"){
        if(input.query?.trim()){
          const query=input.query.trim(),like=`%${query.replaceAll("\\","\\\\").replaceAll("%","\\%").replaceAll("_","\\_")}%`;
          // Return a snippet at the actual match, including hits beyond a long
          // message's initial excerpt. Selection is bounded in SQL.
          const items=this.store.selectAll(`SELECT id,turn_id AS turnId,type,created_at AS createdAt,
            max(0,instr(lower(text),lower(?))-301) AS offset,length(text) AS totalCharacters,
            substr(text,max(1,instr(lower(text),lower(?))-300),800) AS text
            FROM session_items WHERE session_id=? AND type IN ('userMessage','agentMessage')
            AND COALESCE(presentation_role,'') NOT IN ('commentary','reasoning') AND text LIKE ? ESCAPE '\\'
            ${before?"AND (created_at < ? OR (created_at=? AND id<?))":""}
            ORDER BY created_at DESC,id DESC LIMIT ?`,[query,query,session.id,like,
            ...(before?[before.createdAt,before.createdAt,before.id]:[]),limit+1]);
          result=page(items.map(item=>({...item,textTruncated:item.offset>0 || item.totalCharacters>Array.from(item.text).length})),limit);
        }else{
          const resultPage=this.store.readContextConversationPage(session.id,{before,limit});
          result={items:resultPage.items.map(item=>({...item,text:bounded(item.text,800),offset:0,
            textTruncated:item.textTruncated || item.text.length>800})),
            nextCursor:resultPage.nextCursor?JSON.stringify(resultPage.nextCursor):null,truncated:resultPage.hasMore};
        }
        result.sessionId=session.id;
      }else if(input.tool==="read_message"){
        if(!input.messageId)fail("COORDINATION_READ_MESSAGE_REQUIRED");
        // Leave room for IDs and metadata even when every codepoint is four UTF-8 bytes.
        const item=this.store.readContextMessageChunk(session.id,input.messageId,input.offset??0,1600);
        if(!item)fail("COORDINATION_READ_MESSAGE_NOT_FOUND");
        const nextOffset=(input.offset??0)+Array.from(item.text).length;
        result={sessionId:session.id,item,offset:input.offset??0,nextOffset:nextOffset<item.totalCharacters?nextOffset:null,
          truncated:nextOffset<item.totalCharacters};
      }else{
        if(!this.mailbox)fail("COORDINATION_MAILBOX_READ_UNAVAILABLE");
        // Mailbox cursors use sequence numbers instead of conversation positions.
        if(input.messageId){
          const value=this.mailbox.get(session.id,input.messageId),body=Array.from(value.body??value.preview??""),offset=input.offset??0;
          result={...value,body:body.slice(offset,offset+1600).join(""),offset,nextOffset:offset+1600<body.length?offset+1600:null,
            truncated:offset>0 || offset+1600<body.length};
        }else result=this.mailbox.rows(session.id,{filter:"all",limit,beforeCursor:input.cursor??undefined});
      }
    }
    const output={tool:input.tool,observedAt:new Date().toISOString(),referenceOnly:true,...result};
    return output;
  }
  scope(reference,rootTaskId) {
    const source=this.store.getSession(reference.sessionId),route=this.store.getLogicalSessionByLegacySessionId(reference.sessionId);
    const root=source?.taskId && this.store.getTask(source.taskId);
    if(!root || root.id!==rootTaskId || source.sessionKind!=="worker" || source.workId!==root.work_id
      || root.archived || root.deletion_status || source.archived || source.deletedAt || route?.archived
      || route?.activeBinding?.state!=="active" || route.activeBinding.bindingId!==reference.bindingId)fail("COORDINATION_READ_SCOPE_INVALID");
    if (root.current_session_id !== source.id && !coordinationDelegation(this.store, route.logicalSessionId)) fail("COORDINATION_READ_SCOPE_INVALID");
    return {source,route,root};
  }
  executionSnapshot(task,session) {
    const latest=this.store.selectOne("SELECT task_id FROM agent_operations WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",[session.id]);
    const operation=this.store.getRunningAgentTaskForSession(session.id) ?? (latest && this.store.getAgentTask(latest.task_id));
    const dispatch=operation && this.store.selectOne("SELECT * FROM task_coordination_dispatches WHERE operation_id=?",[operation.taskId]);
    const adopted=operation && this.store.selectOne("SELECT * FROM session_mailbox_messages WHERE operation_id=? AND disposition='adopted' AND adopted_turn_id IS NOT NULL",[operation.taskId]);
    const logical=this.store.getLogicalSessionByLegacySessionId(session.id);
    const turnId=adopted?.adopted_turn_id ?? operation?.targetTurnId ?? session.external?.activeTurnId ?? null;
    const bindingId=adopted?.adopted_binding_id ?? logical?.activeBinding?.bindingId;
    const turn=turnId && this.store.getSessionTurn(session.id,bindingId,turnId);
    const status=turn?.executionStatus ?? turn?.execution_status ?? (adopted ? "unknown" : operation?.status) ?? session.status;
    const final=turnId && this.store.selectOne(`SELECT id,substr(text,1,1200) AS text FROM session_items WHERE session_id=? AND turn_id=?
      AND type='agentMessage' AND COALESCE(presentation_role,'') NOT IN ('commentary','reasoning') ORDER BY created_at DESC,id DESC LIMIT 1`,[session.id,turnId]);
    const activity=turnId && this.store.selectOne(`SELECT id,type,title,substr(text,1,800) AS text,status,created_at FROM session_items
      WHERE session_id=? AND turn_id=? AND type IN ('commandExecution','toolExecution','mcpToolCall','customToolCall','webSearch')
      ORDER BY created_at DESC,id DESC LIMIT 1`,[session.id,turnId]);
    const acceptedAt=dispatch?.created_at ?? operation?.createdAt ?? null;
    const startedAt=turn?.startedAt ?? turn?.started_at ?? (adopted ? null : operation?.startedAt) ?? null;
    const endedAt=turn?.endedAt ?? turn?.ended_at ?? (adopted ? null : operation?.completedAt) ?? null;
    const observedAt=new Date().toISOString();
    const duration=(start,end)=>{const a=Date.parse(start),b=Date.parse(end);return Number.isFinite(a)&&Number.isFinite(b)&&b>=a?b-a:null;};
    const dispatchBlock=operation?.source?.dispatchBlock ?? null;
    return {taskId:task.id,sessionId:session.id,operationId:operation?.taskId??null,dispatchId:dispatch?.dispatch_id??null,
      turnId,status,targetOutcome:"not_assessed",acceptanceState:task.lifecycle_state,
      phase:['completed','failed','cancelled'].includes(status) ? status : dispatchBlock?.kind==='paused' ? 'paused' : dispatchBlock ? "waiting_dispatch" : ["queued","accepted"].includes(status) ? "queued" : status === "running" ? "executing" : status,
      timestamps:{acceptedAt,startedAt,endedAt,lastActivityAt:session.external?.lastOutputAt ?? activity?.created_at ?? operation?.updatedAt ?? null,observedAt},
      durations:{queueMs:duration(acceptedAt,startedAt),executionMs:duration(startedAt,endedAt ?? observedAt),totalMs:duration(acceptedAt,endedAt ?? observedAt)},
      currentOperation:activity ? {messageId:activity.id,type:activity.type,title:activity.title,excerpt:activity.text,status:activity.status} : null,
      evidenceGaps:[...(!startedAt?["execution_start_not_recorded"]:[]),...(!activity?["current_command_not_recorded"]:[]),"fine_grained_phase_timing_unavailable"],
      cancellation:operation?.executionEvidence?.cancellation??null,
      latestResult:final?{messageId:final.id,excerpt:final.text}:null,
      queueDepth:this.store.listQueuedAgentTasksForSession(session.id,100).length,dispatchBlock,
      instruction:"状态为running不能证明测试命令已启动。时间只来自记录，未知阶段不得推断。执行结束不代表目标完成；结果全文按messageId读取。"};
  }
  diagnostics(reference,rootTaskId) {
    const targets=this.store.selectAll(`SELECT target_task_id FROM task_coordination_dispatches WHERE parent_task_id=? AND target_task_id IS NOT NULL
      ORDER BY CASE WHEN status IN ('running','queued','preparing','waiting_dispatch','blocked') THEN 0 ELSE 1 END,created_at DESC LIMIT 20`,[rootTaskId]);
    const ids=[...new Set(targets.map(row=>row.target_task_id))];
    const snapshots=[];
    for(const id of ids){try{snapshots.push(this.execute(reference,rootTaskId,{tool:"read_execution",taskId:id}));}
      catch(error){snapshots.push({taskId:id,errorCode:error.code??"EXECUTION_DIAGNOSTICS_UNAVAILABLE"});}}
    return {items:snapshots,selection:"active_and_recent_dispatch_targets",hasMore:targets.length===20};
  }
  revisionFor(reference,rootTaskId,input) {
    const {root}=this.scope(reference,rootTaskId),task=this.task(root,input.taskId??rootTaskId);
    if(!task)fail("COORDINATION_READ_TASK_OUTSIDE_SCOPE");
    if(["read_execution","read_messages","read_message","read_mailbox"].includes(input.tool)) {
      const session=this.session(root,task,input.sessionId);
      const latest=this.store.selectOne("SELECT task_id,status,updated_at FROM agent_operations WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",[session.id]);
      const mailbox=input.tool==="read_mailbox" ? this.store.selectOne("SELECT MAX(sequence) AS sequence,MAX(updated_at) AS updatedAt FROM session_mailbox_messages WHERE recipient_session_id=?",[this.store.getLogicalSessionByLegacySessionId(session.id)?.logicalSessionId??session.id]):null;
      return JSON.stringify([session.status,session.updatedAt,latest,this.store.sessionTimelineRevision(session.id),mailbox]);
    }
    if(input.tool==="read_task")return JSON.stringify([task.id,task.revision,task.resource_version,task.lifecycle_state,task.execution_status,task.creation_state,task.current_session_id,task.archived,task.deletion_status]);
    return String(this.store.stateRevision());
  }
  task(root,id){
    const task=this.store.getTask(id);
    if(!task || task.work_id!==root.work_id)fail("COORDINATION_READ_TASK_OUTSIDE_SCOPE");
    let current=task;
    const seen=new Set();
    while(current.id!==root.id) {
      if(!current.parent_task_id || seen.has(current.id))fail("COORDINATION_READ_TASK_OUTSIDE_SCOPE");
      seen.add(current.id);current=this.store.getTask(current.parent_task_id);
      if(!current || current.work_id!==root.work_id)fail("COORDINATION_READ_TASK_OUTSIDE_SCOPE");
    }
    return task;
  }
  session(root,task,id){
    const route=id && this.store.getLogicalSession(id);
    const candidate=route?.legacySessionId ?? id ?? task.current_session_id;
    if(!candidate)fail("COORDINATION_READ_SESSION_OUTSIDE_SCOPE");
    const session=this.store.getSession(candidate);
    if(!session || session.workId!==root.work_id)fail("COORDINATION_READ_SESSION_OUTSIDE_SCOPE");
    const owner=this.task(root,session.taskId);
    if(task.id!==root.id && owner.id!==task.id)fail("COORDINATION_READ_SESSION_OUTSIDE_SCOPE");
    return session;
  }
}
