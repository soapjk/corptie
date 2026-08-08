import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeAgentManager,
  claudeTranscriptItems
} from "../src/adapters/claudeAgentManager.mjs";

test("Claude transcript keeps SDK tool results inside the originating user turn", () => {
  const session = { id: "claude-a" };
  const items = claudeTranscriptItems(session, [
    sdkUser([{ type: "text", text: "Research this" }]),
    sdkAssistant([
      { type: "text", text: "I will inspect the project." },
      { type: "tool_use", name: "Bash", input: { command: "git status" } }
    ]),
    sdkUser([{ type: "tool_result", tool_use_id: "tool-a", content: "clean" }]),
    sdkAssistant([
      { type: "text", text: "The tree is clean; I will check the docs." },
      { type: "tool_use", name: "Read", input: { file_path: "/repo/README.md" } }
    ]),
    sdkUser([{ type: "tool_result", tool_use_id: "tool-b", content: "docs" }]),
    sdkAssistant([{ type: "text", text: "The project is ready." }])
  ]);

  assert.equal(new Set(items.map((item) => item.turnId)).size, 1);
  assert.deepEqual(items.map((item) => item.type), [
    "userMessage",
    "agentMessage",
    "commandExecution",
    "agentMessage",
    "mcpToolCall",
    "agentMessage"
  ]);
  assert.deepEqual(
    items.filter((item) => item.type === "agentMessage").map((item) => item.presentationRole),
    ["commentary", "commentary", "final_answer"]
  );
  assert.ok(items.every((item) => item.turnStatus === "complete"));
});

test("Claude live messages become process items until the result marks a final answer", () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-live", title: "Claude live", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-live");
  session.currentTurnId = "claude-live:turn:1";
  session.status = "running";
  session.turnState = "running";

  manager.handleSdkMessage(session, sdkAssistant([
    { type: "text", text: "Checking files." },
    { type: "tool_use", name: "Read", input: { file_path: "/tmp/a.txt" } }
  ]));
  manager.handleSdkMessage(session, sdkAssistant([{ type: "text", text: "Done." }]));

  letAgentRoles(manager, ["commentary", "commentary"]);
  manager.handleSdkMessage(session, { type: "result", subtype: "success", result: "Done." });
  letAgentRoles(manager, ["commentary", "final_answer"]);
  assert.ok(manager.detail("claude-live").items.every((item) => item.turnStatus === "complete"));
});

test("Claude clear forgets the SDK context while preserving the Corptie session", async () => {
  const manager = new ClaudeAgentManager();
  const original = manager.start({
    id: "claude-clear",
    title: "Keep this title",
    cwd: "/tmp/project",
    model: "claude-sonnet",
    agentSessionId: "sdk-session-old",
    items: [{ id: "old", type: "agentMessage", text: "Old context" }]
  });
  const session = manager.get("claude-clear");
  let closed = false;
  session.query = { close: async () => { closed = true; } };
  session.queryTask = Promise.resolve();

  const cleared = await manager.clear("claude-clear");

  assert.equal(closed, true);
  assert.equal(cleared.id, original.id);
  assert.equal(cleared.title, "Keep this title");
  assert.equal(cleared.external.cwd, "/tmp/project");
  assert.equal(cleared.external.currentModel, "claude-sonnet");
  assert.equal(cleared.external.agentSessionId, null);
  assert.deepEqual(manager.detail("claude-clear").items, []);
  assert.equal(session.nextItemSeq, 1);
  assert.equal(session.nextTurnSeq, 1);
  assert.equal(session.queryClosed, false);
});

test("Claude permissions can change after session creation and reconfigure the next Query", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({
    id: "claude-permissions",
    cwd: "/tmp/project",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    agentSessionId: "sdk-session-existing"
  });
  const session = manager.get("claude-permissions");
  let closed = false;
  session.query = { close: async () => { closed = true; } };
  session.queryTask = Promise.resolve();

  const updated = await manager.updatePermissions("claude-permissions", {
    sandbox: "danger-full-access",
    approvalPolicy: "never"
  });

  assert.equal(closed, true);
  assert.equal(session.query, null);
  assert.equal(session.agentSessionId, "sdk-session-existing");
  assert.equal(session.permissionMode, "bypassPermissions");
  assert.equal(updated.external.sandbox, "danger-full-access");
  assert.equal(updated.external.approvalPolicy, "never");
});

test("Claude operations restore a persisted session before changing permissions", async () => {
  const manager = new ClaudeAgentManager();
  let restored = false;
  manager.reconnect = async (id) => {
    restored = true;
    return manager.start({ id, cwd: "/tmp/restored", prompt: "" });
  };

  const updated = await manager.updatePermissions("claude-restored", {
    sandbox: "read-only",
    approvalPolicy: "on-request"
  });

  assert.equal(restored, true);
  assert.equal(updated.external.cwd, "/tmp/restored");
  assert.equal(updated.external.sandbox, "read-only");
});

test("Claude permissions can switch while a turn is waiting for approval", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-blocked", cwd: "/tmp/project" });
  const session = manager.get("claude-blocked");
  let switchedMode = null;
  let pendingResolution = null;
  session.query = {
    setPermissionMode: async (mode) => { switchedMode = mode; }
  };
  session.turnState = "requires_action";
  session.status = "running";
  session.pendingChoice = { id: "choice-a" };
  session.pendingDecision = {
    choice: session.pendingChoice,
    resolve: (resolution) => { pendingResolution = resolution; }
  };
  session.pendingChoices.set("choice-a", session.pendingDecision);
  session.items.push({ id: "choice-a", type: "choice", status: "pending" });

  const updated = await manager.updatePermissions("claude-blocked", {
    sandbox: "danger-full-access",
    approvalPolicy: "never"
  });

  assert.equal(switchedMode, "bypassPermissions");
  assert.deepEqual(pendingResolution, { behavior: "allow" });
  assert.equal(session.pendingChoices.size, 0);
  assert.equal(session.items[0].status, "allowed");
  assert.equal(session.turnState, "running");
  assert.equal(updated.external.permissionMode, "bypassPermissions");
});

function letAgentRoles(manager, expected) {
  const roles = manager.detail("claude-live").items
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.presentationRole);
  assert.deepEqual(roles, expected);
}

function sdkUser(content) {
  return { type: "user", message: { role: "user", content } };
}

function sdkAssistant(content) {
  return { type: "assistant", message: { role: "assistant", content } };
}
