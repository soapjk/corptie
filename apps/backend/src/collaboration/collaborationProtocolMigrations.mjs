import { parseJson } from "./collaborationRecordProjection.mjs";

// Ordered, idempotent compatibility migrations. Resource creation uses the same
// domain operations as normal collaboration; SQL and migration receipts live here.
export function migrateCollaborationProtocol({
  store, clock, requireAgent, workForSession, ensureCompatibilityWork, isAssignableContributor, ensureWorkContributor, ensureCollaborationTask, syncTaskStatus
}) {
  const legacy = migrateLegacyCollaborationRequests();
  const result = migrateSessionActorProtocol();
  if (store.db) recordChannelSchemaMigration();
  return legacy.status === "applied" ? legacy : result;

  function migrateLegacyCollaborationRequests() {
    const migrationId = "collaboration-work-task-v2";
    if (!store.db) {
      return { status: "deferred", migrationId, migratedTaskCount: 0 };
    }
    if (store.selectOne(
      "SELECT migration_id FROM data_migrations WHERE migration_id = ?",
      [migrationId]
    )) {
      return { status: "already-applied", migrationId, migratedTaskCount: 0 };
    }
    const rows = store.selectAll(
      `SELECT * FROM collaboration_requests
       WHERE protocol_version = '1.0' OR source_work_id IS NULL OR target_work_id IS NULL OR target_task_id IS NULL`
    );
    return store.runInTransaction(() => {
      for (const row of rows) {
        const initiator = requireAgent(row.initiator_agent_id);
        const recipient = requireAgent(row.recipient_agent_id);
        const sourceWorkId = workForSession(row.initiator_session_id)
          ?? ensureCompatibilityWork(initiator).id;
        let targetWorkId = workForSession(row.recipient_session_id)
          ?? ensureCompatibilityWork(recipient).id;
        if (targetWorkId === sourceWorkId) {
          targetWorkId = ensureCompatibilityWork(recipient).id;
        }
        if (isAssignableContributor(initiator)) {
          ensureWorkContributor(sourceWorkId, initiator.agentId);
        }
        if (isAssignableContributor(recipient)) {
          ensureWorkContributor(targetWorkId, recipient.agentId);
        }
        const task = ensureCollaborationTask({
          requestedTaskId: row.target_task_id,
          taskId: row.task_id,
          targetWorkId,
          recipientAgentId: isAssignableContributor(recipient) ? recipient.agentId : null,
          title: row.title,
          summary: row.summary,
          acceptanceCriteria: parseJson(row.acceptance_criteria_json, []),
          // Legacy Task state is not Task review state. The Task migration
          // may create the resource, but only Task workflows may advance or
          // cancel it.
          lifecycleState: "todo"
        });
        store.db.run(
          `UPDATE collaboration_requests SET protocol_version = ?, source_work_id = ?,
           target_work_id = ?, target_task_id = ? WHERE task_id = ?`,
          ["2.0", sourceWorkId, targetWorkId, task.id, row.task_id]
        );
        const messages = store.selectAll(
          "SELECT * FROM collaboration_messages WHERE task_id = ? ORDER BY created_at, message_id",
          [row.task_id]
        );
        for (const message of messages) {
          const forward = message.sender_agent_id === row.initiator_agent_id;
          const messageSourceWorkId = forward ? sourceWorkId : targetWorkId;
          const messageTargetWorkId = forward ? targetWorkId : sourceWorkId;
          const payload = {
            body: message.body,
            evidence: parseJson(message.evidence_json, []),
            resourceVersion: message.resource_version || null
          };
          store.db.run(
            `UPDATE collaboration_messages SET protocol_version = ?, source_work_id = ?,
             target_work_id = ?, source_task_id = ?, target_task_id = ?, payload_json = ?, error_json = ?
             WHERE message_id = ?`,
            [
              "2.0", messageSourceWorkId, messageTargetWorkId,
              row.source_task_id || null, task.id, JSON.stringify(payload),
              message.error_json, message.message_id
            ]
          );
        }
        syncTaskStatus(task.id, row.task_id, row.status, row.updated_at);
      }
      store.db.run(
        "INSERT INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
        [migrationId, new Date().toISOString()]
      );
      store.scheduleSave();
      return { status: "applied", migrationId, migratedTaskCount: rows.length };
    });
  }

  function migrateSessionActorProtocol() {
    const migrationId = "collaboration-session-actors-v3";
    if (!store.db) return { status: "deferred", migrationId, migratedTaskCount: 0 };
    if (store.selectOne("SELECT migration_id FROM data_migrations WHERE migration_id = ?", [migrationId])) {
      return { status: "already-applied", migrationId, migratedTaskCount: 0 };
    }
    const rows = store.selectAll(
      `SELECT task_id FROM collaboration_requests
       WHERE initiator_session_id IS NOT NULL AND TRIM(initiator_session_id) <> ''
         AND recipient_session_id IS NOT NULL AND TRIM(recipient_session_id) <> ''
         AND initiator_session_id <> recipient_session_id`
    );
    return store.runInTransaction(() => {
      for (const row of rows) {
        store.db.run("UPDATE collaboration_requests SET protocol_version='3.0' WHERE task_id=?", [row.task_id]);
        store.db.run(
          `UPDATE collaboration_messages SET protocol_version='3.0'
           WHERE task_id=? AND sender_session_id IS NOT NULL AND recipient_session_id IS NOT NULL
             AND sender_session_id <> recipient_session_id`,
          [row.task_id]
        );
      }
      store.db.run("INSERT INTO data_migrations (migration_id, applied_at) VALUES (?, ?)", [migrationId, clock()]);
      store.scheduleSave();
      return { status: "applied", migrationId, migratedTaskCount: rows.length };
    });
  }

  function recordChannelSchemaMigration() {
    const migrationId = "collaboration-session-channels-v1";
    store.db.run(
      "INSERT OR IGNORE INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
      [migrationId, clock()]
    );
    if (store.db.getRowsModified() > 0) store.scheduleSave();
  }
}
