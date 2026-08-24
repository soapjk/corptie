import assert from "node:assert/strict";
import test from "node:test";
import { SessionStateDiagnostics } from "../src/application/sessionStateDiagnostics.mjs";

test("session state diagnostics keeps a bounded per-session terminal timeline", () => {
  let tick = 0;
  const diagnostics = new SessionStateDiagnostics({
    capacity: 2,
    clock: () => `t${++tick}`
  });

  diagnostics.record("s1", "providerReceived", { turnId: "turn-1" });
  diagnostics.record("s1", "persisted", { status: "complete" });
  diagnostics.record("s2", "reconciled", { reason: "background" });
  diagnostics.record("s3", "providerReceived");

  assert.equal(diagnostics.get("s1"), null);
  assert.equal(diagnostics.get("s3").stages.providerReceived.timestamp, "t4");
  assert.deepEqual(diagnostics.list().map((entry) => entry.sessionId), ["s3", "s2"]);
});

test("session state diagnostics ignores incomplete identities", () => {
  const diagnostics = new SessionStateDiagnostics();
  assert.equal(diagnostics.record(null, "persisted"), null);
  assert.equal(diagnostics.record("s1", ""), null);
  assert.deepEqual(diagnostics.list(), []);
});
