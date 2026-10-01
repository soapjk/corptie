import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeAgentManager, normalizeClaudeRuntimeOptions } from "../src/adapters/claudeAgentManager.mjs";
test("Claude forks through the SDK at the native message and waits for new input", async () => {
  const calls = [];
  const manager = new ClaudeAgentManager({ forkSession: async (...args) => { calls.push(args); return { sessionId: "sdk-child" }; },
    query: () => assert.fail("Creation must not dispatch a model turn") });
  manager.start({ id: "source", cwd: "/repo/source", agentSessionId: "sdk-source" });
  const result = await manager.fork({ id: "child", cwd: "/repo/child", title: "Child", model: "chosen", reasoningLevel: "low" },
    { forkSource: { reference: { providerSessionId: "source" }, point: { providerMessageId: "native-message" } } });
  assert.deepEqual(calls, [["sdk-source", { dir: "/repo/source", upToMessageId: "native-message", title: "Child" }]]);
  assert.equal(manager.get("child").agentSessionId, "sdk-child");
  assert.equal(manager.get("source").agentSessionId, "sdk-source");
  assert.equal(result.external.cwd, "/repo/child");
  assert.equal(manager.get("child").queryInput.pendingCount, 0);
});

test("Claude persists the native UUID on the final streamed assistant item", () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "source" });
  const session = manager.get("source");
  session.currentTurnId = "turn";
  manager.updateStreamingAssistant(session, "partial");
  manager.handleSdkMessage(session, { type: "assistant", uuid: "native-uuid",
    message: { content: [{ type: "text", text: "final" }], stop_reason: "end_turn" } });
  assert.equal(JSON.parse(session.items.at(-1).rawMetadataJSON).forkPoint.messageId, "native-uuid");
});
test("rejected live model switch leaves the previous selection intact", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "model-switch-rejected", model: "old" });
  const session = manager.get("model-switch-rejected");
  session.query = { setModel: async () => { throw new Error("rejected"); } };
  await assert.rejects(manager.switchModel(session.id, "new"), /rejected/);
  assert.equal(session.currentModel, "old");
  session.query = null;
  session.status = "failed";
  const result = await manager.switchModel(session.id, "new");
  assert.equal(result.external.currentModel, "new");
  assert.equal(result.capabilities.canSend, true);
});

test("Claude carries an explicit empty builtin tool set through to the SDK query", async () => {
  let received;
  const manager = new ClaudeAgentManager({ query: (input) => {
    received = input.options;
    return { async *[Symbol.asyncIterator]() {} };
  } });
  const tools = [];
  manager.start({ id: "claude-no-builtins", runtimeOptions: { tools, settingSources: [] } });
  tools.push("Bash");
  await manager.ensureQueryStarted(manager.get("claude-no-builtins"));
  assert.deepEqual(received.tools, []);
  assert.deepEqual(received.settingSources, []);
  assert.equal(Object.hasOwn(normalizeClaudeRuntimeOptions({}), "tools"), false);
  for (const value of [null, "", {}, [null], [""]]) {
    assert.throws(() => normalizeClaudeRuntimeOptions({ tools: value }), TypeError);
  }
});

test("background no-tools disables built-ins, inherited MCP, settings and plugins, then releases the query", async () => {
  let captured;
  let closed = false;
  const manager = new ClaudeAgentManager({ query: (request) => {
    captured = request;
    return {
      async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", is_error: false, result: "summary" }; },
      close() { closed = true; }
    };
  } });
  assert.deepEqual(await manager.runBackgroundPrompt({
    prompt: "input", developerInstructions: "Schema instructions", executionPolicy: "no-tools",
    permissionProfile: "read-only"
  }), { text: "summary" });
  assert.deepEqual(captured.options.tools, []);
  assert.deepEqual(captured.options.mcpServers, {});
  assert.equal(captured.options.strictMcpConfig, true);
  assert.deepEqual(captured.options.settingSources, []);
  assert.deepEqual(captured.options.plugins, []);
  assert.deepEqual(captured.options.agents, {});
  assert.deepEqual(captured.options.hooks, {});
  assert.equal(captured.options.systemPrompt, "Schema instructions");
  assert.equal(captured.options.persistSession, false);
  assert.equal((await captured.options.canUseTool("Read", {})).behavior, "deny");
  assert.equal(closed, true);
});

test("background rejects unsupported execution policies before creating a query", async () => {
  const manager = new ClaudeAgentManager({ query: () => { assert.fail("must not start query"); } });
  await assert.rejects(manager.runBackgroundPrompt({ executionPolicy: "unknown" }), { code: "CAPABILITY_UNSUPPORTED" });
  await assert.rejects(manager.runBackgroundPrompt({ executionPolicy: "no-tools", permissionProfile: "workspace-write" }), {
    code: "CAPABILITY_UNSUPPORTED"
  });
});

test("background cancellation rejects late output and closes the query", async () => {
  const controller = new AbortController();
  let closed = false;
  const manager = new ClaudeAgentManager({ query: () => ({
    async *[Symbol.asyncIterator]() {
      controller.abort();
      yield { type: "result", result: "late output" };
    },
    close() { closed = true; }
  }) });
  await assert.rejects(manager.runBackgroundPrompt({ executionPolicy: "no-tools", signal: controller.signal }));
  assert.equal(closed, true);
});

test("Claude preserves a recovery handoff alongside ordinary system instructions", () => {
  const manager = new ClaudeAgentManager();
  manager.start({
    id: "claude-recovery-context",
    runtimeOptions: {
      systemPrompt: { type: "preset", preset: "claude_code", append: "Agent instructions" }
    },
    recoveryContext: "STRUCTURED_RECOVERY_HANDOFF"
  });
  assert.equal(
    manager.get("claude-recovery-context").runtimeOptions.systemPrompt.append,
    "Agent instructions\n\nSTRUCTURED_RECOVERY_HANDOFF"
  );
});

test("Claude disconnect releases the live Query but keeps the persisted Session resumable", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-archived" });
  let closed = false;
  manager.get("claude-archived").query = { close: async () => { closed = true; } };

  assert.deepEqual(await manager.disconnect("claude-archived"), { status: "disconnected" });
  assert.equal(closed, true);
  assert.equal(manager.get("claude-archived"), null);
});

test("Claude exposes context use and subscription rate-limit windows through its live SDK query", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-usage", model: "claude-opus" });
  manager.get("claude-usage").query = {
    async getContextUsage() {
      return { totalTokens: 120_000, maxTokens: 200_000, percentage: 60 };
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 37.5, resets_at: "2026-08-10T12:00:00.000Z" },
          seven_day: { utilization: 22, resets_at: "2026-08-17T00:00:00.000Z" }
        }
      };
    }
  };

  assert.deepEqual(await manager.readSessionUsage("claude-usage"), {
    usedTokens: 120_000,
    contextWindow: 200_000,
    remainingTokens: 80_000,
    usedPercent: 60
  });
  const account = await manager.readAccountUsage("claude-usage");
  assert.equal(account.available, true);
  assert.equal(account.provider, "claude");
  assert.equal(account.subscriptionType, "max");
  assert.equal(account.rateLimitsByLimitId.five_hour.primary.usedPercent, 37.5);
  assert.equal(account.rateLimitsByLimitId.five_hour.primary.windowDurationMins, 300);
  assert.equal(account.rateLimitsByLimitId.seven_day.primary.windowDurationMins, 10_080);
});

