import assert from "node:assert/strict";
import test from "node:test";
import { parseSlashCommand } from "../src/commands/unifiedCommands.mjs";
import { executeCodexSlashCommand } from "../src/adapters/codexSlashCommands.mjs";

test("slash parsing preserves multiline objectives and leaves paths and inline mentions alone", () => {
  assert.deepEqual(parseSlashCommand("/goal 第一行\n第二行"), { name: "goal", arguments: "第一行\n第二行" });
  assert.equal(parseSlashCommand("/tmp/image.png"), null);
  assert.equal(parseSlashCommand("解释 /goal"), null);
});

test("goal uses native control RPCs for set, get, edit, pause, resume and clear", async () => {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    return { goal: { objective: "完成迁移", status: params.status ?? "active", tokensUsed: 0 } };
  };
  for (const args of ["完成迁移", "", "edit 完成测试", "pause", "resume", "clear"]) {
    await executeCodexSlashCommand(request, "thread:test", { name: "goal", arguments: args });
  }
  assert.deepEqual(calls, [
    { method: "thread/goal/set", params: { threadId: "thread:test", objective: "完成迁移", status: "active" } },
    { method: "thread/goal/get", params: { threadId: "thread:test" } },
    { method: "thread/goal/set", params: { threadId: "thread:test", objective: "完成测试", status: "active" } },
    { method: "thread/goal/set", params: { threadId: "thread:test", status: "paused" } },
    { method: "thread/goal/set", params: { threadId: "thread:test", status: "active" } },
    { method: "thread/goal/clear", params: { threadId: "thread:test" } }
  ]);
});

test("unsupported commands and invalid goals never dispatch a turn or control RPC", async () => {
  const request = () => { assert.fail("unexpected RPC"); };
  for (const command of [{ name: "unknown", arguments: "" }, { name: "goal", arguments: "edit" },
    { name: "goal", arguments: "x".repeat(4001) }, { name: "compact", arguments: "unexpected" }]) {
    await assert.rejects(() => executeCodexSlashCommand(request, "thread:test", command));
  }
});

test("native goal failure is propagated without reporting successful activation", async () => {
  await assert.rejects(() => executeCodexSlashCommand(async () => {
    throw new Error("goal feature unavailable");
  }, "thread:test", { name: "goal", arguments: "完成迁移" }), /goal feature unavailable/);
});
