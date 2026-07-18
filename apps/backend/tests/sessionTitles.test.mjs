import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSessionTitleAvailable,
  deduplicateSessionTitles,
  findSessionTitleConflict,
  normalizeSessionTitle,
  suggestAvailableSessionTitle
} from "../src/utils/sessionTitles.mjs";

test("session title matching ignores surrounding whitespace, case and Unicode width", () => {
  assert.equal(normalizeSessionTitle("  Ｄｅｆａｕｌｔ  "), "default");
  assert.equal(
    findSessionTitleConflict([{ id: "one", title: "Default" }], " default ")?.id,
    "one"
  );
});

test("renaming a session to its current normalized title is allowed", () => {
  assert.doesNotThrow(() =>
    assertSessionTitleAvailable([{ id: "one", title: "Default" }], " default ", "one")
  );
});

test("duplicate session titles fail with a conflict response", () => {
  assert.throws(
    () => assertSessionTitleAvailable([{ id: "one", title: "Default" }], "default"),
    (error) => error.code === "SESSION_TITLE_CONFLICT" && error.statusCode === 409
  );
});

test("the next available title starts at one and skips occupied suffixes", () => {
  const sessions = [
    { id: "one", title: "Dashboard" },
    { id: "two", title: "dashboard 1" },
    { id: "three", title: "Dashboard 2" },
    { id: "four", title: "Dashboard 4" }
  ];

  assert.equal(suggestAvailableSessionTitle(sessions, "Dashboard"), "Dashboard 3");
});

test("historical duplicate titles receive deterministic numeric suffixes", () => {
  const sessions = deduplicateSessionTitles([
    { id: "one", title: "Corptie" },
    { id: "two", title: " corptie " },
    { id: "three", title: "Corptie (2)" },
    { id: "four", title: "CORPTIE" }
  ]);

  assert.deepEqual(sessions.map((session) => session.title), [
    "Corptie",
    "corptie 1",
    "Corptie (2)",
    "CORPTIE 2"
  ]);
});
