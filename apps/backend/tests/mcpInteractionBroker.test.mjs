import assert from "node:assert/strict";
import test from "node:test";
import { McpInteractionBroker } from "../src/application/mcpInteractionBroker.mjs";

const confirmation = (app = "app.test.one") => ({ message: "Allow Computer Use?", mode: "form",
  requestedSchema: { type: "object", properties: {} },
  _meta: { connector_id: "computer-use", tool_params: { app }, persist: ["session", "always"] } });

function fixture(options = {}) {
  const sessions = new Map(), logicals = new Map(), items = new Map(), events = [];
  for (const id of ["one", "two"]) {
    sessions.set(`session:${id}`, { id: `session:${id}`, external: { activeTurnId: `turn:${id}` } });
    logicals.set(`logical:${id}`, { logicalSessionId: `logical:${id}`, legacySessionId: `session:${id}`,
      activeBinding: { bindingId: `binding:${id}`, state: "active" } });
  }
  const store = {
    getLogicalSession: id => logicals.get(id),
    getLogicalSessionByLegacySessionId: id => [...logicals.values()].find(logical => logical.legacySessionId === id),
    getSession: id => sessions.get(id),
    upsertTimelineItemProjection: (sessionId, item) => { items.set(item.id, { ...item, sessionId }); },
    getSessionItem: (sessionId, itemId) => { const item = items.get(itemId); return item?.sessionId === sessionId ? item : null; }
  };
  const broker = new McpInteractionBroker({ store, emitEvent: (...args) => events.push(args), ...options });
  const metadata = (id = "one") => ({ logicalSessionId: `logical:${id}`, sessionId: `session:${id}`,
    providerBindingId: `binding:${id}`, turnId: `turn:${id}` });
  const reference = (id = "one") => ({ sessionId: `session:${id}`, bindingId: `binding:${id}` });
  return { broker, sessions, logicals, items, events, metadata, reference };
}

test("official empty confirmation requires an explicit decision and never defaults to accept", async () => {
  const f = fixture();
  const result = f.broker.request({ metadata: f.metadata(), request: confirmation() });
  const item = [...f.items.values()][0];
  try {
    assert.equal(f.broker.owns(item.id), true);
    assert.deepEqual(item.userInput.questions[0].options.map(option => option.label),
      ["允许本次", "当前会话允许", "拒绝"]);
    assert.equal(item.userInput.questions[0].id, "decision");
    for (const answers of [{}, { decision: [] }, { decision: ["always"] }, { decision: ["允许本次", "拒绝"] }]) {
      assert.throws(() => f.broker.respond(f.reference(), { itemId: item.id, answers }), { code: "INVALID_USER_INPUT_ANSWER" });
      assert.equal(f.broker.owns(item.id), true);
    }
    f.broker.respond(f.reference(), { itemId: item.id, answers: { decision: ["拒绝"] } });
    assert.deepEqual(await result, { action: "decline" });
    assert.equal(f.broker.owns(item.id), false);
  } finally { f.broker.cancelSession("logical:one"); }
});

test("approval scopes are bounded by the downstream request, without permanent authorization", async () => {
  const f = fixture();
  let response = f.broker.request({ metadata: f.metadata(), request: confirmation() });
  let id = [...f.broker.pending.keys()][0];
  f.broker.respond(f.reference(), { itemId: id, answers: { decision: ["当前会话允许"] } });
  assert.deepEqual(await response, { action: "accept", content: {}, _meta: { persist: "session" } });
  const onlyOnce = { ...confirmation(), _meta: { connector_id: "computer-use", tool_params: { app: "app.test" } } };
  response = f.broker.request({ metadata: f.metadata(), request: onlyOnce });
  id = [...f.broker.pending.keys()][0];
  assert.throws(() => f.broker.respond(f.reference(), { itemId: id, answers: { decision: ["当前会话允许"] } }),
    { code: "INVALID_USER_INPUT_ANSWER" });
  f.broker.respond(f.reference(), { itemId: id, answers: { decision: ["允许本次"] } });
  assert.deepEqual(await response, { action: "accept", content: {} });
});

test("approval items and responses are isolated by Session and exact binding", async () => {
  const f = fixture();
  const first = f.broker.request({ metadata: f.metadata("one"), request: confirmation("one.app") });
  const second = f.broker.request({ metadata: f.metadata("two"), request: confirmation("two.app") });
  const [firstId, secondId] = f.broker.pending.keys();
  try {
    assert.notEqual(firstId, secondId);
    assert.throws(() => f.broker.respond(f.reference("two"), { itemId: firstId, answers: { decision: ["允许本次"] } }),
      { code: "USER_INPUT_NOT_PENDING" });
    assert.throws(() => f.broker.respond({ ...f.reference(), bindingId: "binding:forged" },
      { itemId: firstId, answers: { decision: ["允许本次"] } }), { code: "USER_INPUT_NOT_PENDING" });
    f.broker.cancelSession("logical:one");
    assert.deepEqual(await first, { action: "cancel" });
    assert.equal(f.broker.owns(secondId), true);
    f.broker.respond(f.reference("two"), { itemId: secondId, action: "cancel" });
    assert.deepEqual(await second, { action: "cancel", content: null });
    assert.equal(f.events.filter(([name]) => name === "SessionUserInputRequested").length, 2);
  } finally { f.broker.cancelSession("logical:one"); f.broker.cancelSession("logical:two"); }
});

