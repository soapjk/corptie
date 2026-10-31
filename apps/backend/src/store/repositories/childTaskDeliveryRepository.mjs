import { randomUUID } from "node:crypto";

export class ChildTaskDeliveryRepository {
  constructor(store) { this.store = store; }
  createFromApproval(approval, snapshot, actor) {
    const existing = this.store.selectOne("SELECT operation_id FROM child_task_delivery_operations WHERE approval_operation_id=?", [approval.operationId]);
    if (existing) return this.getOperation(existing.operation_id);
    const active = this.store.selectOne("SELECT state FROM child_task_delivery_operations WHERE child_task_id=? AND state IN ('queued','running','waiting') LIMIT 1", [snapshot.taskId]);
    if (active) throw failure("CHILD_DELIVERY_ACTIVE", "该子任务已有收尾作业。");
    this.store.db.run("UPDATE child_task_delivery_operations SET state='superseded',revision=revision+1 WHERE child_task_id=? AND state='blocked'",[snapshot.taskId]);
    const id = `child-delivery:${randomUUID()}`, now = new Date().toISOString();
    this.store.db.run(`INSERT INTO child_task_delivery_operations
      (operation_id,child_task_id,parent_task_id,work_id,approval_operation_id,snapshot_json,actor_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, [id,snapshot.taskId,snapshot.parentTaskId,snapshot.workId,approval.operationId,
      JSON.stringify(snapshot),JSON.stringify(actor),now,now]);
    this.store.scheduleSave();
    return this.getOperation(id);
  }
  getOperation(id) {
    const row = this.store.selectOne("SELECT * FROM child_task_delivery_operations WHERE operation_id=?", [id]);
    return row ? { operationId: row.operation_id, taskId: row.child_task_id, parentTaskId: row.parent_task_id,
      workId: row.work_id, approvalOperationId: row.approval_operation_id, snapshot: JSON.parse(row.snapshot_json),
      actor: JSON.parse(row.actor_json), state: row.state, phase: row.phase, revision: row.revision,
      progress: JSON.parse(row.progress_json), errorCode: row.error_code, errorMessage: row.error_message,
      createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  advanceOperation(operation, patch) {
    const next = { ...operation, ...patch };
    this.store.runInTransaction(()=>{
    this.store.db.run(`UPDATE child_task_delivery_operations SET state=?,phase=?,progress_json=?,error_code=?,error_message=?,
      revision=revision+1,updated_at=? WHERE operation_id=? AND revision=?`,
    [next.state,next.phase,JSON.stringify(next.progress),next.errorCode ?? null,next.errorMessage ?? null,
      new Date().toISOString(),operation.operationId,operation.revision]);
    if (Number(this.store.selectOne("SELECT changes() AS count").count) !== 1) throw failure("CHILD_DELIVERY_CHANGED", "收尾状态已变化。");
    // Make the bounded parent record visible through the existing state stream.
    this.store.db.run("UPDATE tasks SET resource_version=resource_version+1 WHERE id IN (?,?)",[operation.parentTaskId,operation.taskId]);
    });
    this.store.scheduleSave(); return this.getOperation(operation.operationId);
  }
  claimOperation(operation) { return this.advanceOperation(operation, { state: "running", errorCode: null, errorMessage: null }); }
  listRecoverableOperations() {
    return this.store.selectAll("SELECT operation_id FROM child_task_delivery_operations WHERE state IN ('queued','running','waiting') ORDER BY created_at")
      .map(row => this.getOperation(row.operation_id));
  }
  listParentDeliveries(parentTaskId, cursor = null, limit = 5) {
    if(cursor!=null && !/^[1-9][0-9]*$/.test(String(cursor))) throw failure("INVALID_CURSOR","无效的分页游标。");
    const size = Math.max(1,Math.min(50,Math.floor(Number(limit) || 5)));
    const rows = this.store.selectAll(`SELECT rowid,operation_id FROM child_task_delivery_operations
      WHERE parent_task_id=? AND (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT ?`, [parentTaskId,cursor,cursor,size+1]);
    return { items: rows.slice(0,size).map(row => this.getOperation(row.operation_id)),
      nextCursor: rows.length>size ? String(rows[size-1].rowid) : null };
  }
}
function failure(code,message) { return Object.assign(new Error(message),{code,statusCode:409}); }
