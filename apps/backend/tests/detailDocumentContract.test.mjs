import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateDetailContract, DETAIL_COMPONENT_KINDS, detailSchema } from "../src/application/detailDocumentContract.mjs";

const fixtures = new URL("../../../packages/CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures/", import.meta.url);
const document = JSON.parse(await readFile(new URL("detail-v1.json", fixtures)));
const action = JSON.parse(await readFile(new URL("detail-action-v1.json", fixtures)));
test("one schema accepts the shared document and the reserved action request, not authority injection", () => {
  assert.equal(validateDetailContract(document, "Document"), document);
  assert.equal(validateDetailContract(action, "ActionRequest"), action);
  assert.throws(() => validateDetailContract({ ...action, endpoint: "/automations/other/cancel" }, "ActionRequest"));
  assert.throws(() => validateDetailContract({ ...action, actorId: "other" }, "ActionRequest"));
});
test("unknown optional fields are additive; unknown component props locally fall back", () => {
  const next = structuredClone(document); next.future = true;
  next.cards[0].nodes[2] = { ...next.cards[0].nodes[2], kind: "future-widget", props: { text: [1, 2, 3], actionId: 9 } };
  assert.doesNotThrow(() => validateDetailContract(next, "Document"));
});
test("root major, unsafe integer, orphan, duplicate and diamond graph all fail closed", () => {
  const mutations = [
    next => { next.schemaVersion = 2; },
    next => { next.revision = 9007199254740992; },
    next => { next.cards[0].nodes.push({ id: "orphan", kind: "text", props: {}, children: [] }); },
    next => { next.cards[0].nodes[0].children = ["work", "work"]; },
    next => { next.cards[0].nodes[1].children = ["work"]; }
  ];
  for (const mutate of mutations) { const next = structuredClone(document); mutate(next); assert.throws(() => validateDetailContract(next, "Document")); }
});
test("patches require monotonic base, unique removals and disjoint upserts", () => {
  const patch = { documentId: document.documentId, sessionId: document.sessionId, generation: document.generation,
    baseRevision: 1, revision: 2, upsertCards: [], removeCardIds: ["session-info"], order: [] };
  assert.doesNotThrow(() => validateDetailContract(patch, "Patch"));
  for (const invalid of [{ ...patch, revision: 1 }, { ...patch, removeCardIds: ["session-info", "session-info"] },
      { ...patch, upsertCards: document.cards }]) assert.throws(() => validateDetailContract(invalid, "Patch"));
});
test("native-v1 catalog and frozen envelope stay pinned", () => {
  assert.deepEqual(DETAIL_COMPONENT_KINDS, ["column", "row", "section", "text", "markdown", "divider", "disclosure"]);
  assert.deepEqual(detailSchema.definitions.Document.required, ["schemaVersion", "documentId", "sessionId", "generation", "revision", "cards", "order"]);
  const digest = createHash("sha256").update(JSON.stringify(detailSchema)).digest("hex");
  assert.equal(digest, "0b999c954bdd82133e074d85e0d20415df36e1953ea9f346167f7f2e6f5d1d15");
});
