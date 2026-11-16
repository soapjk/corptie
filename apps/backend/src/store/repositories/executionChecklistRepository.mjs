export class ExecutionChecklistRepository {
  constructor(store) { this.store = store; }
  get(taskId, {planId, instructionId} = {}) {
    const row = planId ? this.store.selectOne("SELECT body_json FROM execution_checklist_plans WHERE plan_id=? AND task_id=?",[planId,taskId])
      : instructionId ? this.store.selectOne("SELECT body_json FROM execution_checklist_plans WHERE task_id=? AND instruction_id=? ORDER BY updated_at DESC LIMIT 1",[taskId,instructionId]) : null;
    return row ? JSON.parse(row.body_json) : null;
  }
  save(plan) {
    this.store.db.run(`INSERT INTO execution_checklist_plans VALUES(?,?,?,?,?,?)
      ON CONFLICT(plan_id) DO UPDATE SET body_json=excluded.body_json,updated_at=excluded.updated_at`,
    [plan.planId,plan.taskId,plan.logicalSessionId,plan.instructionId??plan.anchorTurnId,JSON.stringify(plan),plan.updatedAt]);
  }
  runtime(planId) {
    if(!planId)return null;
    const row=this.store.selectOne("SELECT * FROM execution_checklist_runtime WHERE plan_id=?",[planId]);
    return row ? {...JSON.parse(row.body_json),enabled:Boolean(row.enabled),state:row.state,generation:row.generation,
      responsibleSessionId:row.responsible_session_id,operationId:row.operation_id} : null;
  }
  saveRuntime(planId, value) {
    const now=new Date().toISOString();
    this.store.db.run(`INSERT INTO execution_checklist_runtime VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(plan_id) DO UPDATE SET
      enabled=excluded.enabled,state=excluded.state,generation=excluded.generation,responsible_session_id=excluded.responsible_session_id,
      operation_id=excluded.operation_id,body_json=excluded.body_json,updated_at=excluded.updated_at`,
    [planId,Number(value.enabled),value.state,value.generation,value.responsibleSessionId,value.operationId??null,JSON.stringify(value),now]);
    this.store.scheduleSave();return value;
  }
  waits(planId) { return this.store.selectAll("SELECT body_json FROM execution_checklist_waits WHERE plan_id=?",[planId]).map(row=>JSON.parse(row.body_json)); }
  wait(planId, value) {
    this.store.db.run(`INSERT INTO execution_checklist_waits VALUES(?,?,?,?,?) ON CONFLICT(plan_id,step_id) DO UPDATE SET
      kind=excluded.kind,resource_id=excluded.resource_id,body_json=excluded.body_json`,[planId,value.stepId,value.kind,value.resourceId,JSON.stringify(value)]);
    this.store.scheduleSave();
  }
  clearWait(planId, stepId) { this.store.db.run("DELETE FROM execution_checklist_waits WHERE plan_id=? AND step_id=?",[planId,stepId]); }
  activeForSession(logicalId) {
    return this.store.selectAll(`SELECT p.body_json FROM execution_checklist_plans p JOIN execution_checklist_runtime r USING(plan_id)
      WHERE r.enabled=1 AND r.state NOT IN ('completed','cancelled') AND (p.owner_session_id=? OR r.responsible_session_id=?)`,[logicalId,logicalId]).map(row=>JSON.parse(row.body_json));
  }
  activePage(after="") { return this.store.selectAll(`SELECT p.body_json FROM execution_checklist_plans p JOIN execution_checklist_runtime r USING(plan_id)
    WHERE r.enabled=1 AND r.state NOT IN ('completed','cancelled') AND p.plan_id>? ORDER BY p.plan_id LIMIT 100`,[after]).map(row=>JSON.parse(row.body_json)); }
  bindBatch(planId,batchId) { this.store.db.run("INSERT OR IGNORE INTO execution_plan_batches VALUES(?,?)",[batchId,planId]); }
  planForBatch(batchId) { return batchId?this.store.selectOne("SELECT plan_id FROM execution_plan_batches WHERE batch_id=?",[batchId])?.plan_id??null:null; }
}
