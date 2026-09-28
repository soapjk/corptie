import assert from "node:assert/strict";
import test from "node:test";
import { createEntitySessionLaunchers } from "../src/application/entitySessionLaunchers.mjs";

function fixture() {
  const calls = [];
  const launchers = createEntitySessionLaunchers({
    store: {
      resolveWorkspaceRoot: () => "/workspace",
      bindSessionToWork: (id, workId) => { calls.push(["bindWork", id, workId]); return { id, workId }; }
    },
    workService: { getTask: () => ({ title: "Task", acceptance_criteria: "" }) },
    collaborationCore: { bindSession: (value) => calls.push(["bind", value]) },
    workChatContextService: { build: () => ({ prompt: "Work context" }) },
    workDiscussionService: {},
    agentProviderRegistry: { supports: () => false },
    environmentName: "development",
    resolveSessionProviderId: (id) => id === "known" ? "test-provider" : null,
    createSessionThroughApplication: async (...args) => { calls.push(["create", ...args]); return { id: "created" }; }
  });
  return { calls, launchers };
}

test("worker creation requires both a supported provider and a prepared execution space", async () => {
  const f = fixture();
  await assert.rejects(f.launchers.createProviderWorkSession({ providerId: "unknown" }), { code: "PROVIDER_UNSUPPORTED" });
  await assert.rejects(f.launchers.createProviderWorkSession({ providerId: "known" }), { code: "START_EXECUTION_SPACE_BINDING_REQUIRED" });
  assert.deepEqual(f.calls, []);
});

test("worker launch preserves deferred prompt and tool-finalization options", async () => {
  const f = fixture();
  await f.launchers.createProviderWorkSession({
    providerId: "known", taskId: "task", assigneeAgentId: "agent",
    workingDirectory: "/workspace", prompt: "Start", deferInitialPromptUntilBound: true,
    deferToolHostFinalization: true
  });
  assert.equal(f.calls[0][1], "test-provider");
  assert.equal(f.calls[0][2].prompt, "");
  assert.equal(f.calls[0][2].sessionKind, "worker");
  assert.equal(f.calls[0][3].taskId, "task");
  assert.equal(f.calls[0][3].deferToolHostFinalization, true);
});

test("work chat rejects outside contributors and includes context for providers without tool attachment", async () => {
  const f = fixture();
  const input = { agent: { agentId: "agent", name: "Agent" }, work: {
    id: "work", name: "Work", workspaceId: "workspace", contributorAgentIds: []
  }, providerId: "known", prompt: "Hello" };
  await assert.rejects(f.launchers.launchWorkChatSession(input), { code: "AGENT_OUTSIDE_WORK" });
  input.work.contributorAgentIds.push("agent");
  await f.launchers.launchWorkChatSession(input);
  assert.match(f.calls[0][2].prompt, /Work context/);
  assert.deepEqual(f.calls.map(([name]) => name), ["create", "bind", "bindWork"]);
});
