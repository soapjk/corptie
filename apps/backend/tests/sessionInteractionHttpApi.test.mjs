import assert from "node:assert/strict";
import test from "node:test";
import { handleSessionInteractionHttpRequest } from "../src/application/sessionInteractionHttpApi.mjs";

function fixture() {
  const calls = [];
  const record = (name, result) => async (...args) => { calls.push([name, ...args]); return result; };
  const reference = { sessionId: "stored", logicalSessionId: "logical" };
  const image = { mimeType: "image/png", byteLength: 3, data: Buffer.from([1, 2, 3]) };
  const dependencies = {
    sendUnifiedSessionMessage: record("message", { accepted: true }),
    userMessageCommandSource: () => ({ type: "desktop", commandId: "command" }),
    requireSessionReference: (id) => { calls.push(["reference", id]); return reference; },
    chatResourceService: {
      importImage: record("import", { managedPath: "image.png" }),
      readImage: record("image", image),
      removeUnsentImage: record("remove", { removed: true })
    },
    interruptUnifiedSession: record("interrupt", { id: "stored" }),
    respondUnifiedSessionApproval: record("approval", { id: "stored" }),
    respondUnifiedSessionUserInput: record("input", { id: "stored" }),
    readJson: async (request) => { if (request.body instanceof Error) throw request.body; return request.body; },
    sendJson: (response, status, body) => response.resolve({ status, body }),
    unifiedErrorStatus: (error) => error.statusCode ?? 400
  };
  function dispatch(path, method = "POST", body = {}) {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const response = {
      resolve,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(data) { resolve({ status: this.status, headers: this.headers, data }); }
    };
    const handled = handleSessionInteractionHttpRequest({ ...dependencies,
      request: { method, body, headers: { "x-corptie-message-trace-id": "trace:test" } }, response,
      url: new URL(path, "http://localhost") });
    return { handled, result };
  }
  return { calls, dependencies, reference, image, dispatch };
}

test("message dispatch retains source, trace and accepted response", async () => {
  const f = fixture();
  const body = { text: "hello", commandId: "command" };
  assert.deepEqual(await f.dispatch("/sessions/public%2Fid/messages", "POST", body).result,
    { status: 202, body: { accepted: true } });
  const [name, id, input, source, options] = f.calls[0];
  assert.equal(name, "message");
  assert.equal(id, "public/id");
  assert.equal(input, body);
  assert.deepEqual(source, { type: "desktop", commandId: "command" });
  assert.equal(options.latencyTrace.traceId, "trace:test");
  assert.equal(options.latencyTrace.sessionId, "public/id");
  assert.equal(options.text, "hello");
});

test("message failures retain request/dispatch stages without logging raw error text", async (t) => {
  const f = fixture();
  const logs = [];
  t.mock.method(console, "error", (line) => logs.push(JSON.parse(line.slice(line.indexOf("{")))));
  const invalid = await f.dispatch("/sessions/public/messages", "POST", new SyntaxError("private input")).result;
  assert.equal(invalid.status, 400);
  assert.deepEqual(f.calls, []);
  assert.equal(logs[0].failureStage, "request_parse");
  f.dependencies.sendUnifiedSessionMessage = async () => { throw Object.assign(new Error("private error"), {
    statusCode: 409, code: "CONFLICT", details: { retryable: true }
  }); };
  assert.deepEqual(await f.dispatch("/sessions/public/messages").result,
    { status: 409, body: { error: "private error", code: "CONFLICT", traceId: "trace:test", details: { retryable: true } } });
  assert.equal(logs[1].failureStage, "message_dispatch");
  assert.ok(!JSON.stringify(logs).includes("private"));
});

test("image operations preserve reference resolution, binary headers and managed removal", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/sessions/public/images", "POST", { image: "data" }).result).status, 201);
  assert.deepEqual(f.calls[1], ["import", f.reference, { image: "data" }]);
  assert.deepEqual(await f.dispatch("/sessions/public/images?path=images%2Fa.png", "GET").result, {
    status: 200,
    headers: { "content-type": "image/png", "content-length": 3, "cache-control": "private, max-age=31536000, immutable" },
    data: f.image.data
  });
  assert.deepEqual(f.calls[3], ["image", f.reference, "images/a.png"]);
  assert.equal((await f.dispatch("/sessions/public/images", "DELETE", { managedPath: "images/a.png" }).result).status, 200);
  assert.deepEqual(f.calls[5], ["remove", f.reference, "images/a.png"]);
  f.dependencies.requireSessionReference = () => { throw Object.assign(new Error("missing"), { statusCode: 404, code: "SESSION_NOT_FOUND" }); };
  assert.equal((await f.dispatch("/sessions/public/images", "GET").result).status, 404);
});

test("interrupt tolerates malformed bodies while approvals preserve supplied source", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/sessions/public/interrupt", "POST", new SyntaxError("invalid")).result).status, 200);
  assert.deepEqual(f.calls[0], ["interrupt", "public", { type: "desktop" }]);
  const input = { source: { type: "test" }, approved: true };
  await f.dispatch("/sessions/public/actions/approve", "POST", input).result;
  assert.deepEqual(f.calls[1], ["approval", "public", input, input.source]);
  await f.dispatch("/sessions/public/actions/user-input", "POST", input).result;
  assert.deepEqual(f.calls[2], ["input", "public", input, { type: "desktop" }]);
  assert.equal((await f.dispatch("/sessions/public/actions/approve", "POST", new SyntaxError("invalid")).result).status, 400);
  assert.equal(f.calls.length, 3);
});

test("unmatched interaction paths and methods fall through", () => {
  const f = fixture();
  for (const [path, method] of [["/other", "POST"], ["/sessions/public/images", "PATCH"], ["/sessions/public/messages", "GET"]]) {
    assert.equal(f.dispatch(path, method).handled, false);
  }
  assert.deepEqual(f.calls, []);
});
