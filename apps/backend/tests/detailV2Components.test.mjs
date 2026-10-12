import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { validateDetailV2Envelope } from "../src/application/detailV2Contract.mjs";
import { DETAIL_COMPONENTS_CATALOG, DETAIL_COMPONENT_CAPABILITIES, detailV2TemplateID,
  validateDetailV2Field } from "../src/application/detailV2Catalog.mjs";
import { validateDetailV2, detailV2Hash, detailV2StateHash, applyDetailV2, diffDetailV2,
  canonicalDetailV2, DetailV2Journal } from "../src/application/detailSyncV2.mjs";
import { DetailDocumentService } from "../src/application/detailDocumentService.mjs";

const bytes = readFileSync(new URL("./fixtures/detail-v2-components-sync.json", import.meta.url));
const fixture = JSON.parse(bytes);
const profile = { catalog: DETAIL_COMPONENTS_CATALOG, clientCapabilities: [...DETAIL_COMPONENT_CAPABILITIES] };
const clone = structuredClone;
const same = (a, b) => assert.equal(canonicalDetailV2(a), canonicalDetailV2(b));
function rehash(state, changeTemplate = false) {
  if (changeTemplate) {
    const template = Object.values(state.templates)[0];
    const { templateId, ...structure } = template;
    template.templateId = detailV2TemplateID(structure);
    const hash = detailV2Hash(template); state.templates = { [hash]: template };
    for (const ref of Object.values(state.manifest.cards)) { ref.templateId = template.templateId; ref.templateHash = hash; }
  }
  for (const instance of Object.values(state.instances)) instance.hash = detailV2Hash({ fields: instance.fields, collections: instance.collections, actions: instance.actions });
  state.manifest.hash = detailV2Hash({ cards: state.manifest.cards, order: state.manifest.order });
  state.stateHash = detailV2StateHash(state); return state;
}
test("fixed Swift two-card fixture hash and atomic collection commit agree with Node", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "f32330217621cf3fed731e10e2bbb21336b531c61e1fe69d4d63f42931774b69");
  assert.equal(Object.keys(fixture.snapshot.templates).length, 1);
  validateDetailV2(fixture.snapshot, profile);
  const next = applyDetailV2(fixture.snapshot, fixture.commit, profile);
  same(next, fixture.expectedState); same(next.instances.b, fixture.snapshot.instances.b);
  same(applyDetailV2(fixture.snapshot, diffDetailV2(fixture.snapshot, next, profile), profile), next);
  assert.strictEqual(applyDetailV2(next, fixture.commit, profile), next);
});
test("closed recursive field schemas share every Swift positive and negative case", async t => {
  for (const example of fixture.schemaCases) await t.test(example.name, () => {
    const check = () => validateDetailV2Field(example.schema, example.value);
    if (example.valid) assert.doesNotThrow(check); else assert.throws(check);
  });
});
test("legacy and reduced capabilities never accept rich templates", () => {
  assert.throws(() => validateDetailV2(fixture.snapshot));
  assert.throws(() => validateDetailV2(fixture.snapshot, { ...profile, clientCapabilities: [] }));
  assert.throws(() => validateDetailV2(fixture.snapshot, { ...profile, clientCapabilities: [...profile.clientCapabilities].reverse() }));
  assert.throws(() => new DetailV2Journal().publish(fixture.snapshot));
});
test("strict Request requires sorted whitelisted capabilities only for the new catalog", () => {
  const request = { protocolVersion: 2, ...profile, resume: null, cachedTemplateHashes: [] };
  validateDetailV2Envelope(request, "Request");
  for (const mutate of [v => delete v.clientCapabilities, v => v.clientCapabilities.reverse(),
    v => v.clientCapabilities.push(v.clientCapabilities[0]), v => v.clientCapabilities = ["detail.DateTime"],
    v => v.clientCapabilities = ["detail.execute"], v => v.principalId = "spoof", v => v.catalog = "native-v2"]) {
    const bad = clone(request); mutate(bad); assert.throws(() => validateDetailV2Envelope(bad, "Request"));
  }
  assert.throws(() => new DetailDocumentService({}).attachV2(null, () => ({}), "logical:sample", null, request), { status: 409 });
});
test("malformed schema, components and rooted graphs fail even with valid content hashes", () => {
  for (const mutate of [
    (s, t) => t.fieldSchema.title.execute = "script",
    (s, t) => t.fieldSchema.note = { type: "object", required: false, properties: { nested: { type: "array", required: false, maxItems: 21, items: { type: "bool", required: true } } } },
    (s, t) => t.card.nodes[0].children.push("root"),
    (s, t) => t.card.nodes.push(clone(t.card.nodes[1])),
    (s, t) => t.card.nodes[1].props.url = "https://example.invalid",
    (s, t) => t.requiredCapabilities.reverse(),
    (s, t) => t.card.nodes.find(n => n.kind === "detail.button").props.actionId = "missing",
    (s, t) => t.card.nodes.find(n => n.kind === "detail.form").props.controls[0].kind = "script",
    (s, t) => t.card.titleBinding = "missing",
    s => s.instances.a.fields.image = { resourceType: "artifact", id: "sample", url: "file:///secret" },
    s => s.instances.a.fields.progress = 101,
    s => s.instances.a.fields.time = "2026-10-11T21:00:00",
    s => s.instances.a.collections.resources.order.push("missing"),
    s => s.instances.a.collections.resources.nextCursor = "x".repeat(513),
    s => s.instances.a.fields.note = null
  ]) {
    const bad = clone(fixture.snapshot); mutate(bad, Object.values(bad.templates)[0]); rehash(bad, true);
    assert.throws(() => validateDetailV2(bad, profile));
  }
});
test("collection revisions and conflicting set/remove are rejected without changing baseline", () => {
  for (const mutate of [
    c => c.instanceChanges[0].collections.set.resources.revision = 1,
    c => { c.instanceChanges[0].collections.set.resources.nextCursor = "page:2"; },
    c => c.instanceChanges[0].collections.remove.push("resources"),
    c => c.instanceChanges[0].collections.remove.push("missing"),
    c => { c.instanceChanges[0].collections = { set: {}, remove: ["resources", "resources"] }; }
  ]) {
    const baseline = clone(fixture.snapshot), bad = clone(fixture.commit); mutate(bad);
    // Recompute result hashes so revision failures are not merely stale hashes.
    if (bad.instanceChanges[0].collections.set.resources) {
      const expected = clone(fixture.expectedState); expected.instances.a.collections.resources = clone(bad.instanceChanges[0].collections.set.resources);
      rehash(expected); bad.instanceChanges[0].resultHash = expected.instances.a.hash; bad.resultStateHash = expected.stateHash;
    }
    assert.throws(() => applyDetailV2(baseline, bad, profile)); same(baseline, fixture.snapshot);
  }
  const badHash = clone(fixture.commit); badHash.resultStateHash = badHash.baseStateHash;
  assert.throws(() => applyDetailV2(fixture.snapshot, badHash, profile));
  const unchangedPage = clone(fixture.expectedState); unchangedPage.instances.a.collections.resources = clone(fixture.snapshot.instances.a.collections.resources);
  unchangedPage.instances.a.collections.resources.revision++; rehash(unchangedPage);
  assert.throws(() => diffDetailV2(fixture.snapshot, unchangedPage, profile));
});
test("a journal freezes its catalog/capabilities and only resumes validated rich states", () => {
  const input = { ...profile, clientCapabilities: [...profile.clientCapabilities] };
  const journal = new DetailV2Journal(input); input.clientCapabilities.length = 0;
  journal.publish(fixture.snapshot); journal.publish(fixture.expectedState);
  const result = journal.resume(fixture.snapshot);
  if (result.kind === "commit") same(applyDetailV2(fixture.snapshot, result.value, profile), fixture.expectedState);
  else same(result.value, fixture.expectedState);
  assert.equal(journal.resume(fixture.expectedState).kind, "ready");
  assert.throws(() => journal.profile.clientCapabilities.push("detail.execute"));
});
