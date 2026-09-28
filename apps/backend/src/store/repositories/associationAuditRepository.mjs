import { createdAtFromOrNow } from "../../utils/timestamps.mjs";

// Shared connection and transaction ownership remain with Store.
export class AssociationAuditRepository {
  constructor({ getDatabase, selectAll, runInTransaction, listWorks, getWorkspace, getAgent, listTasks, getWork }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.runInTransaction = runInTransaction;
    this.listWorks = listWorks;
    this.getWorkspace = getWorkspace;
    this.getAgent = getAgent;
    this.listTasks = listTasks;
    this.getWork = getWork;
  }

  get db() { return this.getDatabase(); }

  auditWorkTaskAssociations() {
    const auditedAt = createdAtFromOrNow();
    this.runInTransaction(() => {
      this.db.run("DELETE FROM work_task_association_audit WHERE status = 'unresolved'");

      for (const work of this.listWorks()) {
        if (!this.getWorkspace(work.workspaceId)) {
          this.recordAssociationAudit({
            entityType: "work", entityId: work.id, field: "workspaceId",
            receivedValue: work.workspaceId, status: "unresolved",
            reason: "workspace_not_found", auditedAt
          });
        }
        if (work.contributorAgentIds.length === 0) {
          this.recordAssociationAudit({
            entityType: "work", entityId: work.id, field: "contributorAgentIds",
            receivedValue: null, status: "unresolved",
            reason: "contributor_required", auditedAt
          });
        }
        for (const agentId of work.contributorAgentIds) {
          const agent = this.getAgent(agentId);
          if (!agent || agent.status !== "available") {
            this.recordAssociationAudit({
              entityType: "work", entityId: work.id, field: "contributorAgentIds",
              receivedValue: agentId, status: "unresolved",
              reason: !agent ? "agent_not_found" : "agent_not_assignable", auditedAt
            });
          }
        }
      }

      for (const task of this.listTasks()) {
        const work = this.getWork(task.work_id);
        if (!work) {
          this.recordAssociationAudit({
            entityType: "task", entityId: task.id, field: "workId",
            receivedValue: task.work_id, status: "unresolved",
            reason: "work_not_found", auditedAt
          });
          continue;
        }
        if (task.main_agent_id && !work.contributorAgentIds.includes(task.main_agent_id)) {
          this.recordAssociationAudit({
            entityType: "task", entityId: task.id, field: "mainAgentId",
            receivedValue: task.main_agent_id, status: "unresolved",
            reason: "agent_outside_work_scope", auditedAt
          });
        }
      }
    });
    return this.listWorkTaskAssociationAudit();
  }

  recordAssociationAudit(input) {
    const receivedValue = input.receivedValue == null
      ? null
      : typeof input.receivedValue === "string" ? input.receivedValue : JSON.stringify(input.receivedValue);
    const auditId = [input.entityType, input.entityId, input.field, receivedValue ?? "<null>"].join("|");
    this.db.run(
      `INSERT INTO work_task_association_audit (
         audit_id, entity_type, entity_id, field, received_value, status, reason,
         migrated_value, first_audited_at, last_audited_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(audit_id) DO UPDATE SET
         status=excluded.status,
         reason=excluded.reason,
         migrated_value=excluded.migrated_value,
         last_audited_at=excluded.last_audited_at`,
      [
        auditId, input.entityType, input.entityId, input.field, receivedValue,
        input.status, input.reason, input.migratedValue ?? null, input.auditedAt, input.auditedAt
      ]
    );
  }

  listWorkTaskAssociationAudit(options = {}) {
    const rows = options.status
      ? this.selectAll(
        `SELECT * FROM work_task_association_audit WHERE status = ?
         ORDER BY entity_type, entity_id, field, received_value`,
        [options.status]
      )
      : this.selectAll(
        `SELECT * FROM work_task_association_audit
         ORDER BY status, entity_type, entity_id, field, received_value`
      );
    return rows.map((row) => ({
      auditId: row.audit_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      field: row.field,
      receivedValue: row.received_value,
      status: row.status,
      reason: row.reason,
      migratedValue: row.migrated_value,
      firstAuditedAt: row.first_audited_at,
      lastAuditedAt: row.last_audited_at
    }));
  }
}