test("a stale binding cannot create or answer an approval item", async () => {
  const f = fixture();
  assert.throws(() => f.broker.request({ metadata: { ...f.metadata(), providerBindingId: "binding:old" }, request: confirmation() }),
    { code: "MCP_INTERACTION_STALE" });
  assert.equal(f.items.size, 0);
  const pending = f.broker.request({ metadata: f.metadata(), request: confirmation() });
  const id = [...f.broker.pending.keys()][0];
  try {
    f.logicals.get("logical:one").activeBinding = { bindingId: "binding:new", state: "active" };
    assert.throws(() => f.broker.respond(f.reference(), { itemId: id, answers: { decision: ["允许本次"] } }),
      { code: "MCP_INTERACTION_STALE" });
    assert.throws(() => f.broker.respond({ ...f.reference(), bindingId: "binding:new" },
      { itemId: id, answers: { decision: ["允许本次"] } }), { code: "USER_INPUT_NOT_PENDING" });
  } finally { f.broker.cancelSession("logical:one"); await pending; }
});

test("aborted invocation creates no item; later abort removes pending approval and blocks late input", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await f.broker.request({ metadata: f.metadata(), request: confirmation(), signal: controller.signal }),
    { action: "cancel" });
  assert.equal(f.items.size, 0);
  const active = new AbortController();
  const pending = f.broker.request({ metadata: f.metadata(), request: confirmation(), signal: active.signal });
  const id = [...f.broker.pending.keys()][0];
  active.abort();
  assert.deepEqual(await pending, { action: "cancel" });
  assert.equal(f.items.get(id).status, "cancelled");
  assert.throws(() => f.broker.respond(f.reference(), { itemId: id, answers: { decision: ["允许本次"] } }),
    { code: "USER_INPUT_NOT_PENDING" });
});

test("cancelSession affects only the selected turn and approval deadlines cancel rather than accept", async () => {
  const f = fixture({ timeoutMs: 15 });
  const keepAlive = setTimeout(() => {}, 1000);
  const pending = f.broker.request({ metadata: f.metadata(), request: confirmation() });
  const id = [...f.broker.pending.keys()][0];
  try {
    f.broker.cancelSession("logical:one", "turn:different");
    assert.equal(f.broker.owns(id), true);
    assert.deepEqual(await pending, { action: "cancel" });
    assert.equal(f.items.get(id).status, "cancelled");
    assert.equal(f.broker.pending.size, 0);
  } finally { clearTimeout(keepAlive); f.broker.cancelSession("logical:one"); }
});

test("missing active turn and unsupported forms fail closed before timeline creation", () => {
  const f = fixture();
  f.sessions.get("session:one").external = {};
  assert.throws(() => f.broker.request({ metadata: { ...f.metadata(), turnId: undefined }, request: confirmation() }),
    { code: "MCP_TURN_REQUIRED" });
  assert.throws(() => f.broker.request({ metadata: f.metadata(), request: { message: "unknown", requestedSchema: { type: "array" } } }),
    { code: "INVALID_USER_INPUT_ANSWER" });
  assert.equal(f.items.size, 0);
});

test("malformed empty-form constraints and unrenderable confirmations never create pending approvals", () => {
  const f = fixture();
  try {
    for (const requestedSchema of [
      { type: "object", properties: [] },
      { type: "object", properties: {}, required: {} },
      { type: "object", properties: {}, additionalProperties: "not a boolean" }
    ]) {
      assert.throws(() => f.broker.request({ metadata: f.metadata(), request: { ...confirmation(), requestedSchema } }),
        { code: "INVALID_USER_INPUT_ANSWER" });
    }
    assert.throws(() => f.broker.request({ metadata: f.metadata(), request: { ...confirmation(), message: "x".repeat(3000) } }),
      { code: "INVALID_USER_INPUT_ANSWER" });
    assert.equal(f.items.size, 0);
    assert.equal(f.broker.pending.size, 0);
  } finally { f.broker.cancelSession("logical:one"); }
});

test("Session app grants are bound to the server and binding and revoked by an explicit stop", async () => {
  const f = fixture();
  const metadata = { ...f.metadata(), mcpServerKey: "official-runtime" };
  const pending = f.broker.request({ metadata, request: confirmation() });
  f.broker.respond(f.reference(), { itemId: [...f.broker.pending.keys()][0], answers: { decision: ["当前会话允许"] } });
  await pending;
  const count = f.items.size;
  assert.equal((await f.broker.request({ metadata, request: confirmation() })).action, "accept");
  assert.equal(f.items.size, count);
  const other = f.broker.request({ metadata: { ...metadata, mcpServerKey: "another-server" }, request: confirmation() });
  assert.equal(f.broker.pending.size, 1);
  f.broker.cancelSession("logical:one", null, { revokeGrants: true });
  await other;
  const afterStop = f.broker.request({ metadata, request: confirmation() });
  assert.equal(f.broker.pending.size, 1);
  f.broker.cancelSession("logical:one");
  await afterStop;
});

test("a projection failure cancels rather than releasing an accepted operation", async () => {
  const f = fixture();
  const pending = f.broker.request({ metadata: f.metadata(), request: confirmation() });
  const itemId = [...f.broker.pending.keys()][0];
  f.broker.store.upsertTimelineItemProjection = () => { throw new Error("database unavailable"); };
  assert.throws(() => f.broker.respond(f.reference(), { itemId, answers: { decision: ["允许本次"] } }),
    { code: "MCP_INTERACTION_PERSISTENCE_FAILED" });
  assert.deepEqual(await pending, { action: "cancel" });
});
