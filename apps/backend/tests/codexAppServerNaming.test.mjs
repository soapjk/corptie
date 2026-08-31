import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CodexAppServerClient,
  codexPreDispatchRecoveryError,
  codexResponseError,
  mapCodexThreadToSession
} from "../src/adapters/codexAppServer.mjs";
import { schemaHash } from "../src/application/hostToolCatalog.mjs";

function persistedToolProof(threadId, definitions, kind = "thread_start_accepted") {
  return {
    providerRevision: kind === "thread_start_accepted"
      ? `thread-start:${threadId}:confirmed`
      : `thread-fork-inherited:${threadId}:thread-source:confirmed`,
    providerDefinitionsHash: schemaHash(definitions),
    providerDefinitionsCount: definitions.length,
    providerObservationKind: kind
  };
}

function fakeCodexProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.requests = [];
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) {
        const request = JSON.parse(line);
        child.requests.push(request);
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`));
      }
      newline = buffer.indexOf("\n");
    }
  });
  return child;
}

test("concurrent Codex initialization shares one app-server process generation", async () => {
  const children = [];
  const client = new CodexAppServerClient({
    spawnProcess: () => {
      const child = fakeCodexProcess();
      children.push(child);
      return child;
    }
  });

  await Promise.all(Array.from({ length: 20 }, () => client.initialize()));

  assert.equal(children.length, 1);
  assert.equal(children[0].requests.filter((request) => request.method === "initialize").length, 1);
  assert.equal(client.process, children[0]);
  assert.equal(client.initialized, true);
  await client.close();
});

test("a stale Codex process exit cannot tear down a newer initialized generation", async () => {
  const children = [];
  const client = new CodexAppServerClient({
    spawnProcess: () => {
      const child = fakeCodexProcess();
      children.push(child);
      return child;
    }
  });

  await client.initialize();
  const first = children[0];
  await client.close();
  await client.initialize();
  const second = children[1];
  first.emit("exit", 0, null);

  assert.equal(children.length, 2);
  assert.equal(client.process, second);
  assert.equal(client.initialized, true);
  assert.equal(second.killed, false);
  await client.close();
});

test("missing Codex rollout is normalized as a safely replaceable Provider Session", () => {
  const error = codexResponseError({
    code: -32600,
    message: "no rollout found for thread id thread-a"
  });
  assert.equal(error.code, "PROVIDER_SESSION_UNAVAILABLE");
  assert.equal(error.safeToRetry, true);

  const missingThread = codexResponseError({
    code: -32600,
    message: "thread not found: thread-a"
  });
  assert.equal(missingThread.code, "PROVIDER_SESSION_UNAVAILABLE");
  assert.equal(missingThread.safeToRetry, true);

  const relocatedRollout = codexResponseError({
    code: -32600,
    message: "failed to resolve rollout path `/old/runtime/sessions/rollout-thread-a.jsonl`: file does not exist"
  });
  assert.equal(relocatedRollout.code, "PROVIDER_SESSION_UNAVAILABLE");
  assert.equal(relocatedRollout.safeToRetry, true);

  const unreadableRollout = codexResponseError({
    code: -32600,
    message: "failed to resolve rollout path `/old/runtime/sessions/rollout-thread-a.jsonl`: permission denied"
  });
  assert.equal(unreadableRollout.code, undefined);
  assert.equal(unreadableRollout.safeToRetry, undefined);

  const ambiguous = codexResponseError({ code: -32603, message: "transport closed" });
  assert.equal(ambiguous.code, undefined);
  assert.equal(ambiguous.safeToRetry, undefined);

  const emptyAfterRestart = codexResponseError({
    code: -32600,
    message: "thread not loaded: thread-empty"
  });
  assert.equal(emptyAfterRestart.code, "PROVIDER_EMPTY_THREAD_UNRECOVERABLE");
  assert.equal(emptyAfterRestart.safeToRecreate, true);
});

test("a missing rollout is retryable only when marked at the pre-dispatch resume boundary", () => {
  const missing = codexPreDispatchRecoveryError(codexResponseError({
    code: -32600,
    message: "failed to resolve rollout path `/development/rollout-thread-a.jsonl`: file does not exist"
  }));
  assert.equal(missing.dispatchState, "not_sent");
  assert.equal(missing.recoveryAction, "replace_provider_binding");
  assert.equal(missing.replacementReason, "PROVIDER_SESSION_UNAVAILABLE");

  const ambiguous = new Error("transport closed after turn/start");
  ambiguous.code = "PROVIDER_SESSION_UNAVAILABLE";
  assert.equal(codexPreDispatchRecoveryError(ambiguous).dispatchState, undefined);

  const unconfirmed = new Error("tool schema is not installed");
  unconfirmed.code = "PROVIDER_TOOL_APPLICATION_UNCONFIRMED";
  const recoverableToolSchema = codexPreDispatchRecoveryError(unconfirmed);
  assert.equal(recoverableToolSchema.dispatchState, "not_sent");
  assert.equal(recoverableToolSchema.recoveryAction, "replace_provider_binding");
  assert.equal(recoverableToolSchema.replacementReason, "PROVIDER_TOOL_APPLICATION_UNCONFIRMED");
});

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

test("bindThreadToolContext finalizes a fresh thread without an invalid resume", () => {
  const client = new CodexAppServerClient();
  const dynamicTools = [{ name: "corptie_automations_list" }];
  client.restoreThreadToolPlanConfirmation(
    "thread-fresh",
    dynamicTools,
    persistedToolProof("thread-fresh", dynamicTools)
  );
  const result = client.bindThreadToolContext("thread-fresh", {
    dynamicToolAgentId: "agent-a",
    dynamicToolMetadata: {
      sessionId: "session:a",
      logicalSessionId: "logical:a"
    },
    dynamicTools
  });

  assert.equal(result.toolContextBound, true);
  assert.equal(client.dynamicToolAgentsByThread.get("thread-fresh"), "agent-a");
  assert.deepEqual(client.dynamicToolMetadataByThread.get("thread-fresh"), {
    sessionId: "session:a",
    logicalSessionId: "logical:a"
  });
});

test("route recovery inspects an empty Codex target without thread/resume or a model Turn", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: params.threadId, turns: [] } };
  };
  const dynamicTools = [{ name: "corptie_tool_call" }];
  const proof = persistedToolProof("thread-empty", dynamicTools);

  const result = await client.inspectEmptyThreadForRouteCommit("thread-empty", {
    cwd: "/repo",
    dynamicTools,
    dynamicToolConfirmation: proof,
    dynamicToolAgentId: "agent-a"
  });

  assert.equal(result.thread.id, "thread-empty");
  assert.deepEqual(calls, [{
    method: "thread/read",
    params: { threadId: "thread-empty", includeTurns: true }
  }]);
  assert.equal(client.dynamicToolAgentsByThread.get("thread-empty"), "agent-a");
  assert.equal(client.confirmThreadToolPlan("thread-empty", dynamicTools).providerRevision,
    proof.providerRevision);
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

  const dynamicTools = [{ name: "corptie_tool_gateway", inputSchema: { type: "object" } }];
  client.restoreThreadToolPlanConfirmation(
    "thread-source",
    dynamicTools,
    persistedToolProof("thread-source", dynamicTools)
  );
  const result = await client.forkThread("thread-source", {
    lastTurnId: "turn-complete",
    cwd: "/repo/feature worktree",
    runtimeWorkspaceRoots: ["/repo/feature worktree"],
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    dynamicToolAgentId: "agent-a",
    dynamicTools
  });

  assert.equal(calls[0].method, "thread/fork");
  assert.equal(calls[0].params.threadId, "thread-source");
  assert.equal(calls[0].params.lastTurnId, "turn-complete");
  assert.equal(calls[0].params.cwd, "/repo/feature worktree");
  assert.deepEqual(calls[0].params.runtimeWorkspaceRoots, ["/repo/feature worktree"]);
  assert.equal(calls[0].params.sandbox, "workspace-write");
  assert.equal(calls[0].params.deferGoalContinuation, true);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].params, "dynamicTools"), false);
  assert.equal(calls[0].timeoutMs, 30000);
  assert.deepEqual(result.instructionSources, ["/repo/feature worktree/AGENTS.md"]);
  assert.equal(client.dynamicToolAgentsByThread.get("thread-feature"), "agent-a");
  assert.match(
    client.confirmThreadToolPlan("thread-feature", dynamicTools).providerRevision,
    /^thread-fork-inherited:thread-feature:thread-source:/
  );
});

test("forkThread fails before Provider mutation when the requested Tool schema differs from the source", async () => {
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  let requests = 0;
  client.request = async () => { requests += 1; };
  const sourceTools = [{ name: "legacy_tool" }];
  client.restoreThreadToolPlanConfirmation(
    "thread-source",
    sourceTools,
    persistedToolProof("thread-source", sourceTools)
  );

  await assert.rejects(() => client.forkThread("thread-source", {
    dynamicTools: [{ name: "corptie_tool_call" }]
  }), { code: "PROVIDER_TOOL_SCHEMA_FORK_UNSUPPORTED" });
  assert.equal(requests, 0);
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

test("a fresh empty thread starts its first turn without an invalid resume", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-a" } };
    return { thread: { id: params.threadId } };
  };
  const initial = {
    cwd: "/repo",
    runtimeWorkspaceRoots: ["/repo"],
    dynamicToolAgentId: "agent-a",
    dynamicTools: [{ name: "tool-a" }]
  };

  await client.startThread(initial);
  const cached = await client.ensureThreadResumed("thread-a", initial);
  assert.equal(cached.alreadyLoaded, true);
  assert.deepEqual(calls.map((call) => call.method), ["thread/start"]);

  await assert.rejects(() => client.ensureThreadResumed("thread-a", {
    ...initial,
    dynamicTools: [{ name: "tool-b" }]
  }), { code: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED" });
  assert.deepEqual(calls.map((call) => call.method), ["thread/start"]);

  await client.startTurn("thread-a", "first instruction");
  await client.ensureThreadResumed("thread-a", {
    ...initial,
    developerInstructions: "updated context"
  });
  assert.equal(client.freshThreadIds.has("thread-a"), false);
  assert.deepEqual(calls.map((call) => call.method), [
    "thread/start",
    "turn/start",
    "thread/resume"
  ]);
});

test("a restored thread reloads when runtime context changes", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: params.threadId } };
  };
  const dynamicTools = [{ name: "tool-b" }];
  const dynamicToolConfirmation = persistedToolProof("thread-a", dynamicTools);
  client.threadResumeFingerprints.set("thread-a", JSON.stringify({
    cwd: "/repo",
    runtimeWorkspaceRoots: ["/repo"],
    config: null,
    developerInstructions: null,
    dynamicTools,
    dynamicToolConfirmation,
    dynamicToolAgentId: "agent-a",
    dynamicToolMetadata: null
  }));

  await client.ensureThreadResumed("thread-a", {
    cwd: "/repo",
    runtimeWorkspaceRoots: ["/repo"],
    dynamicToolAgentId: "agent-a",
    dynamicTools,
    dynamicToolConfirmation,
    developerInstructions: "updated context"
  });
  assert.deepEqual(calls.map((call) => call.method), ["thread/resume"]);
});

test("ensureThreadResumed coalesces selection prewarm with foreground send", async () => {
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let resumes = 0;
  client.request = async (method, params) => {
    assert.equal(method, "thread/resume");
    resumes += 1;
    await gate;
    return { thread: { id: params.threadId } };
  };
  const options = { cwd: "/repo", runtimeWorkspaceRoots: ["/repo"] };

  const prewarm = client.ensureThreadResumed("thread-a", options);
  const send = client.ensureThreadResumed("thread-a", options);
  release();
  const [, foreground] = await Promise.all([prewarm, send]);

  assert.equal(resumes, 1);
  assert.equal(foreground.alreadyLoaded, true);
  assert.equal(foreground.coalesced, true);
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

  const liveItems = client.liveItemsForThread("thread-a");
  assert.equal(JSON.parse(liveItems[0].rawMetadataJSON).provider, "codex-app-server");
  assert.deepEqual(liveItems.map(({ rawMetadataJSON: _, ...item }) => item), [{
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

test("turn completion settles every live item in that turn without touching another turn", () => {
  const client = new CodexAppServerClient();
  for (const [turnId, id, phase] of [
    ["turn-a", "commentary-a", "commentary"],
    ["turn-a", "answer-a", "final_answer"],
    ["turn-b", "commentary-b", "commentary"]
  ]) {
    client.captureLiveItem({
      method: "item/completed",
      params: {
        threadId: "thread-a",
        turnId,
        item: { id, type: "agentMessage", text: id, phase }
      }
    });
  }

  client.captureLiveItem({
    method: "turn/completed",
    params: {
      threadId: "thread-a",
      turn: { id: "turn-a", status: "completed" }
    }
  });

  const byId = new Map(client.liveItemsForThread("thread-a").map((item) => [item.id, item]));
  assert.equal(byId.get("commentary-a").turnStatus, "completed");
  assert.equal(byId.get("answer-a").turnStatus, "completed");
  assert.equal(byId.get("answer-a").presentationRole, "final_answer");
  assert.equal(byId.get("commentary-b").turnStatus, "inProgress");
});
