import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexRolloutTimeline } from "../src/adapters/codexAppServer.mjs";

function msgLine(role, text) {
  return JSON.stringify({
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "output_text", text }] },
  });
}

test("提取对话 + 工具调用/结果的完整有序时间线", () => {
  const text = [
    msgLine("user", "请完成工作项"),
    JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "ls -la" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: "total 4" }] },
    }),
    msgLine("assistant", "完成了"),
  ].join("\n");

  const items = parseCodexRolloutTimeline(text);

  assert.deepEqual(
    items.map((i) => [i.kind, i.role ?? i.name, i.text ?? i.output ?? i.arguments]),
    [
      ["message", "user", "请完成工作项"],
      ["tool-call", "exec", "ls -la"],
      ["tool-output", undefined, "total 4"],
      ["message", "assistant", "完成了"],
    ]
  );

  // 校验 tool 条目字段。
  assert.equal(items[1].callId, "call_1");
  assert.equal(items[2].callId, "call_1");
});

test("兼容旧版 function_call / function_call_output 命名", () => {
  const text = [
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", call_id: "fc_9", name: "bash", arguments: "pwd" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "fc_9", output: "/home/user" },
    }),
  ].join("\n");

  const items = parseCodexRolloutTimeline(text);
  assert.deepEqual(
    items.map((i) => [i.kind, i.callId, i.name ?? i.output]),
    [
      ["tool-call", "fc_9", "bash"],
      ["tool-output", "fc_9", "/home/user"],
    ]
  );
});

test("arguments 为对象时序列化为 JSON 字符串", () => {
  const text = [
    JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call", call_id: "c", name: "exec", input: { cmd: "ls" } },
    }),
  ].join("\n");

  const items = parseCodexRolloutTimeline(text);
  assert.equal(items[0].kind, "tool-call");
  assert.equal(items[0].arguments, JSON.stringify({ cmd: "ls" }));
});

test("跳过 reasoning（无明文）与 developer 系统提示与注入 user 上下文", () => {
  const text = [
    msgLine("developer", "system"),
    msgLine("user", "<environment_context>...</environment_context>"),
    JSON.stringify({ type: "response_item", payload: { type: "reasoning", encrypted_content: "xxxx", summary: [] } }),
    msgLine("assistant", "ok"),
  ].join("\n");

  const items = parseCodexRolloutTimeline(text);
  assert.deepEqual(items.map((i) => [i.kind, i.role]), [["message", "assistant"]]);
});

test("空输入 / 非法行安全返回空数组", () => {
  assert.deepEqual(parseCodexRolloutTimeline(""), []);
  assert.deepEqual(parseCodexRolloutTimeline(null), []);
  assert.deepEqual(parseCodexRolloutTimeline("not json"), []);
});

test("保留 rollout 条目的真实时间戳", () => {
  const timestamp = "2026-08-16T12:34:56.789Z";
  const items = parseCodexRolloutTimeline(JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
  }));
  assert.equal(items[0].createdAt, timestamp);
});
