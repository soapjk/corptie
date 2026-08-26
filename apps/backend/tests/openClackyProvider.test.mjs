import assert from "node:assert/strict";
import test from "node:test";
import { OpenClackyManager, openClackySessionSummary } from "../src/adapters/openClackyManager.mjs";
import { createOpenClackyProvider } from "../src/agent-provider/providers/openClackyProvider.mjs";
import { validateAgentProvider } from "../src/agent-provider/contracts.mjs";

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
});

test("OpenClacky create uses REST once and then sends through its realtime transport", async () => {
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
  assert.deepEqual(requests, [{ path: "/api/sessions", method: "POST" }]);
  assert.equal(socket.sent[0].type, "subscribe");
  assert.equal(socket.sent[1].turn_id, "turn:stable");
  assert.equal(delivery.delivery, "accepted");
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
