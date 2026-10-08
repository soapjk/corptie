import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CorptieStore } from '../src/store/corptieStore.mjs';
import { initializeUnifiedSearch,unifiedSearch } from '../src/store/unifiedSearch.mjs';
async function fixture(){const root=await mkdtemp(join(tmpdir(),'corptie-search-'));const store=new CorptieStore({dbPath:join(root,'db.sqlite'),configPath:join(root,'config.json')});await store.initialize();const agent=store.createAgent({id:'agent:search',name:'Search',role:'independentContributor'});store.createWork({id:'work:one',name:'中文 search',contributorAgentIds:[agent.agentId]});store.createTask({id:'task:one',workId:'work:one',title:'search title'});store.createSession({id:'session:one',title:'Archive chat',sessionKind:'worker',workId:'work:one',taskId:'task:one',archived:true});return {store,async close(){await store.close();await rm(root,{recursive:true,force:true});}};}
function item(f,id,value,type='userMessage'){f.store.upsertTimelineItemProjection('session:one',{id,turnId:'turn:1',turnStatus:'completed',type,title:'Text',text:value,status:'completed',createdAt:'2026-10-01T00:00:00Z'});}
test('search indexes Chinese, literal punctuation, titles and pagination without raw events',async()=>{const f=await fixture();try{item(f,'msg:one','旧的中文记录 search 100% _test \\foo');item(f,'msg:two','search answer','agentMessage');item(f,'tool:one','search SECRET','commandExecution');await initializeUnifiedSearch(f.store);const page=unifiedSearch(f.store,new URLSearchParams({q:'search',limit:'2'}));assert.equal(page.indexState,'ready');assert.deepEqual(page.items.map(i=>i.kind),['task','work']);const rest=unifiedSearch(f.store,new URLSearchParams({q:'search',cursor:page.nextCursor}));assert.equal(rest.items.length,2);assert.ok(rest.items.every(i=>i.kind==='message'&&i.archived));for(const q of ['中文','记录','旧的中文','100%','_test','\\foo'])assert.equal(unifiedSearch(f.store,new URLSearchParams({q,scope:'messages'})).items.length,1,q);assert.equal(unifiedSearch(f.store,new URLSearchParams({q:'search',archived:'exclude',scope:'messages'})).items.length,0);assert.throws(()=>unifiedSearch(f.store,new URLSearchParams({q:'different',cursor:page.nextCursor})));assert.throws(()=>unifiedSearch(f.store,new URLSearchParams({q:'search',unsafe:'1'})));}finally{await f.close();}});
test('edits, role changes and deletes keep the index in the projection transaction',async()=>{const f=await fixture();try{await initializeUnifiedSearch(f.store);item(f,'msg:one','unique needle');assert.equal(unifiedSearch(f.store,new URLSearchParams({q:'needle',scope:'messages'})).items.length,1);f.store.db.run("UPDATE session_items SET text='replacement' WHERE id='msg:one'");assert.equal(unifiedSearch(f.store,new URLSearchParams({q:'needle'})).items.length,0);f.store.db.run("UPDATE session_items SET presentation_role='reasoning' WHERE id='msg:one'");assert.equal(unifiedSearch(f.store,new URLSearchParams({q:'replacement'})).items.length,0);f.store.db.run("DELETE FROM session_items WHERE id='msg:one'");assert.equal(f.store.db.get('SELECT count(*) AS n FROM conversation_search_v1').n,0);}finally{await f.close();}});

test('read workers use the same versioned contract and reject invalid cursors',async()=>{
  const f=await fixture();const {TimelineReadPool}=await import('../src/store/timelineReadPool.mjs');let pool;
  try{item(f,'msg:historical','历史关键词 old history');await initializeUnifiedSearch(f.store);pool=new TimelineReadPool({dbPath:f.store.dbPath,configPath:f.store.configPath,size:1});
    const page=await pool.readUnifiedSearch({query:new URLSearchParams({q:'关键词',scope:'messages'}).toString()});
    assert.equal(page.items[0].messageId,'msg:historical');assert.equal(page.items[0].workTitle,'中文 search');
    await assert.rejects(pool.readUnifiedSearch({query:'q=old&cursor=invalid'}),e=>e.code==='SEARCH_INVALID_QUERY'&&e.statusCode===400);
  }finally{await pool?.close();await f.close();}
});

