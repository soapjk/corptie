import assert from "node:assert/strict";
import test from "node:test";
import { storedSessionIdForListSession } from "../src/application/sessionListOrder.mjs";

test("transport-prefixed Session commands resolve the stable stored identity", () => {
  assert.equal(storedSessionIdForListSession("pty:claude-session"), "claude-session");
  assert.equal(storedSessionIdForListSession("codex:session-a"), "codex:session-a");
});
