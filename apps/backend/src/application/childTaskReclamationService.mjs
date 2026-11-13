// Reclaim payloads after the existing delivery/deletion services have released
// runtime and Git ownership. Referential tombstones contain no chat archive.
export class ChildTaskReclamationService {
  constructor({ store, resources }) { Object.assign(this, { store, resources }); this.running = new Map(); this.retries = new Map(); }
  schedule(taskId) {
    if (this.running.has(taskId)) return this.running.get(taskId);
    if (this.retries.has(taskId)) return Promise.resolve();
    const flight = this.reclaim(taskId).catch(error => {
      if (!this.store.db) return;
      this.store.db.run("UPDATE coordination_shadow_reclamation SET phase='purge',last_error=?,updated_at=? WHERE task_id=?",
        [String(error.code ?? error.message).slice(0, 1000), new Date().toISOString(), taskId]);
      this.store.scheduleSave();
      const timer = setTimeout(() => { this.retries.delete(taskId); if (this.store.db) void this.schedule(taskId); }, 30_000);
      timer.unref?.(); this.retries.set(taskId, timer);
    }).finally(() => this.running.delete(taskId));
    this.running.set(taskId, flight);
    return flight;
  }
  async reclaim(taskId) {
    const task = this.store.selectOne("SELECT parent_task_id,deletion_status FROM tasks WHERE id=?", [taskId]);
    const recovery = this.store.selectOne("SELECT * FROM coordination_shadow_reclamation WHERE task_id=?", [taskId]);
    if (!recovery) return;
    if (!task?.parent_task_id || task.deletion_status !== "deleted") {
      throw Object.assign(new Error("Child deletion is not complete."), { code: "CHILD_RECLAMATION_NOT_READY" });
    }
    await this.resources.reclaimDeletedTask(taskId);
    const sessions = this.store.selectAll("SELECT id FROM sessions WHERE task_id=?", [taskId]);
    this.store.runInTransaction(() => {
      for (const { id } of sessions) {
        const logical = this.store.selectOne("SELECT logical_session_id FROM logical_sessions WHERE legacy_session_id=?", [id]);
        const ids = [...new Set([id, logical?.logical_session_id].filter(Boolean))];
        for (const sessionId of ids) {
          this.store.db.run("DELETE FROM session_mailbox_messages WHERE recipient_session_id=? OR adopted_provider_session_id=? OR operation_id IN (SELECT task_id FROM agent_operations WHERE session_id=?)", [sessionId, sessionId, sessionId]);
          this.store.db.run("UPDATE session_collaboration_messages SET body='',resource_context_json='{}' WHERE sender_session_id=? OR recipient_session_id=?", [sessionId, sessionId]);
          this.store.db.run("UPDATE session_collaboration_channels SET status='revoked' WHERE session_a_id=? OR session_b_id=?", [sessionId, sessionId]);
          this.store.db.run("DELETE FROM scheduled_session_tasks WHERE logical_session_id=?", [sessionId]);
          this.store.db.run("UPDATE agent_operations SET text='',source_json='{}',execution_evidence_json=NULL,last_error=NULL WHERE session_id=?", [sessionId]);
          for (const table of ["session_items", "session_events", "session_logs", "provider_event_inbox", "event_outbox", "message_deliveries", "session_turns", "session_execution_plan_state"]) {
            this.store.db.run(`DELETE FROM ${table} WHERE session_id=?`, [sessionId]);
          }
          for (const table of ["session_memory_topics", "memory_extraction_progress", "memory_backfill_progress", "memory_extraction_jobs"]) {
            this.store.db.run(`DELETE FROM ${table} WHERE session_id=?`, [sessionId]);
          }
          this.store.db.run("UPDATE session_recovery_attempts SET snapshot_json='{}',manifest_json=NULL,replacement_json=NULL,metrics_json='{}',error_message=NULL WHERE logical_session_id=?", [sessionId]);
          this.store.db.run("UPDATE logical_sessions SET session_name='',session_name_key=NULL WHERE logical_session_id=?", [sessionId]);
          this.store.db.run("DELETE FROM session_context_references WHERE owner_session_id=?", [sessionId]);
          this.store.db.run("DELETE FROM coordination_result_receipts WHERE execution_session_id=? OR recipient_session_id=?", [sessionId, sessionId]);
        }
        this.store.db.run("UPDATE sessions SET title='',summary='',raw_json='{}',active_choice_json=NULL WHERE id=?", [id]);
      }
      this.store.db.run("DELETE FROM execution_checklists WHERE task_id=?", [taskId]);
      this.store.db.run("UPDATE tasks SET title='',description='',acceptance_criteria='',verification_criteria='' WHERE id=?", [taskId]);
      this.store.db.run("UPDATE task_coordination_dispatches SET request_json='{}',runtime_json='{}',error_message=NULL WHERE target_task_id=? OR parent_task_id=?", [taskId, taskId]);
      // Delivery operations contain pinned inputs and temporary recovery state;
      // the user-facing result has already been copied to the main timeline.
      this.store.db.run("DELETE FROM child_task_delivery_operations WHERE child_task_id=?", [taskId]);
      this.store.db.run("DELETE FROM task_deletion_operations WHERE task_id=?", [taskId]);
      this.store.db.run("DELETE FROM coordination_shadow_reclamation WHERE task_id=?", [taskId]);
    });
    this.store.scheduleSave();
  }
}
