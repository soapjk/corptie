import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { createCodexReplyProbe, createClaudeReplyProbe, createOpenClackyReplyProbe, runProbeProcess } from "../src/agent-provider/providers/providerReplyProbe.mjs";

const cases = [
  ["Codex", createCodexReplyProbe, [{ type: "item.completed", item: { type: "agent_message", text: "CORPTIE_OK" } }, { type: "turn.completed" }]],
  ["Claude", createClaudeReplyProbe, [{ type: "result", subtype: "success", result: "CORPTIE_OK" }]],
  ["OpenClacky", createOpenClackyReplyProbe, [{ type: "assistant_message", content: "CORPTIE_OK" }, { type: "complete" }]]
];
for (const [name, create, events] of cases) {
  test(`${name}: protocol reply proves availability and temporary directory is cleaned up`, async () => {
    let cwd;
    const probe = create({ execute: async (path, args, options) => {
      assert.equal(path, "/custom path/binary");
      assert.ok(args.some(arg => arg.includes("CORPTIE_OK")));
      cwd = options.cwd;
      assert.ok(!cwd.includes("worktree"));
      await access(cwd);
      return events.map(e => JSON.stringify(e)).join("\n");
    } });
    assert.deepEqual(await probe("/custom path/binary"), { ok: true });
    await assert.rejects(access(cwd));
  });
  test(`${name}: exit success/help/user echo/empty output does not pass`, async () => {
    for (const output of ["", "version 1.2.3", "CORPTIE_OK", '{"type":"user","content":"CORPTIE_OK"}']) {
      await assert.rejects(create({ execute: async () => output })("/bin/provider"));
    }
  });
  test(`${name}: timeout and process failure do not leak raw diagnostics`, async () => {
    const failure = Object.assign(new Error("secret-api-key"), { code: "PROBE_PROCESS_FAILED" });
    await assert.rejects(create({ execute: async () => { throw failure; } })("/bin/provider"), e => !e.message.includes("secret"));
    failure.code = "PROBE_TIMEOUT";
    await assert.rejects(create({ execute: async () => { throw failure; } })("/bin/provider"), /超时/);
  });
}

test("error completion cannot masquerade as an assistant reply", async () => {
  await assert.rejects(createCodexReplyProbe({ execute: async () => '{"type":"turn.failed"}\n{"type":"item.completed","item":{"type":"agent_message","text":"CORPTIE_OK"}}' })("/bin/provider"));
  await assert.rejects(createClaudeReplyProbe({ execute: async () => '{"type":"result","subtype":"success","is_error":true,"result":"CORPTIE_OK"}' })("/bin/provider"));
});

test("subprocess timeout and cancellation terminate the probe", async () => {
  const options = { cwd: "/tmp", env: process.env, timeoutMs: 50 };
  await assert.rejects(runProbeProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], options), { code: "PROBE_TIMEOUT" });
  const controller = new AbortController();
  const pending = runProbeProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { ...options, timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "PROBE_CANCELLED" });
});
