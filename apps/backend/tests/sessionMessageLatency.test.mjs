import assert from "node:assert/strict";
import test from "node:test";
import {
  logSessionMessageLatency,
  logSessionMessageFailure,
  normalizeSessionMessageLatencyTrace,
  sessionMessageLatencyTraceFromHeaders
} from "../src/utils/sessionMessageLatency.mjs";

test("failure diagnostics preserve correlation and stage without logging private error contents", () => {
  const lines = [];
  const error = Object.assign(new TypeError("SECRET submitted message"), {
    code: "GOAL_FAILED", commandStage: "command_prepare",
    stack: "TypeError: SECRET submitted message\n at prepare (file:///private/user/session.mjs:98:35)"
  });
  const payload = logSessionMessageFailure({ traceId: "message:test", sessionId: "session:test" },
    error, 502, "message_dispatch", { logger: line => lines.push(line) });
  assert.equal(payload.failureStage, "command_prepare");
  assert.equal(payload.httpStatus, 502);
  assert.equal(payload.errorCode, "GOAL_FAILED");
  assert.equal(payload.source, "session.mjs:98:35");
  assert.equal(payload.traceId, "message:test");
  assert.doesNotMatch(lines.join(""), /SECRET|submitted|private\/user/);
});

test("parse failures and unsafe error codes remain bounded and content-free", () => {
  const payload = logSessionMessageFailure({ traceId: "message:test" },
    { code: "private message\ncredentials", message: "private message" }, 400, "request_parse", { logger() {} });
  assert.equal(payload.failureStage, "request_parse");
  assert.equal(payload.errorCode, null);
});

test("Session message latency trace validates external header values", () => {
  assert.deepEqual(sessionMessageLatencyTraceFromHeaders({
    "x-corptie-message-trace-id": "message:abc-123",
    "x-corptie-message-clicked-at-ms": "1000",
    "x-corptie-message-request-started-at-ms": "1012"
  }, { sessionId: "logical-a", serverReceivedAtMs: 1020 }), {
    traceId: "message:abc-123",
    sessionId: "logical-a",
    clientClickedAtMs: 1000,
    clientRequestStartedAtMs: 1012,
    serverReceivedAtMs: 1020
  });
  assert.equal(normalizeSessionMessageLatencyTrace({ traceId: "contains spaces" }), null);
  assert.equal(normalizeSessionMessageLatencyTrace(null), null);
  assert.equal(logSessionMessageLatency(null, "queue_drain_dispatched"), null);
});

test("Session message latency stages report comparable end-to-end durations", () => {
  const lines = [];
  const payload = logSessionMessageLatency({
    traceId: "message:abc-123",
    sessionId: "logical-a",
    clientClickedAtMs: 1000,
    clientRequestStartedAtMs: 1012,
    serverReceivedAtMs: 1020
  }, "task_enqueued", { queuePosition: 1 }, {
    atMs: 1035,
    logger: (line) => lines.push(line)
  });
  assert.equal(payload.sinceClickMs, 35);
  assert.equal(payload.sinceRequestMs, 23);
  assert.equal(payload.sinceServerReceiveMs, 15);
  assert.equal(payload.queuePosition, 1);
  assert.match(lines[0], /^\[session-message-latency\] /);
});
