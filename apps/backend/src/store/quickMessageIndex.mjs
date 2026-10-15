// Derived, Provider-neutral statistics. Live writes and their contributions are
// one SQLite transaction, including direct SQL, cascade deletes and rollback.
import { QUICK_MESSAGE_COMMON as commonTexts } from "../application/quickMessageRecommendations.mjs";
const commonSQL = commonTexts.map(text => `'${text.replaceAll("'", "''")}'`).join(",");
const eligible = alias => `${alias}.type='userMessage' AND length(${alias}.text) BETWEEN 1 AND 80
  AND corptie_quick_message_eligible_v1(${alias}.type,${alias}.text,${alias}.status,${alias}.presentation_role,${alias}.raw_metadata_json)=1`;
const builds = new WeakMap();

export function initializeQuickMessageIndex(store, { schedule = true } = {}) {
  const db = store.db;
  db.run(`
    CREATE TABLE IF NOT EXISTS quick_message_build_v1 (
      id INTEGER PRIMARY KEY CHECK(id=1), last_row INTEGER NOT NULL DEFAULT 0,
      high_row INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0, common_revision INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO quick_message_build_v1(id,high_row,ready)
      SELECT 1,COALESCE(MAX(rowid),0),CASE WHEN MAX(rowid) IS NULL THEN 1 ELSE 0 END FROM session_items;
    CREATE TABLE IF NOT EXISTS quick_message_contributions_v1 (
      source_row INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      text TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_quick_message_contributions_scope
      ON quick_message_contributions_v1(session_id,text,created_at DESC);
    CREATE TABLE IF NOT EXISTS quick_message_stats_v1 (
      session_id TEXT NOT NULL, text TEXT NOT NULL, count INTEGER NOT NULL, last_at TEXT NOT NULL,
      PRIMARY KEY(session_id,text));
    CREATE INDEX IF NOT EXISTS idx_quick_message_stats_common ON quick_message_stats_v1(trim(text));
    CREATE TABLE IF NOT EXISTS quick_message_revisions_v1(session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS quick_message_contribution_insert_v1 AFTER INSERT ON quick_message_contributions_v1 BEGIN
      INSERT INTO quick_message_stats_v1 VALUES(new.session_id,new.text,1,new.created_at)
        ON CONFLICT(session_id,text) DO UPDATE SET count=count+1,last_at=MAX(last_at,excluded.last_at);
      INSERT INTO quick_message_revisions_v1 VALUES(new.session_id,1)
        ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
      UPDATE quick_message_build_v1 SET common_revision=common_revision+1 WHERE trim(new.text) IN (${commonSQL});
    END;
    CREATE TRIGGER IF NOT EXISTS quick_message_contribution_delete_v1 AFTER DELETE ON quick_message_contributions_v1 BEGIN
      UPDATE quick_message_stats_v1 SET count=count-1,
        last_at=COALESCE((SELECT MAX(created_at) FROM quick_message_contributions_v1
          WHERE session_id=old.session_id AND text=old.text),'')
        WHERE session_id=old.session_id AND text=old.text;
      DELETE FROM quick_message_stats_v1 WHERE session_id=old.session_id AND text=old.text AND count<=0;
      INSERT INTO quick_message_revisions_v1 VALUES(old.session_id,1)
        ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
      UPDATE quick_message_build_v1 SET common_revision=common_revision+1 WHERE trim(old.text) IN (${commonSQL});
    END;
    CREATE TRIGGER IF NOT EXISTS quick_message_item_insert_v1 AFTER INSERT ON session_items WHEN ${eligible("new")} BEGIN
      INSERT OR IGNORE INTO quick_message_contributions_v1 VALUES(new.rowid,new.session_id,new.text,new.created_at);
    END;
    CREATE TRIGGER IF NOT EXISTS quick_message_item_delete_v1 AFTER DELETE ON session_items WHEN old.type='userMessage' BEGIN
      DELETE FROM quick_message_contributions_v1 WHERE source_row=old.rowid;
    END;
    CREATE TRIGGER IF NOT EXISTS quick_message_item_update_v1
      AFTER UPDATE OF type,text,status,presentation_role,raw_metadata_json,created_at,session_id ON session_items
      WHEN (old.type='userMessage' OR new.type='userMessage') AND
        (old.text IS NOT new.text OR old.session_id IS NOT new.session_id OR old.created_at IS NOT new.created_at
          OR (${eligible("old")}) IS NOT (${eligible("new")})) BEGIN
      DELETE FROM quick_message_contributions_v1 WHERE source_row=old.rowid;
      INSERT OR IGNORE INTO quick_message_contributions_v1
        SELECT new.rowid,new.session_id,new.text,new.created_at WHERE ${eligible("new")};
    END;
    CREATE TRIGGER IF NOT EXISTS quick_message_session_scope_v1 AFTER UPDATE OF task_id,deleted_at ON sessions
      WHEN old.task_id IS NOT new.task_id OR old.deleted_at IS NOT new.deleted_at BEGIN
      INSERT INTO quick_message_revisions_v1 VALUES(new.id,1)
        ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
      UPDATE quick_message_build_v1 SET common_revision=common_revision+1
        WHERE EXISTS(SELECT 1 FROM quick_message_stats_v1 WHERE session_id=new.id AND trim(text) IN (${commonSQL}));
    END;
    CREATE TRIGGER IF NOT EXISTS quick_message_session_delete_v1 AFTER DELETE ON sessions BEGIN
      DELETE FROM quick_message_revisions_v1 WHERE session_id=old.id;
    END;
  `);
  if (!schedule || builds.has(db)) return builds.get(db);
  const completion = new Promise(resolve => {
    const batch = () => {
      if (store.db !== db) { resolve(); return; }
      if (db.writeBlocked || store.migrationInProgress) { setTimeout(batch, 100).unref(); return; }
      try {
        if (buildQuickMessageBatch(store)) {
          // One completion notification, not one event per historical row.
          const session = db.get("SELECT session_id FROM quick_message_stats_v1 LIMIT 1");
          if (session) store.notifyTimelineDirty(session.session_id, { quickMessagesChanged: true, quickMessagesGlobalChanged: true });
          resolve();
        } else setTimeout(batch, 10).unref();
      } catch (error) {
        // Keep the checkpoint for the next startup; do not crash the server.
        console.error("Quick-message history build paused:", error.code ?? error.name);
        resolve();
      }
    };
    setImmediate(batch);
  });
  builds.set(db, completion);
  return completion;
}

export function buildQuickMessageBatch(store, batchSize = 200) {
  const db = store.db;
  const state = db.get("SELECT * FROM quick_message_build_v1 WHERE id=1");
  if (state.ready) return true;
  // Page row IDs, not transcript bodies. The second query reads only short user messages.
  const rows = db.all("SELECT rowid FROM session_items WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?",
    [state.last_row, state.high_row, batchSize]);
  const last = rows.at(-1)?.rowid ?? state.high_row;
  const ready = rows.length < batchSize || last >= state.high_row;
  store.runInTransaction(() => {
    db.run(`INSERT OR IGNORE INTO quick_message_contributions_v1
      SELECT i.rowid,i.session_id,i.text,i.created_at FROM session_items i
      WHERE i.rowid>? AND i.rowid<=? AND ${eligible("i")}`, [state.last_row, last]);
    db.run("UPDATE quick_message_build_v1 SET last_row=?,ready=? WHERE id=1", [last, ready ? 1 : 0]);
  });
  return ready;
}
