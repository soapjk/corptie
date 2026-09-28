export function migrateSessionAssociationGuards({ db, runDataMigrationOnce }) {
    db.run(`UPDATE sessions SET agent_id = (
        SELECT bindings.agent_id FROM agent_sessions bindings
        WHERE bindings.session_id = sessions.id
        ORDER BY bindings.bound_at DESC LIMIT 1
      ) WHERE agent_id IS NULL OR TRIM(agent_id) = ''`);
    db.run(`UPDATE sessions SET session_kind = 'worker'
      WHERE task_id IS NOT NULL AND TRIM(task_id) <> ''
        AND (session_kind IS NULL OR TRIM(session_kind) = ''
          OR session_kind NOT IN ('assistantChat', 'workChat', 'worker'))`);
    db.run(`UPDATE sessions SET session_kind = 'workChat'
      WHERE work_id IS NOT NULL AND TRIM(work_id) <> ''
        AND (task_id IS NULL OR TRIM(task_id) = '')
        AND (session_kind IS NULL OR TRIM(session_kind) = ''
          OR session_kind NOT IN ('assistantChat', 'workChat', 'worker'))`);
    // Work discussion is a one-to-one association. Preserve the oldest
    // discussion as canonical and retain historical duplicates as ordinary,
    // unbound chats before installing the durable uniqueness guard.
    db.run(`UPDATE sessions AS duplicate
      SET work_id = NULL, session_kind = 'assistantChat'
      WHERE duplicate.session_kind = 'workChat'
        AND duplicate.deleted_at IS NULL
        AND duplicate.work_id IS NOT NULL
        AND TRIM(duplicate.work_id) <> ''
        AND EXISTS (
          SELECT 1 FROM sessions AS canonical
          WHERE canonical.session_kind = 'workChat'
            AND canonical.deleted_at IS NULL
            AND canonical.work_id = duplicate.work_id
            AND (
              canonical.created_at < duplicate.created_at
              OR (canonical.created_at = duplicate.created_at AND canonical.id < duplicate.id)
            )
        )`);
    runDataMigrationOnce("sessions-active-work-chat-index-v1", () => {
      db.run("DROP INDEX IF EXISTS idx_sessions_work_chat");
      db.run(`CREATE UNIQUE INDEX idx_sessions_work_chat
        ON sessions(work_id)
        WHERE session_kind = 'workChat'
          AND work_id IS NOT NULL
          AND deleted_at IS NULL`);
    });
    db.run(`UPDATE sessions SET session_kind = 'assistantChat'
      WHERE (session_kind IS NULL OR TRIM(session_kind) = ''
          OR session_kind NOT IN ('assistantChat', 'workChat', 'worker'))
        AND task_id IS NULL AND work_id IS NULL`);
    db.run(`UPDATE sessions SET session_kind = 'legacy'
      WHERE session_kind IS NULL OR TRIM(session_kind) = ''
        OR session_kind NOT IN ('assistantChat', 'workChat', 'worker', 'legacy')`);
    db.run("DROP TRIGGER IF EXISTS sessions_worker_association_insert_guard");
    db.run("DROP TRIGGER IF EXISTS sessions_worker_association_update_guard");
    db.run("DROP TRIGGER IF EXISTS sessions_work_chat_association_insert_guard");
    db.run("DROP TRIGGER IF EXISTS sessions_work_chat_association_update_guard");
    db.run(`CREATE TRIGGER sessions_worker_association_insert_guard
      BEFORE INSERT ON sessions
      WHEN NEW.session_kind = 'worker'
      BEGIN
        SELECT CASE
          WHEN NEW.work_id IS NULL OR TRIM(NEW.work_id) = ''
            OR NEW.task_id IS NULL OR TRIM(NEW.task_id) = ''
          THEN RAISE(ABORT, 'WORKER_SESSION_ASSOCIATION_REQUIRED')
          WHEN NOT EXISTS (
            SELECT 1 FROM tasks wi
            JOIN works o ON o.id = wi.work_id
            WHERE wi.id = NEW.task_id AND wi.work_id = NEW.work_id
          )
          THEN RAISE(ABORT, 'SESSION_TASK_WORK_MISMATCH')
        END;
      END`);
    db.run(`CREATE TRIGGER sessions_worker_association_update_guard
      BEFORE UPDATE OF session_kind, work_id, task_id ON sessions
      WHEN NEW.session_kind = 'worker' AND (
        OLD.session_kind IS NOT NEW.session_kind
        OR OLD.work_id IS NOT NEW.work_id
        OR OLD.task_id IS NOT NEW.task_id
      )
      BEGIN
        SELECT CASE
          WHEN NEW.work_id IS NULL OR TRIM(NEW.work_id) = ''
            OR NEW.task_id IS NULL OR TRIM(NEW.task_id) = ''
          THEN RAISE(ABORT, 'WORKER_SESSION_ASSOCIATION_REQUIRED')
          WHEN NOT EXISTS (
            SELECT 1 FROM tasks wi
            JOIN works o ON o.id = wi.work_id
            WHERE wi.id = NEW.task_id AND wi.work_id = NEW.work_id
          )
          THEN RAISE(ABORT, 'SESSION_TASK_WORK_MISMATCH')
        END;
      END`);
    db.run(`CREATE TRIGGER sessions_work_chat_association_insert_guard
      BEFORE INSERT ON sessions
      WHEN NEW.session_kind = 'workChat'
      BEGIN
        SELECT CASE
          WHEN NEW.work_id IS NULL OR TRIM(NEW.work_id) = '' OR NEW.task_id IS NOT NULL
          THEN RAISE(ABORT, 'WORK_CHAT_ASSOCIATION_INVALID')
          WHEN NOT EXISTS (SELECT 1 FROM works WHERE id = NEW.work_id)
          THEN RAISE(ABORT, 'WORK_CHAT_WORK_NOT_FOUND')
        END;
      END`);
    db.run(`CREATE TRIGGER sessions_work_chat_association_update_guard
      BEFORE UPDATE OF session_kind, work_id, task_id ON sessions
      WHEN NEW.session_kind = 'workChat'
      BEGIN
        SELECT CASE
          WHEN NEW.work_id IS NULL OR TRIM(NEW.work_id) = '' OR NEW.task_id IS NOT NULL
          THEN RAISE(ABORT, 'WORK_CHAT_ASSOCIATION_INVALID')
          WHEN NOT EXISTS (SELECT 1 FROM works WHERE id = NEW.work_id)
          THEN RAISE(ABORT, 'WORK_CHAT_WORK_NOT_FOUND')
        END;
      END`);
}
