import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { handleDshHttpRequest } from "../src/dsh-adapter/dshHttpApi.mjs";

function fixture() {
  const calls = [];
  const dependencies = {
    sessionApplicationService: {}, store: {}, listGatewaySessions: () => [],
    readJson: async () => ({}),
    createSession: () => {}, sendSessionMessage: () => {},
    readStoredSessionConversation: async () => [{ text: "conversation" }],
    readStoredSessionTimeline: async () => [{ text: "timeline" }],
    now: () => "2026-09-27T00:00:00.000Z",
    sendJson: (response, status, body) => response.resolve({ status, body }),
    rpcHandler: async (context) => { calls.push(["rpc", context]); context.response.resolve({ rpc: true }); return true; },
    staticPathMatches: (_request, path) => path === "/",
    staticHandler: async ({ response }) => { calls.push(["static"]); response.resolve({ static: true }); }
  };
  function dispatch(path, method = "GET") {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const response = {
      resolve, headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(data) { resolve({ status: this.status, headers: this.headers, data }); }
    };
    const handled = handleDshHttpRequest({ ...dependencies, request: { method }, response, url: new URL(path, "http://localhost") });
    return { handled, result };
  }
  return { calls, dependencies, dispatch };
}

test("DSH export takes precedence over RPC and returns a valid deflated session ZIP", async () => {
  const f = fixture();
  const result = await f.dispatch("/api/session.export?sessionId=session%2Fone").result;
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls, []);
  assert.equal(result.headers["content-type"], "application/zip");
  assert.equal(result.headers["content-length"], result.data.length);
  assert.match(result.headers["content-disposition"], /dsh-session-session_one.zip/);
  const zip = result.data;
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const nameLength = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLength).toString(), "session.json");
  const offset = 30 + nameLength;
  const compressedLength = zip.readUInt32LE(18);
  const payload = JSON.parse(inflateRawSync(zip.subarray(offset, offset + compressedLength)).toString());
  assert.deepEqual(payload, { sessionId: "session/one", exportedAt: "2026-09-27T00:00:00.000Z", conversation: [{ text: "conversation" }], timeline: [{ text: "timeline" }] });
  assert.equal(zip.readUInt32LE(offset + compressedLength), 0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});

test("export HEAD omits data and missing Session ID is rejected before reads", async () => {
  const f = fixture();
  const head = await f.dispatch("/api/session.export?sessionId=session", "HEAD").result;
  assert.equal(head.status, 200);
  assert.equal(head.data, undefined);
  assert.ok(head.headers["content-length"] > 0);
  const missing = await f.dispatch("/api/session.export").result;
  assert.equal(missing.status, 400);
  assert.deepEqual(f.calls, []);
});

test("RPC dispatch retains injected Session callbacks and unhandled/error contracts", async (t) => {
  const f = fixture();
  t.mock.method(console, "error", () => {});
  assert.deepEqual(await f.dispatch("/api/session.list").result, { rpc: true });
  assert.equal(f.calls[0][1].createSession, f.dependencies.createSession);
  assert.equal(f.calls[0][1].sendSessionMessage, f.dependencies.sendSessionMessage);
  f.dependencies.rpcHandler = async () => false;
  assert.equal((await f.dispatch("/api/session.unknown").result).status, 404);
  f.dependencies.rpcHandler = async () => { throw new Error("private"); };
  assert.deepEqual(await f.dispatch("/api/host.describe").result, { status: 500, body: { error: "internal error" } });
  assert.deepEqual(await f.dispatch("/").result, { static: true });
  f.dependencies.staticHandler = async () => { throw new Error("private"); };
  assert.equal((await f.dispatch("/").result).status, 500);
  assert.equal(f.dispatch("/unrelated").handled, false);
});
