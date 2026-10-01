import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientSessionAPI, approvalRequestIsCurrent } from "../src/application/clientSessionAPI.mjs";

const identity = { deviceId: "device:one" };

test("device history preserves typed timeline presentation without leaking provider envelopes", async () => {
  const f = await fixture();
  try {
    const presentation = { turnStatus: "running", title: "Read source", presentationRole: "commentary",
      presentationText: "检查代码", sourceType: "tool", localVisibility: "visible",
      processingError: "execution failed", processStartedAt: "2026-09-19T00:00:00Z",
      processEndedAt: "2026-09-19T00:00:01Z" };
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      readWindow: async () => ({ revision: 5, hasEarlier: false, items: [
        { id: "tool:1", turnId: "turn:1", type: "commandExecution", text: "output", ...presentation,
          rawMetadataJSON: "private", rawEventEnvelope: "private", providerCredentials: { token: "private" } },
        { id: "old", type: "agentMessage", text: "old backend" },
        { id: "malformed", type: "agentMessage", text: "invalid metadata", title: { secret: "private" }, turnStatus: 42 },
      ] }) });
    const { items } = await api.messages(identity, "session:test", new URLSearchParams());
    for (const [key, value] of Object.entries(presentation)) {
      assert.equal(items[0][key], value);
      assert.equal(items[1][key], null);
    }
    assert.equal(items[0].turnId, "turn:1");
    assert.equal(items[2].title, null);
    assert.equal(items[2].turnStatus, null);
    for (const key of ["rawMetadataJSON", "rawEventEnvelope", "providerCredentials"]) {
      assert.equal(Object.hasOwn(items[0], key), false);
    }
  } finally { await f.close(); }
});

test("background snapshots and usage-only deltas carry durable usage without Provider reads", async () => {
  const f = await fixture();
  try {
    const windowRequests = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      readWindow: async (_sessionId, options) => {
        windowRequests.push(options);
        return { revision: 3, hasEarlier: false, items: [] };
      } });
    let usageReads = 0, composerReads = 0;
    api.usageReader = async () => { usageReads += 1; return {}; };
    f.store.upsertSessionUsageSnapshot({ sessionId: "session:test", providerId: "test",
      context: { usedTokens: 10, contextWindow: 100, remainingTokens: 90 },
      account: { available: true, provider: "test", rateLimits: { primary: { usedPercent: 20 } } } });
    api.configuration = async () => { composerReads += 1; return { schemaVersion: 1 }; };

    const background = await api.realtimeTimeline(identity, "session:test", 0, { includeDetail: false });
    assert.equal(background.usage.context.usedTokens, 10);
    assert.equal(background.usage.account.rateLimits.primary.usedPercent, 20);
    assert.equal(background.composer, null);
    assert.equal(usageReads, 0);
    assert.equal(composerReads, 0);
    assert.equal(windowRequests[0].before, 200,
      "resident push warms the same wide bounded source window used by desktop presentation");

    api.store.sessionTimelineChangesAfter = () => ({ snapshotRequired: false, baseRevision: 3,
      revision: 3, currentRevision: 3, hasMore: false, changes: [] });
    f.store.upsertSessionUsageSnapshot({ sessionId: "session:test", providerId: "test",
      context: { usedTokens: 30, contextWindow: 100, remainingTokens: 70 } });
    const delta = await api.realtimeTimeline(identity, "session:test", 3, { includeDetail: false });
    assert.equal(delta.kind, "delta");
    assert.equal(delta.usage.context.usedTokens, 30);
    assert.equal(usageReads, 0);

    await api.realtimeTimeline(identity, "session:test", 0, { includeDetail: true });
    assert.equal(usageReads, 1);
    assert.equal(composerReads, 1);
  } finally { await f.close(); }
});

