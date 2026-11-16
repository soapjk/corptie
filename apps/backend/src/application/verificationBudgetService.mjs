import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
const identity = value => {
  if (typeof value !== "string" || !value.trim() || value.length > 512) fail("VERIFICATION_ID_INVALID", 400);
  return value;
};
const count = value => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) fail("VERIFICATION_LIMIT_INVALID", 400);
  return value;
};

const budgetState = (row, used, running = false) => {
  const enabled=row.enabled===1;
  const pauseReason=row.pause_reason ?? (row.stopped ? 'recovery_unknown' : null);
  const paused=pauseReason==='user'||pauseReason==='recovery_unknown'||(enabled&&pauseReason==='budget');
  const status=pauseReason==='user'?'stopped_user':pauseReason==='recovery_unknown'?'recovery_unknown':paused?'paused_budget':running?'running':!enabled?'disabled':used>=row.limit_count?'exhausted':'available';
  return {instructionId:row.instruction_id,taskId:row.task_id,enabled,limit:row.limit_count,used,remaining:enabled?Math.max(0,row.limit_count-used):null,status,paused,pauseReason,revision:row.revision};
};

export const VERIFICATION_LIMITATION = "仅约束统一验证入口；Provider 原生 Shell 和其他执行通道仍可绕过预算。";

