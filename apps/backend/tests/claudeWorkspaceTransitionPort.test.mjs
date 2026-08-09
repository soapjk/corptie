import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeWorkspaceTransitionPort } from "../src/agent-provider/adapters/claudeWorkspaceTransitionPort.mjs";

test("Claude workspace transition forks SDK context while retaining the stable Provider session", async () => {
  const calls = [];
  const binding = { providerSessionId: "claude-session" };
  const runtime = { currentTurnId: "claude-turn:7" };
  const manager = {
    async switchWorkspace(id, cwd) {
      calls.push({ id, cwd });
      return { external: { cwd, sandbox: "workspace-write", approvalPolicy: "on-request" } };
    },
    get: () => runtime
  };
  const port = new ClaudeWorkspaceTransitionPort({
    store: { getProviderThreadBinding: () => binding },
    manager,
    instructionSources: async (cwd) => [`${cwd}/AGENTS.md`]
  });

  const result = await port.forkThread("route:source", { cwd: "/repo/feature" });

  assert.deepEqual(calls, [{ id: "claude-session", cwd: "/repo/feature" }]);
  assert.equal(result.providerId, "claude-sdk");
  assert.equal(result.providerSessionId, "claude-session");
  assert.match(result.thread.id, /^claude-route:/);
  assert.deepEqual(result.instructionSources, ["/repo/feature/AGENTS.md"]);
});

test("Claude continuation handoff is hidden from the visible transcript", async () => {
  const sent = [];
  const manager = {
    async send(id, prompt, options) {
      sent.push({ id, prompt, options });
    },
    get: () => ({ currentTurnId: "turn:continuation" })
  };
  const port = new ClaudeWorkspaceTransitionPort({
    store: { getProviderThreadBinding: () => ({ providerSessionId: "claude-session" }) },
    manager
  });

  const result = await port.startTurn("route:next", "Continue.");

  assert.equal(result.turn.id, "turn:continuation");
  assert.deepEqual(sent[0].options, { localVisibility: "status_only" });
});
