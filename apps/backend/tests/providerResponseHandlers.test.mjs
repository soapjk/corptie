import assert from "node:assert/strict";
import test from "node:test";
import { createProviderResponseHandlers } from "../src/application/providerResponseHandlers.mjs";

function fixture() {
  const calls = [];
  const turn = { execution_status: "running" };
  let applied = true;
  const service = { interrupt: async (...args) => calls.push(["interrupt", ...args]) };
  const handlers = createProviderResponseHandlers({
    store: {
      getSessionTurn: () => turn,
      getLogicalSession: () => ({ logicalSessionId: "logical" }),
      getSession: () => ({ id: "session", external: { currentModel: "model" } })
    },
    providerEventIngestion: {
      ingest: (event) => {
        calls.push(["ingest", event]);
        return { status: applied ? "applied" : "ignored", event, projection: { session: { id: "session" } } };
      }
    },
    sessionApplicationService: service,
    handleCommittedProviderTerminalLifecycle: (result) => calls.push(["terminal", result]),
    now: () => "2026-01-01T00:00:00Z"
  });
  const entry = {
    providerId: "test-provider", providerSessionId: "native", bindingId: "binding",
    logicalSessionId: "logical", sessionId: "session", routingVersion: 2, turnId: "turn"
  };
  return { calls, handlers, entry, turn, service, ignore: () => { applied = false; } };
}

test("delay warning is a retryable provider event and does not interrupt execution", () => {
  const f = fixture();
  f.handlers.handleProviderResponseDelayed(f.entry);
  assert.equal(f.calls.length, 1);
  const event = f.calls[0][1];
  assert.equal(event.type, "provider.error");
  assert.equal(event.payload.error.code, "PROVIDER_RESPONSE_DELAYED");
  assert.equal(event.payload.willRetry, true);
  assert.equal(event.routingVersion, 2);
});

test("stream-idle warning explains that execution continues without reliable heartbeats", () => {
  const f = fixture();
  f.handlers.handleProviderResponseDelayed({ ...f.entry, warningKind: "stream_idle" });
  const event = f.calls[0][1];
  assert.equal(event.payload.error.code, "PROVIDER_RESPONSE_DELAYED");
  assert.match(event.payload.error.message, /无法确认模型是否仍在执行/);
  assert.equal(event.payload.willRetry, true);
});

test("retry timeout reports a model-network failure instead of generic stream silence", async () => {
  const f = fixture();
  await f.handlers.handleProviderResponseTimeout({
    ...f.entry,
    timeoutKind: "provider_retry",
    lastFailureAt: "2026-01-01T00:00:01Z",
    lastProviderError: { code: "PROVIDER_REQUEST_RETRY", message: "connection refused", retryable: true }
  });
  const event = f.calls[0][1];
  assert.equal(event.payload.error.code, "PROVIDER_RETRY_TIMEOUT");
  assert.equal(event.payload.items[0].title, "模型连接失败");
  assert.match(event.payload.items[0].text, /检查模型网络/);
  assert.match(event.payload.items[0].text, /connection refused/);
});

test("timeout persists a visible failed item before terminal handling and interruption", async () => {
  const f = fixture();
  await f.handlers.handleProviderResponseTimeout(f.entry);
  assert.deepEqual(f.calls.map(([name]) => name), ["ingest", "terminal", "interrupt"]);
  const event = f.calls[0][1];
  assert.equal(event.type, "turn.failed");
  assert.equal(event.payload.error.code, "PROVIDER_FIRST_ACTIVITY_TIMEOUT");
  assert.equal(event.payload.items[0].status, "failed");
  assert.equal(f.calls[2][2].summary.external.activeTurnId, "turn");
  assert.equal(f.calls[2][2].summary.external.currentModel, "model");
});

test("timeout after Provider activity reports a stream idle failure", async () => {
  const f = fixture();
  await f.handlers.handleProviderResponseTimeout({
    ...f.entry,
    timeoutKind: "inactivity",
    lastActivityAt: "2026-01-01T00:00:01Z"
  });
  const event = f.calls[0][1];
  assert.equal(event.payload.error.code, "PROVIDER_STREAM_IDLE_TIMEOUT");
  assert.equal(event.payload.items[0].title, "模型流中断");
});

test("settled turns and unapplied timeout events cannot trigger interruption", async () => {
  const f = fixture();
  f.turn.execution_status = "completed";
  f.handlers.handleProviderResponseDelayed(f.entry);
  await f.handlers.handleProviderResponseTimeout(f.entry);
  assert.deepEqual(f.calls, []);
  f.turn.execution_status = "running";
  f.ignore();
  await f.handlers.handleProviderResponseTimeout(f.entry);
  assert.deepEqual(f.calls.map(([name]) => name), ["ingest"]);
});

test("provider interruption failure does not undo or reject the recorded timeout", async () => {
  const f = fixture();
  f.service.interrupt = async () => { throw new Error("offline"); };
  await f.handlers.handleProviderResponseTimeout(f.entry);
  assert.deepEqual(f.calls.map(([name]) => name), ["ingest", "terminal"]);
});
