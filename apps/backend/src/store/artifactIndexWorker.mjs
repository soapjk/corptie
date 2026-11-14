import { parentPort, workerData } from 'node:worker_threads';
import { openWritableStoreDatabase } from './storeDatabaseConnection.mjs';
import { ArtifactRepository } from './repositories/artifactRepository.mjs';
let db, repository;
try {
  db = openWritableStoreDatabase(workerData.dbPath);
  repository = new ArtifactRepository({getDatabase:()=>db,selectOne:(...a)=>db.get(...a),selectAll:(...a)=>db.all(...a),scheduleSave(){}});
  parentPort.postMessage({type:'ready'});
} catch(error) { parentPort.postMessage({type:'fatal',error:{code:error.code,message:'Artifact index initialization failed'}}); }
parentPort.on('message',({requestId,operation,input})=>{
  try {
    if(operation==='searchArtifactDocuments') {
      const result=repository.searchArtifactDocuments(input.workId,input.query,input.limit);
      const payload=new TextEncoder().encode(JSON.stringify(result));
      parentPort.postMessage({type:'result',requestId,payload},[payload.buffer]);
      return;
    }
    if(operation!=='drainArtifactIndex') throw new Error('Unsupported index operation');
    db.run('BEGIN IMMEDIATE');
    let processed = 0;
    try {
      const job = db.get('SELECT artifact_id,input_json,body FROM artifact_index_jobs ORDER BY rowid LIMIT 1');
      if(job) {
        repository.upsertArtifactSearchDocument({...JSON.parse(job.input_json),body:job.body});
        db.run('DELETE FROM artifact_index_jobs WHERE artifact_id=?',[job.artifact_id]);
        processed=1;
      }
      db.run('COMMIT');
    } catch(error) { db.run('ROLLBACK'); throw error; }
    const payload=new TextEncoder().encode(JSON.stringify({processed}));
    parentPort.postMessage({type:'result',requestId,payload},[payload.buffer]);
  } catch(error) { parentPort.postMessage({type:'result',requestId,error:{code:error.code,message:'Artifact index update failed'}}); }
});
