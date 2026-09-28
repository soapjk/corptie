// Uses the caller-owned migration connection; no transaction or startup reordering.
export function ensureStateSyncTables({ db }) {
  db.run(`
    CREATE TABLE IF NOT EXISTS state_sync_clock (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO state_sync_clock (singleton, revision) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS state_change_log (
      revision INTEGER PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
      changed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_state_change_log_entity
    ON state_change_log(entity_type, entity_id, revision DESC);

    CREATE TABLE IF NOT EXISTS session_timeline_revisions (
      session_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS session_timeline_change_log (
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
      changed_at TEXT NOT NULL,
      PRIMARY KEY (session_id, revision),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_timeline_change_item
    ON session_timeline_change_log(session_id, item_id, revision DESC);
  `);

  // Existing materialized timelines start at one baseline revision. Their
  // individual historical mutations predate this protocol and are recovered
  // through the stored snapshot endpoint rather than fabricated change rows.
  db.run(`
    INSERT OR IGNORE INTO session_timeline_revisions (session_id, revision, updated_at)
    SELECT sessions.id,
           CASE WHEN EXISTS (
             SELECT 1 FROM session_items WHERE session_items.session_id = sessions.id
           ) THEN 1 ELSE 0 END,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM sessions
  `);

  const tracked = [
    ["sessions", "session", "id"],
    ["tasks", "task", "id"],
    ["works", "work", "id"],
    ["agents", "agent", "agent_id"],
    ["skill_registry", "skill", "skill_id"],
    ["git_repositories", "repository", "repository_id"],
    ["project_integration_runs", "integrationRun", "id"],
    // Artifact collections are fetched through their dedicated paginated
    // endpoints, so the State stream carries invalidations instead of the
    // potentially large content projection. All three authoritative tables
    // use artifact_id to collapse one publish/repin transaction into one
    // client refresh signal.
    ["artifacts", "artifact", "artifact_id"],
    ["artifact_versions", "artifact", "artifact_id"],
    ["artifact_references", "artifact", "artifact_id"]
  ];
  const noOpUpdateGuards = {
    sessions: [
      "id", "title", "agent", "provider", "command", "args_json", "cwd", "status",
      "progress", "summary", "accent", "created_at", "updated_at", "archived", "pinned",
      "sort_order", "active_choice_json", "raw_json", "work_id", "task_id",
      "session_kind", "agent_id", "archive_dependency_version", "deleted_at"
    ],
    agents: [
      "agent_id", "name", "description", "status", "capabilities_json", "current_session_id",
      "created_at", "updated_at", "role", "system_prompt", "work_dir", "avatar_path", "agent_kind"
    ]
  };
  for (const [table, entityType, idColumn] of tracked) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const suffix = operation.toLowerCase();
      const row = operation === "DELETE" ? "OLD" : "NEW";
      const changeOperation = operation === "DELETE" ? "delete" : "upsert";
      const guardedColumns = operation === "UPDATE" ? noOpUpdateGuards[table] : null;
      if (guardedColumns) {
        // Trigger definitions predate IF-NOT-EXISTS migrations. Recreate the
        // two high-frequency projection triggers so existing databases gain
        // the no-op guard as well as newly created stores.
        db.run(`DROP TRIGGER IF EXISTS state_sync_${table}_${suffix}`);
      }
      const when = guardedColumns
        ? `WHEN ${guardedColumns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}`
        : "";
      db.run(`
        CREATE TRIGGER IF NOT EXISTS state_sync_${table}_${suffix}
        AFTER ${operation} ON ${table}
        ${when}
        BEGIN
          UPDATE state_sync_clock SET revision = revision + 1 WHERE singleton = 1;
          INSERT INTO state_change_log (revision, entity_type, entity_id, operation, changed_at)
          SELECT revision, '${entityType}', ${row}.${idColumn}, '${changeOperation}',
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          FROM state_sync_clock WHERE singleton = 1;
          DELETE FROM state_change_log
          WHERE revision < MAX(0, (SELECT revision FROM state_sync_clock WHERE singleton = 1) - 10000);
        END;
      `);
    }
  }
  // Worker presentation is derived from its Task. Touch a projection-only
  // dependency counter whenever Task fields used by the Session projection
  // change, so the ordinary Session stream publishes the new presentation
  // without rewriting conversation ordering metadata.
  db.run("DROP TRIGGER IF EXISTS state_sync_worker_archive_dependency_update");
  db.run(`
    CREATE TRIGGER state_sync_worker_archive_dependency_update
    AFTER UPDATE OF title, lifecycle_state, archived ON tasks
    WHEN (OLD.lifecycle_state = 'done') IS NOT (NEW.lifecycle_state = 'done')
      OR OLD.archived IS NOT NEW.archived
      OR OLD.title IS NOT NEW.title
    BEGIN
      UPDATE sessions
      SET archive_dependency_version = archive_dependency_version + 1
      WHERE session_kind = 'worker' AND task_id = NEW.id;
    END
  `);
  // Work Chat presentation is derived from its Work name. Reuse the same
  // generic projection dependency counter (its legacy name predates this
  // broader role) so incremental clients receive the renamed Session.
  db.run("DROP TRIGGER IF EXISTS state_sync_work_chat_presentation_dependency_update");
  db.run(`
    CREATE TRIGGER state_sync_work_chat_presentation_dependency_update
    AFTER UPDATE OF name ON works
    WHEN OLD.name IS NOT NEW.name
    BEGIN
      UPDATE sessions
      SET archive_dependency_version = archive_dependency_version + 1
      WHERE session_kind = 'workChat' AND work_id = NEW.id;
    END
  `);
  // A scheduled wake is projected on its owning Corptie Task row. Keep that
  // derived UI state on the ordinary Task change stream instead of adding a
  // second collection for every client to join. Only fields that can change
  // whether the wake is pending invalidate the Task; scheduler leases and
  // run-history bookkeeping must not cause list-wide render churn.
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const suffix = operation.toLowerCase();
    const row = operation === "DELETE" ? "OLD" : "NEW";
    const when = operation === "UPDATE"
      ? `WHEN OLD.logical_session_id IS NOT NEW.logical_session_id
           OR OLD.environment IS NOT NEW.environment
           OR OLD.status IS NOT NEW.status
           OR OLD.next_run_at IS NOT NEW.next_run_at
           OR OLD.expires_at IS NOT NEW.expires_at`
      : "";
    db.run(`DROP TRIGGER IF EXISTS state_sync_scheduled_session_tasks_${suffix}`);
    db.run(`
      CREATE TRIGGER state_sync_scheduled_session_tasks_${suffix}
      AFTER ${operation} ON scheduled_session_tasks
      ${when}
      BEGIN
        UPDATE state_sync_clock
        SET revision = revision + 1
        WHERE singleton = 1 AND EXISTS (
          SELECT 1
          FROM logical_sessions logical
          JOIN sessions session ON session.id = logical.legacy_session_id
          WHERE logical.logical_session_id = ${row}.logical_session_id
        );
        INSERT INTO state_change_log (revision, entity_type, entity_id, operation, changed_at)
        SELECT clock.revision, 'session', session.id, 'upsert',
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM state_sync_clock clock
        JOIN logical_sessions logical ON logical.logical_session_id = ${row}.logical_session_id
        JOIN sessions session ON session.id = logical.legacy_session_id
        WHERE clock.singleton = 1;
        UPDATE state_sync_clock SET revision = revision + 1
        WHERE singleton = 1 AND EXISTS (
          SELECT 1 FROM logical_sessions logical
          JOIN sessions session ON session.id = logical.legacy_session_id
          WHERE logical.logical_session_id = ${row}.logical_session_id
            AND session.task_id IS NOT NULL
        );
        INSERT INTO state_change_log (revision, entity_type, entity_id, operation, changed_at)
        SELECT clock.revision, 'task', session.task_id, 'upsert',
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM state_sync_clock clock
        JOIN logical_sessions logical ON logical.logical_session_id = ${row}.logical_session_id
        JOIN sessions session ON session.id = logical.legacy_session_id
        WHERE clock.singleton = 1 AND session.task_id IS NOT NULL;
        DELETE FROM state_change_log
        WHERE revision < MAX(0, (SELECT revision FROM state_sync_clock WHERE singleton = 1) - 10000);
      END
    `);
  }
  // Read-receipt mutations change the client-visible Session projection but
  // must never rewrite sessions.updated_at (which drives conversation order).
  for (const operation of ["INSERT", "UPDATE"]) {
    const suffix = operation.toLowerCase();
    db.run(`
      CREATE TRIGGER IF NOT EXISTS state_sync_session_read_receipts_${suffix}
      AFTER ${operation} ON session_read_receipts
      BEGIN
        UPDATE state_sync_clock SET revision = revision + 1 WHERE singleton = 1;
        INSERT INTO state_change_log (revision, entity_type, entity_id, operation, changed_at)
        SELECT revision, 'session', NEW.session_id, 'upsert',
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM state_sync_clock WHERE singleton = 1;
      END;
    `);
  }
  // A completed Agent message advances the unread cursor even when no
  // sessions column changes in the same transaction.
  db.run(`
    CREATE TRIGGER IF NOT EXISTS state_sync_session_events_agent_message_insert
    AFTER INSERT ON session_events
    WHEN NEW.has_agent_message = 1
    BEGIN
      UPDATE state_sync_clock SET revision = revision + 1 WHERE singleton = 1;
      INSERT INTO state_change_log (revision, entity_type, entity_id, operation, changed_at)
      SELECT revision, 'session', NEW.session_id, 'upsert',
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM state_sync_clock WHERE singleton = 1;
    END;
  `);
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const suffix = operation.toLowerCase();
    const row = operation === "DELETE" ? "OLD" : "NEW";
    const changeOperation = operation === "DELETE" ? "delete" : "upsert";
    db.run(`
      CREATE TRIGGER IF NOT EXISTS session_timeline_${suffix}
      AFTER ${operation} ON session_items
      WHEN EXISTS (SELECT 1 FROM sessions WHERE id = ${row}.session_id)
      BEGIN
        INSERT INTO session_timeline_revisions (session_id, revision, updated_at)
        VALUES (${row}.session_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(session_id) DO UPDATE SET
          revision = session_timeline_revisions.revision + 1,
          updated_at = excluded.updated_at;
        INSERT INTO session_timeline_change_log (
          session_id, revision, item_id, operation, changed_at
        )
        SELECT ${row}.session_id, revision, ${row}.id, '${changeOperation}', updated_at
        FROM session_timeline_revisions WHERE session_id = ${row}.session_id;
        DELETE FROM session_timeline_change_log
        WHERE session_id = ${row}.session_id
          AND revision < MAX(0, (
            SELECT revision FROM session_timeline_revisions
            WHERE session_id = ${row}.session_id
          ) - 2000);
      END;
    `);
  }
  // A bounded durable replay window is sufficient because clients fall back
  // to /state/snapshot when their cursor predates it.
  db.run(`
    DELETE FROM state_change_log
    WHERE revision < MAX(0, (SELECT revision FROM state_sync_clock WHERE singleton = 1) - 10000)
  `);

  // Agent↔Skill assignments are part of the Agent wire model. Link changes
  // therefore publish Agent upserts even though the agents row itself is not
  // rewritten. Cascade deletes from skill_registry use the same triggers.
  for (const operation of ["INSERT", "DELETE"]) {
    const suffix = operation.toLowerCase();
    const row = operation === "DELETE" ? "OLD" : "NEW";
    db.run(`
      CREATE TRIGGER IF NOT EXISTS state_sync_agent_skill_links_${suffix}
      AFTER ${operation} ON agent_skill_links
      BEGIN
        UPDATE state_sync_clock SET revision = revision + 1 WHERE singleton = 1;
        INSERT INTO state_change_log (revision, entity_type, entity_id, operation, changed_at)
        SELECT revision, 'agent', ${row}.agent_id, 'upsert',
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM state_sync_clock WHERE singleton = 1;
      END;
      `);
    }
}
