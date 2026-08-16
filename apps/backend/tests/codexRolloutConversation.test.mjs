import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexRolloutConversation } from "../src/adapters/codexAppServer.mjs";

// 构造一条 rollout 行：response_item type=message，content 是 ContentPart 数组。
function msgLine(role, text) {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: "output_text", text }],
    },
  });
}

test("提取 user/assistant 对话消息，跳过 developer 系统提示", () => {
  const text = [
    msgLine("developer", "You are a helpful assistant."),
    msgLine("user", "请完成工作项"),
    msgLine("assistant", "我先检查仓库现状"),
    msgLine("assistant", "已完成 release 一键安装能力"),
    msgLine("user", "hi"),
    msgLine("assistant", "嗨！"),
  ].join("\n");

  const messages = parseCodexRolloutConversation(text);

  assert.equal(messages.length, 5);
  assert.deepEqual(
    messages.map((m) => [m.role, m.text]),
    [
      ["user", "请完成工作项"],
      ["assistant", "我先检查仓库现状"],
      ["assistant", "已完成 release 一键安装能力"],
      ["user", "hi"],
      ["assistant", "嗨！"],
    ]
  );
});

test("跳过 function_call / function_call_output / reasoning 等非 message 条目", () => {
  const text = [
    msgLine("user", "go"),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "bash", arguments: "ls" } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "ok" } }),
    JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: ["think"] } }),
    msgLine("assistant", "done"),
  ].join("\n");

  const messages = parseCodexRolloutConversation(text);

  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((m) => [m.role, m.text]),
    [["user", "go"], ["assistant", "done"]]
  );
});

test("跳过 event_msg 的 agent_message / final_answer（避免与 response_item 正文重复）", () => {
  const text = [
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "duplicate status" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "final_answer", message: "final answer dup" } }),
    msgLine("user", "hello"),
    msgLine("assistant", "world"),
  ].join("\n");

  const messages = parseCodexRolloutConversation(text);

  assert.deepEqual(
    messages.map((m) => [m.role, m.text]),
    [["user", "hello"], ["assistant", "world"]]
  );
});

test("空文本 message 与空 content 被跳过", () => {
  const text = [
    msgLine("user", ""),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } }),
    msgLine("assistant", "ok"),
  ].join("\n");

  const messages = parseCodexRolloutConversation(text);
  assert.deepEqual(messages.map((m) => [m.role, m.text]), [["assistant", "ok"]]);
});

test("contentText 支持多种文本字段（text / output_text / input_text）", () => {
  const text = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "part1" }, { type: "input_text", text: "part2" }],
      },
    }),
  ].join("\n");

  const messages = parseCodexRolloutConversation(text);
  assert.deepEqual(messages.map((m) => [m.role, m.text]), [["assistant", "part1\npart2"]]);
});

test("过滤 codex 注入的系统上下文 user 消息（以 < 开头）", () => {
  const text = [
    msgLine("user", "<recommended_plugins>\nHere is a list of plugins"),
    msgLine("user", "请完成工作项"),
    msgLine("assistant", "我先检查仓库现状"),
    msgLine("user", "<environment_context>\n  <current_date>2026-08-16</current_date>"),
    msgLine("user", "hi"),
    msgLine("assistant", "嗨！"),
  ].join("\n");

  const messages = parseCodexRolloutConversation(text);

  assert.deepEqual(
    messages.map((m) => [m.role, m.text]),
    [
      ["user", "请完成工作项"],
      ["assistant", "我先检查仓库现状"],
      ["user", "hi"],
      ["assistant", "嗨！"],
    ]
  );
});

test("空输入 / 非字符串 / 非法 JSON 行安全返回空数组", () => {
  assert.deepEqual(parseCodexRolloutConversation(""), []);
  assert.deepEqual(parseCodexRolloutConversation(null), []);
  assert.deepEqual(parseCodexRolloutConversation("not json\n{garbage"), []);
});
