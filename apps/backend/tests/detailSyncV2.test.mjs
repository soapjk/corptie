import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalDetailV2, detailV2Hash, validateDetailV2, projectDetailV2,
  diffDetailV2, applyDetailV2, DetailV2Journal, DETAIL_V2_LIMITS } from "../src/application/detailSyncV2.mjs";
const fixture = JSON.parse(await readFile(new URL("../../../packages/CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures/detail-v2.json", import.meta.url)));
const v1 = JSON.parse(await readFile(new URL("../../../packages/CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures/detail-v1.json", import.meta.url)));
const clone = value => structuredClone(value);
const equalState = (actual, expected) => assert.equal(canonicalDetailV2(actual), canonicalDetailV2(expected));
function updated(before, change) {
  const document = clone(v1); document.revision = before.revision + 1; change(document);
  return projectDetailV2(document, before);
}
test("native-v2 cross-language canonical vectors are pinned", () => {
  for (const { value, canonical, hash } of fixture.vectors) {
    assert.equal(canonicalDetailV2(value), canonical); assert.equal(detailV2Hash(value), hash);
  }
  for (const value of [0.5, NaN, Infinity, 9007199254740992, undefined, "\ud800", new Date()]) {
    assert.throws(() => canonicalDetailV2(value));
  }
  assert.equal(detailV2Hash({ b: 1, a: 2 }), detailV2Hash({ a: 2, b: 1 }));
});
test("shared snapshot and commit converge; data-only update has no UI or unrelated text", () => {
  const before = clone(fixture.snapshot), commit = clone(fixture.commit);
  const after = applyDetailV2(before, commit);
  assert.equal(after.stateHash, fixture.resultStateHash);
  assert.deepEqual(commit.templates, {}); assert.equal(commit.manifestChange, null);
  assert.deepEqual(commit.instanceChanges[0].fields.set, { workName: "更新后的 Work" });
  assert.doesNotMatch(JSON.stringify(commit), /rootNodeId|semanticKind|fallback|Sample Work/);
  assert.strictEqual(applyDetailV2(after, commit), after);
  assert.deepEqual(before, fixture.snapshot);
});
test("bad hashes, gaps, identity changes, duplicate mutations fail without altering baseline", () => {
  for (const mutate of [c => c.baseRevision++, c => c.resultStateHash = c.baseStateHash,
    c => c.generation = "other", c => c.sessionId = "other", c => c.protocolVersion = 1,
    c => c.instanceChanges.push(clone(c.instanceChanges[0])),
    c => c.instanceChanges[0].fields.remove.push("workName"),
    c => c.instanceChanges[0].fields.remove.push("missing")]) {
    const before = clone(fixture.snapshot), bad = clone(fixture.commit); mutate(bad);
    assert.throws(() => applyDetailV2(before, bad)); assert.deepEqual(before, fixture.snapshot);
  }
});
test("template and data change are one atomic commit", () => {
  const before = fixture.snapshot;
  const after = updated(before, document => {
    document.cards[0].title.fallback = "New title"; document.cards[0].templateRevision++;
    document.cards[0].data.workName = "New data";
  });
  const commit = diffDetailV2(before, after);
  assert.equal(Object.keys(commit.templates).length, 1); assert.ok(commit.manifestChange);
  equalState(applyDetailV2(before, commit), after);
  const bad = clone(commit); bad.templates = {};
  assert.throws(() => applyDetailV2(before, bad));
});
test("added and removed instances follow manifest membership; stale templates are pruned", () => {
  const before = fixture.snapshot;
  const after = updated(before, document => {
    const card = clone(document.cards[0]); card.id = "new-card"; document.cards.push(card); document.order.push(card.id);
  });
  equalState(applyDetailV2(before, diffDetailV2(before, after)), after);
  const removedDoc = clone(v1); removedDoc.revision = after.revision + 1;
  const removed = projectDetailV2(removedDoc, after);
  equalState(applyDetailV2(after, diffDetailV2(after, removed)), removed);
});
test("null means data, remove means deletion; dangerous object keys do not mutate prototypes", () => {
  const before = fixture.snapshot;
  const after = updated(before, document => {
    document.cards[0].data = JSON.parse('{"sessionId":"logical:sample","workName":null,"__proto__":"literal"}');
  });
  equalState(applyDetailV2(before, diffDetailV2(before, after)), after);
  assert.equal({}.literal, undefined);
});
test("aggregate state size and safe revisions remain bounded", () => {
  const oversized = clone(fixture.snapshot); oversized.instances["session-info"].fields.large = "x".repeat(DETAIL_V2_LIMITS.bytes);
  assert.throws(() => validateDetailV2(oversized), { code: "DETAIL_V2_LIMIT" });
  const unsafe = clone(fixture.snapshot); unsafe.revision = 9007199254740992;
  assert.throws(() => validateDetailV2(unsafe));
});
test("resume coalesces missing commits and verifies client's applied cursor", () => {
  const journal = new DetailV2Journal(), before = fixture.snapshot;
  journal.publish(before);
  const second = updated(before, document => document.cards[0].data.workName = "second"); journal.publish(second);
  const third = updated(second, document => document.cards[0].data.workName = "third"); journal.publish(third);
  const cursor = { documentId: before.documentId, generation: before.generation, revision: before.revision, stateHash: before.stateHash };
  const result = journal.resume(cursor);
  assert.equal(result.kind, "commit"); equalState(applyDetailV2(before, result.value), third);
  assert.equal(journal.resume({ ...cursor, stateHash: "bad" }).kind, "snapshot");
  assert.equal(journal.resume({ ...cursor, revision: third.revision, stateHash: third.stateHash }).kind, "ready");
  third.instances["session-info"].fields.workName = "outside mutation";
  assert.equal(journal.resume().value.instances["session-info"].fields.workName, "third");
});
test("journal expires and bounds entries and bytes; generation reset needs snapshot", () => {
  let now = 0;
  const journal = new DetailV2Journal({ now: () => now, limits: { ...DETAIL_V2_LIMITS, journalEntries: 2, journalMs: 10 } });
  journal.publish(fixture.snapshot);
  const second = updated(fixture.snapshot, document => document.cards[0].data.workName = "second"); now = 11; journal.publish(second);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.resume({ ...fixture.snapshot }).kind, "snapshot");
  const reset = clone(second); reset.generation = "new-generation"; reset.revision = 1; journal.publish(reset);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.resume({ ...second }).kind, "snapshot");
  const tiny = new DetailV2Journal({ limits: { ...DETAIL_V2_LIMITS, journalBytes: 1 } });
  tiny.publish(fixture.snapshot); tiny.publish(second); assert.equal(tiny.entries.length, 1);
});
