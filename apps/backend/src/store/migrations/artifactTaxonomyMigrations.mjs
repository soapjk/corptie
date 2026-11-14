export function migrateArtifactTaxonomy({ ensureColumn, runDataMigrationOnce, db }) {
    ensureColumn("artifacts", "scope", "TEXT NOT NULL DEFAULT 'work'");
    ensureColumn("artifacts", "kind", "TEXT NOT NULL DEFAULT 'other'");
    ensureColumn("artifacts", "category_path", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("artifacts", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("artifacts", "aliases_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("artifacts", "keywords_json", "TEXT NOT NULL DEFAULT '[]'");
    runDataMigrationOnce("artifact-scope-taxonomy-v1", () => {
      db.run(`UPDATE artifacts SET scope=CASE
        WHEN visibility='task_private' THEN 'task'
        WHEN visibility='session_private' THEN 'session'
        ELSE 'work' END`);
    });
    db.run(`CREATE INDEX IF NOT EXISTS idx_artifacts_work_taxonomy
      ON artifacts(work_id, scope, kind, category_path, status, updated_at DESC)`);
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search_fts USING fts5(
      artifact_id UNINDEXED,
      work_id UNINDEXED,
      title,
      summary,
      kind,
      category_path,
      tags,
      aliases,
      keywords,
      body,
      tokenize='unicode61 remove_diacritics 2'
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS artifact_search_rows (
      artifact_id TEXT PRIMARY KEY, fts_rowid INTEGER NOT NULL UNIQUE
    )`);
    runDataMigrationOnce("artifact-search-row-locator-v1", () => {
      // Migration worker only: scan legacy metadata once, never on a user request.
      // Preserve every existing FTS rowid; duplicates retain the newest document.
      db.run(`INSERT INTO artifact_search_rows(artifact_id,fts_rowid)
        SELECT artifact_id,MAX(rowid) FROM artifact_search_fts GROUP BY artifact_id`);
      db.run(`DELETE FROM artifact_search_fts WHERE rowid NOT IN
        (SELECT fts_rowid FROM artifact_search_rows)`);
    });
    db.run(`CREATE TABLE IF NOT EXISTS artifact_index_jobs (
      artifact_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, body TEXT
    )`);
}