test("Claude starts only one live Query when usage loading and sending connect concurrently", async () => {
  let starts = 0;
  const query = {
    async *[Symbol.asyncIterator]() {},
    async getContextUsage() { return { totalTokens: 1, maxTokens: 100, percentage: 1 }; },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return { rate_limits_available: false, rate_limits: null };
    }
  };
  const manager = new ClaudeAgentManager({
    query: () => {
      starts += 1;
      return query;
    }
  });
  manager.start({ id: "claude-concurrent-usage" });
  const session = manager.get("claude-concurrent-usage");

  await Promise.all([
    manager.ensureQueryStarted(session),
    manager.readSessionUsage("claude-concurrent-usage"),
    manager.readAccountUsage("claude-concurrent-usage")
  ]);

  assert.equal(starts, 1);
});

test("Claude sends resolved Session context without exposing it as the visible user message", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-context" });
  const session = manager.get("claude-context");
  manager.ensureQueryStarted = async () => {};
  let providerMessage = null;
  manager.enqueueInput = (_session, message) => { providerMessage = message; };

  await manager.send("claude-context", "Fix the bug", { contextPrompt: "Reference context" });

  assert.equal(session.items.at(-1).text, "Fix the bug");
  assert.equal(providerMessage.message.content[0].text, "[[CORPTIE_CONTEXT_V1:17]]Reference contextFix the bug");
});

test("Claude connection test reports a verified model without exposing its ephemeral API Key", async () => {
  const apiKey = "sk-ant-connection-key-12345678901234567890";
  let received = null;
  let closed = false;
  const manager = new ClaudeAgentManager({
    environment: () => ({ PATH: "/usr/bin" }),
    query: (input) => {
      received = input;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "sdk-test", model: "claude-sonnet-4-6" };
          yield { type: "result", subtype: "success", is_error: false, result: "OK", session_id: "sdk-test" };
        },
        close: () => { closed = true; }
      };
    }
  });

  const result = await manager.testConnection({ apiKey, timeoutMs: 5_000 });

  assert.equal(result.ok, true);
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.equal(result.authentication.configured, true);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
  assert.equal(received.options.env.ANTHROPIC_API_KEY, apiKey);
  assert.equal(received.options.persistSession, false);
  assert.equal(closed, true);
});

test("Claude connection test classifies a rate-limit result", async () => {
  const manager = new ClaudeAgentManager({
    query: () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["429 rate limit exceeded"]
        };
      },
      close: () => {}
    })
  });

  await assert.rejects(
    manager.testConnection({ timeoutMs: 5_000 }),
    (error) => error.code === "RATE_LIMITED" && error.retryable === true
  );
});

test("Claude emits stable incremental timeline items for SDK partial text", async () => {
  const events = [];
  const manager = new ClaudeAgentManager({ onProviderEvent: (event) => events.push(event) });
  manager.start({ id: "claude-stream" });
  manager.ensureQueryStarted = async () => {};
  manager.enqueueInput = () => {};
  await manager.send("claude-stream", "Stream", { turnId: "turn:stream" });
  const session = manager.get("claude-stream");

  manager.handleSdkMessage(session, {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }
  });
  manager.handleSdkMessage(session, {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }
  });
  manager.handleSdkMessage(session, sdkAssistant([{ type: "text", text: "Hello" }]));
  await new Promise((resolve) => setImmediate(resolve));

  const streamed = session.items.filter((item) => item.type === "agentMessage");
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0].text, "Hello");
  assert.equal(streamed[0].presentationRole, "commentary");
  const deltas = events.filter((event) => event.type === "assistant.message.delta");
  assert.equal(new Set(deltas.map((event) => event.itemId)).size, 1);
  assert.deepEqual(deltas.map((event) => event.item.text), ["Hel", "Hello"]);
  assert.equal(events.at(-1).type, "assistant.message.completed");
});

test("Claude emits a structured plan only after its TodoWrite tool result succeeds", async () => {
  const events = [];
  const manager = new ClaudeAgentManager({ onProviderEvent: (event) => events.push(event) });
  manager.start({ id: "claude-plan" });
  const session = manager.get("claude-plan");
  session.currentTurnId = "turn:plan";
  manager.handleSdkMessage(session, sdkAssistant([{ type: "tool_use", id: "tool:todo",
    name: "TodoWrite", input: { todos: [{ content: "Implement", status: "in_progress", activeForm: "Implementing" }] } }]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.type === "plan.updated"), false);
  manager.handleSdkMessage(session, { type: "user", uuid: "result:todo", tool_use_result: {
    newTodos: [{ content: "Implement", status: "in_progress", activeForm: "Implementing" }]
  }, message: { content: [
    { type: "tool_result", tool_use_id: "tool:todo", content: "ok" }
  ] } });
  await new Promise((resolve) => setImmediate(resolve));
  const planEvents = events.filter((event) => event.type === "plan.updated");
  assert.equal(planEvents.length, 1);
  assert.equal(planEvents[0].turnId, "turn:plan");
  assert.deepEqual(planEvents[0].plan.steps, [{ text: "Implement", status: "inProgress" }]);
});

test("Claude without declared plan support keeps TodoWrite as an ordinary settled tool", async () => {
  const events = [];
  const manager = new ClaudeAgentManager({ structuredPlanEvents: false,
    onProviderEvent: (event) => events.push(event) });
  manager.start({ id: "claude-plan-disabled" });
  const session = manager.get("claude-plan-disabled");
  session.currentTurnId = "turn:disabled";
  manager.handleSdkMessage(session, sdkAssistant([{ type: "tool_use", id: "tool:todo-disabled",
    name: "TodoWrite", input: { todos: [{ content: "Inspect", status: "pending" }] } }]));
  manager.handleSdkMessage(session, { type: "user", uuid: "result:disabled", tool_use_result: {
    newTodos: [{ content: "Inspect", status: "completed" }]
  }, message: { content: [{ type: "tool_result", tool_use_id: "tool:todo-disabled", content: "ok" }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].title, "TodoWrite");
  assert.equal(session.items[0].status, "completed");
  assert.equal(events.some((event) => event.type === "plan.updated"), false);
});

test("failed Claude plan tool remains visible without changing the checklist", async () => {
  const events = [];
  const manager = new ClaudeAgentManager({ onProviderEvent: (event) => events.push(event) });
  manager.start({ id: "claude-plan-failed" });
  const session = manager.get("claude-plan-failed");
  session.currentTurnId = "turn:failed-plan";
  manager.handleSdkMessage(session, sdkAssistant([{ type: "tool_use", id: "tool:failed",
    name: "TodoWrite", input: { todos: [{ content: "Inspect", status: "pending", activeForm: "Inspecting" }] } }]));
  manager.handleSdkMessage(session, { type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "tool:failed", is_error: true, content: "failed" }
  ] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.type === "plan.updated"), false);
  assert.ok(events.some((event) => event.type === "tool.failed" && event.item?.title === "TodoWrite"));
});

