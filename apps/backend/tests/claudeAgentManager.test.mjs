import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeAgentManager,
  claudeTranscriptItems,
  loadClaudeTranscriptMessages,
  mergeClaudeTranscriptItems
} from "../src/adapters/claudeAgentManager.mjs";

test("Claude exposes context use and subscription rate-limit windows through its live SDK query", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-usage", model: "claude-opus" });
  manager.get("claude-usage").query = {
    async getContextUsage() {
      return { totalTokens: 120_000, maxTokens: 200_000, percentage: 60 };
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 37.5, resets_at: "2026-08-10T12:00:00.000Z" },
          seven_day: { utilization: 22, resets_at: "2026-08-17T00:00:00.000Z" }
        }
      };
    }
  };

  assert.deepEqual(await manager.readSessionUsage("claude-usage"), {
    usedTokens: 120_000,
    contextWindow: 200_000,
    remainingTokens: 80_000,
    usedPercent: 60
  });
  const account = await manager.readAccountUsage("claude-usage");
  assert.equal(account.available, true);
  assert.equal(account.provider, "claude");
  assert.equal(account.subscriptionType, "max");
  assert.equal(account.rateLimitsByLimitId.five_hour.primary.usedPercent, 37.5);
  assert.equal(account.rateLimitsByLimitId.five_hour.primary.windowDurationMins, 300);
  assert.equal(account.rateLimitsByLimitId.seven_day.primary.windowDurationMins, 10_080);
});

test("Claude starts only one live Query when usage loading and sending connect concurrently", async () => {
  let starts = 0;
  const query = {
    async *[Symbol.asyncIterator]() {},
    async getContextUsage() { return { totalTokens: 1, maxTokens: 100, percentage: 1 }; },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return { rate_limits_available: false, rate_limits: null };
    }
  };
  const manager = new ClaudeAgentManager({
    query: () => {
      starts += 1;
      return query;
    }
  });
  manager.start({ id: "claude-concurrent-usage" });
  const session = manager.get("claude-concurrent-usage");

  await Promise.all([
    manager.ensureQueryStarted(session),
    manager.readSessionUsage("claude-concurrent-usage"),
    manager.readAccountUsage("claude-concurrent-usage")
  ]);

  assert.equal(starts, 1);
});

test("Claude sends resolved Session context without exposing it as the visible user message", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-context" });
  const session = manager.get("claude-context");
  manager.ensureQueryStarted = async () => {};
  let providerMessage = null;
  manager.enqueueInput = (_session, message) => { providerMessage = message; };

  await manager.send("claude-context", "Fix the bug", { contextPrompt: "Reference context" });

  assert.equal(session.items.at(-1).text, "Fix the bug");
  assert.equal(providerMessage.message.content[0].text, "[[CORPTIE_CONTEXT_V1:17]]Reference contextFix the bug");
  const replayed = claudeTranscriptItems(session, [providerMessage]);
  assert.equal(replayed[0].text, "Fix the bug");
});

test("Claude transcript loader pages past the SDK's earliest-message limit", async () => {
  const source = Array.from({ length: 7 }, (_, index) => ({ index }));
  const calls = [];
  const messages = await loadClaudeTranscriptMessages(
    "sdk-session",
    { dir: "/tmp/project", pageSize: 3, maxMessages: 20 },
    async (_sessionId, options) => {
      calls.push({ limit: options.limit, offset: options.offset });
      return source.slice(options.offset, options.offset + options.limit);
    }
  );

  assert.deepEqual(messages, source);
  assert.deepEqual(calls, [
    { limit: 3, offset: 0 },
    { limit: 3, offset: 3 },
    { limit: 3, offset: 6 }
  ]);
});

test("Claude transcript replay retains Corptie-hosted handled choices", () => {
  const transcript = [
    { id: "user-1", type: "userMessage", text: "Choose one", createdAt: "2026-08-09T10:00:00.000Z" },
    { id: "agent-1", type: "agentMessage", text: "Continuing", createdAt: "2026-08-09T10:02:00.000Z" }
  ];
  const selectedChoice = {
    id: "choice-1",
    type: "choice",
    text: "Which option?",
    status: "selected",
    createdAt: "2026-08-09T10:01:00.000Z",
    options: [
      { id: "a", label: "A", selected: false },
      { id: "b", label: "B", selected: true }
    ]
  };

  const merged = mergeClaudeTranscriptItems(transcript, [
    selectedChoice,
    { ...selectedChoice, id: "pending", status: "pending" }
  ]);

  assert.deepEqual(merged.map((item) => item.id), ["user-1", "choice-1", "agent-1"]);
  assert.equal(merged[1].options[1].selected, true);
});

