import { BUILTIN_SCENE_TEMPLATES } from "./sceneTemplates.mjs";

export function migrateSceneDomain(store) {
  store.db.run(`
    CREATE TABLE IF NOT EXISTS scene_template_versions (
      template_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      definition_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (template_id, version)
    );

    CREATE TABLE IF NOT EXISTS scene_instances (
      instance_id TEXT PRIMARY KEY,
      owner_scope TEXT NOT NULL,
      template_id TEXT NOT NULL,
      template_version INTEGER NOT NULL,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL,
      unit_preferences_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      instance_revision INTEGER NOT NULL DEFAULT 0,
      resource_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (template_id, template_version)
        REFERENCES scene_template_versions(template_id, version)
    );

    CREATE TABLE IF NOT EXISTS scene_records (
      instance_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      record_version INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, record_id),
      FOREIGN KEY (instance_id) REFERENCES scene_instances(instance_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scene_views (
      instance_id TEXT NOT NULL,
      view_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (instance_id, view_id),
      FOREIGN KEY (instance_id) REFERENCES scene_instances(instance_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scene_mutations (
      mutation_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      instance_revision INTEGER NOT NULL,
      source_session_id TEXT,
      source_kind TEXT NOT NULL,
      command_name TEXT NOT NULL,
      summary TEXT NOT NULL,
      changes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (instance_id) REFERENCES scene_instances(instance_id) ON DELETE CASCADE,
      UNIQUE (instance_id, instance_revision)
    );

    CREATE TABLE IF NOT EXISTS scene_command_receipts (
      instance_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, idempotency_key),
      FOREIGN KEY (instance_id) REFERENCES scene_instances(instance_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_scene_instances_updated
      ON scene_instances(status, updated_at DESC, instance_id);
    CREATE INDEX IF NOT EXISTS idx_scene_records_view
      ON scene_records(instance_id, record_type, deleted_at, updated_at DESC, record_id);
    CREATE INDEX IF NOT EXISTS idx_scene_mutations_revision
      ON scene_mutations(instance_id, instance_revision);
  `);

  const seededAt = new Date(0).toISOString();
  for (const template of BUILTIN_SCENE_TEMPLATES) {
    store.db.run(
      `INSERT OR IGNORE INTO scene_template_versions (
         template_id, version, title, description, definition_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [template.templateId, template.version, template.title, template.description,
        JSON.stringify(template), seededAt]
    );
  }
}
