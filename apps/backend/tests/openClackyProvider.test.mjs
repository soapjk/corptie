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
  assert.equal(descriptor.runtime.lifecycle, "managed");
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

test("OpenClacky history infers distinct turns when upstream turn ids are missing", () => {
  const summary = openClackySessionSummary({
    id: "clacky-1",
    name: "Task",
    status: "idle",
    created_at: "2026-08-17T00:00:00Z"
  });
  const detail = openClackySessionDetail(summary, [
    { type: "history_user_message", content: "First" },
    { type: "tool_call", name: "read" },
    { type: "assistant_message", content: "First answer" },
    { type: "history_user_message", content: "Second" },
    { type: "assistant_message", content: "Second answer" }
  ]);

  assert.deepEqual(detail.items.map((item) => item.turnId), [
    "clacky-1:turn:1",
    "clacky-1:turn:1",
    "clacky-1:turn:1",
    "clacky-1:turn:4",
    "clacky-1:turn:4"
  ]);
});

test("OpenClacky live completion updates the canonical Session summary before notifying the host", () => {
  const changes = [];
  const manager = new OpenClackyManager({
    fetch: async () => Response.json({}),
    WebSocket: FakeWebSocket,
    onSessionChanged: (change) => changes.push(change)
  });
  const summary = openClackySessionSummary({
    id: "clacky-live",
    name: "Live task",
    status: "running",
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:01:00Z"
  });
  manager.sessions.set("clacky-live", summary);
  manager.details.set("clacky-live", openClackySessionDetail(summary, []));

  manager.handleSocketEvent("clacky-live", JSON.stringify({
    id: "answer", type: "assistant_message", content: "Finished the work."
  }));
  manager.handleSocketEvent("clacky-live", JSON.stringify({
    id: "finished", type: "task_finished", message: "done"
  }));

  assert.equal(manager.list()[0].status, "complete");
  assert.equal(manager.list()[0].summary, "Finished the work.");
  assert.equal(changes.at(-1).session.status, "complete");
});

test("OpenClacky history preserves explicit turn ids across following events", () => {
  const summary = openClackySessionSummary({
    id: "clacky-1",
    name: "Task",
    status: "idle",
    created_at: "2026-08-17T00:00:00Z"
  });
  const detail = openClackySessionDetail(summary, [
    { type: "history_user_message", turn_id: "upstream-turn", content: "First" },
    { type: "assistant_message", content: "Answer" }
  ]);

  assert.deepEqual(detail.items.map((item) => item.turnId), ["upstream-turn", "upstream-turn"]);
});

test("OpenClacky history normalizes Unix seconds without inventing missing event timestamps", () => {
  const expected = "2026-08-18T10:24:10.000Z";
  const unixSeconds = Date.parse(expected) / 1_000;
  const summary = openClackySessionSummary({
    id: "clacky-1",
    name: "Task",
    status: "idle",
    created_at: unixSeconds,
    updated_at: String(unixSeconds)
  });
  const detail = openClackySessionDetail(summary, [
    { type: "history_user_message", content: "First", created_at: unixSeconds },
    { type: "assistant_message", content: "Answer" },
    { type: "history_user_message", content: "Second", created_at: unixSeconds + 1 },
    { type: "assistant_message", content: "Second answer", created_at: (unixSeconds + 2) * 1_000 }
  ]);

  assert.equal(summary.updatedAt, expected);
  assert.equal(detail.createdAt, expected);
  assert.deepEqual(detail.items.map((item) => item.createdAt), [
    expected,
    null,
    "2026-08-18T10:24:11.000Z",
    "2026-08-18T10:24:12.000Z"
  ]);
  assert.deepEqual(detail.items.map((item) => item.type), [
    "userMessage",
    "agentMessage",
    "userMessage",
    "agentMessage"
  ]);
});

test("OpenClacky refresh keeps last-known state when the provider returns a transient 404", async () => {
  const requestedPaths = [];
  const owned = ["clacky-1"];
  const manager = new OpenClackyManager({
    fetch: async (url) => {
      const path = new URL(url).pathname;
      requestedPaths.push(path);
      return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
    },
    WebSocket: FakeWebSocket,
    resolveOwnedSessionIds: () => owned,
    refreshIntervalMs: 0
  });

  // Seed a known-good session, then let a refresh hit 404 for it.
  manager.sessions.set("clacky-1", openClackySessionSummary({
    id: "clacky-1",
    name: "Clacky Task",
    status: "idle",
    working_dir: "/tmp/project"
  }));

  await manager.refresh();

  assert.deepEqual(requestedPaths, ["/api/sessions/clacky-1"]);
  assert.deepEqual(manager.list().map((session) => session.external.sessionId), ["clacky-1"]);
});

test("OpenClacky refresh still drops sessions no longer owned by Corptie", async () => {
  const manager = new OpenClackyManager({
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/sessions/clacky-2") {
        return Response.json({ session: { id: "clacky-2", name: "Other", status: "idle" } });
      }
      return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
    },
    WebSocket: FakeWebSocket,
    resolveOwnedSessionIds: () => ["clacky-2"],
    refreshIntervalMs: 0
  });

  manager.sessions.set("clacky-1", openClackySessionSummary({
    id: "clacky-1",
    name: "Clacky Task",
    status: "idle"
  }));

  await manager.refresh();

  // clacky-1 is no longer owned (not in resolveOwnedSessionIds), so it is pruned.
  assert.deepEqual(manager.list().map((session) => session.external.sessionId), ["clacky-2"]);
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

test("OpenClacky manager backfills stored sessions when the in-memory list is incomplete", () => {
  const manager = new OpenClackyManager({
    fetch: async () => Response.json({}),
    WebSocket: FakeWebSocket,
    listStoredSessions: ({ archived }) => archived === false ? [
      { id: "openclacky:idle-1", status: "complete", archived: false, sortOrder: 1 },
      { id: "openclacky:idle-2", status: "complete", archived: false, sortOrder: 2 }
    ] : []
  });

  // In-memory map only has the actively working session; the idle ones are missing
  // while `refresh()` is in flight. `list()` must not drop them.
  manager.sessions.set("openclacky:live-1", {
    id: "openclacky:live-1", status: "running", archived: false, sortOrder: 3
  });

  const ids = manager.list({ archived: false }).map((session) => session.id);
  assert.deepEqual(ids, ["openclacky:live-1", "openclacky:idle-1", "openclacky:idle-2"]);
});

test("OpenClacky manager does not duplicate a session present in both memory and store", () => {
  const stored = { id: "openclacky:dup-1", status: "complete", archived: false, sortOrder: 1 };
  const manager = new OpenClackyManager({
    fetch: async () => Response.json({}),
    WebSocket: FakeWebSocket,
    listStoredSessions: () => [stored]
  });
  // Live map has a fresher status for the same session; the stored copy must be skipped.
  manager.sessions.set("openclacky:dup-1", { id: "openclacky:dup-1", status: "running", archived: false, sortOrder: 1 });

  const list = manager.list({ archived: false });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "running");
});
