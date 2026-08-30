import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenClackyManager,
  mergeOpenClackyRuntimeInstructions,
  openClackyPreDispatchRecoveryError,
  probeRuntimeResult
} from "../src/adapters/openClackyManager.mjs";
import { createOpenClackyProvider, openClackyCapabilities } from "../src/agent-provider/providers/openClackyProvider.mjs";
import { validateAgentProvider, AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";

const CAP = AGENT_PROVIDER_CAPABILITIES;

function probeManager(overrides = {}) {
  return new OpenClackyManager({
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health") return Response.json({ healthy: true });
      if (path === "/api/version") {
        return Response.json({ version: "1.6.0", bridge_protocol: "corptie-bridge-v1" });
      }
      return Response.json({});
    },
    WebSocket: class { constructor() {} addEventListener() {} send() {} close() {} },
    ...overrides
  });
}

test("healthy bridge handshake unlocks Tool Host and Workspace transition capabilities", async () => {
  const manager = probeManager();
  await manager.probeRuntime();
  const provider = createOpenClackyProvider(manager, {
    attachTools: () => ({}),
    prepareWorkspaceTransition: () => ({}),
    readSessionUsage: () => ({})
  });
  const descriptor = validateAgentProvider(provider);
  assert.equal(descriptor.runtime.lifecycle, "managed");
  const caps = new Set(descriptor.capabilities);
  assert.equal(caps.has(CAP.TOOL_HOST_ATTACH), true);
  assert.equal(caps.has(CAP.WORKSPACE_TRANSITION), true);
  assert.equal(caps.has(CAP.SESSION_USAGE_READ), true);
});

test("OpenClacky bootstrap preserves injected recovery context with ordinary runtime instructions", () => {
  assert.equal(
    mergeOpenClackyRuntimeInstructions("ordinary Session boundary", "recovery manifest payload"),
    "ordinary Session boundary\n\nrecovery manifest payload"
  );
  assert.equal(mergeOpenClackyRuntimeInstructions(null, "recovery only"), "recovery only");
});

test("older OpenClacky runtimes receive recovery context on the replacement's first message exactly once", async () => {
  const sent = [];
  class FakeSocket {
    constructor() { this.readyState = 1; }
    addEventListener() {}
    send(value) { sent.push(JSON.parse(value)); }
    close() {}
  }
  const manager = new OpenClackyManager({
    fetch: async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/sessions" && init.method === "POST") {
        return Response.json({ session: { id: "recovered", name: "Recovered", working_dir: "/tmp", status: "idle" } });
      }
      return Response.json({ session: { id: "recovered", name: "Recovered", working_dir: "/tmp", status: "idle" } });
    },
    WebSocket: FakeSocket
  });
  await manager.create({ title: "Recovered", cwd: "/tmp", recoveryContext: "RECOVERY-SEED-6621" });
  await manager.send("recovered", "first visible message");
  await manager.send("recovered", "second visible message");

  const messages = sent.filter((message) => message.type === "message");
  assert.match(messages[0].content, /RECOVERY-SEED-6621/);
  assert.match(messages[0].content, /first visible message/);
  assert.doesNotMatch(messages[1].content, /RECOVERY-SEED-6621/);
  assert.equal(messages[1].content, "second visible message");
});

