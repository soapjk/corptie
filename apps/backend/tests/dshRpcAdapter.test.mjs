import assert from "node:assert/strict";
import test from "node:test";
import {
  parseClientRequest,
  okResponse,
  errorResponse,
  RpcErrorCode,
} from "../src/dsh-adapter/dshWireCodec.mjs";
import { mapEvent, mapHistory, mapFallbackEvent } from "../src/dsh-adapter/dshEventMapper.mjs";
import { mapSessionSummary, mapSessionList } from "../src/dsh-adapter/dshSessionSummaryMapper.mjs";
import {
  mapWorkspaceList,
  settingsDescribe,
  settingsMutate,
  historyFromCodexRollout,
  sessionPrompt,
  sessionModels,
  sessionSelectModel,
} from "../src/dsh-adapter/dshRpcAdapter.mjs";

// ---- wire codec ----

test("parseClientRequest 解析合法的 client-request 信封", () => {
  const req = parseClientRequest({
    type: "client-request",
    rpcId: "abc-123",
    method: "session.list",
    payload: {},
  });
  assert.deepEqual(req, { rpcId: "abc-123", method: "session.list", payload: {} });
});

test("parseClientRequest 在 payload 缺失时补空对象", () => {
  const req = parseClientRequest({ type: "client-request", rpcId: "x", method: "session.list" });
  assert.deepEqual(req, { rpcId: "x", method: "session.list", payload: {} });
});

test("parseClientRequest 拒绝非法信封", () => {
  assert.equal(parseClientRequest(null), null);
  assert.equal(parseClientRequest({ type: "server-response" }), null);
  assert.equal(parseClientRequest({ type: "client-request", method: "x" }), null); // 缺 rpcId
  assert.equal(parseClientRequest({ type: "client-request", rpcId: "x" }), null); // 缺 method
});

test("okResponse / errorResponse 符合 server-response 信封", () => {
  assert.deepEqual(okResponse("id", { items: [] }), {
    type: "server-response",
    rpcId: "id",
    result: { ok: true, value: { items: [] } },
  });
  assert.deepEqual(errorResponse("id", RpcErrorCode.SESSION_NOT_FOUND, "gone", { sessionId: "s1" }), {
    type: "server-response",
    rpcId: "id",
    result: { ok: false, error: { code: "session-not-found", message: "gone", details: { sessionId: "s1" } } },
  });
});

test("session.prompt 通过 Corptie 统一消息入口投递", async () => {
  const calls = [];
  const result = await sessionPrompt({
    sessionId: "session:a",
    content: [{ type: "text", text: "hello" }],
    mode: "queue",
  }, {
    sessionApplicationService: null,
    sendSessionMessage: async (...args) => calls.push(args),
  });
  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(calls, [["session:a", "hello"]]);
});

test("session.models 把 Provider 目录映射为 DSH schema", async () => {
  const result = await sessionModels({ sessionId: "session:a" }, {
    sessionApplicationService: {
      listModelsForSession: async () => ({
        providerId: "fake.provider",
        providerName: "Fake Provider",
        currentModel: "model-a",
        currentReasoningLevel: "high",
        models: [{
          id: "model-a",
          name: "Model A",
          description: "Test model",
          reasoningLevels: ["low", "high"],
          defaultReasoningLevel: "high",
        }],
      }),
    },
  });
  assert.equal(result.current.provider, "fake.provider");
  assert.equal(result.current.model, "model-a");
  assert.equal(result.current.reasoningEffort, "high");
  assert.equal(result.groups[0].id, "fake.provider");
  assert.deepEqual(result.groups[0].models[0].reasoning.efforts, [
    { id: "low", name: "low" },
    { id: "high", name: "high" },
  ]);
});

test("session.selectModel 同时应用模型与 reasoning effort", async () => {
  const calls = [];
  const result = await sessionSelectModel({
    sessionId: "session:a",
    provider: "fake.provider",
    model: "model-b",
    reasoningEffort: "medium",
  }, {
    sessionApplicationService: {
      switchModel: async (...args) => calls.push(["model", ...args]),
      switchReasoning: async (...args) => calls.push(["reasoning", ...args]),
    },
  });
  assert.deepEqual(result, {
    selected: {
      provider: "fake.provider",
      model: "model-b",
      reasoningEffort: "medium",
    },
  });
  assert.equal(calls[0][0], "model");
  assert.equal(calls[1][0], "reasoning");
});