test("Claude plan calls without a result remain visible as uncertain after the Turn settles", async () => {
  const events = [];
  const manager = new ClaudeAgentManager({ onProviderEvent: (event) => events.push(event) });
  manager.start({ id: "claude-plan-no-result" });
  const session = manager.get("claude-plan-no-result");
  session.currentTurnId = "turn:no-result";
  manager.handleSdkMessage(session, sdkAssistant([{ type: "tool_use", id: "tool:missing",
    name: "TodoWrite", input: { todos: [{ content: "Inspect", status: "pending" }] } }]));
  assert.equal(session.items.filter((item) => item.title === "TodoWrite").length, 0);
  manager.handleSdkMessage(session, { type: "result", subtype: "success", is_error: false, result: "" });
  await new Promise((resolve) => setImmediate(resolve));
  const fallback = session.items.find((item) => item.title === "TodoWrite");
  assert.ok(fallback);
  assert.equal(fallback.id, "claude-plan-no-result:plan-tool:tool:missing");
  assert.equal(fallback.status, "unknown");
  assert.equal(fallback.turnId, "turn:no-result");
  assert.equal(events.some((event) => event.type === "plan.updated"), false);
  assert.equal(events.filter((event) => event.item?.id === fallback.id).length, 1);
});

test("Claude TaskUpdate without confirmed checklist fields remains a completed tool card", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-task-no-plan-change" });
  const session = manager.get("claude-task-no-plan-change");
  session.currentTurnId = "turn:no-plan-change";
  manager.handleSdkMessage(session, sdkAssistant([{ type: "tool_use", id: "tool:description",
    name: "TaskUpdate", input: { taskId: "7", description: "More detail", status: "completed" } }]));
  manager.handleSdkMessage(session, { type: "user", uuid: "result:description", tool_use_result: {
    success: true, taskId: "7", updatedFields: ["description"]
  }, message: { content: [{ type: "tool_result", tool_use_id: "tool:description", content: "ok" }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].type, "mcpToolCall");
  assert.equal(session.items[0].status, "completed");
  assert.equal(session.items.some((item) => item.type === "executionPlan"), false);
});

test("malformed Claude plan tool calls retain their ordinary tool card", () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-plan-malformed" });
  const session = manager.get("claude-plan-malformed");
  session.currentTurnId = "turn:malformed";
  manager.handleSdkMessage(session, sdkAssistant([{ type: "tool_use", id: "tool:malformed",
    name: "TodoWrite", input: "not an object" }]));
  assert.equal(session.items.filter((item) => item.title === "TodoWrite").length, 1);
  assert.equal(session.pendingPlanCalls?.size, 0);
});

test("Claude tool results settle the original call instead of adding another item", async () => {
  const events = [];
  const manager = new ClaudeAgentManager({ onProviderEvent: (event) => events.push(event) });
  manager.start({ id: "claude-tool-result" });
  const session = manager.get("claude-tool-result");
  session.currentTurnId = "turn:tool";
  manager.handleSdkMessage(session, sdkAssistant([{ type: "tool_use", id: "use:bash",
    name: "Bash", input: { command: "pwd" } }]));
  const original = session.items.find((item) => item.toolUseId === "use:bash");
  assert.equal(original.status, "running");
  assert.deepEqual(JSON.parse(original.rawMetadataJSON).toolExecution, {
    schemaVersion: 1, toolId: original.id, name: "Bash", status: "running",
    input: "pwd", result: null
  });
  manager.handleSdkMessage(session, { type: "user", uuid: "result:bash", message: { content: [
    { type: "tool_result", tool_use_id: "use:bash", content: "/tmp/project" }
  ] } });
  await new Promise((resolve) => setImmediate(resolve));
  const settled = session.items.find((item) => item.id === original.id);
  assert.equal(session.items.length, 1);
  assert.equal(settled.status, "completed");
  assert.match(settled.text, /\/tmp\/project/);
  assert.deepEqual(JSON.parse(settled.rawMetadataJSON).toolExecution, {
    schemaVersion: 1, toolId: original.id, name: "Bash", status: "completed",
    input: "pwd", result: "/tmp/project"
  });
  assert.deepEqual(events.filter((event) => event.type.startsWith("tool.")).map((event) => event.itemId),
    [original.id, original.id]);
});

test("Claude generic tool input and result never expose named credentials in client-visible fields", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-secret-tool" });
  const session = manager.get("claude-secret-tool");
  session.currentTurnId = "turn:secret-tool";
  manager.handleSdkMessage(session, sdkAssistant([{ type: "tool_use", id: "use:secret",
    name: "McpSecretTool", input: { apiKey: "must-not-leak", query: "safe" } }]));
  const original = session.items.find((item) => item.toolUseId === "use:secret");
  assert.ok(original);
  assert.doesNotMatch(original.text, /must-not-leak/);
  assert.match(original.text, /\[REDACTED\]/);
  assert.doesNotMatch(original.rawMetadataJSON, /must-not-leak/);
  manager.handleSdkMessage(session, { type: "user", uuid: "result:secret", message: { content: [
    { type: "tool_result", tool_use_id: "use:secret",
      content: '{"accessToken":"also-secret","status":"ok"}' }
  ] } });
  await new Promise((resolve) => setImmediate(resolve));
  const settled = session.items.find((item) => item.id === original.id);
  assert.equal(settled.status, "completed");
  assert.doesNotMatch(JSON.stringify(settled), /must-not-leak|also-secret/);
  assert.match(settled.text, /"status":"ok"/);
  assert.match(JSON.parse(settled.rawMetadataJSON).toolExecution.result, /\[REDACTED\]/);
});

test("a failed Claude Edit does not report a committed file change", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-edit-failed" });
  const session = manager.get("claude-edit-failed");
  session.currentTurnId = "turn:edit";
  manager.handleSdkMessage(session, sdkAssistant([{ type: "tool_use", id: "use:edit",
    name: "Edit", input: { file_path: "/tmp/App.swift", old_string: "old", new_string: "new" } }]));
  assert.equal(session.items[0].changeSet.changes[0].path, "/tmp/App.swift");
  manager.handleSdkMessage(session, { type: "user", uuid: "result:edit", message: { content: [
    { type: "tool_result", tool_use_id: "use:edit", is_error: true, content: "not found" }
  ] } });
  assert.equal(session.items[0].status, "failed");
  assert.equal(session.items[0].changeSet, null);
  assert.equal(JSON.parse(session.items[0].rawMetadataJSON).changeSet, undefined);
});

