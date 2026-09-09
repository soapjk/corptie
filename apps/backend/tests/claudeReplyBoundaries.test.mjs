import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeAgentManager } from "../src/adapters/claudeAgentManager.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ProviderEventProjector } from "../src/application/providerEventProjector.mjs";
import { mapClaudeProviderEvent, mapClaudeTurnSettled } from "../src/application/providerEventEnvelope.mjs";

test("multi-message Claude Turn preserves distinct text, tools and final answer in SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-replies-"));
  const store = new CorptieStore({ dbPath: join(dir, "db.sqlite"), configPath: join(dir, "config.json") });
  try {
    await store.initialize();
    store.upsertSession({ id: "pty:reply", provider: "claude-sdk", title: "Replies", status: "running", sessionKind: "assistantChat" });
    const binding = { sessionId: "pty:reply", bindingId: "binding:reply", providerId: "claude-sdk",
      providerSessionId: "reply", logicalSessionId: "logical:reply", routingVersion: 1, isCurrentRoute: true };
    const projector = new ProviderEventProjector({ store });
    let sequence = 0;
    const project = event => projector.project({ binding, event: { ...event, providerSequence: ++sequence } });
    const manager = new ClaudeAgentManager({
      onProviderEvent: event => project(mapClaudeProviderEvent({ event, binding, receivedAt: new Date().toISOString() })),
      onTurnSettled: event => project(mapClaudeTurnSettled({ event, binding, receivedAt: new Date().toISOString() }))
    });
    manager.start({ id: "reply" });
    const session = manager.get("reply");
    session.currentTurnId = "turn:reply"; session.turnState = "running"; session.status = "running";
    const emit = message => manager.handleSdkMessage(session, message);
    const text = (value, stop_reason) => {
      emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "The" } } });
      emit({ type: "assistant", message: { stop_reason, content: [{ type: "text", text: value }] } });
    };
    text("The first progress update", "tool_use");
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool:one", name: "Bash", input: { command: "true" } }] } });
    text("The second progress update", "tool_use");
    text("The complete formal answer, not just The", "end_turn");
    assert.ok(session.items.filter(i => i.type === "agentMessage").every(i => i.presentationRole === "commentary"));
    emit({ type: "result", subtype: "success", result: "The complete formal answer, not just The" });
    await new Promise(resolve => setImmediate(resolve));
    const messages = store.getItems("pty:reply", 100).filter(i => i.type === "agentMessage");
    assert.equal(new Set(messages.map(i => i.id)).size, 3);
    assert.deepEqual(messages.map(i => i.text), ["The first progress update", "The second progress update", "The complete formal answer, not just The"]);
    assert.deepEqual(messages.map(i => i.presentationRole), ["commentary", "commentary", "final_answer"]);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("tool continuation text is not promoted to a formal answer at settlement", () => {
  const manager = new ClaudeAgentManager(); manager.start({ id: "continuation" });
  const session = manager.get("continuation"); session.currentTurnId = "turn:one";
  manager.handleSdkMessage(session, { type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "text", text: "Let me inspect" }] } });
  manager.handleSdkMessage(session, { type: "result", subtype: "success", result: "" });
  assert.equal(session.items.find(i => i.type === "agentMessage").presentationRole, "commentary");
});
