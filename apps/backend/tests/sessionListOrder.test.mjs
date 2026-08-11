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
  assert.equal(session.external, source.external);
  assert.equal(session.sortOrder, 4);
});

test("Provider order remains available when no persisted order exists", () => {
  const source = { id: "provider-session", sortOrder: 7 };
  const [session] = applyPersistedSessionOrder([source], () => null);
  assert.equal(session, source);
});
