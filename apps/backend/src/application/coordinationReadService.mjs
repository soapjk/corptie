const tools=["list_children","read_task","list_sessions","read_messages","read_message","read_dispatches","read_execution","read_mailbox","read_resource","search_resources"];
export const COORDINATION_READ_QUERY_SCHEMA={type:"object",additionalProperties:false,
  required:["tool","taskId","sessionId","query","cursor","messageId","offset","limit"],properties:{
    tool:{enum:tools},taskId:{type:["string","null"],maxLength:512},sessionId:{type:["string","null"],maxLength:512},
    query:{type:["string","null"],maxLength:200},cursor:{type:["string","null"],maxLength:2000},
    messageId:{type:["string","null"],maxLength:512},offset:{type:"integer",minimum:0,maximum:1000000},
    targetType:{enum:["work","task","session","agent","artifact"]},targetId:{type:"string",maxLength:512},
    section:{type:"string",maxLength:32},
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
    const source=this.store.getSession(reference.sessionId),route=this.store.getLogicalSessionByLegacySessionId(reference.sessionId);
    const root=source?.taskId && this.store.getTask(source.taskId);
    if(!root || root.id!==rootTaskId || source.sessionKind!=="worker" || source.workId!==root.work_id
      || root.archived || root.deletion_status || source.archived || source.deletedAt || route?.archived
      || route?.activeBinding?.state!=="active" || route.activeBinding.bindingId!==reference.bindingId)fail("COORDINATION_READ_SCOPE_INVALID");
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
        description:bounded(task.description,1000),acceptanceCriteria:bounded(task.acceptance_criteria,1000),
        state:task.lifecycle_state,executionStatus:task.execution_status,creationState:task.creation_state,
        archived:Boolean(task.archived),deletionStatus:task.deletion_status,sessionId:task.current_session_id},
        truncated:String(task.description??"").length>1000 || String(task.acceptance_criteria??"").length>1000};
    }else if(input.tool==="read_execution"){
      const session=this.session(root,task,input.sessionId);
      const operation=this.store.getRunningAgentTaskForSession(session.id)
        ?? this.store.listAgentTasksForSession(session.id).at(-1) ?? null;
      const dispatch=operation && this.store.selectOne("SELECT * FROM task_coordination_dispatches WHERE operation_id=?",[operation.taskId]);
      const adopted=operation && this.store.selectOne("SELECT * FROM session_mailbox_messages WHERE operation_id=? AND disposition='adopted' AND adopted_turn_id IS NOT NULL",[operation.taskId]);
      const logical=this.store.getLogicalSessionByLegacySessionId(session.id);
      const turnId=adopted?.adopted_turn_id ?? operation?.targetTurnId ?? session.external?.activeTurnId ?? null;
      const bindingId=adopted?.adopted_binding_id ?? logical?.activeBinding?.bindingId;
      const turn=turnId && this.store.getSessionTurn(session.id,bindingId,turnId);
      const status=turn?.executionStatus ?? turn?.execution_status ?? (adopted ? "unknown" : operation?.status) ?? session.status;
      const final=turnId && this.store.selectOne(`SELECT id,substr(text,1,1200) AS text FROM session_items WHERE session_id=? AND turn_id=?
        AND type='agentMessage' AND COALESCE(presentation_role,'') NOT IN ('commentary','reasoning') ORDER BY created_at DESC,id DESC LIMIT 1`,[session.id,turnId]);
      result={taskId:task.id,sessionId:session.id,operationId:operation?.taskId??null,dispatchId:dispatch?.dispatch_id??null,
        turnId,status,targetOutcome:"not_assessed",acceptanceState:task.lifecycle_state,
        cancellation:operation?.executionEvidence?.cancellation??null,
        latestResult:final?{messageId:final.id,excerpt:final.text}:null,
        queueDepth:this.store.listQueuedAgentTasksForSession(session.id,100).length,
        dispatchBlock:operation?.source?.dispatchBlock??null,
        instruction:"执行轮次结束不代表目标完成；取消记录仅描述原执行。结果全文按messageId读取。"};
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
    const entries=output.items ?? output.messages;
    while(Array.isArray(entries) && entries.length>1 && Buffer.byteLength(JSON.stringify(output))>8000){
      entries.pop();output.truncated=true;
      const last=entries.at(-1);
      if(output.messages){output.hasMore=true;output.beforeCursor=last.cursor;}
      else output.nextCursor=JSON.stringify({id:last.id,createdAt:last.createdAt});
    }
    if(Buffer.byteLength(JSON.stringify(output))>8192) return {tool:input.tool,referenceOnly:true,errorCode:"COORDINATION_READ_RESULT_TOO_LARGE",message:"请缩小查询范围或分段读取。"};
    return output;
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
