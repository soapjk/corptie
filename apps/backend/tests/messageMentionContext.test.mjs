import assert from "node:assert/strict";
import test from "node:test";
import { resolveMessageMentionContext } from "../src/application/messageMentionContext.mjs";

const store = {
  getSession(id) {
    return id === "logical:review" ? { id, title: "Review Session" } : null;
  },
  getWork(id) {
    return id === "work:console" ? { id, name: "Console" } : null;
  }
};

test("message mentions resolve authoritative names and preserve resource boundaries", () => {
  const result = resolveMessageMentionContext(store, "logical:owner", [
    { targetType: "session", targetId: "logical:review", displayName: "Spoofed" },
    { targetType: "work", targetId: "work:console", displayName: "Spoofed" },
    { targetType: "session", targetId: "logical:review", displayName: "Duplicate" }
  ]);
  assert.deepEqual(result.mentions, [
    { targetType: "session", targetId: "logical:review", displayName: "Review Session" },
    { targetType: "work", targetId: "work:console", displayName: "Console" }
  ]);
  assert.match(result.prompt, /Work is context scope, not a message recipient/);
});

test("message mentions ignore self references and deleted resources", () => {
  assert.equal(resolveMessageMentionContext(store, "logical:review", [
    { targetType: "session", targetId: "logical:review", displayName: "Self" },
    { targetType: "work", targetId: "work:missing", displayName: "Missing" }
  ]), null);
});
