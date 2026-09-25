import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeAgentManager } from "../src/adapters/claudeAgentManager.mjs";
import { mapClaudeProviderEvent } from "../src/application/providerEventEnvelope.mjs";
import { ProviderEventIngestionService } from "../src/application/providerEventIngestionService.mjs";
import { ProviderEventProjector } from "../src/application/providerEventProjector.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Claude SDK TodoWrite and TaskCreate results reach the shared persisted checklist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-claude-plan-flow-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  try {
    await store.initialize();
    store.upsertSession({ id: "session:one", title: "Claude plan", agent: "Agent", provider: "claude-sdk", status: "running" });
    const binding = { sessionId: "session:one", bindingId: "binding:claude", providerId: "claude-sdk",
      providerSessionId: "claude:one", logicalSessionId: "logical:one", routingVersion: 1, isCurrentRoute: true };
    const projector = new ProviderEventProjector({ store });
    const ingestion = new ProviderEventIngestionService({ store, resolveBinding: () => binding,
      project: ({ event }) => projector.project({ event, binding }) });
    const accepted = [];
    const manager = new ClaudeAgentManager({ onProviderEvent: (event) => {
      const envelope = mapClaudeProviderEvent({ event, binding, receivedAt: new Date().toISOString() });
      if (envelope) accepted.push(ingestion.ingest(envelope));
    } });
    manager.start({ id: "claude:one" });
    const session = manager.get("claude:one");
    session.currentTurnId = "turn:one";
    manager.handleSdkMessage(session, { type: "assistant", message: { content: [
      { type: "tool_use", id: "call:todo", name: "TodoWrite", input: { todos: [
        { content: "Inspect", status: "in_progress", activeForm: "Inspecting" }
      ] } }
    ] } });
    manager.handleSdkMessage(session, { type: "user", uuid: "result:todo", tool_use_result: {
      newTodos: [{ content: "Inspect", status: "in_progress", activeForm: "Inspecting" }]
    }, message: { content: [
      { type: "tool_result", tool_use_id: "call:todo", content: "ok" }
    ] } });
    manager.handleSdkMessage(session, { type: "assistant", message: { content: [
      { type: "tool_use", id: "call:create", name: "TaskCreate", input: { subject: "Build UI", description: "..." } }
    ] } });
    manager.handleSdkMessage(session, { type: "user", uuid: "result:create", tool_use_result: {
      task: { id: "7", subject: "Build UI" }
    }, message: { content: [{ type: "tool_result", tool_use_id: "call:create", content: "created" }] } });
    manager.handleSdkMessage(session, { type: "assistant", message: { content: [
      { type: "tool_use", id: "call:bash", name: "Bash", input: { command: "pwd" } }
    ] } });
    manager.handleSdkMessage(session, { type: "user", uuid: "result:bash", message: { content: [
      { type: "tool_result", tool_use_id: "call:bash", content: "/tmp/project" }
    ] } });
    manager.handleSdkMessage(session, { type: "assistant", message: { content: [
      { type: "tool_use", id: "call:edit", name: "Edit", input: {
        file_path: "/tmp/project/App.swift", old_string: "old", new_string: "new"
      } }
    ] } });
    manager.handleSdkMessage(session, { type: "user", uuid: "result:edit", tool_use_result: {
      filePath: "/tmp/project/App.swift", structuredPatch: [{ lines: ["-old", "+new"] }]
    }, message: { content: [
      { type: "tool_result", tool_use_id: "call:edit", content: "edited" }
    ] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(accepted.every((result) => result.status === "applied"));
    const plans = store.getItems("session:one").filter((item) => item.type === "executionPlan");
    assert.equal(plans.length, 2);
    assert.deepEqual(plans.map((item) => item.executionPlan.steps[0].text).sort(), ["Build UI", "Inspect"]);
    assert.equal(store.getItems("session:one").filter((item) => ["TodoWrite", "TaskCreate"].includes(item.title)).length, 0,
      "successful structured updates must not duplicate raw tool cards");
    const commands = store.getItems("session:one").filter((item) => item.type === "commandExecution");
    assert.equal(commands.length, 1);
    assert.equal(commands[0].status, "completed");
    assert.match(commands[0].text, /\/tmp\/project/);
    assert.deepEqual(commands[0].toolExecution, {
      schemaVersion: 1, toolId: commands[0].id, name: "Bash", status: "completed",
      input: "pwd", result: "/tmp/project"
    });
    const edits = store.getItems("session:one").filter((item) => item.type === "fileChange");
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0].changeSet.changes, [{
      path: "/tmp/project/App.swift", kind: "modify", diffPreview: "-old\n+new", diffTruncated: false
    }]);
    await store.close();
    const restored = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
    try {
      await restored.initialize();
      assert.equal(restored.getExecutionPlanState("session:one", binding.bindingId, "claude-tasks").steps[0].text, "Build UI");
      new ProviderEventProjector({ store: restored }).project({ binding, event: {
        providerId: binding.providerId, bindingId: binding.bindingId, routingVersion: 1,
        turnId: "turn:two", type: "plan.updated", receivedAt: "2026-09-24T00:00:01Z",
        payload: { plan: { operation: "upsert", planKey: "claude-tasks",
          step: { stepId: "task:7", status: "completed" } } }
      } });
      const latest = restored.getItemsForTurn("session:one", "turn:two").find((item) => item.type === "executionPlan");
      assert.equal(latest.executionPlan.steps[0].text, "Build UI");
      assert.equal(latest.executionPlan.steps[0].status, "completed");
      assert.equal(restored.getSessionItem("session:one", plans.find((item) => item.executionPlan.steps[0].text === "Build UI").id)
        .executionPlan.steps[0].status, "pending");
    } finally {
      await restored.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude background progress persists one revisable tool item across notifications", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-claude-background-flow-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  try {
    await store.initialize();
    store.upsertSession({ id: "session:background", title: "Background", agent: "Agent", provider: "claude-sdk", status: "running" });
    const binding = { sessionId: "session:background", bindingId: "binding:background", providerId: "claude-sdk",
      providerSessionId: "claude:background", logicalSessionId: "logical:background", routingVersion: 1, isCurrentRoute: true };
    const projector = new ProviderEventProjector({ store });
    const ingestion = new ProviderEventIngestionService({ store, resolveBinding: () => binding,
      project: ({ event }) => projector.project({ event, binding }) });
    const results = [];
    const manager = new ClaudeAgentManager({ onProviderEvent: event => {
      const envelope = mapClaudeProviderEvent({ event, binding, receivedAt: new Date().toISOString() });
      if (envelope) results.push(ingestion.ingest(envelope));
    } });
    manager.start({ id: "claude:background" });
    const session = manager.get("claude:background");
    session.currentTurnId = "turn:background";
    for (const message of [
      { subtype: "task_started", uuid: "bg:start", description: "Inspect", subagent_type: "general-purpose" },
      { subtype: "task_progress", uuid: "bg:progress", description: "Inspecting files" },
      { subtype: "task_updated", uuid: "bg:update", patch: { status: "running", description: "Reviewing" } },
      { subtype: "task_notification", uuid: "bg:done", status: "completed", summary: "Reviewed" }
    ]) manager.handleSdkMessage(session, { type: "system", task_id: "task:one", ...message });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(results.length, 4);
    assert.ok(results.every(result => result.status === "applied"));
    const items = store.getItems("session:background").filter(item => item.type === "mcpToolCall");
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "completed");
    assert.match(items[0].text, /Reviewed/);
    assert.equal(items[0].toolExecution.status, "completed");
    assert.equal(items[0].toolExecution.toolId, items[0].id);
    assert.equal(items[0].toolExecution.input, "Inspect");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