test("Claude starts ordinary queries with partial messages and the isolated runtime environment", async () => {
  let received = null;
  const query = { async *[Symbol.asyncIterator]() {} };
  const manager = new ClaudeAgentManager({
    environment: () => ({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-runtime-secret-1234567890" }),
    query: (input) => { received = input; return query; }
  });
  manager.start({ id: "claude-runtime-options" });
  await manager.ensureQueryStarted(manager.get("claude-runtime-options"));

  assert.equal(received.options.includePartialMessages, true);
  assert.equal(received.options.env.ANTHROPIC_API_KEY, "sk-ant-runtime-secret-1234567890");
  assert.equal(received.options.env.CLAUDE_AGENT_SDK_CLIENT_APP, "corptie/claude-provider");
  assert.equal(manager.detail("claude-runtime-options").rawStatus.env, undefined);
});

test("Claude sends a managed image as an SDK image block", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-claude-image-"));
  try {
    const path = join(directory, "image.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(path, bytes);
    const manager = new ClaudeAgentManager();
    manager.start({ id: "claude-image" });
    const session = manager.get("claude-image");
    manager.ensureQueryStarted = async () => {};
    let providerMessage = null;
    manager.enqueueInput = (_session, message) => { providerMessage = message; };

    await manager.send("claude-image", {
      text: "",
      images: [{ absolutePath: path, mimeType: "image/png" }]
    });

    assert.deepEqual(providerMessage.message.content, [{
      type: "image",
      source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") }
    }]);
    assert.equal(session.items.at(-1).type, "userMessage");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude emits Provider-neutral turn and incremental item events without writing product projections", async () => {
  const events = [];
  const storeWrites = [];
  const manager = new ClaudeAgentManager({
    store: {
      getSession: () => null,
      upsertSession: (...args) => storeWrites.push(["session", ...args]),
      appendItem: (...args) => storeWrites.push(["item", ...args])
    },
    onProviderEvent: (event) => events.push(event)
  });
  manager.start({ id: "claude-events" });
  manager.ensureQueryStarted = async () => {};
  manager.enqueueInput = () => {};

  await manager.send("claude-events", "Run it", { localVisibility: "status_only", turnId: "turn:events" });
  manager.handleSdkMessage(
    manager.get("claude-events"),
    sdkAssistant([{ type: "text", text: "Working" }])
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events.map((event) => event.type), ["turn.started", "assistant.message.delta"]);
  assert.equal(events[1].item.text, "Working");
  assert.deepEqual(storeWrites, []);
});

test("Claude reconnect restores Corptie-owned history without importing the SDK transcript", async () => {
  const selectedChoice = {
    id: "choice-restored",
    turnId: "claude-restored-choice:turn:1",
    turnStatus: "complete",
    type: "choice",
    title: "Claude question",
    text: "Deploy now?",
    status: "selected",
    createdAt: "2026-08-09T10:01:00.000Z",
    options: [{ id: "yes", label: "Yes", selected: true }]
  };
  const storedSession = {
    id: "claude-restored-choice",
    title: "Claude restored choice",
    agent: "Claude Code",
    status: "complete",
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:02:00.000Z",
    external: {
      provider: "claude-sdk",
      agentSessionId: "sdk-restored-choice",
      cwd: "/tmp/project"
    },
    rawStatus: {}
  };
  const store = {
    getSession: () => storedSession,
    getItems: () => [selectedChoice],
    upsertSession: () => {}
  };
  const manager = new ClaudeAgentManager({ store });
  await manager.reconnect("claude-restored-choice", { startQuery: false });

  const restored = manager.detail("claude-restored-choice").items;
  assert.deepEqual(restored.map((item) => item.id), ["choice-restored"]);
  assert.equal(restored[0].status, "selected");
  assert.equal(restored[0].options[0].selected, true);
});

test("Claude reconnect does not mistake superseded Provider history for a missing Claude identity", async () => {
  const storedSession = {
    id: "shared-logical-session",
    title: "Switched Session",
    agent: "Claude Code",
    status: "complete",
    createdAt: "2026-09-21T01:00:00.000Z",
    updatedAt: "2026-09-21T01:01:00.000Z",
    external: { provider: "claude-sdk", agentSessionId: null, cwd: "/tmp/project" },
    rawStatus: {}
  };
  const manager = new ClaudeAgentManager({
    store: {
      getSession: () => storedSession,
      getItems: () => [{
        id: "codex-history",
        type: "userMessage",
        text: "Message sent before switching Providers",
        bindingId: "binding:codex"
      }],
      getLogicalSessionByLegacySessionId: () => ({
        logicalSessionId: "logical:shared",
        activeBinding: { bindingId: "binding:claude", providerId: "claude-sdk" }
      }),
      hasSessionTurnForBinding: () => false,
      upsertSession: () => {}
    }
  });

  await manager.reconnect("shared-logical-session", { startQuery: false });

  assert.equal(manager.get("shared-logical-session").agentSessionId, null);
  assert.equal(manager.get("shared-logical-session").phase, "ready");
});

test("Claude reconnect resolves a switched binding whose Provider id differs from the public Session id", async () => {
  const storedSession = {
    id: "codex:public-session",
    title: "Switched Session",
    agent: "Claude Code",
    status: "complete",
    createdAt: "2026-09-21T01:00:00.000Z",
    updatedAt: "2026-09-21T01:01:00.000Z",
    external: { provider: "claude-sdk", agentSessionId: null, cwd: "/tmp/project" },
    rawStatus: {}
  };
  const manager = new ClaudeAgentManager({
    store: {
      getSession: (id) => id === storedSession.id ? storedSession : null,
      getLogicalSessionByProviderSessionId: (providerId, providerSessionId) => {
        assert.equal(providerId, "claude-sdk");
        assert.equal(providerSessionId, "claude:provider-session");
        return { logicalSessionId: "logical:shared", legacySessionId: storedSession.id };
      },
      getLogicalSessionByLegacySessionId: () => ({
        logicalSessionId: "logical:shared",
        activeBinding: { bindingId: "binding:claude", providerId: "claude-sdk" }
      }),
      hasSessionTurnForBinding: () => false,
      getItems: () => [],
      upsertSession: () => {}
    }
  });

  await manager.reconnect("claude:provider-session", { startQuery: false });

  assert.equal(manager.get("claude:provider-session").agentSessionId, null);
  assert.equal(manager.get("claude:provider-session").phase, "ready");
});

test("Claude reconnect clears a stale running state left by a backend restart", async () => {
  const storedSession = {
    id: "claude-stale-running",
    title: "Claude stale running",
    agent: "Claude Code",
    status: "running",
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:01:00.000Z",
    external: { provider: "claude-sdk", agentSessionId: "sdk-stale", cwd: "/tmp/project" },
    rawStatus: {}
  };
  const manager = new ClaudeAgentManager({
    store: {
      getSession: () => storedSession,
      getItems: () => [],
      upsertSession: () => {}
    }
  });
  await manager.reconnect("claude-stale-running", { startQuery: false });

  assert.equal(manager.detail("claude-stale-running").status, "complete");
  assert.equal(manager.get("claude-stale-running").turnState, "idle");
});

for (const agentSessionId of [null, "sdk-restored"]) {
  test(`Claude restored runtime preparation awaits Query startup (${agentSessionId ?? "fresh"})`, async () => {
    const storedSession = {
      id: "claude-restored-runtime",
      status: "complete",
      external: { provider: "claude-sdk", agentSessionId, cwd: "/tmp/project" },
      rawStatus: {}
    };
    const queries = [];
    const manager = new ClaudeAgentManager({
      store: { getSession: () => storedSession, getItems: () => [] },
      query: ({ options }) => {
        let finish;
        const finished = new Promise((resolve) => { finish = resolve; });
        const query = {
          options,
          close() { finish(); },
          async *[Symbol.asyncIterator]() { await finished; }
        };
        queries.push(query);
        return query;
      }
    });
    let releaseStartup;
    const startupGate = new Promise((resolve) => { releaseStartup = resolve; });
    manager.runtimeOptionsFor = async (session) => {
      await startupGate;
      return session.runtimeOptions;
    };
    const runtimeOptions = { mcpServers: { corptie: { type: "stdio", command: "node" } } };
    let reconnected = false;
    const reconnectTask = manager.reconnect(storedSession.id, { runtimeOptions }).then((result) => {
      reconnected = true;
      return result;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(reconnected, false);
      assert.equal(queries.length, 0);
      releaseStartup();
      await reconnectTask;

      const session = manager.get(storedSession.id);
      assert.equal(queries.length, 1);
      assert.equal(session.query, queries[0]);
      assert.equal(queries[0].options.resume, agentSessionId ?? undefined);
      assert.deepEqual(queries[0].options.mcpServers, runtimeOptions.mcpServers);
      assert.equal(session.currentTurnId, null);
      assert.equal(session.turnState, "idle");
      assert.equal(session.queryInput.pendingCount, 0);
    } finally {
      releaseStartup();
      await reconnectTask;
      queries[0]?.close();
      await manager.get(storedSession.id)?.queryTask;
    }
  });

  test(`Claude restored startQuery:false stays lazy with explicit runtime options (${agentSessionId ?? "fresh"})`, async () => {
    const storedSession = {
      id: "claude-restored-lazy",
      status: "complete",
      external: { provider: "claude-sdk", agentSessionId, cwd: "/tmp/project" },
      rawStatus: {}
    };
    let queryCalls = 0;
    const manager = new ClaudeAgentManager({
      store: { getSession: () => storedSession, getItems: () => [] },
      query: () => { queryCalls += 1; throw new Error("Query must stay lazy"); }
    });
    const options = { startQuery: false, runtimeOptions: {} };
    await manager.reconnect(storedSession.id, options);
    await manager.reconnect(storedSession.id, options);

    assert.equal(queryCalls, 0);
    assert.equal(manager.get(storedSession.id).query, null);
  });
}

test("Claude generated MCP refresh closes the old Query before starting the replacement generation", async () => {
  const queries = [];
  const manager = new ClaudeAgentManager({
    query: ({ options }) => {
      let finish;
      const finished = new Promise((resolve) => { finish = resolve; });
      const query = {
        options,
        closed: false,
        close() { this.closed = true; finish(); },
        async *[Symbol.asyncIterator]() { await finished; }
      };
      queries.push(query);
      return query;
    }
  });
  manager.start({
    id: "claude-mcp-refresh", cwd: "/tmp/project",
    toolHost: { providerAttachment: { mcpServers: { corptie: { type: "stdio", command: "old" } } } }
  });
  const session = manager.get("claude-mcp-refresh");
  await manager.ensureQueryStarted(session);

  await manager.reconnect("claude-mcp-refresh", {
    runtimeOptions: { mcpServers: { corptie: { type: "stdio", command: "new" } } }
  });

  assert.equal(queries.length, 2);
  assert.equal(queries[0].closed, true);
  assert.equal(queries[1].options.mcpServers.corptie.command, "new");
  assert.equal(session.query, queries[1]);
  queries[1].close();
});

test("Claude reconnect reuses an idle Query with identical MCP options", async () => {
  const queries = [];
  const manager = new ClaudeAgentManager({
    query: ({ options }) => {
      let finish;
      const finished = new Promise((resolve) => { finish = resolve; });
      const query = {
        options,
        closed: false,
        close() { this.closed = true; finish(); },
        async *[Symbol.asyncIterator]() { await finished; }
      };
      queries.push(query);
      return query;
    }
  });
  const runtimeOptions = {
    mcpServers: { corptie: { type: "stdio", command: "node" } }
  };
  manager.start({ id: "claude-mcp-identical", runtimeOptions });
  const session = manager.get("claude-mcp-identical");
  await manager.ensureQueryStarted(session);
  const originalQueryTask = session.queryTask;

  await manager.reconnect("claude-mcp-identical", {
    runtimeOptions: structuredClone(runtimeOptions)
  });

  assert.equal(queries.length, 1);
  assert.equal(queries[0].closed, false);
  assert.equal(session.query, queries[0]);
  assert.equal(session.queryTask, originalQueryTask);
  queries[0].close();
  await originalQueryTask;
});

test("Claude reconnect preserves an active Turn and rejects changed runtime options", async () => {
  let queryCalls = 0;
  let closed = false;
  const manager = new ClaudeAgentManager({
    query: () => { queryCalls += 1; throw new Error("Must preserve the active Query"); }
  });
  const runtimeOptions = { mcpServers: { corptie: { type: "stdio", command: "node" } } };
  manager.start({ id: "claude-active-runtime", runtimeOptions });
  const session = manager.get("claude-active-runtime");
  const activeQuery = { close() { closed = true; } };
  const activeQueryTask = Promise.resolve();
  const previousRuntimeOptions = session.runtimeOptions;
  session.query = activeQuery;
  session.queryTask = activeQueryTask;
  session.turnState = "running";
  session.currentTurnId = "claude-active-runtime:turn:1";
  session.status = "running";
  session.phase = "working";

  await manager.reconnect(session.id, { runtimeOptions: structuredClone(runtimeOptions) });
  await assert.rejects(manager.reconnect(session.id, {
    runtimeOptions: { mcpServers: { corptie: { type: "stdio", command: "replacement" } } }
  }), { code: "PROVIDER_TOOL_REFRESH_DURING_TURN" });

  assert.equal(queryCalls, 0);
  assert.equal(closed, false);
  assert.equal(session.query, activeQuery);
  assert.equal(session.queryTask, activeQueryTask);
  assert.equal(session.queryClosed, false);
  assert.equal(session.runtimeOptions, previousRuntimeOptions);
  assert.equal(session.turnState, "running");
  assert.equal(session.currentTurnId, "claude-active-runtime:turn:1");
  assert.equal(session.status, "running");
  assert.equal(session.phase, "working");
});

test("Claude restored runtime preparation propagates Query startup failure", async () => {
  const storedSession = {
    id: "claude-restored-startup-failure",
    status: "complete",
    external: { provider: "claude-sdk", agentSessionId: null, cwd: "/tmp/project" },
    rawStatus: {}
  };
  const startupError = new Error("Query startup failed");
  const manager = new ClaudeAgentManager({
    store: { getSession: () => storedSession, getItems: () => [] },
    query: () => { throw startupError; }
  });

  await assert.rejects(manager.reconnect(storedSession.id, { runtimeOptions: {} }),
    (error) => error === startupError);
  assert.equal(manager.get(storedSession.id).query, null);
  assert.equal(manager.get(storedSession.id).queryStartTask, null);
});

test("reading a persisted Claude session restores history without starting a Query", async () => {
  const manager = new ClaudeAgentManager();
  let reconnectOptions = null;
  manager.reconnect = async (id, options) => {
    reconnectOptions = options;
    return manager.start({
      id,
      cwd: "/tmp/restored",
      items: [{ id: "history", type: "userMessage", text: "Restored" }]
    });
  };

  const detail = await manager.read("claude-persisted");

  assert.deepEqual(reconnectOptions, { startQuery: false });
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].text, "Restored");
  assert.equal(manager.get("claude-persisted").query, null);
});

test("Claude Query receives Corptie MCP, skills, plugin, and project settings", async () => {
  let capturedOptions = null;
  const manager = new ClaudeAgentManager({
    query: ({ options }) => {
      capturedOptions = options;
      return (async function* emptyQuery() {})();
    }
  });
  manager.start({
    id: "claude-corptie-runtime",
    cwd: "/tmp/project",
    runtimeWorkspaceRoots: ["/tmp/project", "/tmp/repo/.git/worktrees/integration"],
    toolHost: {
      providerAttachment: {
        mcpServers: { corptie: { type: "stdio", command: "node" } },
        plugins: [{ type: "local", path: "/runtime/corptie-plugin", skipMcpDiscovery: true }],
        skills: "all",
        settingSources: ["user", "project", "local"],
        disallowedTools: ["EnterWorktree", "ExitWorktree", "EnterWorktree", ""],
        systemPrompt: { type: "preset", preset: "claude_code", append: "Use Corptie collaboration." }
      }
    }
  });

  await manager.ensureQueryStarted(manager.get("claude-corptie-runtime"));

  assert.equal(capturedOptions.mcpServers.corptie.command, "node");
  assert.equal(capturedOptions.plugins[0].path, "/runtime/corptie-plugin");
  assert.equal(capturedOptions.skills, "all");
  assert.deepEqual(capturedOptions.settingSources, ["user", "project", "local"]);
  assert.deepEqual(capturedOptions.additionalDirectories, [
    "/tmp/project", "/tmp/repo/.git/worktrees/integration"
  ]);
  assert.deepEqual(capturedOptions.disallowedTools, ["EnterWorktree", "ExitWorktree"]);
  assert.match(capturedOptions.systemPrompt.append, /Corptie collaboration/);
});

test("Claude live messages become process items until the result marks a final answer", () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-live", title: "Claude live", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-live");
  session.currentTurnId = "claude-live:turn:1";
  session.status = "running";
  session.turnState = "running";

  manager.handleSdkMessage(session, sdkAssistant([
    { type: "text", text: "Checking files." },
    { type: "tool_use", name: "Read", input: { file_path: "/tmp/a.txt" } }
  ]));
  manager.handleSdkMessage(session, sdkAssistant([{ type: "text", text: "Done." }]));

  letAgentRoles(manager, ["commentary", "commentary"]);
  manager.handleSdkMessage(session, { type: "result", subtype: "success", result: "Done." });
  letAgentRoles(manager, ["commentary", "final_answer"]);
  assert.ok(manager.detail("claude-live").items.every((item) => item.turnStatus === "complete"));
});

