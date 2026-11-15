import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("startup repair rolls back partial failure and a successful retry is idempotent", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-startup-repair-config", manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    store.createAgent({ id: "agent:test", name: "Test", role: "independentContributor" });
    store.upsertSession({ id: "session:test", title: "Test", agent: "Test",
      agentId: "agent:test", provider: "provider:test", status: "running" });
    const binding = { bindingId: "binding:test", providerId: "provider:test",
      providerSessionId: "thread:test", routingVersion: 1 };
    store.createUserMessageDelivery({ deliveryId: "delivery:test", messageId: "message:test",
      sessionId: "session:test", agentId: "agent:test", binding, text: "preserve until commit" });
    store.upsertSessionTurn({ sessionId: "session:test", bindingId: binding.bindingId,
      routingVersion: 1, turnId: "turn:test", executionStatus: "running" });
    const tables = ["agent_operations", "message_deliveries", "session_items", "session_turns", "sessions"];
    const snapshot = () => tables.map(table => store.selectAll(`SELECT * FROM ${table}`));
    const before = snapshot();
    const revision = store.stateRevision();
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const original = store.db.run;
    const failure = new Error("injected turn repair failure");
    store.db.run = function (sql, ...args) {
      if (/UPDATE session_turns/.test(sql)) throw failure;
      return original.call(this, sql, ...args);
    };
    try {
      assert.throws(() => store.reconcileInterruptedSessionExecutionAtStartup(), error => error === failure);
    } finally {
      store.db.run = original;
    }
    assert.deepEqual(snapshot(), before);
    assert.equal(store.stateRevision(), revision);
    assert.equal(notifications, 0);
    assert.deepEqual(store.reconcileInterruptedSessionExecutionAtStartup(), {
      tasks: 1, deliveries: 1, collaborationDeliveries: 0, sessionCollaborationDeliveries: 0, turns: 1
    });
    assert.equal(notifications, 1);
    const repaired = snapshot();
    const repairedRevision = store.stateRevision();
    assert.deepEqual(store.reconcileInterruptedSessionExecutionAtStartup(), {
      tasks: 0, deliveries: 0, collaborationDeliveries: 0, sessionCollaborationDeliveries: 0, turns: 0
    });
    assert.deepEqual(snapshot(), repaired);
    assert.equal(store.stateRevision(), repairedRevision);
    assert.equal(notifications, 1);
  } finally {
    await store.close();
  }
});


test("restart settles queued user-message metadata and legacy reads cannot display a failed message as waiting",async()=>{
  const store=new CorptieStore({dbPath:':memory:',configPath:'/unused-budget-repair',manageProcessEnvironment:false});
  try{
    await store.initialize({resolveDataPath:false});
    store.createAgent({id:'agent:test',name:'Test'});store.upsertSession({id:'session:test',title:'Test',agentId:'agent:test',provider:'test',status:'running'});
    store.createUserMessageDelivery({deliveryId:'d',messageId:'m',sessionId:'session:test',agentId:'agent:test',binding:{bindingId:'b',providerId:'test',providerSessionId:'p',routingVersion:1},text:'继续'});
    store.updateAgentTask('m',{lastError:'VERIFICATION_BUDGET_EXHAUSTED',source:{type:'desktop',dispatchBlock:{code:'VERIFICATION_BUDGET_EXHAUSTED',kind:'waiting',message:'预算用尽'}}});
    const old=JSON.stringify({taskId:'m',userMessageStatus:'queued',queuePosition:1,processingError:null});
    store.db.run("UPDATE session_items SET turn_status='queued',raw_metadata_json=? WHERE session_id='session:test' AND id='m'",[old]);
    store.reconcileInterruptedSessionExecutionAtStartup('2026-11-15T00:00:00Z');
    let row=store.selectOne("SELECT status,turn_status,raw_metadata_json FROM session_items WHERE session_id='session:test' AND id='m'");
    assert.equal(row.status,'failed');assert.equal(row.turn_status,'failed');
    assert.equal(JSON.parse(row.raw_metadata_json).userMessageStatus,'failed');
    assert.equal(JSON.parse(row.raw_metadata_json).executionBlock.code,'VERIFICATION_BUDGET_EXHAUSTED');
    assert.equal(JSON.parse(row.raw_metadata_json).executionBlock.kind,'settled');
    assert.match(JSON.parse(row.raw_metadata_json).processingError,/restart/);
    assert.equal(store.getAgentTask('m').source.dispatchBlock.kind,'settled');
    // Recreate the exact legacy inconsistency as a read-only compatibility case.
    store.db.run("UPDATE session_items SET turn_status='queued',raw_metadata_json=? WHERE session_id='session:test' AND id='m'",[old]);
    const item=store.getSessionItem('session:test','m');
    assert.equal(item.userMessageStatus,'failed');assert.equal(item.turnStatus,'failed');assert.equal(item.queuePosition,null);
    assert.equal(item.executionBlock.code,'VERIFICATION_BUDGET_EXHAUSTED');assert.equal(item.executionBlock.kind,'settled');
    assert.match(item.processingError,/restart/);
    row=store.selectOne("SELECT turn_status,raw_metadata_json FROM session_items WHERE session_id='session:test' AND id='m'");
    assert.equal(row.turn_status,'queued');assert.equal(row.raw_metadata_json,old);
  }finally{await store.close();}
});
