import assert from "node:assert/strict";
import test from "node:test";
import { TaskSummaryService } from "../src/application/taskSummaryService.mjs";
import { TaskSummaryRepository } from "../src/store/taskSummaryRepository.mjs";

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

test("task without explicit authorization never starts a generation", () => {
  const service = new TaskSummaryService({ store: { selectOne: () => null }, backgroundAgent: {}, isEnabled: () => true });
  assert.equal(service.request("task:1"), false);
  assert.equal(service.running.size, 0);
  assert.equal(service.timer, null);
  service.close();
});
