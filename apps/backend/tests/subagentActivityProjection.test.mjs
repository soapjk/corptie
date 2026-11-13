import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStoredItem } from '../src/store/storedTimelinePresentation.mjs';
import { publicSubagentActivity } from '../src/adapters/subagentActivityProjection.mjs';
test('historical native notifications describe child state rather than notification completion', () => {
  for (const [kind, status] of [['started','running'],['interacted','unknown'],['completed','completed']]) {
    const item = normalizeStoredItem({id:'event', type:'subAgentActivity', rawMetadataJSON:JSON.stringify({payload:{kind,status:'completed',agentThreadId:'child',agentPath:'/root/worker'}})});
    assert.equal(item.subagentActivity.status,status);
    assert.equal(item.subagentActivity.childId,'child');
    assert.equal(item.subagentActivity.name,'worker');
  }
});
test('provider neutral Claude projection and malformed fallback', () => {
  const value={schemaVersion:1,activityId:'event',childId:'task',name:'worker',event:'completed',status:'failed',secret:'not public'};
  assert.equal(publicSubagentActivity(value).status,'failed');
  assert.equal(publicSubagentActivity(value).secret,undefined);
  assert.equal(publicSubagentActivity({...value,childId:''}),null);
  assert.equal(normalizeStoredItem({id:'event',type:'subAgentActivity',rawMetadataJSON:'broken'}).subagentActivity,undefined);
});
