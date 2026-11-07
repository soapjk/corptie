import test from "node:test";
import assert from "node:assert/strict";
import { logError } from "../src/utils/errorDiagnostics.mjs";

function capture(run) {
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  try { run(); } finally { console.error = original; }
  return logs.join("\n");
}
test("logs original recursive system causes without mutating errors", () => {
  const cause = Object.freeze(Object.assign(new Error("socket"), { code: "ECONNREFUSED", errno: -61, syscall: "connect", status: 503, exitCode: 2, signal: "SIGTERM" }));
  const error = Object.freeze(new AggregateError([cause], "outer", { cause }));
  const output = capture(() => logError("test.failure", error, { sessionId: "s1", payload: "PRIVATE", env: "PRIVATE", headers: "PRIVATE" }));
  for (const expected of ["ECONNREFUSED", "connect", "503", "SIGTERM", "s1", "circular error", "stack"]) assert.ok(output.includes(expected), expected);
  assert.ok(!output.includes("PRIVATE"));
});
test("redacts messages URLs credentials and home paths", () => {
  const output = capture(() => logError("test.failure", new Error("https://alice:pass@example.com/path?token=hidden#secret password=hidden Authorization: Bearer hidden /Users/alice/project /home/bob/file sk-ant-fixturesecret")));
  for (const secret of ["alice", "pass@", "?token", "hidden", "bob", "fixturesecret"]) assert.ok(!output.includes(secret), secret);
  assert.ok(output.includes("example.com/path"));
});
test("bounds cycles depth aggregate fanout and long strings", () => {
  const error = new Error("x".repeat(5000)); error.cause = error;
  assert.match(capture(() => logError("test", error)), /circular error/);
  assert.match(capture(() => logError("test", new AggregateError(Array(20).fill(error)))), /truncated: aggregate/);
  let nested = error; for (let i = 0; i < 20; i++) nested = new Error("nested", { cause: nested });
  assert.match(capture(() => logError("test", nested)), /truncated: error chain/);
  assert.match(capture(() => logError("test", error)), /truncated: text/);
});
test("never invokes getters and never throws on hostile values or sink failure", () => {
  const error = { get message() { throw new Error("getter executed"); } };
  assert.match(capture(() => logError("test", error)), /unavailable: accessor/);
  assert.doesNotThrow(() => capture(() => logError("test", new Proxy({}, { getOwnPropertyDescriptor() { throw 1; } }))));
  const original = console.error;
  console.error = () => { throw new Error("sink failed"); };
  try { assert.doesNotThrow(() => logError("test", error)); } finally { console.error = original; }
});
test("collaboration wrapping preserves response semantics and logs original cause to stderr only", async () => {
  const { CollaborationHttpClient } = await import("../src/mcp/collaborationHttpClient.mjs");
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  const underlying = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED", syscall: "connect" });
  const failure = new TypeError("fetch failed", { cause: underlying });
  try {
    const client = new CollaborationHttpClient({ agentId: "fixture", baseUrl: "http://127.0.0.1:1", fetch: async () => { throw failure; } });
    await assert.rejects(client.get("/fixture"), error => {
      assert.equal(error.message, "Corptie backend is unavailable at http://127.0.0.1:1: fetch failed");
      assert.equal(error.code, "BACKEND_UNAVAILABLE");
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.ok(logs.join("\n").includes("ECONNREFUSED"));
  } finally { console.error = original; }
});
test("includes UTC timestamp and only scalar correlation context", () => {
  const output = capture(() => logError("test", new Error("fixture"), {
    logicalSessionId: "logical:fixture", providerSessionId: "provider:fixture", bindingId: "binding:fixture",
    turnId: "turn:fixture", messageId: "message:fixture", jobId: "job:fixture", transitionId: "transition:fixture",
    attemptId: "attempt:fixture", operationId: "operation:fixture", repositoryId: "repo:fixture", worktreeId: "tree:fixture", attempt: 2,
    payload: "PRIVATE", env: "PRIVATE", headers: "PRIVATE"
  }));
  const event = JSON.parse(output.slice(output.indexOf("{") ));
  assert.match(event.timestamp, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(event.context.attempt, 2);
  assert.equal(Object.keys(event.context).length, 12);
  assert.ok(!output.includes("PRIVATE"));
  const nested = capture(() => logError("test", null, { operationId: { payload: "PRIVATE" } }));
  assert.ok(!nested.includes("PRIVATE"));
});
test("captures real native Error stack frames without invoking custom getters", () => {
  const error = new Error("native fixture");
  const output = capture(() => logError("test", error));
  const event = JSON.parse(output.slice(output.indexOf("{")));
  assert.match(event.error.stack, /\n\s+at /);
  assert.match(event.error.stack, /errorDiagnostics\.test\.mjs/);
  let invoked = false;
  const hostile = new Error("hostile");
  Object.defineProperty(hostile, "stack", { get() { invoked = true; throw new Error("custom getter"); } });
  assert.match(capture(() => logError("test", hostile)), /unavailable: accessor/);
  assert.equal(invoked, false);
  const hostileMessage = new Error();
  Object.defineProperty(hostileMessage, "message", { get() { invoked = true; return "secret"; } });
  capture(() => logError("test", hostileMessage));
  assert.equal(invoked, false);
});
test("aggregate array proxy never invokes get traps, including length", () => {
  let gets = 0;
  const errors = new Proxy([new Error("inner")], { get() { gets++; throw new Error("get trap"); } });
  const error = new AggregateError([], "outer");
  Object.defineProperty(error, "errors", { value: errors });
  const output = capture(() => logError("test", error));
  assert.equal(gets, 0);
  assert.match(output, /inner/);
});
