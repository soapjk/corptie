// Additive migration: historical relationships are retained, never guessed.
export function migrateTaskHierarchy({ db, ensureColumn }) {
  ensureColumn("tasks", "hierarchy_revision", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("work_session_startup_operations", "worktree_base_context_json", "TEXT");
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_hierarchy ON tasks(work_id, parent_task_id, archived, lifecycle_state, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
    CREATE TABLE IF NOT EXISTS task_delivery_worktrees (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id), repository_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL UNIQUE, startup_operation_id TEXT NOT NULL,
      binding_revision INTEGER NOT NULL DEFAULT 1, base_worktree_id TEXT,
      base_commit_oid TEXT, base_tree_oid TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_integration_snapshots (
      snapshot_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
      worktree_id TEXT NOT NULL, parent_head_oid TEXT NOT NULL,
      hierarchy_revision INTEGER NOT NULL, binding_revision INTEGER NOT NULL,
      scope_hash TEXT NOT NULL, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_integration_acceptances (
      receipt_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES task_integration_snapshots(snapshot_id),
      task_id TEXT NOT NULL REFERENCES tasks(id), assessment_hash TEXT NOT NULL,
      evidence_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS task_parent_insert_guard BEFORE INSERT ON tasks
      WHEN NEW.parent_task_id IS NOT NULL AND (
        NEW.id=NEW.parent_task_id OR NOT EXISTS (
          SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.work_id=NEW.work_id
            AND p.parent_task_id IS NULL AND COALESCE(p.deletion_status,'')=''
        )
      ) BEGIN SELECT RAISE(ABORT, 'TASK_PARENT_INVALID'); END;
    CREATE TRIGGER IF NOT EXISTS task_parent_update_guard BEFORE UPDATE OF parent_task_id ON tasks
      WHEN NEW.parent_task_id IS NOT OLD.parent_task_id
      BEGIN SELECT RAISE(ABORT, 'TASK_REPARENT_UNSUPPORTED'); END;
    CREATE TRIGGER IF NOT EXISTS task_hierarchy_delete_guard BEFORE DELETE ON tasks
      WHEN OLD.parent_task_id IS NOT NULL OR EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=OLD.id)
      BEGIN SELECT RAISE(ABORT, 'TASK_HIERARCHY_DEPENDENCY'); END;
    CREATE TRIGGER IF NOT EXISTS task_hierarchy_retire_guard BEFORE UPDATE OF deletion_status ON tasks
      WHEN NEW.deletion_status='deleted' AND (OLD.parent_task_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=OLD.id AND COALESCE(c.deletion_status,'')<>'deleted'))
      BEGIN SELECT RAISE(ABORT, 'TASK_HIERARCHY_DEPENDENCY'); END;`);
  for (const table of ["task_integration_snapshots", "task_integration_acceptances"]) {
    for (const operation of ["UPDATE", "DELETE"]) {
      db.run(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'TASK_INTEGRATION_IMMUTABLE'); END`);
    }
  }
}
