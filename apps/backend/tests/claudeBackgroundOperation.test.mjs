import test from "node:test";
import assert from "node:assert/strict";
import { runClaudeBackgroundPrompt } from "../src/adapters/claudeBackgroundOperation.mjs";

test("no-tools background requests carry SDK isolation and close after a result", async () => {
  let captured;
  let closed = 0;
  const result = await runClaudeBackgroundPrompt({
    executionPolicy: "no-tools", prompt: "input", cwd: "/workspace"
  }, {
    environment: () => ({}),
    queryFactory: (request) => {
      captured = request;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "assistant", message: { content: [{ type: "text", text: "draft" }] } };
          yield { type: "result", subtype: "success", result: "final" };
        },
        close() { closed += 1; }
      };
    }
  });
  assert.deepEqual(result, { text: "final" });
  assert.equal(closed, 1);
  assert.equal(captured.options.persistSession, false);
  assert.deepEqual(captured.options.tools, []);
  assert.deepEqual(captured.options.mcpServers, {});
  assert.equal(captured.options.strictMcpConfig, true);
  assert.equal((await captured.options.canUseTool()).behavior, "deny");
});

test("failed iteration closes the operation and redacts configured credentials", async () => {
  let closed = false;
  await assert.rejects(runClaudeBackgroundPrompt({}, {
    environment: () => ({ ANTHROPIC_API_KEY: "synthetic-private-key" }),
    queryFactory: () => ({
      async *[Symbol.asyncIterator]() { throw new Error("failure synthetic-private-key"); },
      close() { closed = true; }
    })
  }), (error) => {
    assert.equal(error.message.includes("synthetic-private-key"), false);
    return true;
  });
  assert.equal(closed, true);
});

test("unsupported permissions and an already-aborted request never launch a Query", async () => {
  const ports = {
    environment: () => ({}),
    queryFactory: () => { assert.fail("must not launch"); }
  };
  await assert.rejects(runClaudeBackgroundPrompt({
    executionPolicy: "no-tools", permissionProfile: "workspace-write"
  }, ports), { code: "CAPABILITY_UNSUPPORTED" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runClaudeBackgroundPrompt({ signal: controller.signal }, ports));
});
