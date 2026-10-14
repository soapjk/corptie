import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { presentationFixture, presentationProfile, rehashPresentation } from "./helpers/detailPresentationFixture.mjs";
import { DETAIL_COMPONENTS_PROFILE_1 } from "../src/application/detailPresentationCatalog.mjs";
import { applyDetailV2, validateDetailV2, DetailV2Journal, canonicalDetailV2 } from "../src/application/detailSyncV2.mjs";
import { validateDetailV2Envelope } from "../src/application/detailV2Contract.mjs";
import { detailV2GetNegotiation } from "../src/application/detailV2Negotiation.mjs";
import { DetailDocumentService } from "../src/application/detailDocumentService.mjs";

const fixture = presentationFixture();
test("fixed cross-language fixture equals deterministic regeneration", () => {
  const fixed = JSON.parse(readFileSync(new URL("./fixtures/detail-v2-presentation.json", import.meta.url)));
  assert.equal(canonicalDetailV2(fixed), canonicalDetailV2(fixture));
});
test("profile2 native presentation preserves atomic collection commits and untouched instances", () => {
  validateDetailV2(fixture.snapshot, presentationProfile);
  const next = applyDetailV2(fixture.snapshot, fixture.commit, presentationProfile);
  assert.equal(canonicalDetailV2(next), canonicalDetailV2(fixture.expectedState));
  assert.deepEqual(next.instances.b, fixture.snapshot.instances.b);
  const journal = new DetailV2Journal({ ...presentationProfile });
  journal.publish(fixture.snapshot); journal.publish(next);
});
test("presentation props are closed, typed, and never accepted by frozen profile1", () => {
  for (const mutate of [
    t => t.card.nodes[1].props.initiallyExpanded = "false",
    t => t.card.nodes[1].props.previewBinding = "absent",
    t => t.card.nodes[1].props.previewBinding = "webData",
    t => t.card.nodes[3].props.itemBindings.body = "absent",
    t => t.card.nodes[3].props.itemBindings.script = "body",
    t => t.card.nodes[3].props.presentation = "table",
    t => t.card.nodes[4].props.presentationRole = "#ff0000",
    t => t.card.render.script = "injected",
    t => delete t.card.render,
    t => t.catalogProfile = DETAIL_COMPONENTS_PROFILE_1
  ]) {
    const bad = structuredClone(fixture.snapshot); mutate(Object.values(bad.templates)[0]); rehashPresentation(bad);
    assert.throws(() => validateDetailV2(bad, presentationProfile));
  }
  assert.throws(() => validateDetailV2(fixture.snapshot, { catalog: DETAIL_COMPONENTS_PROFILE_1, clientCapabilities: presentationProfile.clientCapabilities }));
  assert.throws(() => validateDetailV2(fixture.snapshot, { ...presentationProfile, clientCapabilities: [] }));
  const frozen = structuredClone(fixture.snapshot);
  Object.values(frozen.templates)[0].catalogProfile = DETAIL_COMPONENTS_PROFILE_1;
  rehashPresentation(frozen);
  assert.throws(() => validateDetailV2(frozen, { catalog: DETAIL_COMPONENTS_PROFILE_1, clientCapabilities: presentationProfile.clientCapabilities }));
});
test("web descriptors require explicit capability, closed object data, and fixed package identity", () => {
  const state = structuredClone(fixture.snapshot), template = Object.values(state.templates)[0];
  template.requiredCapabilities.push("detail.web");
  template.card.render = { kind: "web", rendererId: "detail.test-card", rendererVersion: 1,
    assetHash: "sha256:" + "a".repeat(64), dataBinding: "webData", bridgeVersion: 1 };
  rehashPresentation(state);
  const web = { ...presentationProfile, clientCapabilities: [...presentationProfile.clientCapabilities, "detail.web"] };
  validateDetailV2(state, web);
  assert.throws(() => validateDetailV2(state, presentationProfile));
  for (const change of [r => r.remoteURL = "https://example.com", r => r.dataBinding = "body",
    r => r.assetHash = "latest", r => r.assetHash += "\n", r => r.rendererVersion = 1.5, r => r.bridgeVersion = 2]) {
    const bad = structuredClone(state); change(Object.values(bad.templates)[0].card.render);
    assert.throws(() => validateDetailV2(rehashPresentation(bad), web));
  }
});
test("strict profile2 Request/header recognition still requires explicit host enablement", () => {
  const request = { protocolVersion: 2, ...presentationProfile, resume: null, cachedTemplateHashes: [] };
  validateDetailV2Envelope(request, "Request");
  const selected = detailV2GetNegotiation({ headers: { accept: "application/json; corptie-detail=" + request.catalog,
    "x-corptie-detail-capabilities": request.clientCapabilities.join(",") } });
  assert.equal(selected.catalog, request.catalog);
  assert.equal(new DetailDocumentService({}).acceptsDeliveryCatalog(request.catalog), false);
  assert.equal(new DetailDocumentService({}, { richReadEnabled: true }).acceptsDeliveryCatalog(request.catalog), true);
});
test("frozen profile1 refuses the new web capability and remains unchanged", () => {
  assert.throws(() => validateDetailV2Envelope({ protocolVersion: 2, catalog: DETAIL_COMPONENTS_PROFILE_1,
    clientCapabilities: ["detail.web"], resume: null, cachedTemplateHashes: [] }, "Request"));
  const old = JSON.parse(readFileSync(new URL("./fixtures/detail-v2-components-sync.json", import.meta.url)));
  validateDetailV2(old.snapshot, { catalog: DETAIL_COMPONENTS_PROFILE_1, clientCapabilities: presentationProfile.clientCapabilities });
});
