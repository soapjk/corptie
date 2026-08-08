import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient, mapCodexThreadToDetail, mapCodexThreadToSession } from "../src/adapters/codexAppServer.mjs";

test("setThreadName uses the Codex app-server thread naming method", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };

  await client.setThreadName("thread-a", "Custom session name");

  assert.deepEqual(calls, [{
    method: "thread/name/set",
    params: { threadId: "thread-a", name: "Custom session name" }
  }]);
});

test("deleteThread permanently removes the Codex thread and clears local runtime state", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };
  client.liveItemsByThread.set("thread-a", new Map());
  client.turnDiffsByThread.set("thread-a", new Map());
  client.tokenUsageByThread.set("thread-a", {});
  client.serverRequestsByThread.set("thread-a", new Map());
  client.dynamicToolAgentsByThread.set("thread-a", "agent-a");

  await client.deleteThread("thread-a");

  assert.deepEqual(calls, [{
    method: "thread/delete",
    params: { threadId: "thread-a" }
  }]);
  assert.equal(client.liveItemsByThread.has("thread-a"), false);
  assert.equal(client.turnDiffsByThread.has("thread-a"), false);
  assert.equal(client.tokenUsageByThread.has("thread-a"), false);
  assert.equal(client.serverRequestsByThread.has("thread-a"), false);
  assert.equal(client.dynamicToolAgentsByThread.has("thread-a"), false);
});

test("runEphemeralPrompt isolates background generation and deletes its temporary thread", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-background" } };
    if (method === "turn/start") {
      client.liveItemsByThread.set("thread-background", new Map([[
        "message-a",
        {
          id: "message-a",
          turnId: "turn-background",
          type: "agentMessage",
          text: "Generate concise commit subject"
        }
      ]]));
      client.notifications.push({
        method: "turn/completed",
        params: {
          threadId: "thread-background",
          turn: { id: "turn-background", status: "completed" }
        }
      });
      return { turn: { id: "turn-background" } };
    }
    return {};
  };

  const result = await client.runEphemeralPrompt({
    cwd: "/repo/feature",
    prompt: "Generate a commit subject",
    model: "gpt-test",
    reasoningEffort: "medium"
  });

  assert.equal(result.text, "Generate concise commit subject");
  assert.deepEqual(calls.map((call) => call.method), ["thread/start", "turn/start", "thread/delete"]);
  assert.equal(calls[0].params.ephemeral, true);
  assert.equal(calls[0].params.approvalPolicy, "never");
  assert.equal(calls[0].params.sandbox, "read-only");
  assert.deepEqual(calls[0].params.runtimeWorkspaceRoots, ["/repo/feature"]);
  assert.equal(calls[1].params.threadId, "thread-background");
  assert.equal(calls[1].params.effort, "medium");
  assert.deepEqual(calls[1].params.sandboxPolicy, { type: "readOnly" });
  assert.equal(client.liveItemsByThread.has("thread-background"), false);
});

test("runEphemeralPrompt deletes its temporary thread when generation fails", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-background" } };
    if (method === "turn/start") throw new Error("generation failed");
    return {};
  };

  await assert.rejects(
    () => client.runEphemeralPrompt({ cwd: "/repo/feature", prompt: "Generate" }),
    /generation failed/
  );
  assert.deepEqual(calls.map((call) => call.method), ["thread/start", "turn/start", "thread/delete"]);
});

test("runEphemeralPrompt confines workspace-write background work to declared roots", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-writer" } };
    if (method === "turn/start") {
      client.notifications.push({
        method: "turn/completed",
        params: { threadId: "thread-writer", turn: { id: "turn-writer", status: "completed" } }
      });
      return { turn: { id: "turn-writer" } };
    }
    return {};
  };

  await client.runEphemeralPrompt({
    cwd: "/repo/.corptie",
    runtimeWorkspaceRoots: ["/repo/.corptie"],
    permissionProfile: "workspace-write",
    developerInstructions: "Only edit the toolset.",
    threadSource: "project-toolset-initialization",
    prompt: "Configure"
  });

  assert.equal(calls[0].params.sandbox, "workspace-write");
  assert.equal(calls[0].params.developerInstructions, "Only edit the toolset.");
  assert.equal(calls[0].params.threadSource, "project-toolset-initialization");
  assert.deepEqual(calls[1].params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["/repo/.corptie"],
    networkAccess: false
  });
});