test("Claude reconnect restores a handled choice alongside SDK transcript history", async () => {
  const selectedChoice = {
    id: "choice-restored",
    turnId: "claude-restored-choice:turn:1",
    turnStatus: "complete",
    type: "choice",
    title: "Claude question",
    text: "Deploy now?",
    status: "selected",
    createdAt: "2026-08-09T10:01:00.000Z",
    options: [{ id: "yes", label: "Yes", selected: true }]
  };
  const storedSession = {
    id: "claude-restored-choice",
    title: "Claude restored choice",
    agent: "Claude Code",
    status: "complete",
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:02:00.000Z",
    external: {
      provider: "claude-sdk",
      agentSessionId: "sdk-restored-choice",
      cwd: "/tmp/project"
    },
    rawStatus: {}
  };
  const store = {
    getSession: () => storedSession,
    getItems: () => [selectedChoice],
    upsertSession: () => {}
  };
  const manager = new ClaudeAgentManager({ store });
  manager.loadTranscriptItems = async () => [{
    id: "agent-restored",
    turnId: "claude-restored-choice:turn:1",
    turnStatus: "complete",
    type: "agentMessage",
    title: "Claude Code",
    text: "Done",
    createdAt: "2026-08-09T10:02:00.000Z"
  }];

  await manager.reconnect("claude-restored-choice", { startQuery: false });

  const restored = manager.detail("claude-restored-choice").items;
  assert.deepEqual(restored.map((item) => item.id), ["choice-restored", "agent-restored"]);
  assert.equal(restored[0].status, "selected");
  assert.equal(restored[0].options[0].selected, true);
});

test("Claude reconnect clears a stale running state left by a backend restart", async () => {
  const storedSession = {
    id: "claude-stale-running",
    title: "Claude stale running",
    agent: "Claude Code",
    status: "running",
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:01:00.000Z",
    external: { provider: "claude-sdk", agentSessionId: "sdk-stale", cwd: "/tmp/project" },
    rawStatus: {}
  };
  const manager = new ClaudeAgentManager({
    store: {
      getSession: () => storedSession,
      getItems: () => [],
      upsertSession: () => {}
    }
  });
  manager.loadTranscriptItems = async () => [];

  await manager.reconnect("claude-stale-running", { startQuery: false });

  assert.equal(manager.detail("claude-stale-running").status, "complete");
  assert.equal(manager.get("claude-stale-running").turnState, "idle");
});

test("reading a persisted Claude session restores history without starting a Query", async () => {
  const manager = new ClaudeAgentManager();
  let reconnectOptions = null;
  manager.reconnect = async (id, options) => {
    reconnectOptions = options;
    return manager.start({
      id,
      cwd: "/tmp/restored",
      items: [{ id: "history", type: "userMessage", text: "Restored" }]
    });
  };

  const detail = await manager.read("claude-persisted");

  assert.deepEqual(reconnectOptions, { startQuery: false });
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].text, "Restored");
  assert.equal(manager.get("claude-persisted").query, null);
});

test("Claude Query receives Corptie MCP, skills, plugin, and project settings", async () => {
  let capturedOptions = null;
  const manager = new ClaudeAgentManager({
    query: ({ options }) => {
      capturedOptions = options;
      return (async function* emptyQuery() {})();
    }
  });
  manager.start({
    id: "claude-corptie-runtime",
    cwd: "/tmp/project",
    runtimeWorkspaceRoots: ["/tmp/project", "/tmp/repo/.git/worktrees/integration"],
    toolHost: {
      providerAttachment: {
        mcpServers: { corptie: { type: "stdio", command: "node" } },
        plugins: [{ type: "local", path: "/runtime/corptie-plugin", skipMcpDiscovery: true }],
        skills: "all",
        settingSources: ["user", "project", "local"],
        disallowedTools: ["EnterWorktree", "ExitWorktree", "EnterWorktree", ""],
        systemPrompt: { type: "preset", preset: "claude_code", append: "Use Corptie collaboration." }
      }
    }
  });

  await manager.ensureQueryStarted(manager.get("claude-corptie-runtime"));

  assert.equal(capturedOptions.mcpServers.corptie.command, "node");
  assert.equal(capturedOptions.plugins[0].path, "/runtime/corptie-plugin");
  assert.equal(capturedOptions.skills, "all");
  assert.deepEqual(capturedOptions.settingSources, ["user", "project", "local"]);
  assert.deepEqual(capturedOptions.additionalDirectories, [
    "/tmp/project", "/tmp/repo/.git/worktrees/integration"
  ]);
  assert.deepEqual(capturedOptions.disallowedTools, ["EnterWorktree", "ExitWorktree"]);
  assert.match(capturedOptions.systemPrompt.append, /Corptie collaboration/);
});

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

