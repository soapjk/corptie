import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CorptieStore} from '../src/store/corptieStore.mjs';

test('Artifact locator uses primary key and FTS rowid; durable coalescing preserves body across restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'artifact-index-isolation-'));
  const options={dbPath:join(directory,'test.sqlite'),configPath:join(directory,'config.json')};
  let store=new CorptieStore(options);
  try {
    await store.initialize();
    const input={artifactId:'artifact:test',workId:'work:test',title:'Before',body:'searchable body'};
    store.enqueueArtifactSearchDocument(input);
    store.enqueueArtifactSearchDocument({...input,title:'After',body:undefined});
    await store.close();
    store=new CorptieStore(options); await store.initialize();
    await store.flushArtifactIndex();
    const locator=store.selectOne('SELECT fts_rowid FROM artifact_search_rows WHERE artifact_id=?',[input.artifactId]);
    const document=store.selectOne('SELECT title,body FROM artifact_search_fts WHERE rowid=?',[locator.fts_rowid]);
    assert.deepEqual(document,{title:'After',body:'searchable body'});
    assert.equal(store.selectOne('SELECT COUNT(*) AS n FROM artifact_index_jobs').n,0);
    assert.match(JSON.stringify(store.selectAll('EXPLAIN QUERY PLAN SELECT fts_rowid FROM artifact_search_rows WHERE artifact_id=?',[input.artifactId])),/SEARCH.*INDEX/);
    assert.match(JSON.stringify(store.selectAll('EXPLAIN QUERY PLAN SELECT body FROM artifact_search_fts WHERE rowid=?',[locator.fts_rowid])),/INDEX .*=/);
    assert.throws(()=>store.runInTransaction(()=>{store.enqueueArtifactSearchDocument({...input,title:'Rollback'});throw new Error('abort');}));
    await store.flushArtifactIndex();
    assert.equal(store.selectOne('SELECT title FROM artifact_search_fts WHERE rowid=?',[locator.fts_rowid]).title,'After');
  } finally {await store.close();await rm(directory,{recursive:true,force:true});}
});
