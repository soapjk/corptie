import { createdAtFromOrNow } from "../../utils/timestamps.mjs";

export function migrateWorkspaceCreationRequestAuditReferences({ selectOne, selectAll, db }) {
  const table = selectOne(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_creation_requests'"
  );
  if (!table || selectAll("PRAGMA foreign_key_list(workspace_creation_requests)").length === 0) return;
  // Audit rows retain the identities observed at request time. They must not
  // own or block deletion of live Agent/Session/Work/Workspace records.
  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  try {
    db.run(`
      CREATE TABLE workspace_creation_requests_audit_v1 (
        operation_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        actor_agent_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        logical_session_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        task_id TEXT,
        repository_id TEXT NOT NULL,
        target_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
        failure_stage TEXT,
        request_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (logical_session_id, idempotency_key)
      )
    `);
    db.run(`
      INSERT INTO workspace_creation_requests_audit_v1
      SELECT * FROM workspace_creation_requests
    `);
    db.run("DROP TABLE workspace_creation_requests");
    db.run("ALTER TABLE workspace_creation_requests_audit_v1 RENAME TO workspace_creation_requests");
    db.run(`CREATE INDEX idx_workspace_creation_requests_context
      ON workspace_creation_requests(work_id, source_session_id, created_at DESC)`);
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}

export function migrateTaskMemoryAssociations({ selectOne, runInTransaction, db }) {
  const migrationId = "task-memory-association-v1";
  if (selectOne("SELECT migration_id FROM data_migrations WHERE migration_id = ?", [migrationId])) {
    return;
  }
  const appliedAt = createdAtFromOrNow();
  runInTransaction(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS quarantined_task_memories (
        memory_id TEXT PRIMARY KEY,
        owner_id TEXT,
        source_session_id TEXT,
        reason TEXT NOT NULL,
        record_json TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      )
    `);
    db.run(
      `INSERT OR IGNORE INTO quarantined_task_memories (
         memory_id, owner_id, source_session_id, reason, record_json, quarantined_at
       )
       SELECT m.id, m.owner_id, m.source_session_id,
         CASE
           WHEN wi.id IS NULL THEN 'task_missing'
           WHEN wi.current_session_id IS NULL THEN 'task_not_started'
           WHEN s.id IS NULL THEN 'source_session_missing'
           ELSE 'source_session_binding_mismatch'
         END,
         json_object(
           'id', m.id, 'owner_type', m.owner_type, 'owner_id', m.owner_id,
           'kind', m.kind, 'content', m.content, 'structured_json', m.structured_json,
           'tags_json', m.tags_json, 'base_confidence', m.base_confidence,
           'confidence', m.confidence, 'recency_score', m.recency_score,
           'usage_count', m.usage_count, 'last_accessed_at', m.last_accessed_at,
           'source_type', m.source_type, 'source_session_id', m.source_session_id,
           'source_event_seqs_json', m.source_event_seqs_json,
           'promotion_status', m.promotion_status, 'promoted_skill_id', m.promoted_skill_id,
           'access_policy', m.access_policy, 'version', m.version,
           'auto_applied', m.auto_applied, 'applied_at', m.applied_at,
           'revoked_at', m.revoked_at, 'created_at', m.created_at, 'updated_at', m.updated_at
         ), ?
       FROM memories m
       LEFT JOIN tasks wi ON wi.id = m.owner_id
       LEFT JOIN sessions s ON s.id = m.source_session_id
       WHERE m.owner_type = 'task'
         AND (
           wi.id IS NULL OR wi.current_session_id IS NULL OR s.id IS NULL
           OR s.task_id IS NOT wi.id OR s.work_id IS NOT wi.work_id
         )`,
      [appliedAt]
    );
    db.run(`
      DELETE FROM memories
      WHERE owner_type = 'task'
        AND id IN (SELECT memory_id FROM quarantined_task_memories)
    `);
    db.run(`
      UPDATE memories
      SET task_id = CASE WHEN owner_type = 'task' THEN owner_id ELSE NULL END,
          source_event_sequence = CASE
            WHEN json_valid(source_event_seqs_json)
             AND json_array_length(source_event_seqs_json) = 1
            THEN json_extract(source_event_seqs_json, '$[0]')
            ELSE NULL
          END
    `);
    db.run(
      "INSERT INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
      [migrationId, appliedAt]
    );
  });
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_source_event
    ON memories(owner_type, owner_id, source_session_id, source_event_sequence)
    WHERE source_session_id IS NOT NULL AND source_event_sequence IS NOT NULL`);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS memories_task_insert_guard
    BEFORE INSERT ON memories
    WHEN (NEW.owner_type = 'task' AND (NEW.task_id IS NULL OR NEW.task_id IS NOT NEW.owner_id))
      OR (NEW.owner_type <> 'task' AND NEW.task_id IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid work item memory association');
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS memories_task_update_guard
    BEFORE UPDATE OF owner_type, owner_id, task_id ON memories
    WHEN (NEW.owner_type = 'task' AND (NEW.task_id IS NULL OR NEW.task_id IS NOT NEW.owner_id))
      OR (NEW.owner_type <> 'task' AND NEW.task_id IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid work item memory association');
    END
  `);
}

export function migrateSessionOwnedArtifacts({ selectAll, db, selectOne }) {
  // Session-owned Artifacts have no invented Work. Rebuild only the three
  // ownership/audit tables, preserving all columns, indexes and triggers.
  const tables = ["artifacts", "artifact_references", "artifact_audit_events"];
  const pending = tables.filter(table => selectAll(`PRAGMA table_info(${table})`)
    .some(column => column.name === "work_id" && column.notnull === 1));
  if (!pending.length) return;
  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  try {
    for (const table of pending) {
      const schema = selectOne("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [table]).sql;
      const dependents = selectAll("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL", [table]);
      const replacement = `${table}_session_owner_migration`;
      const create = schema.replace(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?[\"\x60]?${table}[\"\x60]?`, "i"), `CREATE TABLE ${replacement}`)
        .replace(/\bwork_id\s+TEXT\s+NOT NULL\b/i, "work_id TEXT");
      if (create === schema) throw new Error(`Cannot migrate ${table} ownership schema`);
      db.run(create);
      db.run(`INSERT INTO ${replacement} SELECT * FROM ${table}`);
      db.run(`DROP TABLE ${table}`);
      db.run(`ALTER TABLE ${replacement} RENAME TO ${table}`);
      for (const dependent of dependents) db.run(dependent.sql);
    }
    for (const table of [...tables, "artifact_versions"]) {
      if (selectAll(`PRAGMA foreign_key_check(${table})`).length) throw new Error(`Artifact migration foreign key failure: ${table}`);
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  } finally { db.run("PRAGMA foreign_keys = ON"); }
}
