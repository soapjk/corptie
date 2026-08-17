import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPersistedSessionOrder,
  storedSessionIdForListSession
} from "../src/application/sessionListOrder.mjs";

test("legacy-prefixed Claude sessions use Corptie's persisted list order", () => {
  const stored = new Map([
    ["claude-session", { sortOrder: 2 }]
  ]);
  const [session] = applyPersistedSessionOrder([
    { id: "pty:claude-session", sortOrder: -281, external: { provider: "claude-sdk" } }
  ], (id) => stored.get(id));

  assert.equal(storedSessionIdForListSession(session.id), "claude-session");
  assert.equal(session.sortOrder, 2);
});

test("canonical session ids and Provider fields remain unchanged", () => {
  const source = {
    id: "codex:session-a",
    sortOrder: -5,
    external: { provider: "codex-app-server" }
  };
  const [session] = applyPersistedSessionOrder([source], (id) => (
    id === source.id ? { sortOrder: 4 } : null
  ));

  assert.equal(session.id, source.id);
  assert.equal(session.external.provider, source.external.provider);
  assert.equal(session.sortOrder, 4);
});

test("Provider order remains available when no persisted order exists", () => {
  const source = { id: "provider-session", sortOrder: 7 };
  const [session] = applyPersistedSessionOrder([source], () => null);
  assert.equal(session, source);
});

test("third-party Provider sessions receive all persisted Corptie bindings", () => {
  const [session] = applyPersistedSessionOrder([
    {
      id: "openclacky:owned",
      title: "Provider title",
      sessionKind: "legacy",
      external: { provider: "openclacky" }
    }
  ], () => ({
    id: "openclacky:owned",
    title: "Corptie title",
    agentId: "agent:liang",
    objectiveId: "objective:poly",
    workItemId: "work-item:poly",
    sessionKind: "worker",
    sortOrder: 3,
    archived: false,
    pinned: false,
    external: {}
  }));

  assert.equal(session.external.provider, "openclacky");
  assert.equal(session.agentId, "agent:liang");
  assert.equal(session.workItemId, "work-item:poly");
  assert.equal(session.sessionKind, "worker");
});
