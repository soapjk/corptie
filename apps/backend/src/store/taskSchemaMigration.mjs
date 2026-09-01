const MIGRATION_ID = "task-domain-v1";

export function needsTaskDomainMigration(db) {
  return Boolean(table(db, "work_items") || hasColumn(db, "tasks", "status"));
}

export function migrateTaskDomainV1(db, now = new Date().toISOString()) {
  if (!needsTaskDomainMigration(db)) return { migrated: false, renamedTables: [], renamedColumns: [] };
  const migratingLegacyTable = Boolean(table(db, "work_items"));
  if (migratingLegacyTable && table(db, "tasks")) {
    throw new Error("TASK_DOMAIN_MIGRATION_CONFLICT: work_items and tasks both exist");
  }

  const renamedTables = [];
  const renamedColumns = [];
  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  try {
    if (migratingLegacyTable) {
      for (const [legacyName, taskName] of legacyTableRenames(db)) {
        db.run(`ALTER TABLE ${identifier(legacyName)} RENAME TO ${identifier(taskName)}`);
        renamedTables.push({ from: legacyName, to: taskName });
      }

      renameCollaborationRequestColumns(db, renamedColumns);
      renameProductTaskColumns(db, renamedColumns);
    }
    renameTaskLifecycleColumn(db, renamedColumns);
    migrateTaxonomyValues(db);
    createTaskSnapshotSchema(db);
    db.run(
      "INSERT INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
      [MIGRATION_ID, now]
    );
    const violations = db.all("PRAGMA foreign_key_check");
    if (violations.length > 0) {
      throw new Error(`TASK_DOMAIN_MIGRATION_FOREIGN_KEY_FAILURE: ${JSON.stringify(violations)}`);
    }
    db.run("COMMIT");
  } catch (error) {
    try { db.run("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
  return { migrated: true, renamedTables, renamedColumns };
}

function renameTaskLifecycleColumn(db, audit) {
  if (!table(db, "tasks")) return;
  const hasStatus = hasColumn(db, "tasks", "status");
  const hasLifecycleState = hasColumn(db, "tasks", "lifecycle_state");
  if (hasStatus && !hasLifecycleState) {
    renameColumn(db, "tasks", "status", "lifecycle_state", audit);
  } else if (hasStatus && hasLifecycleState) {
    db.run("DROP INDEX IF EXISTS idx_tasks_status");
    db.run("DROP TRIGGER IF EXISTS task_status_insert_guard");
    db.run("DROP TRIGGER IF EXISTS task_status_update_guard");
    db.run("DROP TRIGGER IF EXISTS task_completion_guard");
    db.run("DROP TRIGGER IF EXISTS state_sync_worker_archive_dependency_update");
    db.run("UPDATE tasks SET lifecycle_state=status");
    db.run("ALTER TABLE tasks DROP COLUMN status");
    audit.push({ table: "tasks", from: "status", to: "lifecycle_state", operation: "merged_and_dropped" });
  } else if (!hasStatus && !hasLifecycleState) {
    db.run("ALTER TABLE tasks ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'todo'");
    audit.push({ table: "tasks", from: null, to: "lifecycle_state", operation: "added" });
  }
  db.run(`UPDATE tasks SET lifecycle_state=CASE
    WHEN LOWER(TRIM(lifecycle_state)) IN ('done', 'complete', 'completed') THEN 'done'
    WHEN LOWER(TRIM(lifecycle_state)) IN ('in_progress', 'doing', 'running') THEN 'in_progress'
    ELSE 'todo' END`);
}

function legacyTableRenames(db) {
  const existing = db.all("SELECT name FROM sqlite_master WHERE type='table'")
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
  const renames = [];
  for (const name of existing) {
    let target = name;
    if (name === "collaboration_tasks") target = "collaboration_requests";
    else if (name === "agent_work_items") target = "agent_operations";
    else if (name === "work_items") target = "tasks";
    else if (name.includes("work_item")) target = name.replaceAll("work_item", "task");
    if (target === name) continue;
    if (existing.includes(target)) {
      throw new Error(`TASK_DOMAIN_MIGRATION_CONFLICT: ${name} and ${target} both exist`);
    }
    renames.push([name, target]);
  }
  // Rename child/audit tables first and the authoritative Task table last.
  return renames.sort(([left], [right]) => {
    if (left === "work_items") return 1;
    if (right === "work_items") return -1;
    return left.localeCompare(right);
  });
}

function renameCollaborationRequestColumns(db, audit) {
  if (!table(db, "collaboration_requests")) return;
  // The collaboration workflow keeps its established task_id column during
  // this product-domain migration. Product Task references are disambiguated
  // as source_task_id/target_task_id; a collaboration request is not a Task.
  renameColumn(db, "collaboration_requests", "work_item_id", "target_task_id", audit);
  renameColumn(db, "collaboration_requests", "source_work_item_id", "source_task_id", audit);
  if (table(db, "collaboration_messages")) {
    renameColumn(db, "collaboration_messages", "work_item_id", "target_task_id", audit);
    renameColumn(db, "collaboration_messages", "source_work_item_id", "source_task_id", audit);
  }

  for (const row of db.all("SELECT name FROM sqlite_master WHERE type='table'")) {
    const tableName = row.name;
    if (!tableName.startsWith("collaboration_")) continue;
    const foreignKeys = db.all(`PRAGMA foreign_key_list(${identifier(tableName)})`);
    for (const foreignKey of foreignKeys) {
      if (foreignKey.table !== "collaboration_requests") continue;
      // Foreign keys to the collaboration workflow remain task_id until that
      // protocol is independently versioned. They must not be confused with
      // product Task references.
    }
  }
}

function renameProductTaskColumns(db, audit) {
  for (const row of db.all("SELECT name FROM sqlite_master WHERE type='table'")) {
    const tableName = row.name;
    if (tableName.startsWith("sqlite_")) continue;
    const columns = db.all(`PRAGMA table_info(${identifier(tableName)})`)
      .map((column) => column.name);
    for (const column of columns) {
      if (!column.includes("work_item")) continue;
      renameColumn(db, tableName, column, column.replaceAll("work_item", "task"), audit);
    }
  }
}

function migrateTaxonomyValues(db) {
  if (table(db, "memories")) {
    db.run("UPDATE memories SET owner_type='task' WHERE owner_type='work_item'");
  }
  if (table(db, "artifacts")) {
    migrateArtifactTaxonomy(db);
  }
  if (table(db, "memory_events")) {
    db.run("UPDATE memory_events SET owner_type='task' WHERE owner_type='work_item'");
  }
}

function migrateArtifactTaxonomy(db) {
  const tableDefinition = db.get(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'"
  )?.sql;
  if (!tableDefinition) return;

  // The legacy table CHECK rejects task_private before an UPDATE can rewrite
  // existing rows. Rebuild the table inside the surrounding migration
  // transaction so the constraint and the values change atomically, without
  // creating a full-database backup.
  if (tableDefinition.includes("work_item_private")) {
    const temporaryTable = "artifacts_task_domain_v1";
    const dependentSchema = db.all(
      `SELECT type, name, sql FROM sqlite_master
       WHERE tbl_name='artifacts' AND type IN ('index', 'trigger') AND sql IS NOT NULL
       ORDER BY type, name`
    );
    const columns = db.all("PRAGMA table_info(artifacts)").map((column) => column.name);
    const createTemporaryTable = tableDefinition
      .replace(
        /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?artifacts["`\]]?/i,
        `CREATE TABLE ${identifier(temporaryTable)}`
      )
      .replaceAll("work_item_private", "task_private");
    if (createTemporaryTable === tableDefinition) {
      throw new Error("TASK_DOMAIN_ARTIFACT_SCHEMA_UNSUPPORTED");
    }

    db.run(createTemporaryTable);
    const columnList = columns.map(identifier).join(", ");
    const selectList = columns.map((column) => {
      if (column === "visibility") {
        return `CASE WHEN ${identifier(column)}='work_item_private' THEN 'task_private' ELSE ${identifier(column)} END`;
      }
      if (column === "scope") {
        return `CASE WHEN ${identifier(column)}='work_item' THEN 'task' ELSE ${identifier(column)} END`;
      }
      return identifier(column);
    }).join(", ");
    db.run(`INSERT INTO ${identifier(temporaryTable)} (${columnList})
      SELECT ${selectList} FROM artifacts`);
    db.run("DROP TABLE artifacts");
    db.run(`ALTER TABLE ${identifier(temporaryTable)} RENAME TO artifacts`);
    for (const item of dependentSchema) {
      db.run(item.sql.replaceAll("work_item_private", "task_private"));
    }
    return;
  }

  db.run("UPDATE artifacts SET scope='task' WHERE scope='work_item'");
  db.run("UPDATE artifacts SET visibility='task_private' WHERE visibility='work_item_private'");
}

function createTaskSnapshotSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS task_snapshots (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL DEFAULT '',
    acceptance_criteria TEXT NOT NULL DEFAULT '',
    verification_criteria TEXT NOT NULL DEFAULT '',
    acceptance_assessment_json TEXT NOT NULL DEFAULT '{}',
    completion_evidence_json TEXT NOT NULL DEFAULT '[]',
    execution_summary TEXT NOT NULL DEFAULT '',
    source_message_id TEXT,
    created_by_session_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(task_id, version),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by_session_id) REFERENCES sessions(id) ON DELETE RESTRICT
  )`);
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_task_snapshots_hash ON task_snapshots(task_id, content_hash)");
  db.run(`CREATE TRIGGER IF NOT EXISTS task_snapshots_immutable_update
    BEFORE UPDATE ON task_snapshots BEGIN SELECT RAISE(ABORT, 'TASK_SNAPSHOT_IMMUTABLE'); END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS task_snapshots_immutable_delete
    BEFORE DELETE ON task_snapshots BEGIN SELECT RAISE(ABORT, 'TASK_SNAPSHOT_IMMUTABLE'); END`);
}

function renameColumn(db, tableName, from, to, audit) {
  if (from === to) return;
  const columns = db.all(`PRAGMA table_info(${identifier(tableName)})`).map((column) => column.name);
  if (!columns.includes(from)) return;
  if (columns.includes(to)) {
    throw new Error(`TASK_DOMAIN_MIGRATION_CONFLICT: ${tableName}.${from} and ${to} both exist`);
  }
  db.run(`ALTER TABLE ${identifier(tableName)} RENAME COLUMN ${identifier(from)} TO ${identifier(to)}`);
  audit.push({ table: tableName, from, to });
}

function table(db, name) {
  return db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
}

function hasColumn(db, tableName, columnName) {
  return Boolean(table(db, tableName)
    && db.all(`PRAGMA table_info(${identifier(tableName)})`).some((column) => column.name === columnName));
}

function identifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