// ---- event mapper ----

test("mapEvent 映射 user/message 为 DSH 事件", () => {
  const event = mapEvent({
    sequence: 1,
    type: "user/message",
    createdAt: "2026-08-16T00:00:00.000Z",
    payload: { text: "hello", itemType: "userMessage" },
  });
  assert.equal(event.type, "user/message");
  assert.equal(event.seq, 1);
  assert.equal(event.time, Date.parse("2026-08-16T00:00:00.000Z"));
  assert.equal(event.surfaceOp, "append");
  assert.equal(event.data.role, "user");
  assert.equal(typeof event.data.id, "string");
  assert.deepEqual(event.data.content, [{ type: "text", text: "hello" }]);
});

test("mapEvent 映射 assistant/message 为 DSH 事件", () => {
  const event = mapEvent({
    sequence: 2,
    type: "assistant/message",
    createdAt: "2026-08-16T00:00:01.000Z",
    payload: { text: "world", itemType: "agentMessage" },
  });
  assert.equal(event.type, "assistant/message");
  assert.equal(event.seq, 2);
  assert.equal(event.surfaceOp, "append");
  assert.equal(event.data.message.role, "assistant");
  assert.equal(typeof event.data.message.id, "string");
  assert.equal(event.data.message.source.kind, "model");
  assert.equal(typeof event.data.message.source.provider, "string");
  assert.equal(typeof event.data.message.source.model, "string");
  assert.deepEqual(event.data.message.content, [{ type: "text", text: "world" }]);
});

test("mapEvent 对未知类型返回 null", () => {
  assert.equal(mapEvent({ sequence: 3, type: "some/unknown", payload: {} }), null);
});

test("mapHistory 跳过未知类型，只保留可映射事件", () => {
  const entries = mapHistory([
    { sequence: 1, type: "user/message", createdAt: "2026-08-16T00:00:00.000Z", payload: { text: "a" } },
    { sequence: 2, type: "internal/noise", payload: {} },
    { sequence: 3, type: "assistant/message", createdAt: "2026-08-16T00:00:02.000Z", payload: { text: "b" } },
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].event.type, "user/message");
  assert.equal(entries[1].event.type, "assistant/message");
});

// ---- fallback event mapper (底层事件兜底) ----

test("mapFallbackEvent 映射 SessionUserMessageCreated → user/message", () => {
  const event = mapFallbackEvent({
    sequence: 5,
    type: "SessionUserMessageCreated",
    createdAt: "2026-08-16T00:00:00.000Z",
    payload: { sessionId: "s1", message: { id: "m1", type: "userMessage", text: "hi there" } },
  });
  assert.equal(event.type, "user/message");
  assert.equal(event.seq, 5);
  assert.deepEqual(event.data.content, [{ type: "text", text: "hi there" }]);
  assert.equal(event.data.source.kind, "user");
});

test("mapFallbackEvent 映射 Task* 的 summary → assistant/message", () => {
  const event = mapFallbackEvent({
    sequence: 6,
    type: "TaskProgressChanged",
    createdAt: "2026-08-16T00:00:01.000Z",
    payload: { session: { summary: "Working in the background.", progress: 0.5 } },
  });
  assert.equal(event.type, "assistant/message");
  assert.equal(event.data.message.role, "assistant");
  assert.deepEqual(event.data.message.content, [{ type: "text", text: "Working in the background." }]);
});

test("mapFallbackEvent 对无正文底层事件返回 null", () => {
  assert.equal(mapFallbackEvent({ sequence: 7, type: "SessionUsageUpdated", payload: {} }), null);
  assert.equal(mapFallbackEvent({ sequence: 8, type: "SessionUserMessageCreated", payload: { message: { text: "" } } }), null);
});

test("mapHistory 在 surface 事件缺失时回退到底层事件", () => {
  const entries = mapHistory([
    { sequence: 1, type: "SessionUserMessageCreated", createdAt: "2026-08-16T00:00:00.000Z", payload: { message: { text: "hello" } } },
    { sequence: 2, type: "TaskProgressChanged", createdAt: "2026-08-16T00:00:01.000Z", payload: { session: { summary: "working" } } },
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].event.type, "user/message");
  assert.equal(entries[1].event.type, "assistant/message");
});

