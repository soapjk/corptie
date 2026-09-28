export function migrateSessionLogsForeignKey({ selectOne, db }) {
  const table = selectOne(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_logs'"
  );
  if (!table?.sql || !/REFERENCES\s+sessions/i.test(table.sql)) return;

  db.run("BEGIN IMMEDIATE");
  try {
    db.run("ALTER TABLE session_logs RENAME TO session_logs_legacy");
    db.run(`
      CREATE TABLE session_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    db.run(`
      INSERT INTO session_logs (id, session_id, created_at)
      SELECT id, session_id, created_at FROM session_logs_legacy
    `);
    db.run("DROP TABLE session_logs_legacy");
    db.run("CREATE INDEX IF NOT EXISTS idx_session_logs_session_id ON session_logs(session_id)");
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

export function backfillSessionItemPresentation({ runDataMigrationOnce, db }) {
  runDataMigrationOnce("session-item-presentation-v1", () => {
    db.run(`
      UPDATE session_items
      SET presentation_role = COALESCE(
        json_extract(raw_metadata_json, '$.payload.phase'),
        json_extract(raw_metadata_json, '$.payload.presentationRole')
      )
      WHERE presentation_role IS NULL
        AND raw_metadata_json IS NOT NULL
        AND json_valid(raw_metadata_json) = 1
        AND COALESCE(
          json_extract(raw_metadata_json, '$.payload.phase'),
          json_extract(raw_metadata_json, '$.payload.presentationRole')
        ) IS NOT NULL
    `);
  });
}

export function backfillSessionItemBindings({ runDataMigrationOnce, db }) {
  runDataMigrationOnce("session-item-binding-v1", () => {
    db.run(`
      UPDATE session_items
      SET binding_id = (
        SELECT bindings.binding_id
        FROM logical_sessions logical
        JOIN provider_thread_bindings bindings
          ON bindings.provider_thread_id = logical.active_thread_id
        WHERE logical.legacy_session_id = session_items.session_id
        LIMIT 1
      )
      WHERE binding_id IS NULL
    `);
  });
}

export function pruneHistoricalAutomationTimelineItems({ runDataMigrationOnce, db }) {
  runDataMigrationOnce("automation-timeline-whitelist-v1", () => {
    // Authoritative session_events and scheduled_session_events remain
    // untouched; this only removes obsolete derived Timeline cards.
    db.run(`
      DELETE FROM session_items
      WHERE type = 'automationEvent'
        AND (
          raw_metadata_json IS NULL
          OR json_valid(raw_metadata_json) = 0
          OR COALESCE(json_extract(raw_metadata_json, '$.automationEventType'), '')
            NOT IN (
              'ScheduledSessionTaskCreated',
              'ScheduledSessionTaskDue',
              'ScheduledSessionRunQueued'
            )
        )
    `);
  });
}

export function migrateSessionRecoverySchema({ ensureColumn, db }) {
  ensureColumn("provider_thread_bindings", "binding_generation", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("provider_thread_bindings", "capability_revision", "TEXT NOT NULL DEFAULT 'legacy:unknown'");
  db.run(`
    CREATE TABLE IF NOT EXISTS session_recovery_attempts (
      attempt_id TEXT PRIMARY KEY,
      logical_session_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'frozen', 'replacement_created', 'replaying', 'validated', 'committed',
        'cancel_requested', 'cancelled', 'failed', 'manual_required'
      )),
      snapshot_json TEXT NOT NULL,
      manifest_json TEXT,
      manifest_hash TEXT,
      replacement_json TEXT,
      metrics_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT,
      error_message TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (logical_session_id, idempotency_key),
      FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_session_recovery_resume
    ON session_recovery_attempts(state, updated_at);

    CREATE TABLE IF NOT EXISTS session_recovery_binding_audit (
      audit_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL UNIQUE,
      logical_session_id TEXT NOT NULL,
      old_binding_id TEXT NOT NULL,
      new_binding_id TEXT NOT NULL,
      old_provider_session_id TEXT NOT NULL,
      new_provider_session_id TEXT NOT NULL,
      old_routing_version INTEGER NOT NULL,
      new_routing_version INTEGER NOT NULL,
      old_binding_generation INTEGER NOT NULL,
      new_binding_generation INTEGER NOT NULL,
      capability_revision TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      FOREIGN KEY (attempt_id) REFERENCES session_recovery_attempts(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE RESTRICT
    );

    CREATE TRIGGER IF NOT EXISTS session_recovery_snapshot_immutable
    BEFORE UPDATE OF snapshot_json, logical_session_id, idempotency_key, created_at
    ON session_recovery_attempts
    BEGIN SELECT RAISE(ABORT, 'SESSION_RECOVERY_SNAPSHOT_IMMUTABLE'); END;

    CREATE TRIGGER IF NOT EXISTS session_recovery_audit_immutable_update
    BEFORE UPDATE ON session_recovery_binding_audit
    BEGIN SELECT RAISE(ABORT, 'SESSION_RECOVERY_AUDIT_IMMUTABLE'); END;

    CREATE TRIGGER IF NOT EXISTS session_recovery_audit_immutable_delete
    BEFORE DELETE ON session_recovery_binding_audit
    BEGIN SELECT RAISE(ABORT, 'SESSION_RECOVERY_AUDIT_IMMUTABLE'); END;
  `);
}

export function migrateSessionItemIdentity({ selectAll, db }) {
  const columns = selectAll("PRAGMA table_info(session_items)");
  const primaryKey = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
  if (primaryKey.length === 2
    && primaryKey[0] === "session_id"
    && primaryKey[1] === "id") {
    // A temporary compatibility index may be present when a migrated
    // database was still served by an older process using ON CONFLICT(id).
    // The composite-aware process must remove it before accepting writes so
    // unrelated Sessions can finally retain the same Provider item id.
    db.run("DROP INDEX IF EXISTS idx_session_items_legacy_global_id_compat");
    return;
  }

  for (const suffix of ["insert", "update", "delete"]) {
    db.run(`DROP TRIGGER IF EXISTS session_timeline_${suffix}`);
  }
  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  try {
    db.run("ALTER TABLE session_items RENAME TO session_items_global_id_legacy");
    db.run(`
      CREATE TABLE session_items (
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        turn_status TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        options_json TEXT,
        raw_metadata_json TEXT,
        binding_id TEXT,
        presentation_role TEXT,
        presentation_text TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);
    db.run(`
      INSERT INTO session_items (
        id, session_id, turn_id, turn_status, type, title, text,
        options_json, raw_metadata_json, binding_id, presentation_role, presentation_text,
        status, created_at
      )
      SELECT id, session_id, turn_id, turn_status, type, title, text,
             options_json, raw_metadata_json, binding_id, presentation_role, presentation_text,
             status, created_at
      FROM session_items_global_id_legacy
    `);
    db.run("DROP TABLE session_items_global_id_legacy");
    db.run("CREATE INDEX idx_session_items_session_id ON session_items(session_id, created_at)");
    db.run("CREATE INDEX idx_session_items_latest ON session_items(session_id, created_at DESC, id DESC)");
    db.run("CREATE INDEX idx_session_items_turn_window ON session_items(session_id, turn_id, created_at, id)");
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}
