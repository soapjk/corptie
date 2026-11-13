import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { validateTaskInput } from "../src/domain/workTaskValidation.mjs";
import { taskFieldsSchema, taskPatchSchema } from "../src/domain/taskToolSchema.mjs";
import { presentTaskAcceptance, buildAcceptanceAssessment, completionSuggestionForTask } from "../src/application/taskAcceptance.mjs";

const retired = ["description", "acceptanceCriteria", "verificationCriteria"];
const columns = ["description", "acceptance_criteria", "verification_criteria"];

test("fresh and reopened stores never persist retired Task fields and keep Work descriptions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "corptie-task-fields-"));
  const options = { dbPath:path.join(directory,"corptie.sqlite"), configPath:path.join(directory,"config.json") };
  let store = new CorptieStore(options);
  try {
    await store.initialize();
    const agent=store.createAgent({name:"Task field worker"});
    const work=store.createWork({name:"Field_removal",description:"Work scope survives",contributorAgentIds:[agent.agentId]});
    const task=store.createTask({workId:work.id,title:"New_Task"});
    const assessment=buildAcceptanceAssessment(task,{sourceSessionId:"session:report",results:[
      {criterion:"The requested behavior was verified",verdict:"passed",evidence:[{summary:"Verified",reference:"test log"}]}]});
    store.updateTask(task.id,{acceptanceAssessment:assessment});
    assert.equal(completionSuggestionForTask(store.getTask(task.id)).recommended,true);
    for (const field of retired) {
      assert.throws(()=>store.createTask({workId:work.id,title:"Rejected",[field]:"retired"}));
      assert.throws(()=>store.updateTask(task.id,{[field]:"retired"}));
      assert.equal(Object.hasOwn(presentTaskAcceptance(store.getTask(task.id)),field),false);
    }
    await store.close();
    store=new CorptieStore(options); await store.initialize();
    for (const table of ["tasks","task_snapshots"]) {
      const names=store.db.all(`PRAGMA table_info(${table})`).map(row=>row.name);
      for (const column of columns) assert.ok(!names.includes(column));
    }
    assert.equal(store.getTask(task.id).title,"New_Task");
    assert.equal(store.getWork(work.id).description,"Work scope survives");
    assert.deepEqual(store.db.all("PRAGMA foreign_key_check"),[]);
  } finally { await store.close(); await rm(directory,{recursive:true,force:true}); }
});

test("Task create, update and tool contracts reject every retired definition field", () => {
  for (const field of retired) {
    assert.throws(()=>validateTaskInput({workId:"work:1",title:"Task",[field]:"removed"}));
    assert.throws(()=>validateTaskInput({[field]:"removed"},"update"));
    assert.equal(Object.hasOwn(taskPatchSchema.properties,field),false);
  }
  for (const field of columns) assert.equal(Object.hasOwn(taskFieldsSchema,field),false);
});
