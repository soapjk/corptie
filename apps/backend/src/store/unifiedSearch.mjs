import { createHash } from "node:crypto";

const eligible = (alias) => `${alias}.type IN ('userMessage','agentMessage') AND COALESCE(${alias}.presentation_role,'') NOT IN ('commentary','reasoning') AND (${alias}.type='userMessage' OR (lower(COALESCE(${alias}.status,'')) NOT IN ('inprogress','in_progress','running','streaming') AND lower(COALESCE(${alias}.turn_status,'')) NOT IN ('inprogress','in_progress','running','streaming'))) `;
const text = (alias) => `COALESCE(NULLIF(${alias}.presentation_text,''),${alias}.text)`;
const backfills = new WeakMap();

// This derived index contains only product conversation text. Triggers follow
// the same SQLite transaction as projection changes, including cascade deletes.
export function initializeUnifiedSearch(store) {
  const db = store.db;
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS conversation_search_v1 USING fts5(text, tokenize='trigram');
    CREATE TABLE IF NOT EXISTS conversation_search_checkpoint_v1 (id INTEGER PRIMARY KEY CHECK(id=1), last_row INTEGER NOT NULL, ready INTEGER NOT NULL);
    INSERT OR IGNORE INTO conversation_search_checkpoint_v1 VALUES (1,0,0);
    DROP TRIGGER IF EXISTS conversation_search_insert_v1;
    DROP TRIGGER IF EXISTS conversation_search_update_v1;
    DROP TRIGGER IF EXISTS conversation_search_delete_v1;
    CREATE TRIGGER IF NOT EXISTS conversation_search_insert_v2 AFTER INSERT ON session_items WHEN ${eligible('new')} BEGIN
      INSERT INTO conversation_search_v1(rowid,text) VALUES(new.rowid,${text('new')}); END;
    CREATE TRIGGER IF NOT EXISTS conversation_search_delete_v2 AFTER DELETE ON session_items BEGIN
      DELETE FROM conversation_search_v1 WHERE rowid=old.rowid; END;
    CREATE TRIGGER IF NOT EXISTS conversation_search_update_v2 AFTER UPDATE OF text,presentation_text,presentation_role,type,status,turn_status ON session_items WHEN ${eligible('old')} OR ${eligible('new')} BEGIN
      DELETE FROM conversation_search_v1 WHERE rowid=old.rowid;
      INSERT INTO conversation_search_v1(rowid,text) SELECT new.rowid,${text('new')} WHERE ${eligible('new')}; END;`);
  if (backfills.has(db)) return backfills.get(db);
  const completion = new Promise((resolve, reject) => {
    const batch = () => {
      if (store.db !== db) { resolve(); return; }
      if (db.writeBlocked || store.migrationInProgress) { setTimeout(batch, 100).unref(); return; }
      try {
        const state = db.get('SELECT * FROM conversation_search_checkpoint_v1 WHERE id=1');
        if (state.ready) { resolve(); return; }
        const rows = db.all(`SELECT rowid,length(CAST(${text('session_items')} AS BLOB)) AS size FROM session_items WHERE rowid > ? ORDER BY rowid LIMIT 100`, [state.last_row]);
        let bytes = 0;
        const batchRows = [];
        for (const row of rows) {
          if (batchRows.length && bytes + row.size > 262144) break;
          batchRows.push(row); bytes += row.size;
        }
        const last = batchRows.at(-1)?.rowid ?? state.last_row;
        db.run('BEGIN IMMEDIATE');
        try {
          db.run(`INSERT OR REPLACE INTO conversation_search_v1(rowid,text) SELECT i.rowid,${text('i')} FROM session_items i WHERE i.rowid>? AND i.rowid<=? AND ${eligible('i')}`, [state.last_row,last]);
          db.run('UPDATE conversation_search_checkpoint_v1 SET last_row=?,ready=? WHERE id=1',[last,rows.length<100 && batchRows.length===rows.length?1:0]);
          db.run('COMMIT');
        } catch (error) { db.run('ROLLBACK'); throw error; }
        if (rows.length < 100 && batchRows.length === rows.length) resolve(); else setImmediate(batch);
      } catch (error) { reject(error); }
    };
    setImmediate(batch);
  });
  // A failed batch is surfaced by search readiness, not an unhandled rejection.
  completion.catch(() => {});
  backfills.set(db, completion);
  return completion;
}

export function unifiedSearch(store, input) {
  const allowed = ['q','scope','workId','archived','cursor','limit'];
  if ([...input.keys()].some(k=>!allowed.includes(k) || input.getAll(k).length!==1)) throw invalid();
  const q=(input.get('q')??'').trim();
  const scope=input.get('scope')??'all', workId=input.get('workId')??null, archived=input.get('archived')??'include';
  const limit=Number(input.get('limit')??30);
  if (!q || q.length>200 || !['all','titles','messages'].includes(scope) || !['include','exclude'].includes(archived) || !Number.isInteger(limit) || limit<1 || limit>30 || (workId?.length??0)>512) throw invalid();
  const fingerprint=createHash('sha256').update(JSON.stringify([q,scope,workId,archived])).digest('hex');
  let anchor=null;
  if(input.has('cursor')) {
    try { const value=JSON.parse(Buffer.from(input.get('cursor'),'base64url')); if(value.key!==fingerprint || !Number.isInteger(value.rank) || value.rank<0 || value.rank>3 || typeof value.date!=='string' || value.date.length>80 || typeof value.id!=='string' || value.id.length>1024)throw invalid();anchor=value; } catch {throw invalid();}
  }
  const db=store.db;
  const indexed=Boolean(db.get("SELECT 1 FROM sqlite_master WHERE name='conversation_search_v1'"));
  const ready=indexed && Boolean(db.get('SELECT ready FROM conversation_search_checkpoint_v1 WHERE id=1')?.ready);
  const pattern='%'+q.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')+'%';
  const sources=[], params=[];
  const titleRank=(field)=>`CASE WHEN lower(${field})=lower(?) THEN 0 WHEN lower(${field}) LIKE lower(?) ESCAPE '\\' THEN 1 ELSE 2 END`;
  const addTitles=(kind,table,title,work,session,task,archive)=>{
    sources.push(`SELECT '${kind}' AS kind, '${kind}:'||x.id AS id,x.id AS resourceId,${title} AS title,'' AS snippet,x.updated_at AS createdAt,${work} AS workId,${session} AS sessionId,${task} AS taskId,NULL AS messageId,${archive} AS archived,${titleRank(title)} AS rank FROM ${table} x WHERE ${title} LIKE ? ESCAPE '\\' ${workId?'AND '+work+'=?':''} ${archived==='exclude'?'AND NOT ('+archive+')':''}`);
    params.push(q,pattern.slice(1),pattern,...(workId?[workId]:[]));
  };
  if(scope!=='messages') {
    addTitles('work','works','x.name','x.id','NULL','NULL',"x.status='archived'");
    addTitles('task','tasks','x.title','x.work_id','x.current_session_id','x.id','COALESCE(x.archived,0)');
    addTitles('session','sessions','x.title','x.work_id','x.id','x.task_id','x.archived');
  }
  if(scope!=='titles') {
    // Until backfill completes, read the projection to avoid incomplete history
    // results (including read-only previews with an unfinished checkpoint).
    const searchableIndex=indexed && ready;
    const match=searchableIndex && [...q].length>=3;
    const content=searchableIndex?'f.text':text('i');
    sources.push(`SELECT 'message' AS kind,'message:'||i.id AS id,i.id AS resourceId,s.title AS title,substr(${content},max(1,instr(lower(${content}),lower(?))-60),240) AS snippet,i.created_at AS createdAt,COALESCE(s.work_id,t.work_id) AS workId,s.id AS sessionId,s.task_id AS taskId,i.id AS messageId,s.archived AS archived,3 AS rank FROM session_items i JOIN sessions s ON s.id=i.session_id LEFT JOIN tasks t ON t.id=s.task_id ${searchableIndex?'JOIN conversation_search_v1 f ON f.rowid=i.rowid':''} WHERE ${eligible('i')} AND ${match?'conversation_search_v1 MATCH ?':content+" LIKE ? ESCAPE '\\'"} ${workId?'AND COALESCE(s.work_id,t.work_id)=?':''} ${archived==='exclude'?'AND s.archived=0':''}`);
    params.push(q,match?'"'+q.replaceAll('"','""')+'"':pattern,...(workId?[workId]:[]));
  }
  const rows=db.all(`SELECT r.*,w.name AS workTitle,t.title AS taskTitle FROM (SELECT * FROM (${sources.join(' UNION ALL ')}) ${anchor?'WHERE rank>? OR (rank=? AND createdAt<?) OR (rank=? AND createdAt=? AND id>?)':''} ORDER BY rank,createdAt DESC,id LIMIT ?) r LEFT JOIN works w ON w.id=r.workId LEFT JOIN tasks t ON t.id=r.taskId ORDER BY r.rank,r.createdAt DESC,r.id`,[...params,...(anchor?[anchor.rank,anchor.rank,anchor.date,anchor.rank,anchor.date,anchor.id]:[]),limit+1]);
  return {schemaVersion:1,query:q,indexState:indexed?(ready?'ready':'building'):'unavailable',items:rows.slice(0,limit).map(({rank,...row})=>({...row,title:row.title.slice(0,160),archived:Boolean(row.archived)})),nextCursor:rows.length>limit?Buffer.from(JSON.stringify({key:fingerprint,rank:rows[limit-1].rank,date:rows[limit-1].createdAt,id:rows[limit-1].id})).toString('base64url'):null};
}
function invalid(){return Object.assign(new Error('Invalid search query or cursor.'),{statusCode:400,code:'SEARCH_INVALID_QUERY'});}