test("device message history preserves three inline chart fences and the managed image on one item", async () => {
  const f = await fixture();
  try {
    const fence = (spec) => `\`\`\`corptie-chart\n${JSON.stringify(spec)}\n\`\`\``;
    const text = [
      "前文", fence({ version: 1, type: "bar", title: "比较", data: [{ label: "甲", value: 2 }] }),
      "中段", fence({ version: 1, type: "line", title: "趋势", data: [{ x: 1, value: 2 }] }),
      "继续", fence({ version: 1, type: "pie", title: "占比", data: [{ label: "甲", value: 2 }] }),
      "后文"
    ].join("\n\n");
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      readWindow: async () => ({ revision: 1, hasEarlier: false, items: [
        { id: "agent:charts", type: "agentMessage", text, images: [
          { managedPath: "managed:chart-image", fileName: "image.png", mimeType: "image/png",
            originalPath: "/private/provider/path" }
        ], rawEventEnvelope: { token: "private" } }
      ] }) });
    const page = await api.messages(identity, "session:test", new URLSearchParams());
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].text, text);
    assert.equal((page.items[0].text.match(/```corptie-chart/g) ?? []).length, 3);
    assert.deepEqual(page.items[0].images, [{ managedPath: "managed:chart-image",
      fileName: "image.png", mimeType: "image/png", byteLength: null }]);
    assert.equal(Object.hasOwn(page.items[0], "rawEventEnvelope"), false);
  } finally { await f.close(); }
});

test("device receives the complete structured plan without private Provider metadata", async () => {
  const f = await fixture();
  try {
    const plan = { schemaVersion: 1, planId: "plan:one", revision: 2, lifecycle: "active",
      explanation: null, updatedAt: "2026-09-24T00:00:00Z",
      steps: [{ stepId: "step:1", ordinal: 0, text: "Inspect", status: "completed" }] };
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      readWindow: async () => ({ revision: 2, hasEarlier: false, items: [
        { id: "plan:one", turnId: "turn:one", type: "executionPlan", text: "Plan 1/1",
          executionPlan: { ...plan, secret: "private", steps: [{ ...plan.steps[0], secret: "private" }] },
          rawMetadataJSON: "private" }
      ] }) });
    const page = await api.messages(identity, "session:test", new URLSearchParams());
    assert.deepEqual(page.items[0].executionPlan, plan);
    assert.equal(Object.hasOwn(page.items[0], "rawMetadataJSON"), false);
  } finally { await f.close(); }
});

test("device approval uses a current item and one declared option, without exposing private fields", async () => {
  const f = await fixture();
  try {
    const calls = [];
    const item = { id: "choice:one", type: "choice", text: "Allow action?", status: "pending",
      options: [{ id: "allow", label: "Allow Once", role: "approve", secret: "hidden" },
        { id: "deny", label: "Deny", role: "deny" }] };
    f.store.upsertTimelineItemProjection("session:test", item);
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      respondToApproval: async (...args) => {
        const pendingDispatch = f.store.getSessionItem(args[0], args[1].itemId);
        assert.equal(approvalRequestIsCurrent(pendingDispatch, null, args[1], args[2]), true);
        calls.push(args);
      },
      readWindow: async () => ({ revision: 1, hasEarlier: false, items: [item] }) });
    const page = await api.messages(identity, "session:test", new URLSearchParams());
    assert.deepEqual(page.items[0].options, [
      { id: "allow", label: "Allow Once", role: "approve", selected: false },
      { id: "deny", label: "Deny", role: "deny", selected: false }
    ]);
    await assert.rejects(api.approval(identity, "session:test", { itemId: item.id, optionId: "other" }),
      { code: "INVALID_APPROVAL_OPTION" });
    const result = await api.approval(identity, "session:test", { itemId: item.id, optionId: "allow" });
    assert.equal(result.status, "submitted");
    assert.equal(f.store.getSessionItem("session:test", item.id).status, "submitted");
    assert.deepEqual(calls[0][1], { itemId: item.id, choiceId: item.id, optionId: "allow", approved: true });
    const afterRestart = new ClientSessionAPI({ store: f.store, ...callbacks,
      respondToApproval: async (...args) => calls.push(args) });
    assert.equal((await afterRestart.approval(identity, "session:test", { itemId: item.id, optionId: "allow" })).status, "submitted");
    assert.equal(calls.length, 1);
    await assert.rejects(afterRestart.approval(identity, "session:test", { itemId: item.id, optionId: "deny" }),
      { code: "APPROVAL_NOT_PENDING" });
    f.store.upsertTimelineItemProjection("session:test", { ...item, status: "selected" });
    await assert.rejects(api.approval(identity, "session:test", { itemId: item.id, optionId: "deny" }),
      { code: "APPROVAL_NOT_PENDING" });
  } finally { await f.close(); }
});

test("unified approval guard allows only the exact mobile dispatching option", () => {
  const item = { id: "approval:one", type: "approval", status: "dispatching", bindingId: "binding:new",
    rawMetadataJSON: JSON.stringify({ approvalSubmission: { optionId: "allow" } }) };
  const source = { type: "remote-client", deviceId: "device:one" };
  assert.equal(approvalRequestIsCurrent(item, "binding:new", { optionId: "allow" }, source), true);
  assert.equal(approvalRequestIsCurrent(item, "binding:new", { optionId: "deny" }, source), false);
  assert.equal(approvalRequestIsCurrent(item, "binding:old", { optionId: "allow" }, source), false);
  assert.equal(approvalRequestIsCurrent(item, "binding:new", { optionId: "allow" }, { type: "desktop" }), false);
  assert.equal(approvalRequestIsCurrent({ ...item, status: "submitted" }, "binding:new", { optionId: "allow" }, source), false);
  assert.equal(approvalRequestIsCurrent({ ...item, status: "pending" }, "binding:new", { optionId: "allow" }, { type: "desktop" }), true);
});

test("uncertain approval outcome remains non-replayable after service recreation", async () => {
  const f = await fixture();
  try {
    const item = { id: "approval:unknown", type: "approval", text: "Proceed?", status: "pending",
      options: [{ id: "yes", label: "Yes", role: "approve" }] };
    f.store.upsertTimelineItemProjection("session:test", item);
    let calls = 0;
    const callback = async () => { calls++; throw new Error("transport outcome unknown"); };
    const api = new ClientSessionAPI({ store: f.store, ...callbacks, respondToApproval: callback });
    await assert.rejects(api.approval(identity, "session:test", { itemId: item.id, optionId: "yes" }));
    assert.equal(f.store.getSessionItem("session:test", item.id).status, "unknown");
    const restarted = new ClientSessionAPI({ store: f.store, ...callbacks, respondToApproval: callback });
    await assert.rejects(restarted.approval(identity, "session:test", { itemId: item.id, optionId: "yes" }),
      { code: "APPROVAL_OUTCOME_UNCERTAIN" });
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("device multi-question input submits once and retains the complete answer on its card", async () => {
  const f = await fixture();
  try {
    const item = { id: "input:one", turnId: "turn:one", type: "userInput",
      title: "Input required", text: "Choose route", status: "pending",
      rawMetadataJSON: JSON.stringify({ userInput: {
        schemaVersion: 1, isBlocking: true, questions: [
          { id: "route", header: "Route", question: "Choose route", isOther: false,
            isSecret: true, options: [{ label: "A", description: "Fast" }] },
          { id: "token", header: "Token", question: "Enter token", isOther: false,
            isSecret: true, options: null }
        ]
      } }) };
    f.store.upsertTimelineItemProjection("session:test", item);
    const calls = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      respondToUserInput: async (...args) => {
        assert.equal(f.store.getSessionItem(args[0], args[1].itemId).status, "dispatching");
        calls.push(args);
      },
      readWindow: async () => ({ revision: 1, hasEarlier: false, items: [f.store.getSessionItem("session:test", item.id)] }) });
    const page = await api.messages(identity, "session:test", new URLSearchParams());
    assert.equal(page.items[0].userInput.questions[1].isSecret, true);
    assert.equal(Object.hasOwn(page.items[0].userInput, "requestId"), false);
    assert.equal(Object.hasOwn(page.items[0], "rawMetadataJSON"), false);
    const answers = { route: ["A"], token: ["secret-value"] };
    await assert.rejects(api.userInput(identity, "session:test", {
      itemId: item.id, answers: { route: ["other"], token: ["secret-value"] }
    }), { code: "INVALID_USER_INPUT_ANSWER" });
    assert.equal(calls.length, 0);
    const result = await api.userInput(identity, "session:test", { itemId: item.id, answers });
    assert.equal(result.status, "submitted");
    assert.deepEqual(calls[0][1], { itemId: item.id, answers });
    assert.deepEqual(f.store.getSessionItem("session:test", item.id).userInput.submittedAnswers, answers);
    assert.deepEqual(f.store.getSessionItem("session:test", item.id).userInput.selectedOptions, { route: ["A"] });
    const completedPage = await api.messages(identity, "session:test", new URLSearchParams());
    assert.deepEqual(completedPage.items[0].userInput.selectedOptions, { route: ["A"] });
    assert.deepEqual(completedPage.items[0].userInput.submittedAnswers, answers);
    assert.equal(JSON.stringify(result).includes("secret-value"), false);
    const restarted = new ClientSessionAPI({ store: f.store, ...callbacks,
      respondToUserInput: async () => assert.fail("submitted input must not replay") });
    assert.equal((await restarted.userInput(identity, "session:test", { itemId: item.id, answers })).status, "submitted");
  } finally { await f.close(); }
});

test("uncertain user-input transport result is never silently replayed", async () => {
  const f = await fixture();
  try {
    const item = { id: "input:unknown", type: "userInput", text: "Answer", status: "pending",
      rawMetadataJSON: JSON.stringify({ userInput: { schemaVersion: 1,
        questions: [{ id: "answer", question: "Answer", options: null }] } }) };
    f.store.upsertTimelineItemProjection("session:test", item);
    let calls = 0;
    const callback = async () => { calls++; throw new Error("transport outcome unknown"); };
    const input = { itemId: item.id, answers: { answer: ["secret-value"] } };
    const api = new ClientSessionAPI({ store: f.store, ...callbacks, respondToUserInput: callback });
    await assert.rejects(api.userInput(identity, "session:test", input));
    assert.equal(f.store.getSessionItem("session:test", item.id).status, "unknown");
    const restarted = new ClientSessionAPI({ store: f.store, ...callbacks, respondToUserInput: callback });
    await assert.rejects(restarted.userInput(identity, "session:test", input),
      { code: "USER_INPUT_OUTCOME_UNCERTAIN" });
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(f.store.getSessionItem("session:test", item.id)).includes("secret-value"), false);
  } finally { await f.close(); }
});

test("device receives only bounded common tool fields, not Provider metadata", async () => {
  const f = await fixture();
  try {
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      readWindow: async () => ({ revision: 3, hasEarlier: false, items: [
        { id: "tool:one", type: "commandExecution", text: "$ pwd\n/tmp", toolExecution: {
          schemaVersion: 1, toolId: "tool:one", name: "Bash", status: "completed",
          input: "pwd", result: "/tmp", privateToken: "secret"
        }, rawMetadataJSON: "private" },
        { id: "tool:two", type: "mcpToolCall", text: "legacy", toolExecution: {
          schemaVersion: 1, toolId: "tool:two", name: "MCP", status: "running",
          input: { apiKey: "must-not-leak", query: "safe" }, result: null
        } }
      ] }) });
    const page = await api.messages(identity, "session:test", new URLSearchParams());
    assert.deepEqual(page.items[0].toolExecution, {
      schemaVersion: 1, toolId: "tool:one", name: "Bash", status: "completed",
      input: "pwd", result: "/tmp"
    });
    assert.equal(Object.hasOwn(page.items[0], "rawMetadataJSON"), false);
    assert.match(page.items[1].toolExecution.input, /\[REDACTED\]/);
    assert.doesNotMatch(page.items[1].toolExecution.input, /must-not-leak/);
  } finally { await f.close(); }
});

test("device receives the same bounded file-change summary without Review or Undo actions", async () => {
  const f = await fixture();
  try {
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      readWindow: async () => ({ revision: 4, hasEarlier: false, items: [
        { id: "change:one", type: "fileChange", text: "edited", changeSet: {
          schemaVersion: 1, truncated: false, changes: [
            { path: "App.swift", kind: "modify", diffPreview: "+hello", diffTruncated: false,
              privateToken: "secret" }
          ], privateToken: "secret"
        }, rawMetadataJSON: "private" }
      ] }) });
    const page = await api.messages(identity, "session:test", new URLSearchParams());
    assert.deepEqual(page.items[0].changeSet, { schemaVersion: 1, truncated: false,
      changes: [{ path: "App.swift", kind: "modify", diffPreview: "+hello", diffTruncated: false }] });
    assert.equal(Object.hasOwn(page.items[0], "fileChanges"), false);
    assert.equal(Object.hasOwn(page.items[0], "rawMetadataJSON"), false);
  } finally { await f.close(); }
});

test("conversation commands persist public results and deduplicate across restart", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const commands = { list: async () => [], validate: async () => {}, execute: async (id, command, source) => {
      calls++;
      assert.equal(id, "session:test"); assert.equal(command.name, "goal");
      assert.equal(source.type, "remote-client"); assert.equal(source.deviceId, identity.deviceId);
      return { text: "Goal 已设置", messageId: "command:goal-result", privateCredential: "must-not-leak" };
    } };
    const api = new ClientSessionAPI({ store: f.store, ...callbacks, conversationCommands: commands });
    const input = { requestId: "goal_request_1", name: "goal", arguments: "build the app" };
    const result = await api.conversationCommand(identity, "session:test", input);
    assert.equal(result.status, "completed");
    assert.equal(result.kind, "conversation_command");
    assert.deepEqual(result.commandResult, { text: "Goal 已设置", truncated: false, messageId: "command:goal-result" });
    const restored = new ClientSessionAPI({ store: f.store, ...callbacks, conversationCommands: commands });
    assert.deepEqual(await restored.conversationCommand(identity, "session:test", input), result);
    assert.equal(calls, 1);
    await assert.rejects(restored.conversationCommand(identity, "session:test", { ...input, arguments: "other" }), { code: "IDEMPOTENCY_CONFLICT" });
  } finally { await f.close(); }
});

test("concurrent command validation claims one durable dispatch and uncertain outcome is not replayed", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    let finish;
    const dispatch = new Promise(resolve => { finish = resolve; });
    const commands = { list: async () => [], validate: async () => { await Promise.resolve(); },
      execute: async () => { calls++; await dispatch; throw new Error("lost response after side effect"); } };
    const api = new ClientSessionAPI({ store: f.store, ...callbacks, conversationCommands: commands });
    const input = { requestId: "goal_request_2", name: "goal", arguments: "pause" };
    const first = api.conversationCommand(identity, "session:test", input);
    const second = await api.conversationCommand(identity, "session:test", input);
    assert.equal(second.status, "dispatching");
    finish();
    assert.equal((await first).status, "unknown");
    assert.equal((await api.conversationCommand(identity, "session:test", input)).status, "unknown");
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("clear requires confirmation and identity changes during validation prevent dispatch", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const commands = { list: async () => [], validate: async () => {}, execute: async () => { calls++; return { text: "cleared", conversationCleared: true }; } };
    const api = new ClientSessionAPI({ store: f.store, ...callbacks, conversationCommands: commands });
    const input = { requestId: "clear_request_1", name: "clear", arguments: "" };
    await assert.rejects(api.conversationCommand(identity, "session:test", input), { code: "COMMAND_CONFIRMATION_REQUIRED" });
    await assert.rejects(api.conversationCommand(identity, "session:test", { ...input, confirmed: true },
      () => ({ deviceId: "device:other" })), { code: "INVALID_CREDENTIAL" });
    assert.equal(calls, 0);
    const result = await api.conversationCommand(identity, "session:test", { ...input, confirmed: true });
    assert.equal(result.status, "completed");
    assert.equal(result.commandResult.conversationCleared, true);
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("command queries, unsupported capabilities and invalid arguments are explicit", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const commands = { list: async () => [{ name: "goal", available: true, reason: null, requiredPermissions: ["messages.read"] }],
      validate: async (_id, command) => { if (command.name === "ps") throw Object.assign(new Error(), { code: "CAPABILITY_UNSUPPORTED" }); },
      execute: async () => { calls++; return { text: "no active goal" }; } };
    const api = new ClientSessionAPI({ store: f.store, ...callbacks, conversationCommands: commands });
    const catalog = await api.commandCatalog(identity, "session:test");
    assert.equal(catalog.commands[0].canMutate, true);
    assert.equal((await api.conversationCommand(identity, "session:test", { requestId: "query_request_1", name: "goal", arguments: "" })).status, "completed");
    await assert.rejects(api.conversationCommand(identity, "session:test", { requestId: "query_request_2", name: "status", arguments: "unexpected" }), { code: "INVALID_COMMAND_ARGUMENTS" });
    await assert.rejects(api.conversationCommand(identity, "session:test", { requestId: "query_request_3", name: "ps", arguments: "" }), { code: "CAPABILITY_UNSUPPORTED" });
    await assert.rejects(api.conversationCommand(identity, "session:test", { requestId: "query_request_4", name: "unknown", arguments: "" }), { code: "PROVIDER_COMMAND_UNSUPPORTED" });
    assert.equal(calls, 1);
  } finally { await f.close(); }
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-client-command-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  store.createSession({ id: "session:test", title: "Test", sessionKind: "assistantChat", status: "complete" });
  return { store, close: async () => { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const callbacks = { actions: () => ({ send: { available: true }, interrupt: { available: true } }),
  readWindow: async () => ({ revision: 4, hasEarlier: false, items: [{ id: "item:1", type: "agentMessage", text: "hello", secret: "private", userMessageStatus: "processing", queuePosition: 2 }] }),
  send: async () => {}, stop: async () => {} };

test("image-only messages and mentions use shared send and deduplicate attachments", async () => {
  const f = await fixture();
  try {
    const imports = [], sends = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      images: { available: () => true, import: async (id, image) => {
        imports.push([id, image]); return { managedPath: "chat-resources/session/image.png", originalPath: null };
      } }, send: async (...args) => sends.push(args) });
    const input = { requestId: "image_request", text: "", images: [{ fileName: "image.png", dataBase64: "aGVsbG8=" }] };
    assert.equal((await api.command(identity, "session:test", "send", input)).status, "accepted");
    await api.command(identity, "session:test", "send", input);
    assert.equal(imports.length, 1);
    assert.equal(sends.length, 1);
    assert.equal(sends[0][1].images[0].originalPath, null);
    assert.equal(sends[0][2].type, "remote-client");
    await assert.rejects(api.command(identity, "session:test", "send", {
      ...input, images: [{ ...input.images[0], dataBase64: "d29ybGQ=" }]
    }), { code: "IDEMPOTENCY_CONFLICT" });
    for (const images of [[{ sourcePath: "/etc/passwd" }], [{ fileName: "x", dataBase64: "invalid!" }], Array(9).fill(input.images[0])]) {
      await assert.rejects(api.command(identity, "session:test", "send", { ...input, images }), { code: "INVALID_IMAGES" });
    }
    const noImages = new ClientSessionAPI({ store: f.store, ...callbacks });
    await assert.rejects(noImages.command(identity, "session:test", "send", input), { code: "CAPABILITY_UNSUPPORTED" });
    const mention = { targetType: "work", targetId: "work:test", displayName: "Work" };
    await api.command(identity, "session:test", "send", { requestId: "mention_request", text: "@Work hello", mentions: [mention] });
    assert.deepEqual(sends[1][1].mentions, [mention]);
    await assert.rejects(api.command(identity, "session:test", "send", {
      requestId: "invalid_mention", text: "hello", mentions: [{ ...mention, targetType: "agent" }]
    }), { code: "INVALID_MENTIONS" });
  } finally { await f.close(); }
});

test("scheduled messages are scoped and deduplicated without immediate model sends", async () => {
  const f = await fixture();
  try {
    const scheduled = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      send: async () => assert.fail("scheduled message must not send now"),
      schedule: async (...args) => scheduled.push(args) });
    const schedule = { runAt: new Date(Date.now() + 60000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
    const input = { requestId: "schedule_request", text: "later", schedule };
    assert.equal((await api.command(identity, "session:test", "send", input)).status, "accepted");
    await api.command(identity, "session:test", "send", input);
    assert.deepEqual(scheduled, [["session:test", "later", schedule, identity]]);
    for (const bad of [{ ...schedule, process: { pid: 1 } }, { ...schedule, intervalSeconds: 0 }, { ...schedule, runAt: "invalid" }]) {
      await assert.rejects(api.command(identity, "session:test", "send", { ...input, schedule: bad }), { code: "INVALID_SCHEDULE" });
    }
    assert.equal(scheduled.length, 1);
  } finally { await f.close(); }
});

test("composer configuration resolves Session identity and uses neutral callbacks", async () => {
  const f = await fixture();
  try {
    const calls = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      resolveSession: id => id === "logical:test" ? "session:test" : id,
      actions: () => ({ switchModel: { available: true }, switchReasoning: { available: false } }),
      composer: {
        read: async id => ({ currentModel: "model:test", models: [{ id: "model:test", name: "Test", secret: "private" }] }),
        update: async (...args) => calls.push(args)
      } });
    const result = await api.configuration(identity, "logical:test", { model: "model:test" });
    assert.equal(result.sessionId, "session:test");
    assert.equal(result.currentModel, "model:test");
    assert.equal(Object.hasOwn(result.models[0], "secret"), false);
    assert.deepEqual(calls, [["session:test", "model", "model:test"]]);
    await assert.rejects(api.configuration(identity, "session:test", { reasoningLevel: "high" }), { code: "CAPABILITY_UNSUPPORTED" });
    for (const input of [{}, [], { model: "x", source: "admin" }, { provider: "x" }, { model: "" }]) {
      await assert.rejects(api.configuration(identity, "session:test", input), { code: "INVALID_CONFIGURATION" });
    }
    assert.equal(calls.length, 1);
  } finally { await f.close(); }
});

test("commands dispatch once, replay durable receipt and reject changed payload", async () => {
  const f = await fixture();
  try {
    let sends = 0;
    const api = new ClientSessionAPI({ store: f.store, ...callbacks, send: async () => { sends++; } });
    const input = { requestId: "request_123", text: "Hello" };
    const results = await Promise.all([api.command(identity, "session:test", "send", input), api.command(identity, "session:test", "send", input)]);
    assert.equal(sends, 1);
    assert.ok(results.some(r => r.status === "accepted"));
    const restarted = new ClientSessionAPI({ store: f.store, ...callbacks, send: async () => { sends++; } });
    assert.equal((await restarted.command(identity, "session:test", "send", input)).status, "accepted");
    assert.equal(sends, 1);
    await assert.rejects(api.command(identity, "session:test", "send", { ...input, text: "changed" }), { code: "IDEMPOTENCY_CONFLICT" });
    assert.throws(() => api.receipt({ ...identity, deviceId: "another" }, input.requestId), { code: "COMMAND_NOT_FOUND" });
    let stops = 0;
    const stopping = new ClientSessionAPI({ store: f.store, ...callbacks, stop: async () => { stops++; } });
    const stop = { requestId: "stop_12345" };
    assert.equal((await stopping.command(identity, "session:test", "stop", stop)).status, "stop_requested");
    await stopping.command(identity, "session:test", "stop", stop);
    assert.equal(stops, 1);
  } finally { await f.close(); }
});

test("provider capabilities and payload boundaries precede execution", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    for (const provider of ["codex", "claude", "openclacky", "future-provider"]) {
      const api = new ClientSessionAPI({ store: f.store, ...callbacks,
        actions: () => ({ send: { available: false, reason: "CAPABILITY_UNSUPPORTED" } }), send: async () => { calls++; } });
      await assert.rejects(api.command(identity, "session:test", "send", { requestId: `request_${provider}`, text: "test" }), { code: "CAPABILITY_UNSUPPORTED" });
    }
    const api = new ClientSessionAPI({ store: f.store, ...callbacks });
    for (const text of ["", "/clear", "a".repeat(16001)]) {
      await assert.rejects(api.command(identity, "session:test", "send", { requestId: "request_123", text }), { code: "INVALID_MESSAGE" });
    }
    await assert.rejects(api.command(identity, "session:test", "send", { requestId: "request_123", text: "test", source: { type: "agent" } }), { code: "INVALID_COMMAND" });
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test("capabilities carry Session readiness and usage is a sanitized read-only projection", async () => {
  const f = await fixture();
  try {
    const plain = new ClientSessionAPI({ store: f.store, ...callbacks });
    const withoutReadiness = plain.capabilities(identity, "session:test");
    assert.equal(withoutReadiness.readiness, null);
    assert.equal(withoutReadiness.notReadyReason, null);
    await assert.rejects(plain.usage(identity, "session:test"), { code: "CAPABILITY_UNSUPPORTED" });

    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      readiness: () => ({ readiness: "not_ready", notReadyReason: { code: "PROVIDER_INITIALIZING", message: "starting", retryable: true, secret: "private" } }),
      usage: async () => ({ account: { available: true, provider: "codex", model: "gpt-5", token: "private",
        rateLimits: { limitId: "default", limitName: "gpt-5", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1700000000, raw: {} }, secondary: null },
        rateLimitsByLimitId: { default: { limitId: "default", primary: { usedPercent: "bad" } }, broken: "no" },
        rateLimitResetCredits: { availableCount: 2, privateField: "private", credits: [
          { id: "credit:one", resetType: "codexRateLimits", status: "available", grantedAt: 1700000000,
            expiresAt: 1701000000, title: "Full reset", description: "One use", token: "private" }
        ] } },
        context: { usedTokens: 1200, contextWindow: 4000, remainingTokens: 2800, usedPercent: 30, trace: "private" },
        resetForecast: { forecast: { url: "https://example.invalid" } } }) });
    const capabilities = api.capabilities(identity, "session:test");
    assert.equal(capabilities.readiness, "not_ready");
    assert.deepEqual(capabilities.notReadyReason, { code: "PROVIDER_INITIALIZING", message: "starting", retryable: true });
    const ready = new ClientSessionAPI({ store: f.store, ...callbacks,
      readiness: () => ({ readiness: "ready", notReadyReason: { code: "STALE", message: "ignored" } }) });
    assert.equal(ready.capabilities(identity, "session:test").readiness, "ready");
    assert.equal(ready.capabilities(identity, "session:test").notReadyReason, null);

    const usage = await api.usage(identity, "session:test");
    assert.deepEqual(usage, { schemaVersion: 1, sessionId: "session:test", accountFresh: null,
      context: { usedTokens: 1200, contextWindow: 4000, remainingTokens: 2800, usedPercent: 30 },
      account: { available: true, provider: "codex", model: "gpt-5",
        rateLimitResetCredits: { availableCount: 2, credits: [
          { id: "credit:one", resetType: "codexRateLimits", status: "available", grantedAt: 1700000000,
            expiresAt: 1701000000, title: "Full reset", description: "One use" }
        ] },
        rateLimits: { limitId: "default", limitName: "gpt-5",
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1700000000 }, secondary: null },
        rateLimitsByLimitId: { default: { limitId: "default", limitName: null,
          primary: { usedPercent: null, windowDurationMins: null, resetsAt: null }, secondary: null } } } });
    await assert.rejects(api.usage(identity, "session:missing"), { code: "SESSION_NOT_AVAILABLE" });
  } finally { await f.close(); }
});

test("paired-client quota verification requires a fresh provider-neutral account read", async () => {
  const f = await fixture();
  try {
    const reads = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      usage: async (_sessionId, options) => {
        reads.push(options);
        return { accountFresh: true, account: { available: true, provider: "codex" } };
      } });
    const result = await api.usage(identity, "session:test", { freshAccount: true });
    assert.equal(result.accountFresh, true);
    assert.deepEqual(reads, [{ requireFreshAccount: true }]);
  } finally { await f.close(); }
});

test("uncertain dispatch is never automatically replayed; reads project only public message fields", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const api = new ClientSessionAPI({ store: f.store, ...callbacks, send: async () => { calls++; throw new Error("secret provider detail"); } });
    const input = { requestId: "request_123", text: "test" };
    assert.equal((await api.command(identity, "session:test", "send", input)).status, "unknown");
    await api.command(identity, "session:test", "send", input);
    assert.equal(calls, 1);
    const page = await api.messages(identity, "session:test", new URLSearchParams());
    assert.equal(page.items[0].text, "hello");
    assert.equal(page.items[0].userMessageStatus, "processing");
    assert.equal(page.items[0].queuePosition, 2);
    assert.equal(Object.hasOwn(page.items[0], "secret"), false);
    const history = new ClientSessionAPI({ store: f.store, ...callbacks, readWindow: async () => ({
      revision: 5, hasEarlier: true, items: ["older", "previous", "anchor", "newer"].map(id => ({ id, type: "userMessage", text: id }))
    }) });
    const older = await history.messages(identity, "session:test", new URLSearchParams("before=anchor&limit=2"));
    assert.deepEqual(older.items.map(item => item.id), ["older", "previous"]);
    assert.equal(older.nextBefore, "older");
    await assert.rejects(api.messages(identity, "session:test", new URLSearchParams("before=missing")), { code: "ANCHOR_NOT_FOUND" });
    await assert.rejects(api.messages(identity, "session:test", new URLSearchParams("limit=100")), { code: "INVALID_LIMIT" });
  } finally { await f.close(); }
});

test("stable logical Session ids resolve to the current executable Session", async () => {
  const f = await fixture();
  try {
    const calls = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      resolveSession: id => id === "logical:test" ? "session:test" : id,
      readWindow: async id => {
        calls.push(id);
        return { revision: 1, hasEarlier: false, items: [] };
      },
      send: async id => { calls.push(id); } });
    const page = await api.messages(identity, "logical:test", new URLSearchParams());
    assert.equal(page.sessionId, "session:test");
    assert.equal(api.capabilities(identity, "logical:test").sessionId, "session:test");
    const receipt = await api.command(identity, "logical:test", "send",
      { requestId: "logical_request", text: "Hello" });
    assert.equal(receipt.sessionId, "session:test");
    assert.deepEqual(calls, ["session:test", "session:test"]);
  } finally { await f.close(); }
});

test("read receipts acknowledge an exact rendered cursor and publish through the host callback", async () => {
  const f = await fixture();
  try {
    f.store.appendSessionEvent({ sessionId: "session:test", eventId: "event:agent-1", type: "AgentTurnCompleted",
      payload: { hasAgentMessage: true }, source: "test" });
    const published = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks, markRead: (sessionId, through) => {
      const receipt = f.store.markSessionMessagesRead(sessionId, through);
      published.push([sessionId, through]);
      return receipt;
    } });
    const latest = f.store.lastAgentMessageSequence("session:test");
    const receipt = api.readReceipt(identity, "session:test", { throughSequence: latest });
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.sessionId, "session:test");
    assert.equal(receipt.lastReadMessageSequence, latest);
    assert.deepEqual(published, [["session:test", latest]]);
    assert.throws(() => api.readReceipt(identity, "session:test", { throughSequence: latest + 1 }), { code: "INVALID_READ_SEQUENCE", status: 409 });
    for (const input of [{}, { throughSequence: -1 }, { throughSequence: "1" }, { throughSequence: 0, extra: true }]) {
      assert.throws(() => api.readReceipt(identity, "session:test", input), { code: "INVALID_READ_SEQUENCE", status: 400 });
    }
    assert.throws(() => api.readReceipt(identity, "session:missing", { throughSequence: 0 }), { code: "SESSION_NOT_AVAILABLE" });
  } finally { await f.close(); }
});

test("message attachments project managed paths only and stream through the owned image callback", async () => {
  const f = await fixture();
  try {
    const reads = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      readWindow: async () => ({ revision: 6, hasEarlier: false, items: [
        { id: "m:1", type: "userMessage", text: "see", images: [
          { managedPath: "chat-resources/session/a.png", originalPath: "/Users/me/secret.png", fileName: "a.png", mimeType: "image/png", byteLength: 12 },
          { originalPath: "/Users/me/only-original.png" }, null, { managedPath: "" },
        ] },
        { id: "m:2", type: "agentMessage", text: "none", images: "invalid" },
      ] }),
      images: { available: () => true, import: async () => ({}), read: async (sessionId, managedPath) => {
        reads.push([sessionId, managedPath]);
        if (managedPath.endsWith("missing.png")) { const error = new Error("missing"); error.code = "CHAT_IMAGE_MISSING"; error.statusCode = 404; throw error; }
        if (managedPath.startsWith("chat-resources/other")) { const error = new Error("foreign"); error.code = "CHAT_IMAGE_FORBIDDEN"; error.statusCode = 403; throw error; }
        return { data: Buffer.from("png-bytes"), mimeType: "image/png", byteLength: 9 };
      } } });
    const { items } = await api.messages(identity, "session:test", new URLSearchParams());
    assert.deepEqual(items[0].images, [{ managedPath: "chat-resources/session/a.png", fileName: "a.png", mimeType: "image/png", byteLength: 12 }]);
    assert.equal(Object.hasOwn(items[0].images[0], "originalPath"), false);
    assert.deepEqual(items[1].images, []);

    const image = await api.image(identity, "session:test", new URLSearchParams({ path: "chat-resources/session/a.png" }));
    assert.equal(image.contentType, "image/png");
    assert.equal(image.byteLength, 9);
    assert.equal(image.data.toString(), "png-bytes");
    assert.deepEqual(reads, [["session:test", "chat-resources/session/a.png"]]);
    await assert.rejects(api.image(identity, "session:test", new URLSearchParams({ path: "chat-resources/session/missing.png" })), { code: "IMAGE_NOT_AVAILABLE", status: 404 });
    // Foreign Sessions' paths read as absent, never as forbidden.
    await assert.rejects(api.image(identity, "session:test", new URLSearchParams({ path: "chat-resources/other/a.png" })), { code: "IMAGE_NOT_AVAILABLE", status: 404 });
    for (const query of [new URLSearchParams(), new URLSearchParams({ path: "" }), new URLSearchParams([["path", "a"], ["path", "b"]]), new URLSearchParams({ path: "a", extra: "1" })]) {
      await assert.rejects(api.image(identity, "session:test", query), { status: query.get("path") === "" ? 404 : 400 });
    }
    await assert.rejects(api.image(identity, "session:missing", new URLSearchParams({ path: "a" })), { code: "SESSION_NOT_AVAILABLE" });
    const noImages = new ClientSessionAPI({ store: f.store, ...callbacks });
    await assert.rejects(noImages.image(identity, "session:test", new URLSearchParams({ path: "a" })), { code: "IMAGE_NOT_AVAILABLE", status: 404 });
  } finally { await f.close(); }
});