test("Claude remains working and interruptible while a background task outlives the parent result", async () => {
  const settled = [];
  const manager = new ClaudeAgentManager({ onTurnSettled: (event) => settled.push(event) });
  manager.start({ id: "claude-background", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-background");
  session.currentTurnId = "claude-background:turn:1";
  session.status = "running";
  session.turnState = "running";
  session.query = {};

  manager.handleSdkMessage(session, {
    type: "system",
    subtype: "task_started",
    task_id: "task-market-cow",
    description: "Implement the delegated change",
    subagent_type: "general-purpose"
  });
  manager.handleSdkMessage(session, { type: "result", subtype: "success", result: "Delegated." });

  let detail = manager.detail("claude-background");
  assert.equal(detail.status, "running");
  assert.equal(detail.activityStatus, "Claude is working");
  assert.equal(detail.capabilities.canInterrupt, true);
  assert.equal(settled.length, 0);

  manager.handleSdkMessage(session, {
    type: "system",
    subtype: "task_notification",
    task_id: "task-market-cow",
    status: "completed",
    summary: "Implementation completed"
  });

  detail = manager.detail("claude-background");
  assert.equal(detail.status, "complete");
  assert.equal(detail.capabilities.canInterrupt, false);
  await Promise.resolve();
  assert.equal(settled.length, 1);
});

test("Claude settles after its result while a background Bash service keeps running", async () => {
  const settled = [];
  const manager = new ClaudeAgentManager({ onTurnSettled: (event) => settled.push(event) });
  manager.start({ id: "claude-background-service", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-background-service");
  session.currentTurnId = "claude-background-service:turn:1";
  session.status = "running";
  session.turnState = "running";
  session.query = {};

  manager.handleSdkMessage(session, {
    type: "system",
    subtype: "task_started",
    task_id: "task-dashboard",
    task_type: "bash",
    description: "Start dashboard in background"
  });
  manager.handleSdkMessage(session, { type: "result", subtype: "success", result: "Dashboard started." });

  let detail = manager.detail("claude-background-service");
  assert.equal(detail.status, "complete");
  assert.equal(detail.activityStatus, "Ready");
  assert.equal(detail.capabilities.canInterrupt, false);
  await Promise.resolve();
  assert.equal(settled.length, 1);

  manager.handleSdkMessage(session, {
    type: "system",
    subtype: "task_progress",
    task_id: "task-dashboard",
    task_type: "bash",
    description: "Dashboard is still running"
  });

  detail = manager.detail("claude-background-service");
  assert.equal(detail.status, "complete");
  assert.equal(detail.activityStatus, "Ready");
  assert.equal(settled.length, 1);
});

test("Claude restores working state when assistant activity arrives after a parent result", () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-late-background", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-late-background");
  session.currentTurnId = "claude-late-background:turn:1";
  session.status = "running";
  session.turnState = "running";
  session.query = {};

  manager.handleSdkMessage(session, { type: "result", subtype: "success", result: "Done." });
  assert.equal(manager.detail("claude-late-background").status, "complete");

  manager.handleSdkMessage(session, sdkAssistant([
    { type: "tool_use", name: "Bash", input: { command: "npm test" } }
  ]));

  const detail = manager.detail("claude-late-background");
  assert.equal(detail.status, "running");
  assert.equal(detail.capabilities.canInterrupt, true);
});

test("Claude interrupt closes the whole Query so background agents cannot survive", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-interrupt-background", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-interrupt-background");
  const calls = [];
  session.status = "running";
  session.turnState = "running";
  session.query = {
    interrupt: async () => calls.push("interrupt"),
    close: async () => calls.push("close")
  };
  session.queryTask = Promise.resolve();
  session.activeTaskIds.add("background-task");

  const summary = await manager.interrupt("claude-interrupt-background");

  assert.deepEqual(calls, ["interrupt", "close"]);
  assert.equal(session.query, null);
  assert.equal(session.activeTaskIds.size, 0);
  assert.equal(summary.status, "complete");
});

