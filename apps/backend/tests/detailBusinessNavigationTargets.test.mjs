import test from "node:test";
import assert from "node:assert/strict";
import { detailBusinessNavigationTarget } from "../src/application/detailBusinessNavigationTargets.mjs";
import { createDetailBusinessReadPorts } from "../src/application/detailBusinessReadPorts.mjs";

test("focus Task target preserves exact authorized read-port Session, never Task/current Session fallback", () => {
  const task = { id: "task", title: "Task", current_session_id: "session-b" };
  const sessions = new Map([["session-a", { id: "session-a", taskId: "task" }], ["session-b", { id: "session-b", taskId: "task" }]]);
  const ports = createDetailBusinessReadPorts({ store: {
    listTasksByWork: () => [task], getSession: id => sessions.get(id),
    getLogicalSessionByLegacySessionId: id => ({ logicalSessionId: `logical:${id}`, legacySessionId: id })
  } });
  const scope = { session: { id: "current-work-chat", sessionKind: "workChat" }, work: { id: "work" } };
  const before = ports.focusTasks.read(scope).items[0];
  assert.deepEqual(detailBusinessNavigationTarget("focusTasks", before), { resourceType: "session", id: "logical:session-b" });
  task.current_session_id = "session-a";
  const after = ports.focusTasks.read(scope).items[0];
  assert.deepEqual(before.resource, after.resource); // stable collection row Task ID
  assert.deepEqual(detailBusinessNavigationTarget("focusTasks", after), { resourceType: "session", id: "logical:session-a" });
  assert.deepEqual(detailBusinessNavigationTarget("focusTasks", before), { resourceType: "session", id: "logical:session-b" });
  sessions.get("session-a").taskId = "another-task";
  assert.equal(detailBusinessNavigationTarget("focusTasks", ports.focusTasks.read(scope).items[0]), null);
  sessions.get("session-a").taskId = "task"; sessions.get("session-a").archived = true;
  assert.equal(detailBusinessNavigationTarget("focusTasks", ports.focusTasks.read(scope).items[0]), null);
});

test("missing or malformed focus Session association refuses navigation without mutating the row", () => {
  const resource = { resourceType: "task", id: "task" };
  for (const target of [null, undefined, { resourceType: "task", id: "task" }, { resourceType: "session", id: "" },
    { resourceType: "session", id: "x".repeat(513) }, { resourceType: "session", id: "session\ncommand" }]) {
    assert.equal(detailBusinessNavigationTarget("focusTasks", { resource, sessionTarget: target }), null);
  }
  const row = Object.freeze({ resource: Object.freeze(resource), sessionTarget: Object.freeze({ resourceType: "session", id: "exact" }) });
  assert.deepEqual(detailBusinessNavigationTarget("focusTasks", row), { resourceType: "session", id: "exact" });
  assert.equal(detailBusinessNavigationTarget("focusTasks", { resource: { resourceType: "reference", id: "task" }, sessionTarget: row.sessionTarget }), null);
});

test("other modules only resolve registered semantic resource types, not paths, URLs or injected targets", () => {
  for (const [name, source, target] of [["references", "contextReference", "reference"], ["artifacts", "artifact", "artifact"],
    ["memories", "memory", "memory"], ["schedules", "automation", "schedule"]]) {
    const row = { resource: { resourceType: source, id: "resource" }, locator: "/private/secret", url: "https://evil.invalid",
      sessionTarget: { resourceType: "session", id: "injected" } };
    assert.deepEqual(detailBusinessNavigationTarget(name, row), { resourceType: target, id: "resource" });
    assert.equal(detailBusinessNavigationTarget(name, { resource: { resourceType: "session", id: "injected" } }), null);
  }
  for (const name of ["provider", "worktree", "turn", "recalls", "unknown", "__proto__"]) {
    assert.equal(detailBusinessNavigationTarget(name, { resource: { resourceType: "task", id: "task" } }), null);
  }
});
