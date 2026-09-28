import assert from "node:assert/strict";
import test from "node:test";
import { createSessionTaskCommands } from "../src/application/sessionTaskCommands.mjs";

function fixture() {
  const calls = [];
  const task = { id: "task" };
  const session = { id: "session", agentId: "agent", taskId: task.id };
  const commands = createSessionTaskCommands({
    store: {
      getLogicalSession: (id) => id === "logical" ? { legacySessionId: session.id } : null,
      getLogicalSessionByLegacySessionId: () => null,
      getSession: (id) => id === session.id ? session : null,
      getTask: (id) => id === task.id ? task : null
    },
    collaborationCore: { getAgentForSession: () => ({ agentId: "agent" }) },
    workService: {
      recordAcceptanceAssessment: (id, input) => { calls.push(["acceptance", id, input]); return task; },
      reviseTask: (id, input) => { calls.push(["revise", id, input]); return { task, snapshot: { id: "snapshot" } }; }
    },
    taskCompletionService: {
      completeFromSession: (input, metadata) => {
        calls.push(["complete", input, metadata]);
        return { task, operation: { id: "operation" }, idempotentReplay: true };
      }
    },
    presentTaskForClient: (value) => ({ ...value, presented: true })
  });
  return { calls, commands, session };
}

test("bound-task reads and acceptance require the authenticated session and matching task", () => {
  const f = fixture();
  assert.throws(() => f.commands.getBoundTaskForAgent("agent"), { code: "SESSION_SCOPE_REQUIRED" });
  assert.throws(() => f.commands.getBoundTaskForAgent("other", {}, { sessionId: "session" }), { code: "SESSION_ACTOR_MISMATCH" });
  assert.throws(() => f.commands.getBoundTaskForAgent("agent", {}, {
    sessionId: "session", taskId: "other"
  }), { code: "TASK_SESSION_MISMATCH" });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.commands.getBoundTaskForAgent("agent", {}, { sessionId: "logical" }), {
    id: "task", presented: true
  });
});

test("acceptance records the resolved session, never a caller-supplied source identity", () => {
  const f = fixture();
  const results = [{ verdict: "passed" }];
  f.commands.reportTaskAcceptanceForAgent("agent", { results, sourceSessionId: "other" }, { sessionId: "logical" });
  assert.deepEqual(f.calls, [["acceptance", "task", { sourceSessionId: "session", results }]]);
});

test("revision requires direct user provenance and binds its creator to the session", () => {
  const f = fixture();
  assert.throws(() => f.commands.reviseTaskForSession("agent", {}, { sessionId: "session" }), {
    code: "TASK_REVISION_SOURCE_REQUIRED"
  });
  const result = f.commands.reviseTaskForSession("agent", {
    sourceMessageId: "user:one", createdBySessionId: "other"
  }, { sessionId: "logical", taskId: "task" });
  assert.equal(f.calls[0][2].createdBySessionId, "session");
  assert.equal(result.task.presented, true);
  assert.deepEqual(result.snapshot, { id: "snapshot" });
});

test("completion requires logical scope and preserves operation receipts and replay status", () => {
  const f = fixture();
  assert.throws(() => f.commands.completeTaskForSession("agent", {}, { sessionId: "session" }), {
    code: "SESSION_SCOPE_REQUIRED"
  });
  const result = f.commands.completeTaskForSession("agent", { evidence: [] }, {
    sessionId: " session ", logicalSessionId: " logical ", taskId: "task"
  });
  assert.deepEqual(f.calls[0][2], { sessionId: "session", logicalSessionId: "logical", taskId: "task" });
  assert.deepEqual(result, { task: { id: "task", presented: true }, operation: { id: "operation" }, idempotentReplay: true });
});
