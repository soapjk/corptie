import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeTimelineWriter } from "../src/adapters/claudeTimelineWriter.mjs";

function fixture(maxItems = 20) {
  const events = [];
  const session = { id: "session", currentTurnId: "turn", status: "running",
    nextItemSeq: 1, items: [], pendingToolCalls: new Map() };
  const writer = createClaudeTimelineWriter({
    maxItems: () => maxItems,
    emitProviderEvent: (_session, event) => events.push(event)
  });
  return { writer, session, events };
}

test("retention trims old items without reusing sequence identifiers", () => {
  const { writer, session, events } = fixture(2);
  for (let index = 0; index < 3; index++) {
    writer.appendItem(session, { type: "agentMessage", title: "Claude", text: String(index) });
  }
  assert.deepEqual(session.items.map((item) => item.id), ["session:2", "session:3"]);
  assert.equal(session.nextItemSeq, 4);
  assert.equal(events.length, 3);
  assert.equal(events[2].type, "assistant.message.delta");
});

test("tool results settle the correlated row once and remove the pending association", () => {
  const { writer, session, events } = fixture();
  const item = writer.appendItem(session, {
    type: "commandExecution", title: "Bash", text: "pwd",
    status: "running", toolUseId: "native-tool"
  });
  session.pendingToolCalls.set("native-tool", item.id);
  const message = { uuid: "result", message: { content: [
    { type: "tool_result", tool_use_id: "native-tool", content: "/workspace" }
  ] } };
  writer.settleToolResults(session, message);
  assert.equal(session.items[0].status, "completed");
  assert.equal(session.pendingToolCalls.size, 0);
  assert.equal(events.at(-1).type, "tool.completed");
  assert.equal(events.at(-1).providerEventId, "claude-tool:result:native-tool");
  const count = events.length;
  writer.settleToolResults(session, message);
  assert.equal(events.length, count);
});

test("late task progress cannot reopen a terminal task", () => {
  const { writer, session, events } = fixture();
  writer.upsertTaskProgressItem(session, { description: "work" }, "task", false);
  writer.upsertTaskProgressItem(session, { status: "completed", summary: "done" }, "task", true);
  const count = events.length;
  writer.upsertTaskProgressItem(session, { description: "late progress" }, "task", false);
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].status, "completed");
  assert.equal(events.length, count);
});
