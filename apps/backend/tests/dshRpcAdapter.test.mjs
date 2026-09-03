import assert from "node:assert/strict";
import test from "node:test";
import {
  parseClientRequest,
  okResponse,
  errorResponse,
  RpcErrorCode,
} from "../src/dsh-adapter/dshWireCodec.mjs";
import { mapEvent } from "../src/dsh-adapter/dshEventMapper.mjs";
import { mapSessionSummary, mapSessionList } from "../src/dsh-adapter/dshSessionSummaryMapper.mjs";
import {
  mapWorkspaceList,
  settingsDescribe,
  settingsMutate,
  historyFromStoredTimelineItems,
  dispatchDshRequest,
  sessionPrompt,
  sessionModels,
  sessionSelectModel,
} from "../src/dsh-adapter/dshRpcAdapter.mjs";

test("DSH Session list and host handshake read only the injected Corptie Store projection", async () => {
  const sessions = [{ id: "session:stored", title: "Stored", status: "complete", external: { cwd: "/tmp/stored" } }];
  const deps = {
    listStoredSessions: () => sessions,
    store: { listSessionTimelineRevisions: () => new Map([["session:stored", 2]]) },
    sessionApplicationService: {
      listSessions: () => { throw new Error("Provider Session list must not be called"); }
    }
  };
  const listed = await dispatchDshRequest("session.list", {}, deps);
  const host = await dispatchDshRequest("host.describe", {}, deps);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].blank, false);
  assert.equal(host.attachedSessions, 1);
  assert.equal(host.cwd, "/tmp/stored");
});

test("DSH Session list marks revision-zero Sessions reusable without detail reads", async () => {
  const listed = await dispatchDshRequest("session.list", {}, {
    listStoredSessions: () => [{ id: "session:blank", status: "complete" }],
    store: {
      listSessionTimelineRevisions: () => new Map([["session:blank", 0]]),
      getDetail: () => { throw new Error("detail reads are forbidden on Session list"); }
    }
  });
  assert.equal(listed.items[0].blank, true);
});

test("DSH Session creation reuses the Work's unique Work Chat", async () => {
  const calls = [];
  const result = await dispatchDshRequest("session.create", { workspaceId: "work:one" }, {
    store: {
      listSessions: () => [{
        id: "session:existing",
        workId: "work:one",
        agentId: "agent:one",
        sessionKind: "workChat",
        updatedAt: "2026-08-26T10:00:00Z",
        external: { cwd: "/repo" }
      }]
    },
    createSession: async (...args) => {
      calls.push(args);
      return { id: "session:new" };
    }
  });
  assert.deepEqual(result, { sessionId: "session:existing" });
  assert.deepEqual(calls, []);
});

test("DSH Session creation refuses an Work with no existing Agent binding", async () => {
  await assert.rejects(
    dispatchDshRequest("session.create", { workspaceId: "work:empty" }, {
      store: { listSessions: () => [] },
      createSession: async () => ({ id: "must-not-create" })
    }),
    /requires an existing Agent/
  );
});

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
    eventId: "event:user",
    sequence: 1,
    type: "user/message",
    createdAt: "2026-08-16T00:00:00.000Z",
    payload: { itemId: "message:user", text: "hello", itemType: "userMessage" },
  });
  assert.equal(event.type, "user/message");
  assert.equal(event.seq, 1);
  assert.equal(event.time, Date.parse("2026-08-16T00:00:00.000Z"));
  assert.equal(event.surfaceOp, "append");
  assert.equal(event.data.role, "user");
  assert.equal(event.data.id, "message:user");
  assert.deepEqual(event.data.content, [{ type: "text", text: "hello" }]);
});

test("mapEvent 映射 assistant/message 为 DSH 事件", () => {
  const event = mapEvent({
    eventId: "event:assistant",
    sequence: 2,
    type: "assistant/message",
    createdAt: "2026-08-16T00:00:01.000Z",
    payload: { itemId: "message:assistant", text: "world", itemType: "agentMessage" },
  });
  assert.equal(event.type, "assistant/message");
  assert.equal(event.seq, 2);
  assert.equal(event.surfaceOp, "append");
  assert.equal(event.data.message.role, "assistant");
  assert.equal(event.data.message.id, "message:assistant");
  assert.equal(event.data.message.source.kind, "model");
  assert.equal(typeof event.data.message.source.provider, "string");
  assert.equal(typeof event.data.message.source.model, "string");
  assert.deepEqual(event.data.message.content, [{ type: "text", text: "world" }]);
});

test("mapEvent 对未知类型返回 null", () => {
  assert.equal(mapEvent({ sequence: 3, type: "some/unknown", payload: {} }), null);
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

// ---- workspace mapper (Work → WorkspaceView) ----

test("mapWorkspaceList 把 Work 映射为 WorkspaceView，session 按 workId 归组", () => {
  const works = [
    { id: "work:o1", name: "目标一", createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T01:00:00.000Z" },
    { id: "work:o2", name: "目标二", createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T01:00:00.000Z" },
  ];
  const sessions = [
    { id: "session:s1", workId: "work:o1" },
    { id: "session:s2", workId: "work:o1" },
    { id: "session:s3", workId: "work:o2" },
    { id: "session:s4", workId: null }, // 未归属 work 的 session 被忽略
  ];
  const activePath = new Map([["work:o1", "/volumes/T9/projects/a"]]);

  const items = mapWorkspaceList(works, sessions, activePath);

  assert.equal(items.length, 2);
  assert.equal(items[0].workspaceId, "work:o1");
  assert.equal(items[0].title, "目标一");
  assert.deepEqual(items[0].sessionIds, ["session:s1", "session:s2"]);
  assert.equal(items[0].path, "/volumes/T9/projects/a");
  assert.equal(items[0].createdAt, "2026-08-16T00:00:00.000Z");
  assert.equal(items[1].workspaceId, "work:o2");
  assert.deepEqual(items[1].sessionIds, ["session:s3"]);
  assert.equal(items[1].path, ""); // 无活跃 task → 空 path
});

test("mapWorkspaceList 空输入返回空数组", () => {
  assert.deepEqual(mapWorkspaceList([], [], new Map()), []);
  assert.deepEqual(mapWorkspaceList(undefined, undefined), []);
});

// ---- stored Corptie Timeline projection ----

test("historyFromStoredTimelineItems renders stable user, assistant, and tool identities", () => {
  const events = historyFromStoredTimelineItems([
    { id: "message:user", turnId: "turn:1", type: "userMessage", text: "Question", createdAt: "2026-08-26T10:00:00Z" },
    { id: "tool:1", turnId: "turn:1", type: "commandExecution", title: "shell", text: "swift test", createdAt: "2026-08-26T10:00:01Z" },
    { id: "message:assistant", turnId: "turn:1", type: "agentMessage", text: "Answer", createdAt: "2026-08-26T10:00:02Z" }
  ], 20);
  const user = events.find((entry) => entry.event.type === "user/message");
  const assistant = events.find((entry) => entry.event.type === "assistant/message");
  const tool = events.find((entry) => entry.event.type === "tool/call");
  assert.equal(user.event.data.id, "message:user");
  assert.equal(assistant.event.data.message.id, "message:assistant");
  assert.equal(tool.event.data.callId, "tool:1");
  assert.equal(events.at(-1).event.seq, 20);
});

test("historyFromStoredTimelineItems never needs a Provider reader", () => {
  assert.deepEqual(historyFromStoredTimelineItems([]), []);
});


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
