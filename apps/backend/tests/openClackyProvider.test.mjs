import assert from "node:assert/strict";
import test from "node:test";
import { OpenClackyManager, openClackySessionSummary } from "../src/adapters/openClackyManager.mjs";
import { createOpenClackyProvider } from "../src/agent-provider/providers/openClackyProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES, validateAgentProvider } from "../src/agent-provider/contracts.mjs";

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  open() { this.readyState = 1; this.listeners.get("open")?.({}); }
  message(value) { this.listeners.get("message")?.({ data: JSON.stringify(value) }); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
}

test("OpenClacky Provider exposes the shared command contract", () => {
  const manager = new OpenClackyManager({ fetch: async () => Response.json({}), WebSocket: FakeWebSocket });
  const descriptor = validateAgentProvider(createOpenClackyProvider(manager));
  assert.equal(descriptor.id, "openclacky");
  assert.deepEqual(descriptor.aliases, ["clacky", "open-clacky"]);
  assert.equal(descriptor.runtime.lifecycle, "managed");
  assert.equal(descriptor.capabilities.includes(AGENT_PROVIDER_CAPABILITIES.SESSION_FAILED_BINDING_RECOVERY), true);
});

test("OpenClacky validates create/send state through REST and sends content through its realtime transport", async () => {
  FakeWebSocket.instances.length = 0;
  const requests = [];
  const manager = new OpenClackyManager({
    fetch: async (url, init = {}) => {
      requests.push({ path: new URL(url).pathname, method: init.method ?? "GET" });
      return Response.json({
        session: {
          id: "clacky-created",
          name: "Created",
          status: "idle",
          working_dir: "/tmp/project"
        }
      });
    },
    WebSocket: FakeWebSocket
  });

  const summary = await manager.create({ title: "Created", cwd: "/tmp/project" });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  const delivery = await manager.send("clacky-created", "Hello", { turnId: "turn:stable" });

  assert.equal(summary.id, "openclacky:clacky-created");
  assert.deepEqual(requests, [
    { path: "/api/sessions", method: "POST" },
    { path: "/api/sessions/clacky-created", method: "GET" },
    { path: "/api/sessions/clacky-created", method: "GET" }
  ]);
  assert.equal(socket.sent[0].type, "subscribe");
  assert.equal(socket.sent[1].turn_id, "turn:stable");
  assert.equal(delivery.delivery, "accepted");
});

test("OpenClacky replaces stale process-local model ids with the persisted current model", async () => {
  FakeWebSocket.instances.length = 0;
  const requests = [];
  const manager = new OpenClackyManager({
    fetch: async (url, init = {}) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ path, body });
      if (path === "/api/config") {
        return Response.json({ current_id: "model:new", models: [{ id: "model:new", model: "hy4" }] });
      }
      return Response.json({
        session: { id: "model-session", name: "Model", status: "idle", working_dir: "/repo" }
      });
    },
    WebSocket: FakeWebSocket
  });

  await manager.create({ title: "Model", cwd: "/repo", model: "model:old" });

  assert.equal(requests[0].path, "/api/config");
  assert.equal(requests[1].path, "/api/sessions");
  assert.equal(requests[1].body.model_id, "model:new");
});

test("OpenClacky resume never reads Session snapshots or message history", async () => {
  FakeWebSocket.instances.length = 0;
  const requests = [];
  const manager = new OpenClackyManager({
    fetch: async (url, init = {}) => {
      requests.push({ path: new URL(url).pathname, method: init.method ?? "GET" });
      return Response.json({ ok: true });
    },
    WebSocket: FakeWebSocket
  });

  const resumed = await manager.resume("clacky-resumed");
  assert.equal(resumed.id, "openclacky:clacky-resumed");
  assert.deepEqual(requests, []);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("OpenClacky reconnect subscribes from the last stable realtime cursor", () => {
  FakeWebSocket.instances.length = 0;
  const events = [];
  const manager = new OpenClackyManager({
    fetch: async () => Response.json({}),
    WebSocket: FakeWebSocket,
    onSessionChanged: (change) => events.push(change)
  });
  manager.ownedSessionIds.add("clacky-live");
  const first = manager.ensureSocket("clacky-live");
  first.open();
  first.message({ id: "event:42", session_id: "clacky-live", type: "assistant_message", content: "Done" });
  manager.sockets.delete("clacky-live");
  const second = manager.ensureSocket("clacky-live");
  second.open();

  assert.equal(events.at(-1).type, "event");
  assert.deepEqual(second.sent[0], {
    type: "subscribe",
    session_id: "clacky-live",
    cursor: "event:42",
    after: "event:42"
  });
});

test("OpenClacky stop clears ownership before closing sockets and stops its managed runtime", () => {
  FakeWebSocket.instances.length = 0;
  let runtimeStopped = false;
  const manager = new OpenClackyManager({
    fetch: async () => Response.json({}),
    WebSocket: FakeWebSocket,
    stopRuntime: () => { runtimeStopped = true; }
  });
  manager.ownedSessionIds.add("clacky-live");
  const socket = manager.ensureSocket("clacky-live");

  manager.stop();

  assert.equal(manager.ownedSessionIds.size, 0);
  assert.equal(manager.sockets.size, 0);
  assert.equal(socket.readyState, 3);
  assert.equal(runtimeStopped, true);
});

test("OpenClacky Session summary normalization is command-response-only", () => {
  const summary = openClackySessionSummary({
    id: "clacky-summary",
    name: "Task",
    status: "idle",
    working_dir: "/tmp/project",
    updated_at: "2026-08-26T00:00:00Z"
  });
  assert.equal(summary.id, "openclacky:clacky-summary");
  assert.equal(summary.status, "complete");
  assert.equal(summary.external.cwd, "/tmp/project");
});

test("OpenClacky cancelled Turn remains visible and sendable", () => {
  const summary = openClackySessionSummary({
    id: "clacky-interrupted",
    name: "Interrupted task",
    status: "cancelled",
    working_dir: "/tmp/project",
    updated_at: "2026-08-26T00:00:00Z"
  });

  assert.equal(summary.status, "cancelled");
  assert.equal(summary.capabilities.canSend, true);
  assert.equal(summary.sendUnavailableReason, null);
});