test('historical index backfill yields, resumes after restart and includes archived text',async()=>{
  const f=await fixture();let reopened;
  try{await initializeUnifiedSearch(f.store);
    f.store.db.run('DROP TRIGGER conversation_search_insert_v2; DROP TRIGGER conversation_search_update_v2; DROP TRIGGER conversation_search_delete_v2; DROP TABLE conversation_search_v1; DROP TABLE conversation_search_checkpoint_v1;');
    for(let n=0;n<220;n++)item(f,'msg:'+n,'回填旧消息 '+n);
    const dbPath=f.store.dbPath,configPath=f.store.configPath;await f.store.close();
    reopened=new CorptieStore({dbPath,configPath});await reopened.initialize();
    assert.equal(unifiedSearch(reopened,new URLSearchParams({q:'回填'})).indexState,'building');
    await initializeUnifiedSearch(reopened);
    let cursor=null,count=0;
    do{const q=new URLSearchParams({q:'回填',scope:'messages'});if(cursor)q.set('cursor',cursor);const p=unifiedSearch(reopened,q);assert.equal(p.indexState,'ready');count+=p.items.length;cursor=p.nextCursor;}while(cursor);
    assert.equal(count,220);
  }finally{await reopened?.close();await f.close();}
});

test('streaming replies are indexed only when final and transactional rollback never leaks text',async()=>{
  const f=await fixture();try{await initializeUnifiedSearch(f.store);
    f.store.upsertTimelineItemProjection('session:one',{id:'msg:stream',turnId:'turn:stream',turnStatus:'inProgress',type:'agentMessage',title:'Agent',text:'streamed needle',status:'inProgress',createdAt:'2026-10-01T00:00:00Z'});
    assert.equal(unifiedSearch(f.store,new URLSearchParams({q:'streamed'})).items.length,0);
    f.store.db.run("UPDATE session_items SET text='final needle',turn_status='completed',status='completed' WHERE id='msg:stream'");
    assert.equal(unifiedSearch(f.store,new URLSearchParams({q:'final needle'})).items.length,1);
    f.store.db.run('BEGIN IMMEDIATE');f.store.db.run("UPDATE session_items SET text='rolled back secret' WHERE id='msg:stream'");f.store.db.run('ROLLBACK');
    assert.equal(unifiedSearch(f.store,new URLSearchParams({q:'rolled back secret'})).items.length,0);
    assert.equal(unifiedSearch(f.store,new URLSearchParams({q:'final needle'})).items.length,1);
  }finally{await f.close();}
});


test('backfill yields at the UTF-8 byte budget using the indexed presentation text',async()=>{
  const f=await fixture();let reopened;
  try{await initializeUnifiedSearch(f.store);
    f.store.db.run('DROP TRIGGER conversation_search_insert_v2; DROP TRIGGER conversation_search_update_v2; DROP TRIGGER conversation_search_delete_v2; DROP TABLE conversation_search_v1; DROP TABLE conversation_search_checkpoint_v1;');
    for(let n=0;n<3;n++){
      item(f,'large:'+n,'short raw text');
      f.store.db.run('UPDATE session_items SET presentation_text=? WHERE id=?',['中文体积'.repeat(12000),'large:'+n]);
    }
    const dbPath=f.store.dbPath,configPath=f.store.configPath;await f.store.close();
    reopened=new CorptieStore({dbPath,configPath});await reopened.initialize();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(reopened.db.get('SELECT count(*) AS n FROM conversation_search_v1').n,1);
    const buildingPage=unifiedSearch(reopened,new URLSearchParams({q:'中文体积'}));
    assert.equal(buildingPage.indexState,'building');
    assert.equal(buildingPage.items.length,3); // History remains complete before backfill finishes.
    const checkpoint=reopened.db.get('SELECT last_row FROM conversation_search_checkpoint_v1 WHERE id=1').last_row;
    assert.ok(checkpoint>0);
    await reopened.close();
    reopened=new CorptieStore({dbPath,configPath});await reopened.initialize();
    assert.equal(reopened.db.get('SELECT last_row FROM conversation_search_checkpoint_v1 WHERE id=1').last_row,checkpoint);
    await initializeUnifiedSearch(reopened);
    assert.equal(unifiedSearch(reopened,new URLSearchParams({q:'中文体积'})).items.length,3);
  }finally{await reopened?.close();await f.close();}
});
