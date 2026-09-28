import assert from "node:assert/strict";
import test from "node:test";
import { createSessionTitleReservations } from "../src/application/sessionTitleReservations.mjs";

function fixture(identities = []) {
  return createSessionTitleReservations({
    store: {
      listSessionTitleIdentities: () => identities,
      getLogicalSession: (id) => id === "logical" ? { legacySessionId: "stored" } : null,
      getLogicalSessionByLegacySessionId: () => null
    }
  });
}

test("pending reservations reject normalized duplicates and release their title", () => {
  const titles = fixture();
  const release = titles.reserveSessionTitle("Alpha");
  assert.throws(() => titles.reserveSessionTitle(" alpha "), {
    code: "SESSION_TITLE_CONFLICT", statusCode: 409, suggestedTitle: "alpha 1"
  });
  assert.equal(titles.availableTitle("Alpha"), "Alpha 1");
  release();
  assert.equal(titles.availableTitle("Alpha"), "Alpha");
});

test("persisted conflict suggestions also exclude titles held by pending creations", () => {
  const titles = fixture([{ id: "stored", title: "Alpha" }]);
  titles.reserveSessionTitle("Alpha 1");
  assert.throws(() => titles.reserveSessionTitle("Alpha"), {
    code: "SESSION_TITLE_CONFLICT", conflictingSessionId: "stored", suggestedTitle: "Alpha 2"
  });
});

test("rename excludes the canonical stored identity of a logical session", () => {
  const titles = fixture([{ id: "stored", title: "Alpha" }]);
  const release = titles.reserveSessionTitle("Alpha", "logical");
  assert.equal(typeof release, "function");
  release();
});

test("agent title suggestions see the same pending reservation set", () => {
  const titles = fixture();
  const release = titles.reserveSessionTitle("Worker_Session");
  assert.equal(titles.availableAgentTitle("Worker"), "Worker_Session_1");
  release();
  assert.equal(titles.availableAgentTitle("Worker"), "Worker_Session");
});
