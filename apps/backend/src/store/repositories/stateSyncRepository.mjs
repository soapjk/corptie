// Query operations use the Store-owned connection; this module opens no database.
export class StateSyncRepository {
  constructor({ selectOne, selectAll }) {
    this.selectOne = selectOne;
    this.selectAll = selectAll;
  }

  stateRevision() {
    return Number(this.selectOne(
      "SELECT revision FROM state_sync_clock WHERE singleton = 1"
    )?.revision ?? 0);
  }

  stateChangesAfter(revision) {
    return this.selectAll(
      `SELECT revision, entity_type, entity_id, operation, changed_at
       FROM state_change_log WHERE revision > ? ORDER BY revision ASC`,
      [Number(revision) || 0]
    ).map((row) => ({
      revision: Number(row.revision),
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation,
      changedAt: row.changed_at
    }));
  }

  oldestStateChangeRevision() {
    const row = this.selectOne("SELECT MIN(revision) AS revision FROM state_change_log");
    return row?.revision == null ? this.stateRevision() : Number(row.revision);
  }

  stateConsistencyIssues() {
    return this.selectAll(`
      SELECT 'worker_session_work_missing' AS code, s.id AS entity_id,
             s.task_id AS reference_id
      FROM sessions s
      WHERE s.deleted_at IS NULL AND s.session_kind='worker'
        AND (s.work_id IS NULL OR TRIM(s.work_id)='')
      UNION ALL
      SELECT 'worker_session_task_missing', s.id, s.work_id
      FROM sessions s
      WHERE s.deleted_at IS NULL AND s.session_kind='worker'
        AND (s.task_id IS NULL OR TRIM(s.task_id)='')
      UNION ALL
      SELECT 'task_current_session_missing', wi.id,
             wi.current_session_id AS reference_id
      FROM tasks wi
      LEFT JOIN sessions s ON s.id = wi.current_session_id AND s.deleted_at IS NULL
      WHERE wi.current_session_id IS NOT NULL AND s.id IS NULL
      UNION ALL
      SELECT 'task_session_binding_mismatch', wi.id, wi.current_session_id
      FROM tasks wi
      JOIN sessions s ON s.id = wi.current_session_id
      WHERE s.deleted_at IS NOT NULL
        OR s.task_id IS NOT wi.id OR s.work_id IS NOT wi.work_id
      UNION ALL
      SELECT 'session_task_missing', s.id, s.task_id
      FROM sessions s
      LEFT JOIN tasks wi ON wi.id = s.task_id
      WHERE s.deleted_at IS NULL AND s.task_id IS NOT NULL AND wi.id IS NULL
      UNION ALL
      SELECT 'session_work_mismatch', s.id, s.task_id
      FROM sessions s
      JOIN tasks wi ON wi.id = s.task_id
      WHERE s.deleted_at IS NULL AND s.work_id IS NOT wi.work_id
      UNION ALL
      SELECT 'memory_task_association_mismatch', m.id, m.task_id
      FROM memories m
      LEFT JOIN tasks wi ON wi.id = m.task_id
      WHERE m.owner_type = 'task'
        AND (wi.id IS NULL OR m.task_id IS NOT m.owner_id)
      UNION ALL
      SELECT 'memory_source_session_binding_mismatch', m.id, m.source_session_id
      FROM memories m
      LEFT JOIN sessions s ON s.id = m.source_session_id
      LEFT JOIN tasks wi ON wi.id = m.task_id
      WHERE m.owner_type = 'task'
        AND (s.id IS NULL OR s.task_id IS NOT wi.id OR s.work_id IS NOT wi.work_id)
      UNION ALL
      SELECT 'integration_conflict_task_missing', r.id, r.conflict_task_id
      FROM project_integration_runs r
      LEFT JOIN tasks wi ON wi.id = r.conflict_task_id
      WHERE r.conflict_task_id IS NOT NULL AND wi.id IS NULL
      UNION ALL
      SELECT 'integration_conflict_session_missing', r.id, r.conflict_session_id
      FROM project_integration_runs r
      LEFT JOIN sessions s ON s.id = r.conflict_session_id
      WHERE r.conflict_session_id IS NOT NULL AND s.id IS NULL
      UNION ALL
      SELECT 'integration_conflict_binding_mismatch', r.id, r.conflict_session_id
      FROM project_integration_runs r
      JOIN sessions s ON s.id = r.conflict_session_id
      WHERE r.conflict_task_id IS NULL OR s.task_id IS NOT r.conflict_task_id
    `).map((row) => ({
      code: row.code,
      entityId: row.entity_id,
      referenceId: row.reference_id
    }));
  }
}
