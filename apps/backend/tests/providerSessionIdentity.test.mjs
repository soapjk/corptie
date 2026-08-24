import assert from "node:assert/strict";
import test from "node:test";
import { resolveStableSessionIdForProviderDetail } from "../src/application/providerSessionIdentity.mjs";

function fixture({ logical = null, sessions = [] } = {}) {
  const byID = new Set(sessions);
  return {
    getLogicalSessionByLegacySessionId: (id) => (
      id === logical?.legacySessionId ? logical : null
    ),
    getLogicalSessionByProviderSessionId: (providerId, id) => (
      providerId === logical?.providerId && id === logical?.providerSessionId ? logical : null
    ),
    getLogicalSessionByProviderThreadId: (id) => (
      id === logical?.providerThreadId ? logical : null
    ),
    getSession: (id) => (byID.has(id) ? { id } : null)
  };
}

test("physical Provider detail ids resolve to the stable Logical Session projection", () => {
  const store = fixture({
    logical: {
      legacySessionId: "session:stable",
      providerId: "openclacky",
      providerSessionId: "physical:one",
      providerThreadId: "physical:one"
    }
  });

  assert.equal(resolveStableSessionIdForProviderDetail({
    store,
    providerId: "openclacky",
    physicalSessionId: "physical:one"
  }), "session:stable");
});

test("legacy provider-only detail ids resolve to the prefixed durable Session", () => {
  const store = fixture({ sessions: ["openclacky:physical-one"] });

  assert.equal(resolveStableSessionIdForProviderDetail({
    store,
    providerId: "openclacky",
    physicalSessionId: "physical-one"
  }), "openclacky:physical-one");
  assert.equal(resolveStableSessionIdForProviderDetail({
    store,
    providerId: "openclacky",
    physicalSessionId: "openclacky:physical-one"
  }), "openclacky:physical-one");
});

test("unknown Provider details are rejected instead of writing an orphan timeline", () => {
  assert.equal(resolveStableSessionIdForProviderDetail({
    store: fixture(),
    providerId: "openclacky",
    physicalSessionId: "missing"
  }), null);
});
