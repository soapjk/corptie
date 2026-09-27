import assert from "node:assert/strict";
import test from "node:test";
import { asyncQuestionInput, elicitationInput, elicitationResponse, permissionInput, permissionResponse } from "../src/application/structuredInteraction.mjs";
import { validateInteractionAnswers, publicUserInput } from "../src/application/interactionInput.mjs";
import { ClaudeAgentManager } from "../src/adapters/claudeAgentManager.mjs";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";

test("async questions carry independent lifetime and single/custom answer semantics", () => {
  const model = asyncQuestionInput({ type: "agentMessage", delivery: "async", questions: [
    { title: "哪一张详情卡片？", options: ["Worktree", "聊天"] }
  ] });
  assert.equal(model.responseMode, "message");
  assert.equal(model.isBlocking, false);
  assert.equal(validateInteractionAnswers(model, { "question-0": ["其他卡片"] }), true);
  assert.equal(validateInteractionAnswers(model, { "question-0": ["Worktree", "聊天"] }), false);
  assert.equal(publicUserInput({ ...model, kind: "execute-script" }), null);
});

test("MCP form validates typed values and never accepts unsupported constraints silently", () => {
  const request = { mode: "form", message: "设置", requestedSchema: { type: "object", properties: {
    name: { type: "string", minLength: 2 }, count: { type: "integer", minimum: 1, maximum: 4 }, enabled: { type: "boolean" }
  }, required: ["name", "count"] } };
  assert.equal(elicitationInput(request).questions[2].required, false);
  const input = { answers: { "field-0": ["demo"], "field-1": ["3"], "field-2": [] } };
  assert.deepEqual({ ...elicitationResponse(request, input).content }, { name: "demo", count: 3 });
  assert.throws(() => elicitationResponse(request, { answers: { ...input.answers, "field-1": ["5"] } }), { code: "INVALID_USER_INPUT_ANSWER" });
  assert.deepEqual(elicitationResponse(request, { action: "cancel" }), { action: "cancel", content: null });
  assert.throws(() => elicitationInput({ ...request, requestedSchema: { ...request.requestedSchema, oneOf: [] } }));
  assert.throws(() => elicitationInput({ mode: "url", url: "javascript:alert(1)" }));
});

test("permission approval grants only individually selected requested resources", () => {
  const request = { permissions: { network: { enabled: true }, fileSystem: { read: ["/tmp/read"], write: ["/tmp/write"] } } };
  const model = permissionInput(request);
  assert.equal(model.questions[0].selectionMode, "multiple");
  assert.deepEqual(permissionResponse(request, { answers: { permissions: ["读取：/tmp/read"], scope: ["仅当前轮次"] } }),
    { permissions: { fileSystem: { read: ["/tmp/read"] } }, scope: "turn" });
  assert.deepEqual(permissionResponse(request, { answers: { permissions: [], scope: ["当前会话"] } }), { permissions: {}, scope: "session" });
  assert.throws(() => permissionResponse(request, { answers: { permissions: ["写入：/"], scope: ["当前会话"] } }));
});

test("Codex permissions and elicitation return native results, not generic decisions", async () => {
  const client = new CodexAppServerClient();
  const replies = [];
  client.respondToServerRequest = async (id, result) => { replies.push({ id, result }); };
  client.handleServerRequest({ id: "p", method: "item/permissions/requestApproval", params: {
    threadId: "thread", turnId: "turn", permissions: { network: { enabled: true } }
  } });
  await client.respondToUserInput("thread", { itemId: "thread:app-server-user-input:p", action: "cancel" });
  client.handleServerRequest({ id: "e", method: "mcpServer/elicitation/request", params: {
    threadId: "thread", turnId: "turn", mode: "url", url: "https://example.com/auth", message: "登录"
  } });
  await client.respondToUserInput("thread", { itemId: "thread:app-server-user-input:e", action: "cancel" });
  assert.deepEqual(replies, [{ id: "p", result: { permissions: {}, scope: "turn" } }, { id: "e", result: { action: "cancel", content: null } }]);
});

test("Claude supports multiple selections and custom answers and rejects repeated replies", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude:input" });
  const session = manager.get("claude:input");
  const pending = manager.handleToolRequest(session, "AskUserQuestion", { questions: [
    { question: "选功能", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }
  ] });
  const itemId = session.items.at(-1).id;
  manager.respondToUserInput(session.id, { itemId, answers: { "question-0": ["A", "B", "自定义"] } });
  assert.equal((await pending).updatedInput.answers["选功能"], "A, B, 自定义");
  assert.throws(() => manager.respondToUserInput(session.id, { itemId, answers: {} }), { code: "USER_INPUT_NOT_PENDING" });
});

test("Claude elicitation cancellation releases callbacks; neutral notices do not expose auth output", async () => {
  const events = [];
  const manager = new ClaudeAgentManager({ onProviderEvent: event => events.push(event) });
  manager.start({ id: "claude:form" });
  const session = manager.get("claude:form");
  const abort = new AbortController();
  const pending = manager.handleElicitation(session, { mode: "url", url: "https://example.com", message: "登录" }, { signal: abort.signal });
  abort.abort();
  assert.equal((await pending).action, "cancel");
  assert.equal(session.pendingInteractions.size, 0);
  assert.equal(session.items.at(-1).status, "expired");
  manager.handleSdkMessage(session, { type: "auth_status", uuid: "auth", output: ["secret-token"], isAuthenticating: true });
  manager.handleSdkMessage(session, { type: "system", subtype: "compact_boundary", uuid: "compact", compact_metadata: {} });
  manager.handleSdkMessage(session, { type: "tool_use_summary", uuid: "summary", summary: "检查完成" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.filter(e => e.type === "execution.notice").length, 3);
  assert.equal(JSON.stringify(session.items).includes("secret-token"), false);
});
