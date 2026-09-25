import assert from "node:assert/strict";
import test from "node:test";
import { changeSetForClaudeTool, changeSetForCodexItem } from "../src/utils/changeSetProjection.mjs";

test("Codex file changes keep ordered paths and bounded diff previews", () => {
  const changes = changeSetForCodexItem({ type: "fileChange", changes: [
    { path: "Sources/App.swift", kind: { type: "update" }, diff: "+ changed" },
    { path: "Sources/New.swift", kind: "add", diff: "x".repeat(2_500) }
  ] });
  assert.deepEqual(changes.changes.map((change) => [change.path, change.kind]), [
    ["Sources/App.swift", "modify"], ["Sources/New.swift", "add"]
  ]);
  assert.equal(changes.changes[0].diffPreview, "+ changed");
  assert.equal(changes.changes[1].diffPreview.length, 2_000);
  assert.equal(changes.changes[1].diffTruncated, true);
});

test("Claude file changes use verified input path and result type, without inventing an initial Write kind", () => {
  const draft = changeSetForClaudeTool("Write", { file_path: "/project/new.swift" });
  assert.equal(draft.changes[0].kind, "unknown");
  const committed = changeSetForClaudeTool("Write", { file_path: "/project/new.swift" }, {
    type: "create", filePath: "/project/new.swift", structuredPatch: [{ lines: ["+ hello"] }]
  });
  assert.deepEqual(committed.changes[0], {
    path: "/project/new.swift", kind: "add", diffPreview: "+ hello", diffTruncated: false
  });
  assert.equal(changeSetForClaudeTool("Bash", { file_path: "/project/new.swift" }), null);
});

test("one card never sends more than 8,000 diff-preview characters", () => {
  const projected = changeSetForCodexItem({ type: "fileChange", changes:
    Array.from({ length: 10 }, (_, index) => ({
      path: `Sources/${index}.swift`, kind: "update", diff: "x".repeat(2_000)
    })) });
  assert.equal(projected.changes.reduce((total, change) => total + (change.diffPreview?.length ?? 0), 0), 8_000);
  assert.equal(projected.changes[4].diffPreview, null);
  assert.equal(projected.changes[4].diffTruncated, true);
});