test("Claude remains working through task completion until its continuation result settles the Turn", async () => {
  const settled = [];
  const manager = new ClaudeAgentManager({ onTurnSettled: (event) => settled.push(event) });
  manager.start({ id: "claude-background", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-background");
  session.currentTurnId = "claude-background:turn:1";
  session.status = "running";
  session.turnState = "running";
  session.query = {};

  manager.handleSdkMessage(session, {
    type: "system",
    subtype: "task_started",
    task_id: "task-market-cow",
    description: "Implement the delegated change",
    subagent_type: "general-purpose"
  });
  manager.handleSdkMessage(session, { type: "result", subtype: "success", result: "Delegated." });

  let detail = manager.detail("claude-background");
  assert.equal(detail.status, "running");
  assert.equal(detail.activityStatus, "Claude is working");
  assert.equal(detail.capabilities.canInterrupt, true);
  assert.equal(settled.length, 0);

  manager.handleSdkMessage(session, {
    type: "system",
    subtype: "task_notification",
    task_id: "task-market-cow",
    status: "completed",
    summary: "Implementation completed"
  });

  detail = manager.detail("claude-background");
  assert.equal(detail.status, "running");
  assert.equal(detail.capabilities.canInterrupt, true);
  await Promise.resolve();
  assert.equal(settled.length, 0);

  manager.handleSdkMessage(session, sdkAssistant([{ type: "text", text: "Implementation verified." }]));
  manager.handleSdkMessage(session, {
    type: "result",
    subtype: "success",
    origin: { kind: "task-notification" },
    result: "Implementation verified."
  });

  detail = manager.detail("claude-background");
  assert.equal(detail.status, "complete");
  assert.equal(detail.capabilities.canInterrupt, false);
  await Promise.resolve();
  assert.equal(settled.length, 1);
});

test("Claude background task progress updates one stable timeline item and hides ambient tasks", async () => {
  const events = [];
  const manager = new ClaudeAgentManager({ onProviderEvent: event => events.push(event) });
  manager.start({ id: "claude-task-progress", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-task-progress");
  session.currentTurnId = "turn:one";
  session.status = "running";
  session.turnState = "running";
  const task = (subtype, extra = {}) => ({ type: "system", subtype, task_id: "task:one", ...extra });
  manager.handleSdkMessage(session, task("task_started", { uuid: "event:start", description: "Inspect", subagent_type: "general-purpose" }));
  const first = session.items.find(item => item.type === "mcpToolCall");
  manager.handleSdkMessage(session, task("task_progress", { uuid: "event:progress", description: "Inspecting files", summary: "3 files" }));
  manager.handleSdkMessage(session, task("task_updated", { uuid: "event:update", patch: { description: "Review results", status: "running" } }));
  manager.handleSdkMessage(session, task("task_notification", { uuid: "event:done", status: "completed", summary: "Reviewed" }));
  manager.handleSdkMessage(session, task("task_progress", { uuid: "event:late", description: "stale progress" }));
  const taskItems = session.items.filter(item => item.type === "mcpToolCall");
  assert.equal(taskItems.length, 1);
  assert.equal(taskItems[0].id, first.id);
  assert.equal(taskItems[0].turnId, "turn:one");
  assert.equal(taskItems[0].status, "completed");
  assert.match(taskItems[0].text, /Reviewed/);
  assert.equal(JSON.parse(taskItems[0].rawMetadataJSON).toolExecution.status, "completed");
  await Promise.resolve();
  assert.deepEqual(events.filter(event => event.itemId === first.id).map(event => event.type),
    ["tool.started", "tool.progress", "tool.progress", "tool.completed"]);

  manager.handleSdkMessage(session, { type: "system", subtype: "task_started", task_id: "ambient:one",
    description: "Housekeeping", skip_transcript: true, subagent_type: "general-purpose" });
  manager.handleSdkMessage(session, { type: "system", subtype: "task_progress", task_id: "ambient:one",
    description: "Still housekeeping" });
  manager.handleSdkMessage(session, { type: "system", subtype: "task_notification", task_id: "ambient:one",
    status: "completed", summary: "Done" });
  assert.equal(session.items.filter(item => item.type === "mcpToolCall").length, 1);
});

test("Claude settles after its result while a background Bash service keeps running", async () => {
  const settled = [];
  const manager = new ClaudeAgentManager({ onTurnSettled: (event) => settled.push(event) });
  manager.start({ id: "claude-background-service", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-background-service");
  session.currentTurnId = "claude-background-service:turn:1";
  session.status = "running";
  session.turnState = "running";
  session.query = {};

  manager.handleSdkMessage(session, {
    type: "system",
    subtype: "task_started",
    task_id: "task-dashboard",
    task_type: "bash",
    description: "Start dashboard in background"
  });
  manager.handleSdkMessage(session, { type: "result", subtype: "success", result: "Dashboard started." });

  let detail = manager.detail("claude-background-service");
  assert.equal(detail.status, "complete");
  assert.equal(detail.activityStatus, "Ready");
  assert.equal(detail.capabilities.canInterrupt, false);
  await Promise.resolve();
  assert.equal(settled.length, 1);

  manager.handleSdkMessage(session, {
    type: "system",
    subtype: "task_progress",
    task_id: "task-dashboard",
    task_type: "bash",
    description: "Dashboard is still running"
  });

  detail = manager.detail("claude-background-service");
  assert.equal(detail.status, "complete");
  assert.equal(detail.activityStatus, "Ready");
  assert.equal(settled.length, 1);
});

test("Claude restores working state when assistant activity arrives after a parent result", () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-late-background", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-late-background");
  session.currentTurnId = "claude-late-background:turn:1";
  session.status = "running";
  session.turnState = "running";
  session.query = {};

  manager.handleSdkMessage(session, { type: "result", subtype: "success", result: "Done." });
  assert.equal(manager.detail("claude-late-background").status, "complete");

  manager.handleSdkMessage(session, sdkAssistant([
    { type: "tool_use", name: "Bash", input: { command: "npm test" } }
  ]));

  const detail = manager.detail("claude-late-background");
  assert.equal(detail.status, "running");
  assert.equal(detail.capabilities.canInterrupt, true);
});

test("Claude interrupt closes the whole Query so background agents cannot survive", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-interrupt-background", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-interrupt-background");
  const calls = [];
  session.status = "running";
  session.turnState = "running";
  session.query = {
    interrupt: async () => calls.push("interrupt"),
    close: async () => calls.push("close")
  };
  session.queryTask = Promise.resolve();
  session.activeTaskIds.add("background-task");

  const summary = await manager.interrupt("claude-interrupt-background");

  assert.deepEqual(calls, ["interrupt", "close"]);
  assert.equal(session.query, null);
  assert.equal(session.activeTaskIds.size, 0);
  assert.equal(summary.status, "complete");
});

test("Claude interrupt supports the SDK synchronous Query.close contract", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-interrupt-sync-close", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-interrupt-sync-close");
  const calls = [];
  session.status = "running";
  session.turnState = "running";
  session.query = {
    interrupt: async () => calls.push("interrupt"),
    close: () => { calls.push("close"); }
  };
  session.queryTask = Promise.resolve();

  const summary = await manager.interrupt("claude-interrupt-sync-close");

  assert.deepEqual(calls, ["interrupt", "close"]);
  assert.equal(summary.status, "complete");
  assert.equal(summary.capabilities.canInterrupt, false);
  assert.equal(session.query, null);
  assert.equal(session.turnState, "idle");
});