test("OpenClacky bridge installs Session-scoped tools and executes calls with trusted identity", async () => {
  const requests = [];
  const socketMessages = [];
  const toolCalls = [];
  class FakeSocket {
    constructor() { this.readyState = 1; }
    addEventListener() {}
    send(value) { socketMessages.push(JSON.parse(value)); }
    close() {}
  }
  const manager = new OpenClackyManager({
    fetch: async (url, init = {}) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, method: init.method ?? "GET", body });
      if (path === "/api/sessions" && init.method === "POST") {
        return Response.json({ session: { id: "clacky-tools", name: "Tools", working_dir: "/tmp", status: "idle" } });
      }
      if (path === "/api/sessions/clacky-tools/messages") return Response.json({ events: [] });
      if (path === "/api/sessions/clacky-tools") {
        return Response.json({ session: { id: "clacky-tools", name: "Tools", working_dir: "/tmp", status: "idle" } });
      }
      return Response.json({ ok: true });
    },
    WebSocket: FakeSocket,
    issueToolHostToken: () => "opaque-session-token",
    onToolCall: async (input) => { toolCalls.push(input); return { taskId: "scheduled_task:one" }; }
  });
  const toolHost = {
    actorId: "agent:owner",
    providerAttachment: {
      kind: "corptie_call",
      metadata: { sessionId: "session:logical", sessionKind: "worker" },
      tools: [{ name: "corptie_scheduled_tasks_manage", inputSchema: { type: "object" } }]
    }
  };

  await manager.create({ title: "Tools", cwd: "/tmp", toolHost });
  assert.deepEqual(requests[0].body.corptie_tool_host, {
    protocol: "corptie-bridge-v1",
    kind: "corptie_call",
    token: "opaque-session-token",
    tools: [{ name: "corptie_scheduled_tasks_manage", inputSchema: { type: "object" } }]
  });

  manager.handleSocketEvent("clacky-tools", JSON.stringify({
    type: "corptie_tool_call",
    call_id: "call:one",
    token: "opaque-session-token",
    tool: "corptie_scheduled_tasks_manage",
    arguments: { action: "create", schedule_type: "after", delay_seconds: 60 }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(toolCalls, [{
    actorId: "agent:owner",
    metadata: { sessionId: "session:logical", sessionKind: "worker" },
    tool: "corptie_scheduled_tasks_manage",
    arguments: { action: "create", schedule_type: "after", delay_seconds: 60 }
  }]);
  assert.deepEqual(socketMessages.find((message) => message.type === "corptie_tool_result"), {
    type: "corptie_tool_result",
    session_id: "clacky-tools",
    call_id: "call:one",
    success: true,
    result: { taskId: "scheduled_task:one" }
  });

  manager.handleSocketEvent("clacky-tools", JSON.stringify({
    type: "corptie_tool_call",
    call_id: "call:forged",
    token: "forged",
    tool: "corptie_scheduled_tasks_manage",
    arguments: {}
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(toolCalls.length, 1);
  const rejected = socketMessages.find((message) => message.call_id === "call:forged");
  assert.equal(rejected.success, false);
  assert.equal(rejected.error.code, "TOOL_HOST_UNAUTHORIZED");

  await manager.resume("clacky-tools", { toolHost });
  assert.ok(requests.some((request) =>
    request.path === "/api/sessions/clacky-tools/corptie/tool-host"
    && request.method === "POST"
    && request.body.token === "opaque-session-token"
  ));
});

test("missing or outdated bridge degrades to basic chat and never over-claims", () => {
  const manager = new OpenClackyManager({
    fetch: async () => Response.json({}, { status: 404 }),
    WebSocket: class { constructor() {} }
  });
  const probe = probeRuntimeResult("1.5.9", null, false, {});
  assert.equal(probe.toolHost, false);
  assert.equal(probe.workspaceTransition, false);
  assert.equal(probe.restricted, true);
  assert.match(probe.restrictedReason, /restricted|basic chat/i);

  const provider = createOpenClackyProvider(manager, {
    attachTools: () => ({}),
    prepareWorkspaceTransition: () => ({}),
    readSessionUsage: () => ({})
  });
  const caps = new Set(openClackyCapabilities(manager, { attachTools: () => ({}), prepareWorkspaceTransition: () => ({}), readSessionUsage: () => ({}) }));
  // Without a healthy probe, Tool Host and Workspace transition are NOT declared.
  assert.equal(caps.has(CAP.TOOL_HOST_ATTACH), false);
  assert.equal(caps.has(CAP.WORKSPACE_TRANSITION), false);
});

test("send assigns a stable turn id and does not falsely confirm delivery without ack", async () => {
  const sent = [];
  class FakeSocket {
    constructor() { this.readyState = 1; }
    addEventListener() {}
    send(value) { sent.push(JSON.parse(value)); }
    close() {}
  }
  const manager = new OpenClackyManager({
    fetch: async () => Response.json({
      session: { id: "clacky-1", name: "Ready", working_dir: "/tmp", status: "idle" }
    }),
    WebSocket: FakeSocket
  });
  const result = await manager.send("clacky-1", "Hello");
  assert.equal(result.delivery, "accepted");
  assert.match(result.turnId, /^openclacky:turn:/);
  assert.equal(result.turn.id, result.turnId);
  // Accepted at the socket is queued, never confirmed until the provider acks.
  assert.notEqual(result.delivery, "confirmed");
});

test("realtime events without native ids remain correlated to the dispatched Turn and project stable items", async () => {
  const changes = [];
  class FakeSocket {
    constructor() { this.readyState = 1; }
    addEventListener() {}
    send() {}
    close() {}
  }
  const manager = new OpenClackyManager({
    fetch: async () => Response.json({
      session: { id: "clacky-events", name: "Ready", working_dir: "/tmp", status: "idle" }
    }),
    WebSocket: FakeSocket,
    onSessionChanged: (change) => changes.push(change)
  });
  const delivery = await manager.send("clacky-events", "Remember LANTERN-7429");

  manager.handleSocketEvent("clacky-events", JSON.stringify({ type: "task_started" }));
  manager.handleSocketEvent("clacky-events", JSON.stringify({
    type: "assistant_message",
    content: "LANTERN-7429"
  }));
  manager.handleSocketEvent("clacky-events", JSON.stringify({ type: "task_finished" }));

  const events = changes.filter((change) => change.type === "event");
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((change) => change.event.turn_id), [
    delivery.turnId,
    delivery.turnId,
    delivery.turnId
  ]);
  assert.match(events[1].event.event_id, /^openclacky:event:[a-f0-9]{64}$/);
  assert.equal(events[1].event.item_id, events[1].event.event_id);
  assert.equal(events[2].hasAgentMessage, true);

  const duplicateChanges = [];
  manager.onSessionChanged = (change) => duplicateChanges.push(change);
  manager.handleSocketEvent("clacky-events", JSON.stringify({
    type: "assistant_message",
    content: "LANTERN-7429"
  }));
  assert.equal(duplicateChanges[0].event.event_id, events[1].event.event_id);
  assert.equal(duplicateChanges[0].event.turn_id, delivery.turnId);

  manager.handleSocketEvent("unrelated-session", JSON.stringify({ type: "task_finished" }));
  assert.equal(duplicateChanges.at(-1).hasAgentMessage, false);

  manager.handleSocketEvent("clacky-events", JSON.stringify({ type: "token_usage", usage: { total_tokens: 10 } }));
  manager.handleSocketEvent("clacky-events", JSON.stringify({ type: "token_usage", usage: { total_tokens: 11 } }));
  assert.notEqual(duplicateChanges.at(-2).event.event_id, duplicateChanges.at(-1).event.event_id);
});

test("send rejects a failed OpenClacky Session with the provider initialization error", async () => {
  const manager = new OpenClackyManager({
    fetch: async () => Response.json({
      session: {
        id: "clacky-failed",
        name: "Failed",
        working_dir: "/repo",
        status: "error",
        error: "Operation not permitted @ rb_sysopen - /repo/AGENTS.md"
      }
    }),
    WebSocket: class { constructor() { this.readyState = 1; } addEventListener() {} send() {} close() {} }
  });

  await assert.rejects(
    () => manager.send("clacky-failed", "Hello"),
    (error) => error?.code === "PROVIDER_SESSION_UNAVAILABLE"
      && error?.statusCode === 409
      && /Operation not permitted.*AGENTS\.md/.test(error.message)
  );
});

test("a deleted OpenClacky Session is safely recoverable only before realtime dispatch", async () => {
  const manager = new OpenClackyManager({
    fetch: async () => Response.json({ error: "not found" }, { status: 404 }),
    WebSocket: class { constructor() { this.readyState = 1; } addEventListener() {} send() { throw new Error("must not send"); } }
  });
  await assert.rejects(
    () => manager.send("deleted-session", "Hello"),
    (error) => error?.code === "PROVIDER_SESSION_UNAVAILABLE"
      && error?.dispatchState === "not_sent"
      && error?.recoveryAction === "replace_provider_binding"
  );
  const uncertain = new Error("socket closed");
  assert.equal(openClackyPreDispatchRecoveryError(uncertain, "session"), uncertain);
});
