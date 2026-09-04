import assert from "node:assert/strict";
import test from "node:test";
import { createScheduledSessionRouteResolver } from "../src/application/scheduledSessionRoute.mjs";

function fixture(overrides = {}) {
  const binding = { bindingId: "binding:one", state: "active", providerId: "test-provider" };
  const logical = {
    logicalSessionId: "logical:one",
    legacySessionId: "session:one",
    archived: false,
    activeBinding: binding,
    ...overrides.logical
  };
  const session = overrides.session === undefined ? { id: "session:one" } : overrides.session;
  const agent = overrides.agent === undefined ? { agentId: "agent:one" } : overrides.agent;
  return {
    binding,
    resolve: createScheduledSessionRouteResolver({
      store: {
        getLogicalSession: () => overrides.missingLogical ? null : logical,
        getSession: () => session
      },
      collaborationCore: { getAgentForSession: () => agent }
    })
  };
}

test("production Automation route satisfies the scheduler's provider-neutral contract", async () => {
  const { resolve, binding } = fixture();
  const route = await resolve("logical:one");
  assert.equal(route.sessionId, "session:one");
  assert.equal(route.agentId, "agent:one");
  assert.equal(route.binding, binding);
  assert.equal(Object.hasOwn(route, "assigneeAgentId"), false);
});

test("Automation route failures retain actionable boundary error codes", async () => {
  await assert.rejects(fixture({ missingLogical: true }).resolve("logical:one"), { code: "SESSION_NOT_FOUND" });
  await assert.rejects(fixture({ logical: { archived: true } }).resolve("logical:one"), { code: "SESSION_ARCHIVED" });
  await assert.rejects(fixture({ logical: { activeBinding: null } }).resolve("logical:one"), { code: "ROUTE_UNAVAILABLE" });
  await assert.rejects(fixture({ session: null }).resolve("logical:one"), { code: "SESSION_NOT_FOUND" });
  await assert.rejects(fixture({ agent: null }).resolve("logical:one"), { code: "AGENT_NOT_FOUND" });
});