test("Claude interrupt repairs a stale running session without an active Query", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-interrupt-stale", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-interrupt-stale");
  session.status = "running";
  session.turnState = "running";
  session.query = null;
  session.queryTask = null;

  const summary = await manager.interrupt("claude-interrupt-stale");

  assert.equal(summary.status, "complete");
  assert.equal(summary.capabilities.canInterrupt, false);
  assert.equal(session.turnState, "idle");
  assert.equal(session.interruptRequested, false);
});

test("Claude cancelled Turn keeps the same Session ready for the next message", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({
    id: "claude-cancelled-sendable",
    cwd: "/tmp/project",
    agentSessionId: "sdk-session-existing"
  });
  const session = manager.get("claude-cancelled-sendable");
  session.status = "cancelled";
  session.turnState = "idle";
  manager.ensureQueryStarted = async () => {};
  manager.enqueueInput = () => {};

  const before = manager.toSessionSummary(session);
  assert.equal(before.status, "cancelled");
  assert.equal(before.capabilities.canSend, true);
  assert.ok(before.sendUnavailableReason == null);

  const after = await manager.send("claude-cancelled-sendable", "Continue");
  assert.equal(after.status, "running");
  assert.equal(session.agentSessionId, "sdk-session-existing");
});

test("Claude reports a normalized turn-settled event to product orchestration", async () => {
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });
  const manager = new ClaudeAgentManager({ onTurnSettled: settle });
  manager.start({ id: "claude-settled", title: "Claude settled", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-settled");
  session.currentTurnId = "claude-settled:turn:1";
  session.status = "running";
  session.turnState = "running";

  manager.handleSdkMessage(session, sdkAssistant([{ type: "text", text: "Done." }]));
  manager.handleSdkMessage(session, { type: "result", subtype: "success", result: "Done." });

  assert.deepEqual(await settled, {
    providerSessionId: "claude-settled",
    session: manager.toSessionSummary(session),
    items: session.items.filter((item) => item.turnId === "claude-settled:turn:1"),
    hasAgentMessage: true,
    turnId: "claude-settled:turn:1",
    status: "completed",
    error: null
  });
});

