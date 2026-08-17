import assert from "node:assert/strict";
import test from "node:test";
import { OpenClackyManager, openClackySessionDetail, openClackySessionSummary } from "../src/adapters/openClackyManager.mjs";
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
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  open() {
    this.readyState = 1;
    this.listeners.get("open")?.({});
  }
  message(value) {
    this.listeners.get("message")?.({ data: JSON.stringify(value) });
  }
  send(value) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
    this.listeners.get("close")?.({});
  }
}

function fetchFixture() {
  const calls = [];
  const session = {
    id: "clacky-1",
    name: "Clacky Task",
    status: "idle",
    working_dir: "/tmp/project",
    model_id: "model-1",
    created_at: "2026-08-17T00:00:00Z",
    updated_at: "2026-08-17T00:01:00Z"
  };
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push([path, options]);
    if (path === "/api/config") {
      return Response.json({ current_id: "model-1", models: [{ id: "model-1", model: "Clacky Model" }] });
    }
    if (path.endsWith("/messages")) {
      return Response.json({ events: [
        { type: "history_user_message", content: "Hello" },
        { type: "assistant_message", content: "Hi" }
      ] });
    }
    if (options.method === "DELETE") return Response.json({ ok: true });
    if (path === "/api/sessions" && options.method === "POST") return Response.json({ session }, { status: 201 });
    if (path === "/api/sessions") return Response.json({ sessions: [session] });
    return Response.json({ session });
  };
  return { calls, fetch, session };
}

test("OpenClacky Provider exposes the shared contract and native capabilities", () => {
  const manager = new OpenClackyManager({ fetch: async () => Response.json({}), WebSocket: FakeWebSocket });
  const provider = createOpenClackyProvider(manager);
  const descriptor = validateAgentProvider(provider);
  assert.equal(descriptor.id, "openclacky");
  assert.deepEqual(descriptor.aliases, ["clacky", "open-clacky"]);
  assert.equal(descriptor.runtime.lifecycle, "external");
  assert.deepEqual(descriptor.configuration.fields.map((field) => field.id), ["baseURL", "accessKey"]);
});

test("OpenClacky manager maps REST sessions and history to canonical models", async () => {
  FakeWebSocket.instances.length = 0;
  const fixture = fetchFixture();
  const manager = new OpenClackyManager({
    fetch: fixture.fetch,
    WebSocket: FakeWebSocket,
    resolveOwnedSessionIds: () => ["clacky-1"],
    refreshIntervalMs: 0
  });

  await manager.refresh();
  assert.equal(manager.list()[0].id, "openclacky:clacky-1");
  assert.equal(manager.list()[0].status, "complete");

  const detail = await manager.read("clacky-1");
  assert.deepEqual(detail.items.map((item) => item.type), ["userMessage", "agentMessage"]);
  assert.equal(detail.cwd, "/tmp/project");

  const models = await manager.listModels();
  assert.equal(models.currentModel, "model-1");
  assert.equal(models.models[0].name, "Clacky Model");
});

test("OpenClacky manager only restores Sessions owned by Corptie", async () => {
  const requestedPaths = [];
  const manager = new OpenClackyManager({
    fetch: async (url) => {
      const path = new URL(url).pathname;
      requestedPaths.push(path);
      return Response.json({ session: {
        id: "corptie-owned",
        name: "Corptie Session",
        status: "idle",
        working_dir: "/tmp/project"
      } });
    },
    WebSocket: FakeWebSocket,
    resolveOwnedSessionIds: () => ["corptie-owned"],
    refreshIntervalMs: 0
  });

  await manager.refresh();

  assert.deepEqual(requestedPaths, ["/api/sessions/corptie-owned"]);
  assert.deepEqual(manager.list().map((session) => session.external.sessionId), ["corptie-owned"]);
});

test("OpenClacky manager creates over REST and sends chat over a subscribed WebSocket", async () => {
  FakeWebSocket.instances.length = 0;
  const fixture = fetchFixture();
  const manager = new OpenClackyManager({
    fetch: fixture.fetch,
    WebSocket: FakeWebSocket,
    refreshIntervalMs: 0
  });

  const session = await manager.create({ title: "Clacky Task", cwd: "/tmp/project", prompt: "Start" });
  assert.equal(session.external.sessionId, "clacky-1");
  const createCall = fixture.calls.find(([path, options]) => path === "/api/sessions" && options.method === "POST");
  assert.deepEqual(JSON.parse(createCall[1].body), {
    name: "Clacky Task",
    working_dir: "/tmp/project",
    agent_profile: "coding"
  });

  const socket = FakeWebSocket.instances[0];
  socket.open();
  assert.deepEqual(socket.sent, [
    { type: "subscribe", session_id: "clacky-1" },
    { type: "message", session_id: "clacky-1", content: "Start" }
  ]);
  await manager.interrupt("clacky-1");
  assert.deepEqual(socket.sent.at(-1), { type: "interrupt", session_id: "clacky-1" });
  await manager.send("clacky-1", "Use this", { sessionContext: { prompt: "Reference context" } });
  assert.equal(socket.sent.at(-1).content, "[[CORPTIE_CONTEXT_V1:17]]Reference contextUse this");
});

test("OpenClacky event mapping exposes confirmation as a blocked shared choice", () => {
  const summary = openClackySessionSummary({
    id: "clacky-1",
    name: "Task",
    status: "running",
    created_at: "2026-08-17T00:00:00Z"
  });
  const detail = openClackySessionDetail(summary, [{
    type: "request_confirmation",
    id: "conf-1",
    message: "Allow command?"
  }]);
  assert.equal(detail.items[0].type, "choice");
  assert.deepEqual(detail.items[0].options.map((option) => option.id), ["yes", "no"]);
});
