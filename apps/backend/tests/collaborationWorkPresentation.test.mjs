import assert from "node:assert/strict";
import test from "node:test";

import { collaborationWorkPresentation } from "../src/collaboration/collaborationWorkPresentation.mjs";

test("collaboration timeline projections include names for both Work IDs", () => {
  const works = new Map([
    ["work:source", { id: "work:source", name: "Source Work" }],
    ["work:target", { id: "work:target", name: "Target Work" }]
  ]);
  const presentation = collaborationWorkPresentation(
    { getWork: (workId) => works.get(workId) ?? null },
    { sourceWorkId: "work:source", targetWorkId: "work:target" }
  );

  assert.deepEqual(presentation, {
    collaborationSourceWorkId: "work:source",
    collaborationSourceWorkName: "Source Work",
    collaborationTargetWorkId: "work:target",
    collaborationTargetWorkName: "Target Work"
  });
});

test("collaboration timeline projections preserve IDs when a Work is unavailable", () => {
  const presentation = collaborationWorkPresentation(
    { getWork: () => null },
    { sourceWorkId: "work:source", targetWorkId: null }
  );

  assert.deepEqual(presentation, {
    collaborationSourceWorkId: "work:source",
    collaborationSourceWorkName: null,
    collaborationTargetWorkId: null,
    collaborationTargetWorkName: null
  });
});