test("Claude clear forgets the SDK context while preserving the Corptie session", async () => {
  const manager = new ClaudeAgentManager();
  const original = manager.start({
    id: "claude-clear",
    title: "Keep this title",
    cwd: "/tmp/project",
    model: "claude-sonnet",
    agentSessionId: "sdk-session-old",
    items: [{ id: "old", type: "agentMessage", text: "Old context" }]
  });
  const session = manager.get("claude-clear");
  let closed = false;
  session.query = { close: async () => { closed = true; } };
  session.queryTask = Promise.resolve();

  const cleared = await manager.clear("claude-clear");

  assert.equal(closed, true);
  assert.equal(cleared.id, original.id);
  assert.equal(cleared.title, "Keep this title");
  assert.equal(cleared.external.cwd, "/tmp/project");
  assert.equal(cleared.external.currentModel, "claude-sonnet");
  assert.equal(cleared.external.agentSessionId, null);
  assert.deepEqual(manager.detail("claude-clear").items, []);
  assert.equal(session.nextItemSeq, 1);
  assert.equal(session.nextTurnSeq, 1);
  assert.equal(session.queryClosed, false);
});

test("Claude reasoning effort applies through the live Query and persists on the Session", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-reasoning", cwd: "/tmp/project" });
  const session = manager.get("claude-reasoning");
  const applied = [];
  session.query = {
    applyFlagSettings: async (settings) => { applied.push(settings); }
  };

  const updated = await manager.switchReasoning("claude-reasoning", "HIGH");

  assert.deepEqual(applied, [{ effortLevel: "high" }]);
  assert.equal(session.currentReasoningLevel, "high");
  assert.equal(updated.external.currentReasoningLevel, "high");
  assert.equal(updated.capabilities.canSwitchReasoning, true);
  assert.equal(
    session.items.at(-1).text,
    "Switched Claude reasoning effort to high."
  );
});

