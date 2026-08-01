import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSessionCommitMessage, sessionCommitMessagePrompt } from "../src/utils/sessionCommitMessage.mjs";

test("sanitizeSessionCommitMessage keeps one clean subject line", () => {
  assert.equal(sanitizeSessionCommitMessage('Commit message: "Fix workspace deletion"\nExtra'), "Fix workspace deletion");
  assert.equal(sanitizeSessionCommitMessage("`Preserve changes before merge.`"), "Preserve changes before merge");
  assert.equal(sanitizeSessionCommitMessage("x".repeat(100)).length, 72);
});

test("sessionCommitMessagePrompt includes local change context and forbids tools", () => {
  const prompt = sessionCommitMessagePrompt({
    sourceBranch: "feature/delete-flow",
    statusSummary: "M app.swift",
    diffStat: "app.swift | 2 ++"
  });
  assert.match(prompt, /feature\/delete-flow/);
  assert.match(prompt, /M app\.swift/);
  assert.match(prompt, /Do not call tools/);
});
