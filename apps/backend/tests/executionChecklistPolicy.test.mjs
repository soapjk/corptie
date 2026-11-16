import test from "node:test";
import assert from "node:assert/strict";
import { checklistStepCoverage, selectChecklistWork, validateChecklistDependencies } from "../src/domain/executionChecklistPolicy.mjs";

const steps = () => [{stepId:"implementation",status:"pending",phase:"implementation"},
  {stepId:"verification",status:"pending",phase:"verification",dependsOnStepIds:["implementation"]}];
const input = () => ({plan:{steps:steps()},runtime:{enabled:true,state:"idle"}});

test("unfinished authorized items are selected even after a model ends or hides the card",()=>{
  const value=input();value.plan.closed=true;
  assert.deepEqual(selectChecklistWork(value),{kind:"execute",stepIds:["implementation"]});
  value.plan.steps[0].status="blocked";
  assert.equal(selectChecklistWork(value).kind,"execute");
});
test("real current work is reused; an old ended dispatch or superseded execution cannot hide a missing continuation",()=>{
  const value=input(),operation={operationId:"operation:1",stepIds:["implementation"],authorized:true,status:"running"};
  value.operations=[operation];assert.equal(selectChecklistWork(value).kind,"covered");
  for(const patch of [{status:"completed"},{authorized:false},{superseded:true},{executionRevision:1}]) {
    value.operations=[{...operation,...patch}];assert.equal(selectChecklistWork(value).kind,"execute");
  }
  assert.equal(checklistStepCoverage(value.plan.steps[0],[]),null);
});
test("one waiting item does not block another independent implementation item",()=>{
  const value=input();value.plan.steps.splice(1,0,{stepId:"independent",status:"pending",phase:"implementation"});
  value.waits=[{stepId:"implementation",kind:"operation",resourceId:"dependency:one",satisfied:false}];
  assert.deepEqual(selectChecklistWork(value),{kind:"execute",stepIds:["independent"]});
  value.plan.steps[1].status="completed";assert.equal(selectChecklistWork(value).kind,"waiting_dependency");
  value.waits[0].satisfied=true;assert.equal(selectChecklistWork(value).kind,"execute");
});
test("all development must finish before verification, including a later unordered development item",()=>{
  const value=input();value.plan.steps[0].status="completed";
  value.plan.steps.push({stepId:"later-development",status:"pending",phase:"implementation"});
  assert.deepEqual(selectChecklistWork(value),{kind:"execute",stepIds:["later-development"]});
  value.plan.steps[2].status="completed";assert.deepEqual(selectChecklistWork(value),{kind:"execute",stepIds:["verification"]});
});
test("user stops and verification budget pauses outrank automatic continuation and completion",()=>{
  const value=input();value.plan.steps.forEach(step=>step.status="completed");
  value.runtime.pauseReason="user";assert.equal(selectChecklistWork(value).kind,"paused_user");
  value.runtime.pauseReason="budget";assert.equal(selectChecklistWork(value).kind,"paused_budget");
  value.runtime.pauseReason=null;value.budgetPaused=true;assert.equal(selectChecklistWork(value).kind,"paused_budget");
  value.budgetPaused=false;assert.equal(selectChecklistWork(value).kind,"complete");
});
test("legacy progress-only plans do not automatically activate and an empty plan is not target completion",()=>{
  const value=input();value.runtime.enabled=false;assert.equal(selectChecklistWork(value).kind,"progress_only");
  value.runtime.enabled=true;value.plan.steps=[];assert.equal(selectChecklistWork(value).kind,"needs_attention");
});
test("explicit decision waits are distinct from internal dependencies and remain scoped to relevant items",()=>{
  const value=input();value.waits=[{stepId:"implementation",kind:"decision",resourceId:"decision:1",satisfied:false}];
  assert.equal(selectChecklistWork(value).kind,"waiting_user");
  value.runtime.state="needs_attention";assert.equal(selectChecklistWork(value).kind,"needs_attention");
});
test("dependency validation rejects cycles and foreign identities but accepts a shared acyclic dependency",()=>{
  validateChecklistDependencies(steps());
  assert.throws(()=>validateChecklistDependencies([{stepId:"a",dependsOnStepIds:["b"]},{stepId:"b",dependsOnStepIds:["a"]}]),{code:"CHECKLIST_DEPENDENCY_CYCLE"});
  assert.throws(()=>validateChecklistDependencies([{stepId:"a",dependsOnStepIds:["foreign"]}]),{code:"CHECKLIST_INVALID_DEPENDENCY"});
  assert.throws(()=>validateChecklistDependencies([{stepId:"a"},{stepId:"a"}]),{code:"CHECKLIST_INVALID_DEPENDENCY"});
});
test('delivery is released after verification and cannot be selected first',()=>{
  const value=input();value.plan.steps.unshift({stepId:'delivery',status:'pending',phase:'delivery'});
  assert.deepEqual(selectChecklistWork(value).stepIds,['implementation']);
  value.plan.steps.find(s=>s.stepId==='implementation').status='completed';
  assert.deepEqual(selectChecklistWork(value).stepIds,['verification']);
});
