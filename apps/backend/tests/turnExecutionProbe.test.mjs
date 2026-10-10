import test from "node:test";
import assert from "node:assert/strict";
import { probeCodexTurnExecution } from "../src/adapters/codexTurnExecutionProbe.mjs";
import { TurnExecutionProbeScheduler } from "../src/application/turnExecutionProbeScheduler.mjs";
import { createTurnExecutionProbe } from "../src/application/turnExecutionProbeComposition.mjs";
import { createProviderTerminalLifecycle } from "../src/application/providerTerminalLifecycle.mjs";
import { createCodexAppServerProvider } from "../src/agent-provider/providers/codexAppServerProvider.mjs";

test("Codex probe uses bounded non-resuming reads and does not infer running from thread alone", async () => {
  for (const [threadStatus, turnStatus, expected] of [
    ["active", "inProgress", "running"], ["active", null, "unknown"],
    ["idle", null, "absent"], ["notLoaded", null, "unknown"],
    ["idle", "completed", "terminal"], ["idle", "interrupted", "terminal"]
  ]) {
    const calls = [];
    const result = await probeCodexTurnExecution(async (method, args) => {
      calls.push([method, args]);
      return method === "thread/read" ? { thread: { id: "native", status: { type: threadStatus } } }
        : { data: turnStatus ? [{ id: "turn", status: turnStatus }] : [], nextCursor: "more" };
    }, "native", "turn");
    assert.equal(result.state, expected);
    assert.deepEqual(calls[0], ["thread/read", { threadId: "native", includeTurns: false }]);
    assert.equal(calls[1][1].limit, 5);
    assert.equal(calls[1][1].itemsView, "notLoaded");
  }
});

test("unsupported paging and wrong identity remain conservative", async () => {
  const result = await probeCodexTurnExecution(async method => {
    if (method === "thread/read") return { thread: { id: "native", status: { type: "active" } } };
    throw Error("unsupported");
  }, "native", "turn");
  assert.equal(result.state, "unknown");
  assert.equal((await probeCodexTurnExecution(async () => ({thread:{id:"other"}}), "native", "turn")).reasonCode,
    "PROBE_IDENTITY_MISMATCH");
});

const entry = { sessionId:"session", logicalSessionId:"logical", bindingId:"binding", providerId:"fake",
  providerSessionId:"native", routingVersion:1, turnId:"turn" };
const observation = type => ({event:{...entry, type},binding:{...entry}});
function fixture(options = {}) {
  const timers = new Set(); const results = [];
  const scheduler = new TurnExecutionProbeScheduler({
    supports: () => true, isCurrent: () => true,
    probe: async () => ({state:"running",providerSessionId:"native",turnId:"turn"}),
    onResult: (e,r) => results.push(r),
    schedule: (fn,delay) => { const timer={fn,delay}; timers.add(timer); return timer; },
    cancel: timer => timers.delete(timer), ...options
  });
  scheduler.observe(observation("turn.started"));
  return { scheduler, results, timers, target: scheduler.entries.values().next().value };
}

test("quiet scheduling resets on activity and absent needs two independent observations", async () => {
  const f=fixture({probe:async()=>({...entry,state:"absent"})});
  assert.equal([...f.timers][0].delay,60000);
  await f.scheduler.run(f.target);
  assert.equal(f.results[0].confirmed,false);
  await f.scheduler.run(f.target);
  assert.equal(f.results[1].confirmed,true);
  f.scheduler.observe(observation("tool.progress"));
  await f.scheduler.run(f.target);
  assert.equal(f.results[2].confirmed,false);
  f.scheduler.close();
  assert.equal(f.timers.size,0);
});

test("late probe after real activity or terminal event is discarded", async () => {
  for (const type of ["tool.completed","turn.cancelled"]) {
    let finish; const f=fixture({probe:()=>new Promise(resolve=>{finish=resolve;})});
    const pending=f.scheduler.run(f.target);
    f.scheduler.observe(observation(type));
    finish({...entry,state:"absent"}); await pending;
    assert.equal(f.results.length,0);
    f.scheduler.close();
  }
});

test("timeout retains concurrency permit until underlying request settles", async () => {
  let finish; let calls=0;
  const f=fixture({maxConcurrent:1,probe:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
  const pending=f.scheduler.run(f.target);
  [...f.timers].find(t=>t.delay===20000).fn();
  assert.equal(f.results[0].reasonCode,"PROBE_TIMEOUT");
  await f.scheduler.run(f.target); assert.equal(calls,1);
  finish({...entry,state:"terminal",terminalStatus:"completed"}); await pending;
  assert.equal(f.results.length,1); assert.equal(f.scheduler.inflight,0);
  f.scheduler.close();
});

test("unsupported Provider and obsolete binding do not make requests", async () => {
  const unsupported=fixture({supports:()=>false});
  assert.equal(unsupported.scheduler.entries.size,0);
  let called=false;
  const obsolete=fixture({isCurrent:()=>false,probe:async()=>{called=true;}});
  await obsolete.scheduler.run(obsolete.target);
  assert.equal(called,false);
});

test("composition reconciles through ingestion and suppresses automatic continuation", async () => {
  let result={...entry,state:"absent",reasonCode:"NATIVE_SESSION_IDLE"};
  const events=[]; const terminal=[];
  const service=createTurnExecutionProbe({
    store:{getSessionTurn:()=>({execution_status:"running"}),getSession:()=>({external:{activeTurnId:"turn"}}),getLogicalSession:()=>({})},
    registry:{get:()=>({descriptor:{capabilities:["turn.execution.probe"]}}),invoke:async()=>result},
    bindings:{resolve:()=>entry}, ingestion:{ingest:event=>{events.push(event);return {status:"applied",event,projection:{}};}},
    onTerminal:r=>terminal.push(r),now:()=>"2026-10-09T00:00:00Z"
  });
  service.observe(observation("turn.started"));
  const target=service.entries.values().next().value;
  await service.run(target);assert.equal(events.length,0);
  await service.run(target);assert.equal(events[0].type,"turn.failed");
  assert.equal(events[0].payload.error.code,"PROVIDER_EXECUTION_OUTCOME_UNKNOWN");
  assert.equal(events[0].payload.suppressAutomaticContinuation,true);
  assert.equal(terminal.length,1);
  service.close();
});

test("reconciled terminal lifecycle settles bookkeeping without advancing queue", () => {
  const calls=[];
  const handle=createProviderTerminalLifecycle({
    store:{getAgentTaskForTurn:()=>null,getRunningAgentTaskForSession:()=>null},
    settleEntityTaskFromSession:()=>calls.push("settle"),
    collaborationCore:{getAgentForSession:()=>{throw Error("must not continue");}},
    scheduleAgentWorkDrain:()=>calls.push("drain")
  });
  handle({event:{type:"turn.failed",payload:{suppressAutomaticContinuation:true}},projection:{session:{id:"s"}}});
  assert.deepEqual(calls,["settle"]);
});

test("Codex advertises status query only when an adapter operation exists", () => {
  assert.equal(createCodexAppServerProvider({}).descriptor.metadata.turnLiveness.supportsStatusProbe,false);
  const provider=createCodexAppServerProvider({probeTurnExecution:async()=>({state:"unknown"})});
  assert.equal(provider.descriptor.metadata.turnLiveness.supportsStatusProbe,true);
  assert.ok(provider.descriptor.capabilities.includes("turn.execution.probe"));
});
