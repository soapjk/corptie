import assert from "node:assert/strict";
import test from "node:test";
import { handleFeishuHttpRequest } from "../src/feishu/feishuHttpApi.mjs";

function fixture() {
  const events = [];
  const calls = [];
  const bot = { id: "bot/one", bindings: [{ id: "binding", botId: "bot/one" }] };
  const gateway = {
    status: () => ({ connected: true }),
    listProfiles: async () => ["profile"],
    listBots: () => [bot],
    createBot: async (input) => { calls.push(["create", input]); return bot; },
    updateBot: async (id, input) => { calls.push(["update", id, input]); return bot; },
    deleteBot: async (id) => { calls.push(["delete", id]); return true; },
    createPairingCode: async (...args) => { calls.push(["pair", ...args]); return { code: "pairing" }; },
    getBot: () => bot,
    assignSession: async (...args) => { calls.push(["assign", ...args]); return { sessionId: "session" }; },
    releaseSession: (id) => calls.push(["release", id])
  };
  const store = {
    getFeishuAssignmentForBot: () => ({ sessionId: "session" }),
    revokeFeishuBinding: (id) => calls.push(["revoke", id])
  };
  function dispatch(path, method = "GET", body = {}) {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const handled = handleFeishuHttpRequest({
      request: { method }, response: { resolve }, url: new URL(path, "http://localhost"),
      feishuGateway: gateway, store,
      readJson: async () => { if (body instanceof Error) throw body; return body; },
      sendJson: (response, status, payload) => response.resolve({ status, body: payload }),
      emitEvent: (...args) => events.push(args),
      unifiedErrorStatus: (error) => error.statusCode ?? 400
    });
    return { handled, result };
  }
  return { gateway, store, bot, calls, events, dispatch };
}

test("Feishu inventory routes retain their response envelopes and profile failure status", async () => {
  const f = fixture();
  assert.deepEqual(await f.dispatch("/feishu/status").result, { status: 200, body: { connected: true } });
  assert.deepEqual(await f.dispatch("/feishu/profiles").result, { status: 200, body: { profiles: ["profile"] } });
  assert.deepEqual(await f.dispatch("/feishu/bots").result, { status: 200, body: { bots: [f.bot] } });
  f.gateway.listProfiles = async () => { throw new Error("unavailable"); };
  assert.equal((await f.dispatch("/feishu/profiles").result).status, 502);
});

test("bot mutations decode identifiers and emit only successful changes", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/feishu/bots", "POST", { name: "bot" }).result).status, 201);
  assert.equal((await f.dispatch("/feishu/bots/bot%2Fone", "PATCH", { name: "renamed" }).result).status, 200);
  assert.equal((await f.dispatch("/feishu/bots/bot%2Fone", "DELETE").result).status, 200);
  assert.deepEqual(f.calls[1], ["update", "bot/one", { name: "renamed" }]);
  assert.deepEqual(f.calls[2], ["delete", "bot/one"]);
  assert.deepEqual(f.events.map(([type]) => type), ["FeishuBotCreated", "FeishuBotUpdated", "FeishuBotDeleted"]);
  f.gateway.updateBot = async () => null;
  f.gateway.deleteBot = async () => false;
  assert.equal((await f.dispatch("/feishu/bots/missing", "PATCH").result).status, 404);
  assert.equal((await f.dispatch("/feishu/bots/missing", "DELETE").result).status, 404);
  assert.equal(f.events.length, 3);
});

test("bot creation failure diagnostics remain redacted", async (t) => {
  const f = fixture();
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  f.gateway.createBot = async () => { throw Object.assign(new Error("failed credential fixture-secret"), { feishuStage: "identity" }); };
  const response = await f.dispatch("/feishu/bots", "POST", { appSecret: "fixture-secret" }).result;
  assert.equal(response.status, 400);
  assert.match(logs[0], /mode=credentials stage=identity/);
  assert.ok(!logs[0].includes("fixture-secret"));
  assert.deepEqual(f.events, []);
});

test("pairing preserves TTL conversion and malformed-body fallback", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/feishu/bots/bot%2Fone/pairing-code", "POST", { ttlMs: "1234" }).result).status, 201);
  assert.deepEqual(f.calls[0], ["pair", "bot/one", 1234]);
  await f.dispatch("/feishu/bots/bot%2Fone/pairing-code", "POST", new SyntaxError("bad JSON")).result;
  assert.deepEqual(f.calls[1], ["pair", "bot/one", undefined]);
  f.gateway.createPairingCode = async () => null;
  assert.equal((await f.dispatch("/feishu/bots/missing/pairing-code", "POST").result).status, 404);
});

test("assignment and release retain Session-scoped events and missing-binding errors", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/feishu/bots/bot%2Fone/assignment", "POST", { sessionId: "session" }).result).status, 200);
  assert.deepEqual(f.calls[0], ["assign", "bot/one", "binding", "session"]);
  assert.deepEqual(f.events[0], ["FeishuSessionAssigned", { assignment: { sessionId: "session" } }, { sessionId: "session" }]);
  const invalid = await f.dispatch("/feishu/bots/bot%2Fone/assignment", "POST", { bindingId: "missing" }).result;
  assert.equal(invalid.body.code, "FEISHU_NOT_BOUND");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.dispatch("/feishu/bots/bot%2Fone/assignment", "DELETE").result, { status: 200, body: { released: true } });
  assert.deepEqual(f.events[1], ["FeishuSessionReleased", { botId: "bot/one", sessionId: "session" }, { sessionId: "session" }]);
  f.store.getFeishuAssignmentForBot = () => null;
  assert.equal((await f.dispatch("/feishu/bots/bot%2Fone/assignment", "DELETE").result).body.released, false);
  assert.equal(f.events.length, 2);
});

test("binding revocation rejects missing bindings and unrelated routes fall through", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/feishu/bindings/missing", "DELETE").result).status, 404);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.dispatch("/feishu/bindings/binding", "DELETE").result).status, 200);
  assert.deepEqual(f.calls, [["revoke", "binding"]]);
  assert.deepEqual(f.events, [["FeishuBindingRevoked", { bindingId: "binding", botId: "bot/one" }]]);
  assert.equal(f.dispatch("/other").handled, false);
  assert.equal(f.dispatch("/feishu/bots", "PUT").handled, false);
});
