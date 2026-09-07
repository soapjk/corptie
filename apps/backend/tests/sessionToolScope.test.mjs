import assert from "node:assert/strict";
import test from "node:test";
import { assertSessionToolScope } from "../src/application/sessionToolScope.mjs";

test("authenticated assistant Sessions can use their exact Tool Host binding", () => {
  const result = assertSessionToolScope({
    actorId: "agent:investment",
    providerBindingId: "binding:investment",
    session: { id: "session:investment", sessionKind: "assistantChat", agentId: "agent:investment" },
    metadata: { providerBindingId: "binding:investment" }
  });
  assert.equal(result.sessionId, "session:investment");
});

test("Session Tool scope rejects a different actor or stale binding", () => {
  const base = {
    actorId: "agent:investment",
    providerBindingId: "binding:investment",
    session: { id: "session:investment", sessionKind: "assistantChat", agentId: "agent:investment" },
    metadata: { providerBindingId: "binding:investment" }
  };
  assert.throws(() => assertSessionToolScope({ ...base, actorId: "agent:other" }), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
  assert.throws(() => assertSessionToolScope({ ...base, providerBindingId: "binding:stale" }), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
});