test("Claude reasoning effort starts with the Session and reaches the first Query", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-reasoning-start", cwd: "/tmp/project", reasoningLevel: "xhigh" });
  const session = manager.get("claude-reasoning-start");
  const started = [];
  manager.ensureQueryStarted = async (target) => { started.push(target); };

  assert.equal(session.currentReasoningLevel, "xhigh");
  await manager.send("claude-reasoning-start", "hello");
  assert.deepEqual(started, [session]);
  assert.equal(session.currentReasoningLevel, "xhigh");
});

test("Claude rejects unsupported reasoning levels and rejects a switch during a running Turn", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-reasoning-guard", cwd: "/tmp/project", reasoningLevel: "not-a-level" });
  assert.equal(manager.get("claude-reasoning-guard").currentReasoningLevel, null);

  await assert.rejects(
    () => manager.switchReasoning("claude-reasoning-guard", "off"),
    /Unsupported Claude reasoning level/
  );

  manager.get("claude-reasoning-guard").turnState = "running";
  await assert.rejects(
    () => manager.switchReasoning("claude-reasoning-guard", "high"),
    (error) => error.code === "SESSION_BUSY"
  );
  assert.equal(manager.get("claude-reasoning-guard").currentReasoningLevel, null);
});

test("Claude reasoning switch restores a persisted Session before applying the level", async () => {
  const manager = new ClaudeAgentManager();
  let restored = false;
  manager.reconnect = async (id) => {
    restored = true;
    return manager.start({ id, cwd: "/tmp/restored", prompt: "" });
  };

  const updated = await manager.switchReasoning("claude-restored-reasoning", "low");

  assert.equal(restored, true);
  assert.equal(updated.external.cwd, "/tmp/restored");
  assert.equal(updated.external.currentReasoningLevel, "low");
});

test("Claude permissions can change after session creation and reconfigure the next Query", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({
    id: "claude-permissions",
    cwd: "/tmp/project",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    agentSessionId: "sdk-session-existing"
  });
  const session = manager.get("claude-permissions");
  let closed = false;
  session.query = { close: async () => { closed = true; } };
  session.queryTask = Promise.resolve();

  const updated = await manager.updatePermissions("claude-permissions", {
    sandbox: "danger-full-access",
    approvalPolicy: "never"
  });

  assert.equal(closed, true);
  assert.equal(session.query, null);
  assert.equal(session.agentSessionId, "sdk-session-existing");
  assert.equal(session.permissionMode, "bypassPermissions");
  assert.equal(updated.external.sandbox, "danger-full-access");
  assert.equal(updated.external.approvalPolicy, "never");
});

test("Claude operations restore a persisted session before changing permissions", async () => {
  const manager = new ClaudeAgentManager();
  let restored = false;
  manager.reconnect = async (id) => {
    restored = true;
    return manager.start({ id, cwd: "/tmp/restored", prompt: "" });
  };

  const updated = await manager.updatePermissions("claude-restored", {
    sandbox: "read-only",
    approvalPolicy: "on-request"
  });

  assert.equal(restored, true);
  assert.equal(updated.external.cwd, "/tmp/restored");
  assert.equal(updated.external.sandbox, "read-only");
});

test("Claude permissions can switch while a turn is waiting for approval", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-blocked", cwd: "/tmp/project" });
  const session = manager.get("claude-blocked");
  let switchedMode = null;
  let pendingResolution = null;
  session.query = {
    setPermissionMode: async (mode) => { switchedMode = mode; }
  };
  session.turnState = "requires_action";
  session.status = "running";
  session.pendingChoice = { id: "choice-a" };
  session.pendingDecision = {
    choice: session.pendingChoice,
    resolve: (resolution) => { pendingResolution = resolution; }
  };
  session.pendingChoices.set("choice-a", session.pendingDecision);
  session.items.push({ id: "choice-a", type: "choice", status: "pending" });

  const updated = await manager.updatePermissions("claude-blocked", {
    sandbox: "danger-full-access",
    approvalPolicy: "never"
  });

  assert.equal(switchedMode, "bypassPermissions");
  assert.deepEqual(pendingResolution, { behavior: "allow" });
  assert.equal(session.pendingChoices.size, 0);
  assert.equal(session.items[0].status, "allowed");
  assert.equal(session.turnState, "running");
  assert.equal(updated.external.permissionMode, "bypassPermissions");
});

test("Claude AskUserQuestion submits the complete question set atomically", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-questions", cwd: "/tmp/project" });
  const session = manager.get("claude-questions");
  const resolutionPromise = manager.handleToolRequest(session, "AskUserQuestion", {
    questions: [
      {
        header: "Instructions",
        question: "Keep CLAUDE.md?",
        multiSelect: false,
        options: [
          { label: "Keep", description: "Keep project instructions." },
          { label: "Ignore", description: "Keep it local only." }
        ]
      },
      {
        header: "Strategies",
        question: "Ignore strategy sources?",
        multiSelect: false,
        options: [
          { label: "Ignore", description: "Keep strategies private." },
          { label: "Track", description: "Keep the clone runnable." }
        ]
      }
    ]
  });

  const detail = manager.detail("claude-questions");
  assert.equal(detail.items.at(-1).type, "userInput");
  assert.equal(detail.items.at(-1).userInput.questions.length, 2);
  manager.respondToUserInput("claude-questions", {
    itemId: detail.items.at(-1).id,
    answers: { "question-0": ["Keep"], "question-1": ["Ignore"] }
  });
  assert.deepEqual(await resolutionPromise, {
    behavior: "allow",
    updatedInput: {
      questions: [
        {
          header: "Instructions",
          question: "Keep CLAUDE.md?",
          multiSelect: false,
          options: [
            { label: "Keep", description: "Keep project instructions." },
            { label: "Ignore", description: "Keep it local only." }
          ]
        },
        {
          header: "Strategies",
          question: "Ignore strategy sources?",
          multiSelect: false,
          options: [
            { label: "Ignore", description: "Keep strategies private." },
            { label: "Track", description: "Keep the clone runnable." }
          ]
        }
      ],
      answers: {
        "Keep CLAUDE.md?": "Keep",
        "Ignore strategy sources?": "Ignore"
      }
    }
  });
});

function letAgentRoles(manager, expected) {
  const roles = manager.detail("claude-live").items
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.presentationRole);
  assert.deepEqual(roles, expected);
}

function sdkUser(content) {
  return { type: "user", message: { role: "user", content } };
}

function sdkAssistant(content) {
  return { type: "assistant", message: { role: "assistant", content } };
}

test("Claude uses the configured executable for ordinary Session queries", async () => {
  let options;
  const manager = new ClaudeAgentManager({
    executable: () => "/custom path/claude",
    query: input => { options = input.options; return (async function* () {})(); }
  });
  manager.start({ id: "configured-binary", cwd: "/tmp" });
  await manager.ensureQueryStarted(manager.get("configured-binary"));
  assert.equal(options.pathToClaudeCodeExecutable, "/custom path/claude");
});