test("startThread installs host-owned collaboration tools and keeps the isolated MCP compatibility path", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    return { thread: { id: "thread-a" } };
  };

  await client.startThread({
    cwd: "/tmp/workspace",
    config: {
      features: { multi_agent: false },
      mcp_servers: { collaboration: { command: "node" } }
    },
    dynamicTools: [{
      type: "function",
      name: "corptie_agents_discover",
      description: "Discover Agents",
      inputSchema: { type: "object" }
    }],
    dynamicToolAgentId: "agent-a",
    developerInstructions: "Stable Agent identity: agent-a"
  });

  assert.equal(calls[0].method, "thread/start");
  assert.equal(calls[0].params.config.features.multi_agent, false);
  assert.equal(calls[0].params.config.mcp_servers.collaboration.command, "node");
  assert.equal(calls[0].params.dynamicTools[0].name, "corptie_agents_discover");
  assert.equal(calls[0].params.developerInstructions, "Stable Agent identity: agent-a");
  assert.equal(calls[0].timeoutMs, 30000);
  assert.equal(client.dynamicToolAgentsByThread.get("thread-a"), "agent-a");
});

test("resumeThread restores collaboration MCP config and Agent identity", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    return { thread: { id: params.threadId } };
  };

  await client.resumeThread("thread-a", {
    config: {
      features: { multi_agent: false },
      mcp_servers: { collaboration: { command: "node" } }
    },
    dynamicToolAgentId: "agent-a",
    developerInstructions: "Stable Agent identity: agent-a"
  });

  assert.deepEqual(calls, [{
    method: "thread/resume",
    params: {
      threadId: "thread-a",
      cwd: undefined,
      runtimeWorkspaceRoots: undefined,
      approvalPolicy: undefined,
      approvalsReviewer: undefined,
      sandbox: undefined,
      permissions: undefined,
      model: undefined,
      modelProvider: undefined,
      config: {
        features: { multi_agent: false },
        mcp_servers: { collaboration: { command: "node" } }
      },
      developerInstructions: "Stable Agent identity: agent-a",
      excludeTurns: undefined,
      initialTurnsPage: undefined
    },
    timeoutMs: 30000
  }]);
  assert.equal(client.dynamicToolAgentsByThread.get("thread-a"), "agent-a");
});

test("forkThread fixes the forked thread to the target workspace and completed source turn", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    return {
      thread: { id: "thread-feature" },
      cwd: "/repo/feature worktree",
      runtimeWorkspaceRoots: ["/repo/feature worktree"],
      instructionSources: ["/repo/feature worktree/AGENTS.md"]
    };
  };

  const result = await client.forkThread("thread-source", {
    lastTurnId: "turn-complete",
    cwd: "/repo/feature worktree",
    runtimeWorkspaceRoots: ["/repo/feature worktree"],
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    dynamicToolAgentId: "agent-a"
  });

  assert.equal(calls[0].method, "thread/fork");
  assert.equal(calls[0].params.threadId, "thread-source");
  assert.equal(calls[0].params.lastTurnId, "turn-complete");
  assert.equal(calls[0].params.cwd, "/repo/feature worktree");
  assert.deepEqual(calls[0].params.runtimeWorkspaceRoots, ["/repo/feature worktree"]);
  assert.equal(calls[0].params.sandbox, "workspace-write");
  assert.equal(calls[0].params.deferGoalContinuation, true);
  assert.equal(calls[0].timeoutMs, 30000);
  assert.deepEqual(result.instructionSources, ["/repo/feature worktree/AGENTS.md"]);
  assert.equal(client.dynamicToolAgentsByThread.get("thread-feature"), "agent-a");
});

test("updateThreadSettings updates cwd and sandbox policy together for recovery", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    return {};
  };

  await client.updateThreadSettings("thread-a", {
    cwd: "/repo/moved worktree",
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/repo/moved worktree"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  });

  assert.equal(calls[0].method, "thread/settings/update");
  assert.equal(calls[0].params.threadId, "thread-a");
  assert.equal(calls[0].params.cwd, "/repo/moved worktree");
  assert.deepEqual(calls[0].params.sandboxPolicy.writableRoots, ["/repo/moved worktree"]);
  assert.equal(calls[0].params.approvalPolicy, "never");
  assert.equal(calls[0].timeoutMs, 8000);
});