test("mapHistory 优先 surface 事件，不回退底层事件", () => {
  const entries = mapHistory([
    { sequence: 1, type: "user/message", createdAt: "2026-08-16T00:00:00.000Z", payload: { text: "surface" } },
    { sequence: 2, type: "SessionUserMessageCreated", createdAt: "2026-08-16T00:00:01.000Z", payload: { message: { text: "fallback" } } },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event.type, "user/message");
  assert.deepEqual(entries[0].event.data.content, [{ type: "text", text: "surface" }]);
});

// ---- session summary mapper ----
test("mapSessionSummary 映射 TaskSession → SessionSummary", () => {
  const summary = mapSessionSummary({
    id: "pty:123",
    status: "running",
    updatedAt: "2026-08-16T00:00:00.000Z",
    external: { cwd: "/tmp/work" },
  });
  assert.equal(summary.sessionId, "pty:123");
  assert.equal(summary.running, true);
  assert.equal(summary.blank, false);
  assert.equal(summary.cwd, "/tmp/work");
  assert.equal(summary.updatedAt, Date.parse("2026-08-16T00:00:00.000Z"));
  // 无 title 的 session 不产生 projections，前端回退 cwd 目录名。
  assert.equal(summary.projections, undefined);
});

test("mapSessionSummary 把 title 映射进 projections.values.title", () => {
  const summary = mapSessionSummary({
    id: "codex:abc",
    title: "完成release一键安装能力",
    status: "complete",
    updatedAt: "2026-08-16T04:53:12.000Z",
    external: { cwd: "/Volumes/T9/projects/llmay-suite/investrace" },
  });
  assert.equal(summary.sessionId, "codex:abc");
  assert.equal(summary.projections.values.title, "完成release一键安装能力");
  assert.equal(summary.projections.asOfSeq, Date.parse("2026-08-16T04:53:12.000Z"));
});

test("mapSessionList 映射数组", () => {
  const items = mapSessionList([
    { id: "a", status: "completed", updatedAt: "2026-08-16T00:00:00.000Z" },
    { id: "b", status: "running", updatedAt: "2026-08-16T00:00:01.000Z" },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].sessionId, "a");
  assert.equal(items[0].running, false);
  assert.equal(items[1].running, true);
});

// ---- workspace mapper (Objective → WorkspaceView) ----

test("mapWorkspaceList 把 Objective 映射为 WorkspaceView，session 按 objectiveId 归组", () => {
  const objectives = [
    { id: "objective:o1", name: "目标一", createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T01:00:00.000Z" },
    { id: "objective:o2", name: "目标二", createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T01:00:00.000Z" },
  ];
  const sessions = [
    { id: "session:s1", objectiveId: "objective:o1" },
    { id: "session:s2", objectiveId: "objective:o1" },
    { id: "session:s3", objectiveId: "objective:o2" },
    { id: "session:s4", objectiveId: null }, // 未归属 objective 的 session 被忽略
  ];
  const activePath = new Map([["objective:o1", "/volumes/T9/projects/a"]]);

  const items = mapWorkspaceList(objectives, sessions, activePath);

  assert.equal(items.length, 2);
  assert.equal(items[0].workspaceId, "objective:o1");
  assert.equal(items[0].title, "目标一");
  assert.deepEqual(items[0].sessionIds, ["session:s1", "session:s2"]);
  assert.equal(items[0].path, "/volumes/T9/projects/a");
  assert.equal(items[0].createdAt, "2026-08-16T00:00:00.000Z");
  assert.equal(items[1].workspaceId, "objective:o2");
  assert.deepEqual(items[1].sessionIds, ["session:s3"]);
  assert.equal(items[1].path, ""); // 无活跃 work_item → 空 path
});

test("mapWorkspaceList 空输入返回空数组", () => {
  assert.deepEqual(mapWorkspaceList([], [], new Map()), []);
  assert.deepEqual(mapWorkspaceList(undefined, undefined), []);
});

// ---- codex rollout 对话回退 (historyFromCodexRollout) ----

test("historyFromCodexRollout 生成完整 turn/step 生命周期的 DSH 事件列表", async () => {
  const events = await historyFromCodexRollout("codex:abc", async () => [
    { kind: "message", role: "user", text: "请完成工作项" },
    { kind: "message", role: "assistant", text: "我先检查仓库现状" },
    { kind: "message", role: "assistant", text: "已完成" },
    { kind: "message", role: "user", text: "hi" },
    { kind: "message", role: "assistant", text: "嗨！" },
  ]);

  // 期望事件序列：每个 user 开启 turn，连续 assistant 是该 turn 内递增 step。
  // turn0: turn/start → user/message → step/start → assistant/message → step/end
  //         → step/start → assistant/message → step/end → turn/end
  // turn1: turn/start → user/message → step/start → assistant/message → step/end → turn/end
  const types = events.map((e) => e.event.type);
  assert.deepEqual(types, [
    "turn/start", "user/message", "step/start", "assistant/message", "step/end",
    "step/start", "assistant/message", "step/end", "turn/end",
    "turn/start", "user/message", "step/start", "assistant/message", "step/end", "turn/end",
  ]);

  // seq 从 0 连续递增。
  assert.deepEqual(events.map((e) => e.event.seq), events.map((_, i) => i));

  // 每个元素必须是 { event: SessionEvent } 信封。
  for (const entry of events) {
    assert.equal(typeof entry.event, "object");
    assert.equal(typeof entry.event.type, "string");
  }

  // 索引定位：turn0 的 user/message 在 idx1，assistant/message 在 idx3 和 idx6。
  const user0 = events[1].event;
  const asst0 = events[3].event;
  const asst1 = events[6].event;
  const user1 = events[10].event;

  // surface 事件必须携带 surfaceOp:'append'；boundary 事件不携带。
  assert.equal(user0.surfaceOp, "append");
  assert.equal(asst0.surfaceOp, "append");
  assert.equal(events[0].event.surfaceOp, undefined); // turn/start 无 surfaceOp

  // user 事件 data 是完整 UserMessage。
  assert.equal(user0.data.role, "user");
  assert.equal(typeof user0.data.id, "string");
  assert.ok(user0.data.id.length > 0);
  assert.deepEqual(user0.data.content, [{ type: "text", text: "请完成工作项" }]);
  assert.equal(user0.data.source.kind, "user");

  // assistant 事件 data 携带 turn/step 坐标 + message（AssistantMessage）。
  assert.equal(asst0.data.turn, 0);
  assert.equal(asst0.data.step, 0);
  assert.equal(asst1.data.turn, 0);
  assert.equal(asst1.data.step, 1); // 同一 turn 内连续 assistant 递增 step
  assert.equal(asst0.data.message.role, "assistant");
  assert.equal(typeof asst0.data.message.id, "string");
  assert.ok(asst0.data.message.id.length > 0);
  assert.deepEqual(asst0.data.message.content, [{ type: "text", text: "我先检查仓库现状" }]);
  assert.equal(asst0.data.message.source.kind, "model");
  assert.equal(asst0.data.message.source.provider, "codex");
  assert.equal(asst0.data.message.source.model, "codex");

  // 第二个 turn 的坐标从 turn1 重新开始。
  assert.equal(user1.data.role, "user");
  const asst2 = events[12].event;
  assert.equal(asst2.data.turn, 1);
  assert.equal(asst2.data.step, 0);

  // turn/end 携带 reason。
  assert.deepEqual(events[8].event.data, { turn: 0, reason: { kind: "completed" } });
});

test("historyFromCodexRollout 在 rollout 不可用/空时返回 null", async () => {
  assert.equal(await historyFromCodexRollout("codex:abc", async () => []), null);
  assert.equal(await historyFromCodexRollout("codex:abc", async () => { throw new Error("no file"); }), null);
});

test("historyFromCodexRollout 将尾序列对齐持久事件流", async () => {
  const events = await historyFromCodexRollout("codex:abc", async () => [
    { kind: "message", role: "user", text: "hello" },
    { kind: "message", role: "assistant", text: "world" },
  ], 120);
  assert.equal(events.at(-1).event.seq, 120);
  assert.deepEqual(
    events.map((entry) => entry.event.seq),
    Array.from({ length: events.length }, (_, index) => 120 - events.length + 1 + index)
  );
});

test("historyFromCodexRollout 使用 rollout 消息时间而不是 Unix epoch", async () => {
  const timestamp = "2026-08-16T12:34:56.789Z";
  const events = await historyFromCodexRollout("codex:abc", async () => [
    { kind: "message", role: "user", text: "hello", createdAt: timestamp },
    { kind: "message", role: "assistant", text: "world", createdAt: timestamp },
  ]);
  assert.equal(events.find((entry) => entry.event.type === "user/message").event.time, Date.parse(timestamp));
  assert.equal(events.find((entry) => entry.event.type === "assistant/message").event.time, Date.parse(timestamp));
});

test("historyFromCodexRollout 将工具调用/结果映射为 tool/call 与 tool/result 事件", async () => {
  const events = await historyFromCodexRollout("codex:abc", async () => [
    { kind: "message", role: "user", text: "执行检查" },
    { kind: "message", role: "assistant", text: "开始检查" },
    { kind: "tool-call", callId: "call_1", name: "exec", arguments: "ls -la" },
    { kind: "tool-output", callId: "call_1", output: "total 4" },
    { kind: "message", role: "assistant", text: "检查完成" },
  ]);

  // 工具调用/结果归属触发它的 assistant message 所属的 step（而非下一个未开启的 step），
  // 因此 step/end 在工具调用序列结束、下一个 assistant message 到来时才闭合。
  const types = events.map((e) => e.event.type);
  assert.deepEqual(types, [
    "turn/start", "user/message", "step/start", "assistant/message",
    "tool/call", "tool/result", "step/end",
    "step/start", "assistant/message", "step/end", "turn/end",
  ]);

  const toolCall = events[4].event;
  assert.equal(toolCall.type, "tool/call");
  assert.equal(toolCall.data.turn, 0);
  assert.equal(toolCall.data.step, 0);
  assert.equal(toolCall.data.callId, "call_1");
  assert.equal(toolCall.data.name, "exec");
  assert.equal(toolCall.data.arguments, "ls -la");
  // tool/call 非 surface 事件，不能带 surfaceOp。
  assert.equal(toolCall.surfaceOp, undefined);

  const toolResult = events[5].event;
  assert.equal(toolResult.type, "tool/result");
  assert.equal(toolResult.surfaceOp, "append"); // tool/result 是 surface-eligible 类型
  assert.equal(toolResult.data.turn, 0);
  assert.equal(toolResult.data.step, 0);
  const msg = toolResult.data.message;
  assert.equal(msg.role, "user");
  assert.equal(msg.source.kind, "tool");
  assert.equal(msg.source.callId, "call_1");
  assert.deepEqual(msg.content, [
    { type: "tool-result", toolCallId: "call_1", content: "total 4", isError: false },
  ]);
});

// ---- settings (欢迎通知 ui-onboarding) ----

test("settingsDescribe 返回已确认的 ui-onboarding 命名空间，欢迎通知不弹窗", async () => {
  const result = await settingsDescribe({});
  assert.equal(result.writable, false);
  assert.equal(result.hasDocument, false);
  assert.equal(result.namespaces.length, 1);
  const ns = result.namespaces[0];
  assert.equal(ns.ns, "ui-onboarding");
  assert.equal(ns.applies, "live");
  assert.equal(ns.revision, 0);
  assert.deepEqual(ns.secrets, []);
  // DSH 前端 acknowledgementOf(view) 读 view.value.welcomeNoticeVersion，
  // 等于 WELCOME_NOTICE_VERSION 时判定 acknowledged=true，弹窗与报错均不出现。
  assert.equal(ns.value.welcomeNoticeVersion, "2026-08-13.1");
});

test("settingsMutate 保存 welcomeNoticeVersion 并返回新 view", async () => {
  const view = await settingsMutate({
    ns: "ui-onboarding",
    ops: [{ op: "set", path: ["welcomeNoticeVersion"], value: "2099-01-01.0" }],
  });
  assert.equal(view.ns, "ui-onboarding");
  assert.equal(view.value.welcomeNoticeVersion, "2099-01-01.0");

  // 后续 describe 应反映已写入的确认状态（进程内持久化）。
  const described = await settingsDescribe({});
  assert.equal(described.namespaces[0].value.welcomeNoticeVersion, "2099-01-01.0");
});

test("settingsMutate unset 移除字段", async () => {
  await settingsMutate({
    ns: "ui-onboarding",
    ops: [{ op: "set", path: ["welcomeNoticeVersion"], value: "x" }],
  });
  const view = await settingsMutate({
    ns: "ui-onboarding",
    ops: [{ op: "unset", path: ["welcomeNoticeVersion"] }],
  });
  assert.equal(view.value.welcomeNoticeVersion, undefined);
});
