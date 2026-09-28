import test from "node:test";
import assert from "node:assert/strict";
import { createCodexSessionCreator } from "../src/adapters/codexSessionCreator.mjs";

test("creation requires an existing Agent before starting a native thread", async () => {
  const creator = createCodexSessionCreator({
    collaborationCore: { getAgent: () => null },
    codexRuntime: { startThread: () => assert.fail("must not create") }
  });
  await assert.rejects(creator.create({}), { code: "AGENT_REQUIRED" });
  await assert.rejects(creator.create({ toolHost: { actorId: "missing" } }), { code: "AGENT_NOT_FOUND" });
});

test("a fork with the wrong workspace is archived before reporting failure", async () => {
  const calls = [];
  const creator = createCodexSessionCreator({
    collaborationCore: { getAgent: () => ({ agentId: "agent" }) },
    codexRuntime: {
      forkThread: async (id, options) => {
        calls.push(["fork", id, options.lastTurnId]);
        return { thread: { id: "fork", cwd: "/wrong" } };
      },
      archiveThread: async id => calls.push(["archive", id]),
      clearThreadGoal: () => assert.fail("workspace must be validated first")
    },
    resolvedNewCodexRuntimeConfig: async () => ({}),
    collaborationThreadOptionsWithAgentContext: async () => ({}),
    withPersistedCodexToolConfirmation: (_reference, options) => options
  });
  await assert.rejects(creator.create(
    { cwd: "/target", toolHost: { actorId: "agent" } },
    { reference: { providerSessionId: "source" }, point: { turnId: "cutoff" } }
  ), { code: "FORK_CWD_MISMATCH" });
  assert.deepEqual(calls, [["fork", "source", "cutoff"], ["archive", "fork"]]);
});
