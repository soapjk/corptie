import assert from "node:assert/strict";
import test from "node:test";
import { OpenClackyManager, probeRuntimeResult, openClackySessionDetail } from "../src/adapters/openClackyManager.mjs";
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

test("readHistory follows has_more pagination, dedupes, and preserves order", async () => {
  // Newest-first pages; `before` moves toward older events. readHistory reverses at
  // the end so the returned order is oldest -> newest.
  const pages = {
    null: { events: [{ id: "e3", type: "assistant_message", content: "third" }], has_more: true, next_cursor: "c2" },
    c2: { events: [{ id: "e2", type: "assistant_message", content: "second" }], has_more: true, next_cursor: "c1" },
    c1: { events: [{ id: "e1", type: "history_user_message", content: "first" }], has_more: false, next_cursor: null }
  };
  const calls = [];
  const manager = new OpenClackyManager({
    fetch: async (url) => {
      const q = new URL(url).searchParams;
      const before = q.get("before");
      calls.push(before);
      return Response.json(pages[before]);
    },
    WebSocket: class { constructor() {} addEventListener() {} send() {} close() {} }
  });
  const { events, hasMore } = await manager.readHistory("clacky-1");
  assert.equal(hasMore, false);
  assert.deepEqual(events.map((event) => event.id), ["e1", "e2", "e3"]);
  assert.deepEqual(calls, [null, "c2", "c1"]);
});

test("send assigns a stable turn id and does not falsely confirm delivery without ack", async () => {
  const sent = [];
  class FakeSocket {
    constructor() { this.readyState = 1; }
    addEventListener() {}
    send(value) { sent.push(JSON.parse(value)); }
    close() {}
  }
  const manager = new OpenClackyManager({ fetch: async () => Response.json({}), WebSocket: FakeSocket });
  const result = await manager.send("clacky-1", "Hello");
  assert.equal(result.delivery, "accepted");
  assert.match(result.turnId, /^openclacky:turn:/);
  // Accepted at the socket is queued, never confirmed until the provider acks.
  assert.notEqual(result.delivery, "confirmed");
});

test("extended event mapping covers subagent, feedback, token usage, and task finished", () => {
  const summary = {
    id: "clacky-1", title: "Task", status: "complete",
    external: { sessionId: "clacky-1", cwd: "/tmp", raw: {}, currentModel: null, currentReasoningLevel: null },
    capabilities: { canSend: true }, activityStatus: "complete", updatedAt: new Date().toISOString()
  };
  const detail = openClackySessionDetail(summary, [
    { type: "subagent_start", subagent_id: "sa-1", name: "auditor" },
    { type: "token_usage", usage: { input_tokens: 10, output_tokens: 5 } },
    { type: "feedback", feedback: "good" },
    { type: "task_finished", message: "done" }
  ]);
  // token_usage is aggregated into usage, not rendered as a chat item.
  assert.equal(detail.items.length, 3);
  assert.equal(detail.items[0].type, "system");
  assert.equal(detail.items[1].type, "system");
  assert.equal(detail.items[2].type, "system");
});
