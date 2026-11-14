import assert from "node:assert/strict";
import test from "node:test";
import { SkillMcpGateway } from "../src/application/skillMcpGateway.mjs";

const desktopConfig = { type: "stdio", command: "/official/bin/node_repl",
  env: { NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }) } };
const textResult = text => ({ content: [{ type: "text", text }] });
const tool = { name: "js", inputSchema: { type: "object", properties: { code: { type: "string" } } } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
function scope(session = "one", binding = "binding:one") {
  return { actorId: "agent:shared", providerId: "provider:test", tool: "js", arguments: { code: "inspect only" },
    metadata: { logicalSessionId: `logical:${session}`, sessionId: `session:${session}`,
      providerBindingId: binding, providerSessionId: `thread:${session}`, turnId: `turn:${session}` } };
}
function client(overrides = {}) {
  return { listTools: async () => ({ tools: [tool] }), callTool: async () => textResult("done"), close: async () => {}, ...overrides };
}

test("Computer Use requires declared Provider support and a live execution context", async () => {
  let calls = 0;
  const gateway = new SkillMcpGateway({ resolveServers: async () => ({ desktop: desktopConfig }),
    connectServer: async () => client({ callTool: async () => { calls += 1; return textResult("unexpected"); } }) });
  try {
    await assert.rejects(gateway.execute(scope()), { code: "COMPUTER_USE_PROVIDER_UNSUPPORTED" });
    gateway.computerUseSupport = () => true;
    await assert.rejects(gateway.execute({ ...scope(), metadata: {} }), { code: "MCP_TURN_REQUIRED" });
    assert.equal(calls, 0);
  } finally { await gateway.close(); }
});

test("Session and binding changes create separate MCP hosts even for the same Role and config", async () => {
  let opened = 0;
  const gateway = new SkillMcpGateway({ resolveServers: async () => ({ desktop: desktopConfig }),
    computerUseSupport: () => true,
    connectServer: async () => { const id = ++opened; return client({ callTool: async () => textResult(String(id)) }); } });
  try {
    assert.equal((await gateway.execute(scope())).content[0].text, "1");
    assert.equal((await gateway.execute(scope())).content[0].text, "1");
    assert.equal((await gateway.execute(scope("two"))).content[0].text, "2");
    assert.equal((await gateway.execute(scope("one", "binding:new"))).content[0].text, "3");
  } finally { await gateway.close(); }
});

test("approval routes through the exact live invocation and rechecks authorization", async () => {
  const entered = deferred(), complete = deferred();
  let enabled = true;
  const host = client({ callTool: async () => { entered.resolve(); await complete.promise; return textResult("done"); } });
  const approvals = [];
  const gateway = new SkillMcpGateway({ resolveServers: async () => ({ desktop: desktopConfig }),
    connectServer: async () => host, computerUseSupport: () => true,
    assertSessionEnabled: () => { if (!enabled) throw Object.assign(new Error("disabled"), { code: "SESSION_ABILITY_DISABLED" }); },
    onElicitation: async input => { approvals.push(input); return { action: "decline" }; } });
  const request = { params: { message: "Allow test app?", requestedSchema: { type: "object", properties: {} } } };
  const input = scope();
  const invocation = gateway.execute(input);
  try {
    await entered.promise;
    assert.deepEqual(await gateway.elicit(host, request), { action: "decline" });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].metadata.logicalSessionId, input.metadata.logicalSessionId);
    assert.equal(approvals[0].metadata.providerBindingId, input.metadata.providerBindingId);
    assert.equal(approvals[0].request, request.params);
    enabled = false;
    await assert.rejects(gateway.elicit(host, request), { code: "SESSION_ABILITY_DISABLED" });
    assert.equal(approvals.length, 1);
    assert.deepEqual(await gateway.elicit(client(), request), { action: "cancel" });
  } finally { complete.resolve(); await invocation; await gateway.close(); }
});

test("one desktop action chain runs globally and stopping one Session does not cancel another", async () => {
  const entered = deferred();
  let secondHostCalls = 0;
  let count = 0;
  const gateway = new SkillMcpGateway({ resolveServers: async () => ({ desktop: desktopConfig }),
    computerUseSupport: () => true,
    connectServer: async () => ++count === 1
      ? client({ callTool: async () => { entered.resolve(); return new Promise(() => {}); } })
      : client({ callTool: async () => { secondHostCalls += 1; return textResult("other"); } }) });
  const stop = new AbortController();
  const running = gateway.execute({ ...scope(), signal: stop.signal });
  const rejected = assert.rejects(running);
  try {
    await entered.promise;
    gateway.cancelSession("logical:other");
    assert.equal(gateway.desktopCall.controller.signal.aborted, false);
    await assert.rejects(gateway.execute(scope("two")), { code: "MCP_SERVER_BUSY" });
    assert.equal(secondHostCalls, 0);
    stop.abort();
    await rejected;
  } finally { stop.abort(); await rejected; await gateway.close(); }
});