test("dynamic tool calls are executed by the host with the thread's bound Agent identity", async () => {
  const responses = [];
  const client = new CodexAppServerClient({
    onDynamicToolCall: async (params) => ({
      agentId: params.agentId,
      tool: params.tool,
      input: params.arguments
    })
  });
  client.dynamicToolAgentsByThread.set("thread-a", "agent-a");
  client.respondToServerRequest = async (id, result) => {
    responses.push({ id, result });
  };

  await client.handleDynamicToolCall({
    id: 42,
    method: "item/tool/call",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      callId: "call-a",
      tool: "corptie_agents_discover",
      arguments: { status: "available" }
    }
  });

  assert.equal(responses[0].id, 42);
  assert.equal(responses[0].result.success, true);
  assert.deepEqual(JSON.parse(responses[0].result.contentItems[0].text), {
    agentId: "agent-a",
    tool: "corptie_agents_discover",
    input: { status: "available" }
  });
});

test("startTurn forwards application context for rules that must apply to an existing thread", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { turn: { id: "turn-a" } };
  };

  await client.startTurn("thread-a", "Send a peer request", {
    additionalContext: {
      "corptie-agent-runtime": {
        kind: "application",
        value: "Every new user instruction creates a new task."
      }
    }
  });

  assert.equal(calls[0].method, "turn/start");
  assert.deepEqual(calls[0].params.additionalContext, {
    "corptie-agent-runtime": {
      kind: "application",
      value: "Every new user instruction creates a new task."
    }
  });
});

test("startTurn forwards restored sandbox and approval settings", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { turn: { id: "turn-a" } };
  };

  await client.startTurn("thread-a", "Modify local files", {
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" }
  });

  assert.equal(calls[0].params.approvalPolicy, "never");
  assert.deepEqual(calls[0].params.sandboxPolicy, { type: "dangerFullAccess" });
});

test("thread mapping retains permission fields returned by Codex", () => {
  const session = mapCodexThreadToSession({
    id: "thread-a",
    status: "idle",
    sandboxPolicy: { type: "dangerFullAccess" },
    approvalPolicy: "never"
  });

  assert.equal(session.external.sandbox, "danger-full-access");
  assert.equal(session.external.approvalPolicy, "never");
});

test("a not-loaded thread preserves an interrupted latest turn", () => {
  const thread = {
    id: "thread-a",
    status: { type: "notLoaded" },
    turns: [{ id: "turn-a", status: "interrupted", items: [] }]
  };

  assert.equal(mapCodexThreadToSession(thread).status, "cancelled");
  assert.equal(mapCodexThreadToDetail(thread).status, "cancelled");
});

test("a not-loaded thread remains complete when its latest turn completed", () => {
  const session = mapCodexThreadToSession({
    id: "thread-a",
    status: { type: "notLoaded" },
    turns: [{ id: "turn-a", status: "completed", items: [] }]
  });

  assert.equal(session.status, "complete");
});

test("a completed item does not prematurely complete its active turn", () => {
  const client = new CodexAppServerClient();
  client.captureLiveItem({
    method: "item/completed",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      item: {
        id: "message-a",
        type: "agentMessage",
        text: "Final response",
        phase: "final_answer"
      }
    }
  });

  assert.deepEqual(client.liveItemsForThread("thread-a"), [{
    id: "message-a",
    turnId: "turn-a",
    turnStatus: "inProgress",
    type: "agentMessage",
    title: "Codex",
    text: "Final response",
    status: "completed",
    presentationRole: "final_answer",
    createdAt: null
  }]);
});

test("thread detail preserves the Codex message phase for presentation", () => {
  const detail = mapCodexThreadToDetail({
    id: "thread-a",
    status: { type: "active" },
    turns: [{
      id: "turn-a",
      status: "inProgress",
      items: [{
        id: "message-a",
        type: "agentMessage",
        text: "Final response",
        phase: "final_answer"
      }]
    }]
  });

  assert.equal(detail.items[0].turnStatus, "inProgress");
  assert.equal(detail.items[0].presentationRole, "final_answer");
});
