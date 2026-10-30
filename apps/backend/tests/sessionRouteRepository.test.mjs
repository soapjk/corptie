import assert from "node:assert/strict";
import test from "node:test";
import { TaskWorktreeHierarchyService } from "../src/application/taskWorktreeHierarchyService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("route creation rolls back partial binding activation and permits retry with the same identity", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-route-repository-config", manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    const input = { logicalSessionId: "logical:test", providerThreadId: "thread:test",
      bindingId: "binding:test", providerSessionId: "thread:test", providerId: "provider:test",
      boundCwd: "/repo", sessionName: "Route Test" };
    const revision = store.stateRevision();
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const run = store.db.run;
    const failure = new Error("injected route activation failure");
    store.db.run = function (sql, ...args) {
      if (sql.includes("UPDATE logical_sessions SET active_thread_id")) throw failure;
      return run.call(this, sql, ...args);
    };
    try {
      assert.throws(() => store.createLogicalSessionRoute(input), error => error === failure);
    } finally {
      store.db.run = run;
    }
    assert.equal(store.getLogicalSession(input.logicalSessionId), null);
    assert.equal(store.getProviderThreadBinding(input.providerThreadId), null);
    assert.equal(store.getAgentSessionBinding(input.bindingId), null);
    assert.equal(store.stateRevision(), revision);
    assert.equal(notifications, 0);
    const route = store.createLogicalSessionRoute(input);
    assert.equal(route.activeBinding.bindingId, input.bindingId);
    assert.equal(store.assertLogicalSessionRoute(input.logicalSessionId), true);
    assert.equal(notifications, 1);
    assert.deepEqual(store.getLogicalSessionByProviderSessionId(input.providerId, input.providerSessionId), route);
    assert.deepEqual(store.listActiveProviderSessionIds(input.providerId), [input.providerSessionId]);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});


test("integration identifies the exact unfinished Delivery and remains blocked until authoritative settlement", async () => {
  const store = new CorptieStore({dbPath:":memory:",configPath:"/unused-route-repository-config",manageProcessEnvironment:false});
  try {
    await store.initialize({resolveDataPath:false});
    store.createAgent({id:"agent:busy",name:"Busy",role:"independentContributor"});
    store.upsertSession({id:"session:busy",title:"Busy Session",agent:"Busy",status:"complete",provider:"provider:test"});
    const binding = {bindingId:"binding:busy",providerId:"provider:test",providerSessionId:"thread:busy",routingVersion:1};
    const created = store.createUserMessageDelivery({deliveryId:"delivery:busy",messageId:"message:busy",sessionId:"session:busy",
      binding,agentId:"agent:busy",text:"run"});
    assert.equal(store.getSessionRuntimeBlocker("session:busy",{includeQueued:false}), null,
      "new queued messages must not block the integration that holds them");
    store.claimAgentTask(created.task.taskId);
    assert.deepEqual(store.getSessionRuntimeBlocker("session:busy",{includeQueued:false}), {reason:"BACKGROUND_OPERATION"},
      "claimed work blocks Git even before Provider acknowledgement");
    store.updateMessageDelivery("delivery:busy",{status:"delivery_unknown"});
    assert.equal(store.getSessionRuntimeBlocker("session:busy",{includeQueued:false}).reason,"UNSETTLED_DELIVERY");
    store.updateMessageDelivery("delivery:busy",{status:"processing",providerTurnId:"turn:busy"});
    // Finish the admission queue operation; the remaining blocker is the Delivery.
    store.db.run("UPDATE agent_operations SET status='completed' WHERE session_id=?",["session:busy"]);
    const hierarchy = new TaskWorktreeHierarchyService({store:{
      listLogicalSessionsByWorkspaceId:id=>id==="tree:busy" ? [{legacySessionId:"session:busy"}] : [],
      getSession:id=>store.getSession(id),getSessionRuntimeBlocker:id=>store.getSessionRuntimeBlocker(id)
    }});
    assert.equal(store.hasUnsettledSessionRuntimeWork("session:busy"),true);
    assert.deepEqual(store.getSessionRuntimeBlocker("session:busy"),{reason:"UNSETTLED_DELIVERY",count:1});
    assert.throws(()=>hierarchy.assertIdle(["tree:busy"],true),error=>{
      assert.equal(error.code,"TASK_HIERARCHY_BUSY");
      assert.deepEqual(error.busyContext,{worktreeId:"tree:busy",sessionId:"session:busy",sessionTitle:"Busy Session",reason:"UNSETTLED_DELIVERY",count:1});
      return true;
    });
    assert.doesNotThrow(()=>hierarchy.assertIdle(["tree:unrelated"],true));
    store.upsertSessionTurn({sessionId:"session:busy",bindingId:binding.bindingId,routingVersion:1,turnId:"turn:busy",executionStatus:"blocked"});
    assert.equal(store.getSessionRuntimeBlocker("session:busy").reason,"WAITING_APPROVAL");
    assert.throws(()=>hierarchy.assertIdle(["tree:busy"],true),{code:"TASK_HIERARCHY_BUSY"});
    store.upsertSessionTurn({sessionId:"session:busy",bindingId:binding.bindingId,routingVersion:1,turnId:"turn:busy",executionStatus:"completed"});
    store.settleMessageDeliveryFromTurn("delivery:busy");
    assert.equal(store.hasUnsettledSessionRuntimeWork("session:busy"),false);
    assert.doesNotThrow(()=>hierarchy.assertIdle(["tree:busy"],true));
    const plans = store.selectAll("EXPLAIN QUERY PLAN SELECT 1 FROM message_deliveries WHERE session_id=? AND status IN ('queued','processing') LIMIT 1",["session:busy"]);
    assert.ok(plans.some(row=>row.detail.includes("idx_message_deliveries_session")),JSON.stringify(plans));
  } finally { await store.close(); }
});