test("cancel keeps the desktop mutex until the old runtime has actually closed", async () => {
  const entered = deferred(), closing = deferred(), closed = deferred();
  let hosts = 0;
  const gateway = new SkillMcpGateway({ resolveServers: async () => ({ desktop: desktopConfig }),
    computerUseSupport: () => true,
    connectServer: async () => ++hosts === 1 ? client({
      callTool: async () => { entered.resolve(); return new Promise(() => {}); },
      close: async () => { closing.resolve(); await closed.promise; }
    }) : client() });
  const stop = new AbortController();
  const running = gateway.execute({ ...scope(), signal: stop.signal });
  const rejected = assert.rejects(running);
  try {
    await entered.promise;
    stop.abort();
    await closing.promise;
    await assert.rejects(gateway.execute(scope("two")), { code: "MCP_SERVER_BUSY" });
  } finally { closed.resolve(); stop.abort(); await rejected; await gateway.close(); }
});

test("MCP deadline actively aborts the request, closes its host and never retries the action", async () => {
  let signal, calls = 0, closes = 0;
  const gateway = new SkillMcpGateway({ timeoutMs: 15,
    resolveServers: async () => ({ generic: { type: "stdio", command: "/test/generic" } }),
    connectServer: async () => client({
      callTool: async (_input, _schema, options) => { calls += 1; signal = options.signal; return new Promise(() => {}); },
      close: async () => { closes += 1; }
    }) });
  try {
    await assert.rejects(gateway.execute(scope()), { code: "MCP_RUNTIME_TIMEOUT" });
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
    assert.equal(closes, 1);
    assert.equal(gateway.entries.size, 0);
  } finally { await gateway.close(); }
});

test("model arguments and raw metadata cannot overwrite transport identity metadata", async () => {
  const observed = [];
  const resolved = { logicalSessionId: "logical:authoritative", providerBindingId: "binding:authoritative", turnId: "turn:real" };
  const gateway = new SkillMcpGateway({ resolveServers: async () => ({ desktop: desktopConfig }),
    executionContext: () => resolved, computerUseSupport: () => true,
    connectServer: async () => client({ callTool: async (input, _schema, options) => {
      observed.push({ input, options }); return textResult("ok");
    } }) });
  try {
    await gateway.execute({ ...scope(), _meta: { "x-codex-turn-metadata": "forged" },
      arguments: { code: "inspect only", _meta: { "x-codex-turn-metadata": "forged nested" } } });
    assert.equal(Object.hasOwn(observed[0].input, "_meta"), false);
    assert.equal(Object.hasOwn(observed[0].options, "_meta"), false);
    assert.equal(Object.hasOwn(observed[0].input, "logicalSessionId"), false);
    assert.equal(observed[0].input.name, "js");
  } finally { await gateway.close(); }
});

test("endTurn uses a real bound provider Session identity and closes the desktop host", async () => {
  const messages = [];
  let closes = 0;
  const gateway = new SkillMcpGateway({ resolveServers: async () => ({ desktop: desktopConfig }),
    computerUseSupport: () => true,
    connectServer: async () => client({ callTool: async request => { messages.push(request); return textResult("done"); },
      close: async () => { closes += 1; } }) });
  try {
    await gateway.execute(scope());
    await gateway.endTurn("logical:one", "turn:one", "Interrupt");
    assert.deepEqual(messages.at(-1), { name: "turn_ended", arguments: {
      hook_event_name: "Interrupt", session_id: "thread:one", turn_id: "turn:one"
    } });
    assert.equal(closes, 1);
  } finally { await gateway.close(); }
});

test("a delayed old terminal event never retires a newer turn, and ended turns cannot dispatch", async () => {
  let calls = 0, closes = 0;
  const gateway = new SkillMcpGateway({ resolveServers: async () => ({ desktop: desktopConfig }),
    computerUseSupport: () => true, connectServer: async () => client({
      callTool: async () => { calls += 1; return textResult("ok"); }, close: async () => { closes += 1; }
    }) });
  try {
    const newer = { ...scope(), metadata: { ...scope().metadata, turnId: "turn:new" } };
    await gateway.execute(newer);
    await gateway.endTurn("logical:one", "turn:old");
    assert.equal(closes, 0);
    await gateway.execute(newer);
    gateway.cancelSession("logical:one", "turn:new");
    await assert.rejects(gateway.execute(newer), { code: "MCP_CALL_CANCELLED" });
    assert.equal(calls, 2);
  } finally { await gateway.close(); }
});