export class VerificationBudgetService {
  constructor({ store, scope, workingDirectory, interrupt = async () => {}, changed = () => {},
    run = execute, readOnly = false, emitEvent = () => {}, resume = null, resumeQueued = null }) {
    Object.assign(this, { store, scope, workingDirectory, interrupt, changed, run, readOnly, emitEvent, resume, resumeQueued });
    this.active = new Map(); this.statusIndex=null;
    this.changed=value=>{this.statusIndex=null;changed(value);};
  }
  writable() { if (this.readOnly) fail("DEVELOPMENT_PREVIEW_READ_ONLY", 403); }
  defaultLimit() { return this.store.selectOne("SELECT limit_count FROM verification_budget_defaults WHERE id=1")?.limit_count ?? 3; }
  defaultEnabled() { return this.store.selectOne("SELECT enabled FROM verification_budget_defaults WHERE id=1")?.enabled === 1; }
  setDefault(limit, { enabled = true } = {}) {
    this.writable(); count(limit); if(typeof enabled!=='boolean')fail('VERIFICATION_POLICY_INVALID',400);
    this.store.db.run("INSERT INTO verification_budget_defaults(id,limit_count,enabled) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET limit_count=excluded.limit_count,enabled=excluded.enabled", [limit,Number(enabled)]);
    this.store.scheduleSave();
    return { limit, enabled, limitation: VERIFICATION_LIMITATION };
  }
  // Walk authoritative existing dispatch/operation links, never a root ID
  // supplied by the model. Missing ancestry stays scoped to the dispatch.
  operationRoot(operation, seen = new Set()) {
    if (!operation || seen.has(operation.task_id)) return null;
    seen.add(operation.task_id);
    let source = {}; try { source = JSON.parse(operation.source_json ?? "{}"); } catch {}
    if(source.checklistContinuation?.sourceOperationId){
      const original=this.store.selectOne('SELECT * FROM agent_operations WHERE task_id=?',[source.checklistContinuation.sourceOperationId]);
      const root=this.operationRoot(original,seen);if(root)return root;
    }
    if (source.verificationContinuation?.instructionId) {
      const budget = this.read(source.verificationContinuation.instructionId);
      if (budget) return { instructionId:budget.instructionId,taskId:budget.taskId,sessionId:budget.sessionId };
    }
    if (source.type === "scheduled_session_task") {
      const scheduled = this.store.getScheduledSessionTask(source.scheduledTaskId);
      const originalId = scheduled?.policySpec?.verificationOperationId;
      const original = originalId && this.store.selectOne("SELECT * FROM agent_operations WHERE task_id=?", [originalId]);
      const root = this.operationRoot(original, seen);
      if (root) return root;
    }
    const request = this.store.selectOne("SELECT * FROM coordination_requests WHERE operation_id=?", [operation.task_id]);
    if (request?.relation === "supplement" && request.related_request_id) {
      const related = this.store.selectOne("SELECT operation_id FROM coordination_requests WHERE request_id=?", [request.related_request_id]);
      const original = related?.operation_id && this.store.selectOne("SELECT * FROM agent_operations WHERE task_id=?", [related.operation_id]);
      const root = this.operationRoot(original, seen);
      if (root) return root;
    }
    const dispatch = this.store.selectOne("SELECT * FROM task_coordination_dispatches WHERE operation_id=? OR dispatch_id=? LIMIT 1", [operation.task_id, source.coordinationDispatchId ?? null]);
    if (dispatch) {
      let runtime = {}; try { runtime = JSON.parse(dispatch.runtime_json); } catch {}
      const origin = runtime.verificationOperationId && this.store.selectOne("SELECT * FROM agent_operations WHERE task_id=?", [runtime.verificationOperationId]);
      const boundRoot = this.operationRoot(origin, seen);
      if (boundRoot) return boundRoot;
      const logical = this.store.getLogicalSession(dispatch.source_session_id);
      const parent = logical && dispatch.source_turn_id && this.store.selectOne(
        "SELECT * FROM agent_operations WHERE session_id=? AND target_turn_id=? ORDER BY created_at DESC LIMIT 1",
        [logical.legacySessionId, dispatch.source_turn_id]);
      return this.operationRoot(parent, seen) ?? { instructionId: dispatch.progress_batch_id ?? dispatch.dispatch_id,
        taskId: dispatch.parent_task_id, sessionId: dispatch.source_session_id };
    }
    const session = this.store.getSession(operation.session_id);
    if (session?.taskId && operation.kind === "user" && /^(继续|继续开发|continue)[。.!！\s]*$/iu.test(operation.text.trim())) {
      const previous = this.store.selectOne("SELECT instruction_id,task_id,session_id FROM verification_budgets WHERE task_id=? AND created_at<=? ORDER BY created_at DESC LIMIT 1", [session.taskId, operation.created_at]);
      if (previous) return { instructionId: previous.instruction_id, taskId: previous.task_id, sessionId: previous.session_id };
    }
    return session?.taskId ? { instructionId: operation.task_id, taskId: session.taskId,
      sessionId: this.store.getLogicalSessionByLegacySessionId(operation.session_id)?.logicalSessionId ?? operation.session_id } : null;
  }
  current(metadata) {
    const { task, logical, session } = this.scope(metadata);
    const operation = this.store.selectOne("SELECT * FROM agent_operations WHERE session_id=? AND status='running' LIMIT 1", [session.id]);
    const root = this.operationRoot(operation);
    if (!root) fail("VERIFICATION_INSTRUCTION_UNAVAILABLE");
    return { ...root, operationId: operation?.task_id, executorSessionId: session.id, executorTaskId: task.id, logicalSessionId: logical.logicalSessionId };
  }
  operationForSession(sessionId) {
    const logical = this.store.getLogicalSession(sessionId) ?? this.store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical) return null;
    const request = this.store.selectOne("SELECT operation_id FROM coordination_requests WHERE shadow_session_id=?", [logical.logicalSessionId]);
    return request?.operation_id ?? this.store.getRunningAgentTaskForSession(logical.legacySessionId)?.taskId ?? null;
  }
  operationPaused(operationId) {
    const operation = this.store.selectOne("SELECT * FROM agent_operations WHERE task_id=?", [operationId]);
    const root = this.operationRoot(operation);
    return Boolean(root && this.read(root.instructionId)?.paused);
  }
  operationBlock(operationId) {
    const root=this.operationRoot(this.store.selectOne('SELECT * FROM agent_operations WHERE task_id=?',[operationId]));
    const budget=root&&this.read(root.instructionId);if(!budget)return null;
    const code=budget.pauseReason==='user'?'VERIFICATION_STOPPED_BY_USER':budget.pauseReason==='recovery_unknown'?'VERIFICATION_OUTCOME_UNKNOWN':budget.enabled&&(budget.paused||budget.used>=budget.limit)?'VERIFICATION_BUDGET_EXHAUSTED':null;
    return code?{code,instructionId:budget.instructionId,sessionId:budget.sessionId}:null;
  }
  async notifyOperationPaused(operation) {
    if(operation.status!=='queued')return;
    const root=this.operationRoot(this.store.selectOne('SELECT * FROM agent_operations WHERE task_id=?',[operation.taskId]));
    if(root) {
      const row=this.store.selectOne('SELECT notified,pause_targets_json FROM verification_budgets WHERE instruction_id=?',[root.instructionId]);
      if(row?.notified && JSON.parse(row.pause_targets_json).some(target=>target.operationId===operation.taskId))return;
      await this.notifyPaused({...root,blockedOperation:operation});
    }
  }
  captureAutomationOwner(sessionId, actor) {
    if (actor?.type !== "agent") return null;
    const logical = this.store.getLogicalSession(sessionId);
    const session = logical && this.store.getSession(logical.legacySessionId);
    if (!session || session.agentId !== actor.id) return null;
    const operation = this.store.getRunningAgentTaskForSession(session.id);
    return operation ? { verificationOperationId: operation.taskId } : null;
  }
  policy(sessionId) {
    const row = this.store.selectOne("SELECT * FROM verification_budget_policies WHERE session_id=?",[sessionId]);
    return { enabled:row ? row.enabled===1 : this.defaultEnabled(), limit:row?.limit_count ?? this.defaultLimit(), revision:row?.revision ?? 0 };
  }
  read(instructionId) {
    const row=this.store.selectOne("SELECT * FROM verification_budgets WHERE instruction_id=?",[instructionId]);if(!row)return null;
    const statistics=this.store.selectOne(`SELECT COUNT(*) total,SUM(status<>'not_started') used,SUM(status IN ('reserved','running')) active FROM verification_budget_charges WHERE instruction_id=?`,[instructionId]);
    const runs=this.store.selectAll(`SELECT rowid AS cursor,execution_id AS executionId,status,created_at AS createdAt,executor_session_id AS executorSessionId,executor_task_id AS executorTaskId FROM verification_budget_charges WHERE instruction_id=? ORDER BY rowid DESC LIMIT 21`,[instructionId]);
    const used=Number(statistics.used ?? 0),running=Number(statistics.active ?? 0)>0;
    const state=budgetState(row,used,running);
    const {enabled,pauseReason,paused,status}=state;
    const targets=JSON.parse(row.pause_targets_json),resumeOperationIds=JSON.parse(row.resume_ids_json);
    const instruction=this.store.selectOne('SELECT text FROM agent_operations WHERE task_id=?',[instructionId])?.text?.slice(0,160) ?? '子任务验证';
    return {instructionId,taskId:row.task_id,sessionId:row.session_id,instruction,enabled,limit:row.limit_count,used,remaining:enabled?Math.max(0,row.limit_count-used):null,status,paused,stopped:Boolean(row.stopped),pauseReason,revision:row.revision,pauseGeneration:row.pause_generation,resumeRequested:row.resume_requested===1,
      running,runs:runs.slice(0,20).reverse().map(run=>({...run,execution_id:run.executionId,created_at:run.createdAt})),runsHasMore:runs.length>20,nextRunCursor:runs.length>20?String(runs[19].cursor):null,resumeOperationIds,
      executionRunning:targets.some(target=>this.store.getAgentTask(target.operationId)?.status==='running'),limitation:VERIFICATION_LIMITATION};
  }
  ancestorTaskIds(taskId) {
    const ids=[],seen=new Set();let task=this.store.getTask(taskId);
    while(task && !seen.has(task.id)) { seen.add(task.id);ids.push(task.id);task=task.parent_task_id && this.store.getTask(task.parent_task_id); }
    return ids;
  }
  list(taskId) {
    const ids=this.ancestorTaskIds(taskId);
    if(!ids.length)return [];
    return this.store.selectAll(`SELECT instruction_id FROM verification_budgets WHERE task_id IN (${ids.map(()=>'?').join(',')}) ORDER BY rowid DESC LIMIT 20`,ids).map(row=>this.read(row.instruction_id));
  }
  relatedStates(taskId) {
    const ids=this.ancestorTaskIds(taskId);if(!ids.length)return [];
    // One bounded aggregate, not a history/trace load for every related budget.
    return this.store.selectAll(`SELECT b.instruction_id,b.task_id,b.enabled,b.limit_count,b.stopped,b.pause_reason,b.revision,
      SUM(CASE WHEN c.execution_id IS NOT NULL AND c.status<>'not_started' THEN 1 ELSE 0 END) used,
      MAX(CASE WHEN c.status IN ('reserved','running') THEN 1 ELSE 0 END) active
      FROM verification_budgets b LEFT JOIN verification_budget_charges c USING(instruction_id)
      WHERE b.instruction_id IN (SELECT instruction_id FROM verification_budgets WHERE task_id IN (${ids.map(()=>'?').join(',')}) ORDER BY rowid DESC LIMIT 20)
      GROUP BY b.instruction_id ORDER BY b.rowid DESC`,ids).map(row=>budgetState(row,Number(row.used),Boolean(row.active)));
  }
  inspectScope(scope,{executionId}={}) {
    const budget=this.read(scope.instructionId);
    const original=this.store.getAgentTask(scope.instructionId);
    const policy=original?.source?.verificationPolicy ?? this.policy(scope.sessionId);
    const compact=row=>({instructionId:row.instructionId,taskId:row.taskId,enabled:row.enabled,limit:row.limit,used:row.used,remaining:row.remaining,status:row.status,pauseReason:row.pauseReason,revision:row.revision});
    const relatedBudgets=this.relatedStates(scope.executorTaskId ?? scope.taskId).filter(row=>row.instructionId!==scope.instructionId).map(compact);
    let executionReceipt=null;
    if(executionId!==undefined) {
      identity(executionId);
      const ids=this.ancestorTaskIds(scope.executorTaskId ?? scope.taskId);
      const rows=ids.length?this.store.selectAll(`SELECT c.instruction_id,c.status FROM verification_budget_charges c JOIN verification_budgets b USING(instruction_id) WHERE c.execution_id=? AND b.task_id IN (${ids.map(()=>'?').join(',')}) ORDER BY c.rowid DESC LIMIT 2`,[executionId,...ids]):[];
      // An execution ID is only a scoped read lookup. It never selects which
      // instruction a future run charges, and collisions must remain explicit.
      executionReceipt={executionId,status:rows.length===1?'found':rows.length?'ambiguous':'not_found',matches:rows.map(row=>({status:row.status,budget:compact(this.read(row.instruction_id))}))};
    }
    return {instructionId:scope.instructionId,budget,
      currentState:budget?compact(budget):{instructionId:scope.instructionId,taskId:scope.taskId,enabled:policy.enabled,limit:policy.limit,used:0,remaining:policy.enabled?policy.limit:null,status:'not_started',pauseReason:null,revision:0},
      relatedBudgets,executionReceipt,enforcement:'entry_only',
      instruction:'budget:null 表示当前指令尚未建立验证账本，不表示没有额度或未收到增额。当前可用额度以 currentState 为准；原指令增额见 relatedBudgets 或 executionReceipt。关联记录仅供查询，不能改变 run 的计费指令；不要沿用历史3/3冻结判断，保留用户明确停止及其他开发约束。'};
  }
  inspect(metadata,input={}) { return this.inspectScope(this.current(metadata),input); }
  contextForSession(sessionId) {
    const logical=this.store.getLogicalSession(sessionId) ?? this.store.getLogicalSessionByLegacySessionId(sessionId);
    const session=logical && this.store.getSession(logical.legacySessionId);
    if(!session?.taskId)return null;
    const operation=this.store.selectOne("SELECT * FROM agent_operations WHERE session_id=? AND status='running' LIMIT 1",[session.id]);
    const root=this.operationRoot(operation);if(!root)return null;
    const value=this.inspectScope({...root,executorTaskId:session.taskId});
    return {contextKey:'verification-state',contextReusable:false,prompt:`<corptie_verification_state>\nCurrent host accounting facts; historical quota numbers and automatic budget freezes may be stale. budget:null means not yet recorded, never exhausted. Related budgets are read-only context and do not select the run root. Respect explicit user stops and development-before-verification requirements. Refresh with corptie_verification get before verification.\n${JSON.stringify({currentState:value.currentState,relatedBudgets:value.relatedBudgets})}\n</corptie_verification_state>`};
  }
  records(taskId,instructionId,before=null) {
    if(!this.taskCanManage(taskId,this.read(instructionId)))fail('VERIFICATION_NOT_FOUND',404);
    if(before!==null && (typeof before!=='string' || !/^[1-9][0-9]*$/.test(before) || !Number.isSafeInteger(Number(before))))fail('VERIFICATION_CURSOR_INVALID',400);
    const rows=this.store.selectAll(`SELECT rowid AS cursor,execution_id AS executionId,status,created_at AS createdAt,executor_session_id AS executorSessionId,executor_task_id AS executorTaskId FROM verification_budget_charges WHERE instruction_id=? ${before?'AND rowid<?':''} ORDER BY rowid DESC LIMIT 21`,before?[instructionId,Number(before)]:[instructionId]);
    return {runs:rows.slice(0,20).map(({cursor,...run})=>run),hasMore:rows.length>20,nextCursor:rows.length>20?String(rows[19].cursor):null};
  }
  pausedForSession(sessionId) {
    if(!this.statusIndex){
      this.statusIndex=new Map();
      const rows=this.store.selectAll(`
        SELECT instruction_id,session_id FROM verification_budgets WHERE enabled=1 AND pause_reason='budget'
        UNION ALL
        SELECT b.instruction_id,c.executor_session_id FROM verification_budgets b
          JOIN verification_budget_charges c USING(instruction_id) WHERE b.enabled=1 AND b.pause_reason='budget' AND c.executor_session_id IS NOT NULL
        UNION ALL
        SELECT b.instruction_id,json_extract(t.value,'$.sessionId') FROM verification_budgets b,json_each(b.pause_targets_json) t
          WHERE b.enabled=1 AND b.pause_reason='budget'`);
      for(const row of rows)this.statusIndex.set(row.session_id,{instructionId:row.instruction_id,reason:'budget'});
    }
    return this.statusIndex.get(sessionId) ?? null;
  }
  snapshot(sessionId) {
    const logical=this.store.getLogicalSession(sessionId) ?? this.store.getLogicalSessionByLegacySessionId(sessionId);
    const session=logical && this.store.getSession(logical.legacySessionId),task=session?.taskId && this.store.getTask(session.taskId);
    if(!session || session.archived || session.deletedAt)fail('SESSION_NOT_FOUND',404);
    const keys=['instructionId','taskId','sessionId','instruction','enabled','limit','used','remaining','status','paused','pauseReason','running','executionRunning','revision','resumeRequested','resumeOperationIds','runsHasMore','nextRunCursor'];
    const budgets=(task?this.list(task.id):[]).map(row=>({...Object.fromEntries(keys.map(key=>[key,row[key]])),runs:row.runs.map(run=>({executionId:run.executionId,status:run.status,createdAt:run.createdAt,executorSessionId:run.executorSessionId,executorTaskId:run.executorTaskId}))}));
    const policy=this.policy(logical.logicalSessionId);
    return { sessionId:logical.logicalSessionId,taskId:task?.id ?? null,available:Boolean(task),policyEditable:Boolean(task&&!task.parent_task_id),policy,budgets,
      revision:[policy.revision,...budgets.map(row=>row.revision)].join(":"),limitation:VERIFICATION_LIMITATION };
  }
  capturePolicy(operation) {
    if(!operation || operation.kind!=='user')return;
    const row=this.store.selectOne('SELECT * FROM agent_operations WHERE task_id=?',[operation.taskId]);
    const root=this.operationRoot(row);if(!root || root.instructionId!==operation.taskId)return;
    const source=JSON.parse(row.source_json ?? '{}');if(source.verificationPolicy)return;
    this.store.updateAgentTask(operation.taskId,{source:{...source,verificationPolicy:this.policy(root.sessionId)}});
  }
  updatePolicy(sessionId,{enabled,limit}) {
    this.writable();if(typeof enabled!=='boolean')fail('VERIFICATION_POLICY_INVALID',400);count(limit);
    const snapshot=this.snapshot(sessionId);if(!snapshot.policyEditable)fail('VERIFICATION_SHARED_POLICY',409);
    this.store.db.run(`INSERT INTO verification_budget_policies(session_id,enabled,limit_count,revision) VALUES(?,?,?,1) ON CONFLICT(session_id) DO UPDATE SET enabled=excluded.enabled,limit_count=excluded.limit_count,revision=revision+1`,[snapshot.sessionId,Number(enabled),limit]);
    this.store.scheduleSave();this.changed({sessionId:snapshot.sessionId,taskId:snapshot.taskId});return this.snapshot(sessionId);
  }
  async control(sessionId,fields,{requestId}) {
    const scope=this.snapshot(sessionId);if(!scope.available)fail('VERIFICATION_INSTRUCTION_UNAVAILABLE');
    if(fields.action==='policy')return this.updatePolicy(sessionId,fields);
    const budget=this.read(fields.instructionId);if(!this.taskCanManage(scope.taskId,budget))fail('VERIFICATION_NOT_FOUND',404);
    if(fields.action==='configure') {
      if(typeof fields.enabled!=='boolean')fail('VERIFICATION_POLICY_INVALID',400);
      const limit=fields.limit ?? budget.limit;if(!Number.isSafeInteger(limit)||limit<1)fail('VERIFICATION_LIMIT_INVALID',400);if(fields.enabled&&limit<budget.used)fail('VERIFICATION_LIMIT_BELOW_USED');
      this.store.runInTransaction(()=>{
        if(!fields.enabled&&budget.pauseReason==='budget')this.requestResume(budget.instructionId);
      this.store.db.run(`UPDATE verification_budgets SET enabled=?,limit_count=?,policy_source='user',revision=revision+1,pause_reason=CASE WHEN pause_reason='budget' AND ?=0 THEN NULL ELSE pause_reason END,stopped=CASE WHEN pause_reason='budget' AND ?=0 THEN 0 ELSE stopped END WHERE instruction_id=?`,[Number(fields.enabled),limit,Number(fields.enabled),Number(fields.enabled),budget.instructionId]);
      });
      this.store.scheduleSave();this.changed(this.read(budget.instructionId));
      if(this.read(budget.instructionId).resumeRequested)await this.resumeBudget(budget.instructionId);
    } else if(fields.action==='extend') {
      const extended=this.extend(scope.taskId,budget.instructionId,{...fields,requestId});
      if(extended.resumeRequested)await this.resumeBudget(extended.instructionId);
    } else fail('VERIFICATION_ACTION_INVALID',400);
    return this.snapshot(sessionId);
  }
  taskCanManage(taskId, budget) {
    if (!budget) return false;
    if (budget.taskId === taskId) return true;
    const owner = this.store.getTask(budget.taskId), seen = new Set();
    let task = this.store.getTask(taskId);
    while(task && owner && task.work_id === owner.work_id && !seen.has(task.id)) {
      if(task.id === owner.id)return true;
      seen.add(task.id);task=task.parent_task_id && this.store.getTask(task.parent_task_id);
    }
    return false;
  }
  reserve(scope, executionId) {
    this.writable(); identity(executionId);
    return this.store.runInTransaction(() => {
      this.store.db.run(`INSERT OR IGNORE INTO verification_budgets(instruction_id,task_id,session_id,limit_count,created_at)
        VALUES(?,?,?,?,?)`, [scope.instructionId, scope.taskId, scope.sessionId, this.defaultLimit(), new Date().toISOString()]);
      if(Number(this.store.selectOne("SELECT changes() AS n").n)) {
        const original=this.store.getAgentTask(scope.instructionId),policy=original?.source?.verificationPolicy ?? this.policy(scope.sessionId);
        this.store.db.run("UPDATE verification_budgets SET enabled=?,limit_count=?,policy_source='captured' WHERE instruction_id=?",[Number(policy.enabled),policy.limit,scope.instructionId]);
      }
      const old = this.store.selectOne("SELECT status FROM verification_budget_charges WHERE instruction_id=? AND execution_id=?", [scope.instructionId, executionId]);
      if (old) return { launch: false, status: old.status, budget: this.read(scope.instructionId) };
      const budget = this.read(scope.instructionId);
      if (budget.running) fail("VERIFICATION_ALREADY_RUNNING");
      if(budget.pauseReason==='user')fail('VERIFICATION_STOPPED_BY_USER');
      if(budget.pauseReason==='recovery_unknown')fail('VERIFICATION_OUTCOME_UNKNOWN');
      if (budget.enabled && (budget.paused || budget.used >= budget.limit)) fail("VERIFICATION_BUDGET_EXHAUSTED");
      this.store.db.run("INSERT INTO verification_budget_charges(instruction_id,execution_id,status,created_at,operation_id,executor_session_id,executor_task_id) VALUES(?,?,'reserved',?,?,?,?)",
        [scope.instructionId, executionId, new Date().toISOString(),scope.operationId ?? null,scope.logicalSessionId ?? scope.executorSessionId ?? null,scope.executorTaskId ?? scope.taskId]);
      this.store.scheduleSave();
      return { launch: true, budget: this.read(scope.instructionId) };
    });
  }
  finish(instructionId, executionId, status) {
    this.store.db.run("UPDATE verification_budget_charges SET status=? WHERE instruction_id=? AND execution_id=?", [status, instructionId, executionId]);
    this.store.scheduleSave();
    this.store.db.run('UPDATE verification_budgets SET revision=revision+1 WHERE instruction_id=?',[instructionId]);
    const budget = this.read(instructionId);
    this.changed(budget);
    return budget;
  }
  extend(taskId, instructionId, { requestId, amount = 1, resume = false }) {
    this.writable(); identity(requestId); count(amount);
    return this.store.runInTransaction(() => {
      const budget = this.read(instructionId);
      if (!this.taskCanManage(taskId, budget)) fail("VERIFICATION_NOT_FOUND", 404);
      const old = this.store.selectOne("SELECT amount,resume FROM verification_budget_extensions WHERE instruction_id=? AND request_id=?", [instructionId, requestId]);
      if (old) { if (old.amount !== amount || Boolean(old.resume)!==resume) fail("VERIFICATION_REQUEST_CONFLICT"); return budget; }
      this.store.db.run("INSERT INTO verification_budget_extensions(instruction_id,request_id,amount,resume) VALUES(?,?,?,?)", [instructionId, requestId, amount,Number(resume)]);
      if(resume && budget.pauseReason==='budget')this.requestResume(instructionId);
      this.store.db.run("UPDATE verification_budgets SET limit_count=limit_count+?,policy_source='user',revision=revision+1,pause_reason=CASE WHEN pause_reason='budget' AND ?=1 THEN NULL ELSE pause_reason END,stopped=CASE WHEN pause_reason='budget' AND ?=1 THEN 0 ELSE stopped END,notified=CASE WHEN ?=1 THEN 0 ELSE notified END WHERE instruction_id=?", [amount,Number(resume),Number(resume),Number(resume),instructionId]);
      this.store.scheduleSave();
      this.store.afterCommit(() => this.changed(this.read(instructionId)));
      return this.read(instructionId);
    });
  }
  stop(taskId, instructionId) {
    this.writable(); const budget = this.read(instructionId);
    if (!this.taskCanManage(taskId, budget)) fail("VERIFICATION_NOT_FOUND", 404);
    this.store.db.run("UPDATE verification_budgets SET stopped=1,pause_reason='user',revision=revision+1 WHERE instruction_id=?", [instructionId]);
    this.store.scheduleSave();
    this.active.get(instructionId)?.controller.abort();
    this.changed(this.read(instructionId));
    return this.read(instructionId);
  }
  cancelSession(sessionId) {
    for (const entry of this.active.values()) if (entry.sessionId === sessionId) entry.controller.abort();
  }
  async notifyPaused(scope,{interrupt=false}={}) {
    let budget=this.read(scope.instructionId);if(!budget?.enabled || ['user','recovery_unknown'].includes(budget.pauseReason))return;
    const targets=this.store.selectAll("SELECT * FROM agent_operations WHERE status='running'").filter(op=>this.operationRoot(op)?.instructionId===scope.instructionId)
      .map(op=>({operationId:op.task_id,sessionId:op.session_id}));
    if(scope.blockedOperation)targets.push({operationId:scope.blockedOperation.taskId,sessionId:scope.blockedOperation.sessionId});
    this.store.runInTransaction(()=>{
      const row=this.store.selectOne('SELECT * FROM verification_budgets WHERE instruction_id=?',[scope.instructionId]);
      if(!row.notified) {
        this.store.db.run("UPDATE verification_budgets SET stopped=1,pause_reason='budget',pause_generation=pause_generation+1,revision=revision+1,pause_targets_json=?,resume_ids_json='[]',notified=1 WHERE instruction_id=?",[JSON.stringify(targets),scope.instructionId]);
        budget=this.read(scope.instructionId);
      }
      const previous=row.notified?JSON.parse(row.pause_targets_json):[];
      const combined=[...new Map([...previous,...targets].map(value=>[value.operationId,value])).values()];
      const encoded=JSON.stringify(combined);
      if(encoded!==JSON.stringify(previous))this.store.db.run('UPDATE verification_budgets SET pause_targets_json=?,revision=revision+1 WHERE instruction_id=?',[encoded,scope.instructionId]);
      budget=this.read(scope.instructionId);
      const rootSession=this.store.getLogicalSession(scope.sessionId)?.legacySessionId ?? scope.sessionId;
      const existing=this.store.selectOne('SELECT created_at FROM session_items WHERE session_id=? AND id=?',[rootSession,`verification-budget:${scope.instructionId}:${budget.pauseGeneration}`]);
      const createdAt=existing?.created_at ?? new Date().toISOString();
      const recipients=new Set([rootSession,...combined.map(target=>target.sessionId)]);
      for(const session of recipients) {
        const item={id:`verification-budget:${scope.instructionId}:${budget.pauseGeneration}`,type:'agentMessage',title:'验证预算耗尽',text:`执行已暂停：验证预算已用尽。本条指令已用 ${budget.used}/${budget.limit} 次。不会自动继续，请在会话性能中增加预算并选择继续。`,
          turnId:'',turnStatus:'completed',status:'completed',createdAt,rawMetadataJSON:JSON.stringify({coordinationEvent:{kind:'verification_budget',sessionId:scope.sessionId,instructionId:scope.instructionId,taskId:budget.taskId,pauseGeneration:budget.pauseGeneration}})};
        // Preserve a historical notice after an increment; the live Detail
        // snapshot is the authority for the new available count.
        if(!this.store.selectOne('SELECT 1 FROM session_items WHERE session_id=? AND id=?',[session,item.id]))this.store.upsertTimelineItemProjection(session,item);
        const generation=budget.pauseGeneration;
        this.store.afterCommit(()=>this.emitEvent('SessionCoordinationMilestone',{item,hasAgentMessage:true},{sessionId:session,eventId:`verification-paused:${scope.instructionId}:${generation}:${session}`}));
      }
      this.store.scheduleSave();
    });
    this.changed(this.read(scope.instructionId));
    if(interrupt)for(const target of targets){
      if(this.store.getAgentTask(target.operationId)?.status!=='running')continue;
      await this.interrupt(target.sessionId);
    }
  }
  requestResume(id) { this.store.db.run('UPDATE verification_budgets SET resume_requested=1 WHERE instruction_id=?',[id]);this.store.scheduleSave(); }
  onRuntimeEvent(type,payload) {
    if(type==='AgentWorkQueued')this.capturePolicy(payload?.task);
    if(!['AgentWorkCompleted','AgentWorkFailed','SessionRunCompleted','SessionRunFailed','SessionRunInterrupted'].includes(type))return;
    for(const row of this.store.selectAll('SELECT instruction_id FROM verification_budgets WHERE resume_requested=1')) {
      void this.resumeBudget(row.instruction_id).catch(error=>console.warn(`[verification-resume] ${error.code ?? error.message}`));
    }
  }
  async resumeBudget(instructionId) {
    const budget=this.read(instructionId);
    if(!budget?.resumeRequested || ['user','recovery_unknown'].includes(budget.pauseReason))return;
    const row=this.store.selectOne('SELECT pause_targets_json FROM verification_budgets WHERE instruction_id=?',[instructionId]);
    let waiting=false;
    const targets=JSON.parse(row.pause_targets_json);
    const queuedSessions=new Set(targets.filter(target=>this.store.getAgentTask(target.operationId)?.status==='queued').map(target=>target.sessionId));
    const awakened=new Set();
    for(const target of targets) {
      const original=this.store.getAgentTask(target.operationId),session=original&&this.store.getSession(target.sessionId);
      const task=session?.taskId&&this.store.getTask(session.taskId);
      if(!task || task.lifecycle_state==='done' || task.archived || task.deletion_status || !session || session.archived || session.deletedAt)continue;
      if(original.status!=='queued' && queuedSessions.has(target.sessionId))continue;
      if(original.status==='running'){waiting=true;continue;}
      if(original.status==='queued') {
        const {dispatchBlock,...source}=original.source ?? {};
        this.store.updateAgentTask(original.taskId,{source,lastError:null});
        if(this.resumeQueued && !awakened.has(session.id)){awakened.add(session.id);this.store.afterCommit(()=>this.resumeQueued(original));}
        this.emitEvent('AgentWorkDispatchReady',{task:this.store.getAgentTask(original.taskId),sessionId:session.id},{sessionId:session.id});
        continue;
      }
      if(original.executionEvidence?.cancellation?.actor==='user')continue;
      const id=`verification-resume:${instructionId}:${budget.pauseGeneration}:${target.operationId}`;
      if(this.store.getAgentTask(id))continue;
      if(!this.resume)fail('VERIFICATION_RESUME_UNAVAILABLE',503);
      this.store.runInTransaction(()=>{
        const current=this.read(instructionId);
        if(!current.resumeOperationIds.includes(id))this.store.db.run("UPDATE verification_budgets SET resume_ids_json=json_insert(resume_ids_json,'$[#]',?),revision=revision+1 WHERE instruction_id=?",[id,instructionId]);
        // Queue acceptance and its authorization identity commit together. The
        // existing mailbox is responsible for execution after this commit.
        this.resume({operationId:id,session,sourceOperationId:target.operationId,instructionId});
      });
    }
    if(!waiting)this.store.db.run('UPDATE verification_budgets SET resume_requested=0 WHERE instruction_id=?',[instructionId]);
    this.store.scheduleSave();this.changed(this.read(instructionId));
  }
  pendingNotices() {
    return this.store.selectAll("SELECT instruction_id FROM verification_budgets WHERE enabled=1 AND pause_reason='budget' ORDER BY rowid DESC LIMIT 20").map(row=>this.notice(this.read(row.instruction_id))).filter(Boolean);
  }
  notice(budget) {
    if(budget?.pauseReason!=='budget' || !budget.enabled)return null;
    const session=this.store.getLogicalSession(budget.sessionId)?.legacySessionId ?? budget.sessionId;
    const row=this.store.selectOne('SELECT created_at FROM session_items WHERE session_id=? AND id=?',[session,`verification-budget:${budget.instructionId}:${budget.pauseGeneration}`]);
    return {id:`verification-paused:${budget.instructionId}:${budget.pauseGeneration}`,sessionId:budget.sessionId,instructionId:budget.instructionId,title:'验证预算耗尽',body:`${budget.instruction}：已用 ${budget.used}/${budget.limit}，后续验证已暂停。`,occurredAt:row?.created_at ?? new Date().toISOString()};
  }
  async execute(metadata, input) {
    this.writable();
    const scope = this.current(metadata);
    if (input.developmentComplete !== true) fail("DEVELOPMENT_NOT_FINISHED");
    const commands = input.commands;
    const timeoutSeconds = input.timeoutSeconds ?? 120;
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) fail("VERIFICATION_TIMEOUT_INVALID", 400);
    if (!Array.isArray(commands) || !commands.length || commands.length > 20) fail("VERIFICATION_COMMANDS_INVALID", 400);
    for (const command of commands) {
      if (!command || typeof command.file !== "string" || !command.file.trim() || !Array.isArray(command.args)
        || command.args.some(arg => typeof arg !== "string" || arg.length > 16000)) fail("VERIFICATION_COMMANDS_INVALID", 400);
    }
    const cwd = await this.workingDirectory(scope.executorSessionId);
    const current = this.current(metadata);
    if (current.operationId !== scope.operationId || current.executorSessionId !== scope.executorSessionId) fail("VERIFICATION_EXECUTION_CHANGED");
    const executionId = identity(input.executionId);
    let receipt;
    try { receipt = this.reserve(scope, executionId); }
    catch (error) {
      if (error.code === "VERIFICATION_BUDGET_EXHAUSTED") {
        await this.notifyPaused(scope,{interrupt:true});
      }
      throw error;
    }
    if (!receipt.launch) return { ...receipt, instruction: "这是原执行的回执，不会重新运行；验证输出沿用原工具结果。" };
    const controller = new AbortController(); this.active.set(scope.instructionId, { controller, sessionId: scope.executorSessionId });
    this.finish(scope.instructionId, executionId, "running");
    const results = [];
    try {
      for (const command of commands) {
        if (controller.signal.aborted) break;
        try {
          const result = await this.run(command.file, command.args, { cwd, signal: controller.signal,
            timeout: timeoutSeconds * 1000, maxBuffer: 1024 * 1024, encoding: "utf8" });
          results.push({ ok: true, stdout: result.stdout, stderr: result.stderr });
        } catch (error) {
          results.push({ ok: false, exitCode: Number.isInteger(error.code) ? error.code : null,
            reason: String(error.code ?? "EXECUTION_FAILED"), stdout: error.stdout ?? "", stderr: error.stderr ?? "" });
        }
      }
      const passed = results.length === commands.length && results.every(result => result.ok);
      const notStarted = results.length === commands.length && results.every(result => !result.ok && ["ENOENT", "EACCES"].includes(result.reason));
      const budget = this.finish(scope.instructionId, executionId, passed ? "passed" : notStarted ? "not_started" : "failed");
      if(budget.enabled && !passed && !notStarted && budget.used>=budget.limit)await this.notifyPaused(scope);
      const finalBudget=this.read(scope.instructionId);
      // Deliver this final allowed round's output normally. Interrupting before
      // returning would discard the very tool result the user relies on. An
      // attempted additional round is rejected and interrupted before launch.
      return { executionId, results, budget:finalBudget, instruction: finalBudget.paused
        ? "验证预算已用完，停止本条指令的后续执行，等待用户追加次数；不要使用其他通道绕过。" : null };
    } finally { this.active.delete(scope.instructionId); }
  }
  recover() {
    this.writable();this.statusIndex=null;
    // No process is relaunched on recovery. Previously reserved executions
    // remain charged; command output is not duplicated in this ledger.
    this.store.db.run("UPDATE verification_budgets SET stopped=1,pause_reason='recovery_unknown',revision=revision+1 WHERE instruction_id IN (SELECT instruction_id FROM verification_budget_charges WHERE status IN ('running','reserved'))");
    this.store.db.run("UPDATE verification_budget_charges SET status='unknown' WHERE status IN ('running','reserved')");
    this.store.scheduleSave();
    for(const row of this.store.selectAll('SELECT instruction_id FROM verification_budgets WHERE resume_requested=1')) void this.resumeBudget(row.instruction_id).catch(error=>console.warn(`[verification-resume-recover] ${error.code ?? error.message}`));
  }
}
