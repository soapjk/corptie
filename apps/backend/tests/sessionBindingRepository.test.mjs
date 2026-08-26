import assert from "node:assert/strict";
import test from "node:test";
import { SessionBindingRepository } from "../src/agent-provider/sessionBindingRepository.mjs";

function fixture() {
  const sessions = new Map([
    ["codex:legacy-a", {
      id: "codex:legacy-a",
      external: { provider: "codex-app-server", threadId: "native-a" }
    }],
    ["pty:claude-a", {
      id: "pty:claude-a",
      external: { provider: "claude-sdk", threadId: "claude-a" }
    }]
  ]);
  const logical = {
    logicalSessionId: "logical:a",
    legacySessionId: "codex:legacy-a",
    routingVersion: 4,
    activeBinding: {
      bindingId: "binding:a",
      providerId: "codex-app-server",
      providerSessionId: "native-after-fork",
      providerMetadata: { source: "migration-test" }
    }
  };
  const store = {
    getLogicalSession: (id) => id === logical.logicalSessionId ? logical : null,
    getLogicalSessionByLegacySessionId: (id) => id === logical.legacySessionId ? logical : null,
    getSession: (id) => sessions.get(id) ?? null,
    listProviderThreadBindings: (id) => id === logical.logicalSessionId ? [
      logical.activeBinding,
      {
        bindingId: "binding:old",
        providerId: "fake-history",
        providerSessionId: "native-before-fork",
        providerMetadata: { source: "history" },
        routingVersion: 3,
        state: "superseded"
      }
    ] : []
  };
  return new SessionBindingRepository({
    store
  });
}

test("binding repository resolves stable Logical Session ids without exposing prefixes", () => {
  const reference = fixture().resolve("logical:a");
  assert.equal(reference.requestedSessionId, "logical:a");
  assert.equal(reference.sessionId, "codex:legacy-a");
  assert.equal(reference.logicalSessionId, "logical:a");
  assert.equal(reference.bindingId, "binding:a");
  assert.equal(reference.providerId, "codex-app-server");
  assert.equal(reference.providerSessionId, "native-after-fork");
  assert.deepEqual(reference.metadata.providerMetadata, { source: "migration-test" });
});

test("binding repository keeps legacy ids as aliases during migration", () => {
  const reference = fixture().resolve("codex:legacy-a");
  assert.equal(reference.logicalSessionId, "logical:a");
  assert.equal(reference.providerSessionId, "native-after-fork");
});

test("binding repository maps an unbound Claude Session to its Provider", () => {
  const reference = fixture().resolve("pty:claude-a");
  assert.equal(reference.logicalSessionId, null);
  assert.equal(reference.providerId, "claude-sdk");
  assert.equal(reference.providerSessionId, "claude-a");
});

test("binding repository delegates legacy Provider aliases to the Registry resolver", () => {
  const session = {
    id: "legacy-openclacky",
    external: { provider: "clacky", sessionId: "native-clacky-a" }
  };
  const repository = new SessionBindingRepository({
    store: {
      getLogicalSession: () => null,
      getLogicalSessionByLegacySessionId: () => null,
      getSession: () => session
    },
    resolveProviderId: (identity) => identity === "clacky" ? "openclacky" : null
  });

  const reference = repository.resolve(session.id);
  assert.equal(reference.providerId, "openclacky");
  assert.equal(reference.providerSessionId, "native-clacky-a");
});

test("binding repository returns null for unknown Sessions", () => {
  assert.equal(fixture().resolve("missing"), null);
});

test("binding repository resolves a historical binding without Provider-specific routing", () => {
  const reference = fixture().resolveBinding("logical:a", "binding:old");
  assert.equal(reference.logicalSessionId, "logical:a");
  assert.equal(reference.bindingId, "binding:old");
  assert.equal(reference.providerId, "fake-history");
  assert.equal(reference.providerSessionId, "native-before-fork");
  assert.equal(reference.metadata.historical, true);
});