test("Claude interrupt supports the SDK synchronous Query.close contract", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-interrupt-sync-close", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-interrupt-sync-close");
  const calls = [];
  session.status = "running";
  session.turnState = "running";
  session.query = {
    interrupt: async () => calls.push("interrupt"),
    close: () => { calls.push("close"); }
  };
  session.queryTask = Promise.resolve();

  const summary = await manager.interrupt("claude-interrupt-sync-close");

  assert.deepEqual(calls, ["interrupt", "close"]);
  assert.equal(summary.status, "complete");
  assert.equal(summary.capabilities.canInterrupt, false);
  assert.equal(session.query, null);
  assert.equal(session.turnState, "idle");
});

test("Claude interrupt repairs a stale running session without an active Query", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-interrupt-stale", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-interrupt-stale");
  session.status = "running";
  session.turnState = "running";
  session.query = null;
  session.queryTask = null;

  const summary = await manager.interrupt("claude-interrupt-stale");

  assert.equal(summary.status, "complete");
  assert.equal(summary.capabilities.canInterrupt, false);
  assert.equal(session.turnState, "idle");
  assert.equal(session.interruptRequested, false);
});

test("Claude reports a normalized turn-settled event to product orchestration", async () => {
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });
  const manager = new ClaudeAgentManager({ onTurnSettled: settle });
  manager.start({ id: "claude-settled", title: "Claude settled", cwd: "/tmp", prompt: "" });
  const session = manager.get("claude-settled");
  session.currentTurnId = "claude-settled:turn:1";
  session.status = "running";
  session.turnState = "running";

  manager.handleSdkMessage(session, sdkAssistant([{ type: "text", text: "Done." }]));
  manager.handleSdkMessage(session, { type: "result", subtype: "success", result: "Done." });

  assert.deepEqual(await settled, {
    providerSessionId: "claude-settled",
    session: manager.toSessionSummary(session),
    hasAgentMessage: true,
    turnId: "claude-settled:turn:1",
    status: "completed",
    error: null
  });
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

test("Claude AskUserQuestion handles the SDK questions array one question at a time", async () => {
  const manager = new ClaudeAgentManager();
  manager.start({ id: "claude-questions", cwd: "/tmp/project" });
  const session = manager.get("claude-questions");
  const resolutionPromise = manager.handleToolRequest(session, "AskUserQuestion", {
    questions: [
      {
        header: "Instructions",
        question: "Keep CLAUDE.md?",
        multiSelect: false,
        options: [
          { label: "Keep", description: "Keep project instructions." },
          { label: "Ignore", description: "Keep it local only." }
        ]
      },
      {
        header: "Strategies",
        question: "Ignore strategy sources?",
        multiSelect: false,
        options: [
          { label: "Ignore", description: "Keep strategies private." },
          { label: "Track", description: "Keep the clone runnable." }
        ]
      }
    ]
  });

  let detail = manager.detail("claude-questions");
  assert.match(detail.items.at(-1).text, /Question 1 of 2/);
  assert.deepEqual(detail.items.at(-1).options.map((option) => option.label), ["Keep", "Ignore"]);

  manager.respondToChoice("claude-questions", {
    choiceId: detail.items.at(-1).id,
    optionId: "question-0-option-0"
  });
  detail = manager.detail("claude-questions");
  assert.equal(detail.items.at(-2).status, "selected");
  assert.match(detail.items.at(-1).text, /Question 2 of 2/);
  assert.deepEqual(detail.items.at(-1).options.map((option) => option.label), ["Ignore", "Track"]);

  manager.respondToChoice("claude-questions", {
    choiceId: detail.items.at(-1).id,
    optionId: "question-1-option-0"
  });
  assert.deepEqual(await resolutionPromise, {
    behavior: "allow",
    updatedInput: {
      questions: [
        {
          header: "Instructions",
          question: "Keep CLAUDE.md?",
          multiSelect: false,
          options: [
            { label: "Keep", description: "Keep project instructions." },
            { label: "Ignore", description: "Keep it local only." }
          ]
        },
        {
          header: "Strategies",
          question: "Ignore strategy sources?",
          multiSelect: false,
          options: [
            { label: "Ignore", description: "Keep strategies private." },
            { label: "Track", description: "Keep the clone runnable." }
          ]
        }
      ],
      answers: {
        "Keep CLAUDE.md?": "Keep",
        "Ignore strategy sources?": "Ignore"
      }
    }
  });
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
