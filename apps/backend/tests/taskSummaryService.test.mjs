import assert from "node:assert/strict";
import test from "node:test";
import { TaskSummaryService } from "../src/application/taskSummaryService.mjs";
import { TaskSummaryRepository } from "../src/store/taskSummaryRepository.mjs";

test("attention context isolates recent dialogue and binds the latest agent reply", () => {
  const service = new TaskSummaryService({ store: {
    getTask: () => ({ title: "任务", description: "描述", user_summary_json: "OLD_SUMMARY" }),
    selectAll: (sql) => {
      assert.match(sql, /type IN \('agentMessage','userMessage'\)/);
      assert.match(sql, /LIMIT 9/);
      return [
        { id: "user:2", type: "userMessage", text: "已经确认", created_at: "3" },
        { id: "agent:1", type: "agentMessage", text: "请确认", created_at: "2" },
        { id: "user:1", type: "userMessage", text: "开始", created_at: "1" }
      ];
    }
  }, backgroundAgent: {}, isEnabled: () => true });
  const context = service.context({ taskID: "task:1", basis: { sessionID: "session:1", taskRevision: 1 } });
  const prompt = JSON.parse(context.prompt);
  assert.equal(context.targetMessageId, "agent:1");
  assert.equal(prompt.latestUserMessage.id, "user:2");
  assert.equal(prompt.latestAgentMessage.text, "请确认");
  assert.equal(context.incomplete, false);
  assert.equal(context.allowedSources.has("agent:1"), true);
  assert.equal(context.prompt.includes("OLD_SUMMARY"), false);
  service.close();
});

test("pending jobs use stable lazy pages instead of stopping at 64 busy Tasks", () => {
  const calls = [];
  const first = Array.from({ length: 64 }, (_, index) => ({ task_id: `task:${index}`, requested_at: "same-time" }));
  const repository = new TaskSummaryRepository({ selectAll: (sql, parameters) => {
    calls.push({ sql, parameters });
    return calls.length === 1 ? first : [{ task_id: "task:later", requested_at: "later-time" }];
  } });
  const pending = repository.pending();
  assert.equal(calls.length, 0);
  for (const job of first) assert.deepEqual(pending.next().value, job);
  assert.equal(calls.length, 1);
  assert.equal(pending.next().value.task_id, "task:later");
  assert.deepEqual(calls[1].parameters, ["same-time", "task:63"]);
  assert.match(calls[1].sql, /ORDER BY jobs.requested_at, jobs.task_id/);
  assert.equal(pending.next().done, true);
  assert.equal(calls.length, 2);
});

test("preview rejects summary demands without reading private context", () => {
  const service = new TaskSummaryService({ store: new Proxy({}, { get() { assert.fail("preview must not read Store"); } }),
    backgroundAgent: {}, isEnabled: () => false });
  service.start();
  service.onSessionEvent({ type: "SessionUserMessageCreated", sessionId: "session:1" });
  service.onCommittedMessageDelivery({ messageId: "message:1", sessionId: "session:1" });
  assert.equal(service.request("task:1"), false);
  service.close();
});

test("committed delivery requests a summary only for its authoritative Session event", () => {
  const event = { type: "SessionUserMessageCreated", sessionId: "session:1" };
  const service = new TaskSummaryService({
    store: { getSessionEvent: (id) => id === "user-message:message:1" ? event : null },
    backgroundAgent: {}, isEnabled: () => true
  });
  const observed = [];
  service.onSessionEvent = (value) => observed.push(value);
  service.onCommittedMessageDelivery({ messageId: "missing", sessionId: "session:1" });
  service.onCommittedMessageDelivery({ messageId: "message:1", sessionId: "session:other" });
  assert.deepEqual(observed, []);
  service.onCommittedMessageDelivery({ messageId: "message:1", sessionId: "session:1" });
  assert.deepEqual(observed, [event]);
  service.close();
});

test("streaming updates do not request model summaries", () => {
  const service = new TaskSummaryService({ store: new Proxy({}, { get() { assert.fail("stream delta read"); } }),
    backgroundAgent: {}, isEnabled: () => true });
  service.onSessionEvent({ type: "AgentMessageDelta", sessionId: "session:1" });
  assert.equal(service.timer, null);
  service.close();
});

test("eligible Task requests an automatic summary without per-Task authorization", () => {
  const service = new TaskSummaryService({ store: {}, backgroundAgent: {
    defaultProviderId: "provider:test", selectProvider: (id) => id
  }, isEnabled: () => true });
  const requested = [];
  service.repository = { basis: () => ({ sessionID: "session:1" }), request: (id) => requested.push(id) };
  assert.equal(service.request("task:1"), true);
  assert.deepEqual(requested, ["task:1"]);
  assert.equal(service.running.size, 0);
  assert.notEqual(service.timer, null);
  service.close();
});

test("unavailable summary capability blocks before queueing or reading transcript", () => {
  const blocked = [];
  const service = new TaskSummaryService({ store: {}, backgroundAgent: {
    defaultProviderId: "provider:test",
    selectProvider: () => { throw Object.assign(new Error("Unavailable"), { code: "BACKGROUND_AGENT_UNAVAILABLE" }); }
  }, isEnabled: () => true });
  service.repository = {
    basis: () => ({ sessionID: "session:1" }),
    block: (...args) => blocked.push(args),
    request: () => assert.fail("unsupported operation must not queue")
  };
  assert.equal(service.request("task:1"), false);
  assert.deepEqual(blocked, [["task:1", "BACKGROUND_AGENT_UNAVAILABLE"]]);
  assert.equal(service.timer, null);
  assert.equal(service.running.size, 0);
  service.close();
});

test("Provider change rechecks blocked demands using the new default", () => {
  const requested = [];
  const service = new TaskSummaryService({
    store: { selectAll: () => [{ task_id: "task:1" }] },
    backgroundAgent: { defaultProviderId: "provider:new", selectProvider: (id) => id },
    isEnabled: () => true
  });
  service.repository = { basis: () => ({}), request: (id) => requested.push(id) };
  service.onProviderChanged();
  assert.deepEqual(requested, ["task:1"]);
  service.close();
});

test("summary routing uses the current default Provider without fallback or a Task override", () => {
  const calls = [];
  const backgroundAgent = { defaultProviderId: "default:one", selectProvider: (...args) => {
    calls.push(args); return args[0];
  } };
  const service = new TaskSummaryService({ store: {}, backgroundAgent });
  assert.equal(service.defaultProvider(), "default:one");
  backgroundAgent.defaultProviderId = "default:two";
  assert.equal(service.defaultProvider(), "default:two");
  assert.deepEqual(calls[1], ["default:two", "read-only", { allowFallback: false, executionPolicy: "no-tools" }]);
  service.close();
});
