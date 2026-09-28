import assert from "node:assert/strict";
import test from "node:test";
import { createCodexConversationClear } from "../src/adapters/codexConversationClear.mjs";

function fixture() {
  const calls = [];
  const runtime = {
    startThread: async () => { calls.push("start"); throw new Error("unavailable"); }
  };
  const operation = createCodexConversationClear({
    store: { deleteSession: () => calls.push("delete") },
    codexRuntime: runtime,
    collaborationCore: { getAgentForSession: () => ({ agentId: "agent" }) },
    ensureCodexSessionPermissions: async (session) => session,
    reserveSessionTitle: () => { calls.push("reserve"); return () => calls.push("release"); },
    collaborationThreadOptionsForSession: async () => ({}),
    codexAppServerSessionCapabilities: () => ({}),
    ensureLogicalRouteForCodexSession: async () => ({}),
    sessionWithLogicalWorkspace: (session) => session,
    upsertManagedCodexSession: () => calls.push("upsert"),
    emitEvent: () => calls.push("event")
  });
  return { calls, operation };
}

test("clear rejects an active run before allocating or reserving anything", async () => {
  const f = fixture();
  await assert.rejects(f.operation.clearCodexAppServerSession("session", { status: "running" }), {
    code: "SESSION_BUSY"
  });
  assert.deepEqual(f.calls, []);
});

test("failed replacement creation releases the title and leaves the old session intact", async () => {
  const f = fixture();
  await assert.rejects(f.operation.clearCodexAppServerSession("session", {
    title: "Title", status: "idle", external: { cwd: "/workspace" }
  }), /unavailable/);
  assert.deepEqual(f.calls, ["reserve", "start", "release"]);
});
