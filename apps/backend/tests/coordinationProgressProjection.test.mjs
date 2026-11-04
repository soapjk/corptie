import test from 'node:test';
import assert from 'node:assert/strict';
import {projectCoordinationAssignment,projectCoordinationProgress} from '../src/application/coordinationProgressProjection.mjs';
const row=(id,dispatchState,extra={})=>({assignmentId:id,title:id,dispatchState,updatedAt:'2026-11-04T00:00:00Z',...extra});
const batch=assignments=>projectCoordinationProgress({batchId:'batch:one',parentSessionId:'logical:parent',revision:1,
 updatedAt:'2026-11-04T00:00:00Z',assignments});
test('finished model executions and unknown data never imply delivery or acceptance',()=>{
 for(const state of ['completed','unknown','future-status'])assert.equal(projectCoordinationAssignment(row('a',state)).state,'needs_review');
 assert.equal(projectCoordinationAssignment(row('a','completed',{deliveryVerified:true})).state,'delivered');
 assert.equal(projectCoordinationAssignment(row('a','completed',{acceptanceVerified:true})).state,'accepted');
 assert.equal(projectCoordinationAssignment(row('a','running',{inconsistent:true})).state,'needs_review');
});
test('prepared preview prioritizes blockers and counts all assignments without rendering the entire list',()=>{
 const result=batch([row('a','completed',{deliveryVerified:true}),row('b','running'),row('c','failed'),
  row('d','queued',{waitingInput:true}),row('e','waiting_workspace')]);
 assert.equal(result.total,5);assert.equal(result.items.length,3);assert.equal(result.hasMore,true);
 assert.deepEqual(result.items.map(item=>item.assignmentId),['d','c','b']);
 assert.equal(result.counts.delivered,1);assert.equal(result.counts.preparing,1);
 assert.equal(Object.values(result.counts).reduce((a,b)=>a+b),5);
});
test('stable identities keep preview deterministic and duplicate assignments are rejected',()=>{
 const a=row('a','running'),b=row('b','running');
 assert.deepEqual(batch([a,b]),batch([b,a]));
 assert.throws(()=>batch([a,a]),/Duplicate coordination assignment/);
 assert.equal(batch([]).total,0);assert.equal(batch([]).hasMore,false);
});
test('projection bounds a large batch preview and does not rewrite input authority',()=>{
 const input=Array.from({length:2000},(_,i)=>Object.freeze(row('a'+i,'queued')));
 const result=batch(input);assert.equal(result.items.length,3);assert.equal(result.total,2000);
 assert.equal(result.counts.queued,2000);assert.equal(input[0].dispatchState,'queued');
});
