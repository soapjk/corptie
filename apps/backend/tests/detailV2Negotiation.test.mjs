import test from "node:test";
import assert from "node:assert/strict";
import { detailV2Negotiation, detailV2GetNegotiation, detailV2ServiceOptions, detailV2PinnedAuthenticate, DETAIL_TRANSPORT_CATALOGS, DETAIL_COMPONENTS_CATALOG } from "../src/application/detailV2Negotiation.mjs";
test("GET and POST negotiation produce one pinned capability digest", () => {
  const tokens = ["detail.chart", "detail.markdown"];
  const post = detailV2Negotiation(DETAIL_COMPONENTS_CATALOG, tokens);
  assert.equal(post.capabilityDigest, "sha256:6c854ba480d86ba739c2074461b63392be9efa4d6815b238ed3042c549ad75d2");
  assert.deepEqual(detailV2GetNegotiation({ headers: { accept: `application/json; corptie-detail=${DETAIL_COMPONENTS_CATALOG}`,
    "x-corptie-detail-capabilities": " detail.chart , detail.markdown " } }), post);
  assert.deepEqual(detailV2GetNegotiation({ headers: { accept: `application/json; corptie-detail=${DETAIL_COMPONENTS_CATALOG}`,
    "x-corptie-detail-capabilities": "" } }).clientCapabilities, []);
  assert.equal(detailV2Negotiation("native-v2").catalog, "native-v2");
});
test("capability headers and bodies reject missing, duplicate, unsorted or unregistered tokens", () => {
  for (const tokens of [undefined, ["detail.unknown"], ["detail.chart", "detail.chart"], ["detail.markdown", "detail.chart"],
    ["detail.chart,detail.markdown"], ["detail.é"], Array(33).fill("detail.chart")]) {
    assert.throws(() => detailV2Negotiation(DETAIL_COMPONENTS_CATALOG, tokens), { status: 400 });
  }
  for (const header of [undefined, " ", "detail.chart,", "detail.chart,detail.chart", "x".repeat(2049)]) {
    assert.throws(() => detailV2GetNegotiation({ headers: { accept: `application/json; corptie-detail=${DETAIL_COMPONENTS_CATALOG}`,
      "x-corptie-detail-capabilities": header } }), { status: 400 });
  }
  assert.throws(() => detailV2Negotiation("native-v2", []), { status: 400 });
});
test("service receives authenticated identity and normalized tokens but no trusted digest", () => {
  const identity = { principalId: "test-user" }, negotiation = detailV2Negotiation(DETAIL_COMPONENTS_CATALOG, ["detail.chart"]);
  const options = detailV2ServiceOptions(identity, negotiation);
  assert.equal(options.identity, identity);
  assert.deepEqual(options, { identity, catalog: DETAIL_COMPONENTS_CATALOG, clientCapabilities: ["detail.chart"] });
  assert.equal(options.capabilityDigest, undefined);
  options.clientCapabilities.push("detail.markdown"); assert.deepEqual(negotiation.clientCapabilities, ["detail.chart"]);
  assert.deepEqual(DETAIL_TRANSPORT_CATALOGS, ["native-v2"]);
});
test("HTTP authentication pins full trusted authority and canonical Session without accepting promises", () => {
  const identity = { serverId: "server", accountId: "account", principalId: "user", deviceId: "device" };
  let current = { ...identity }, session = "logical:one", checks = 0;
  const authenticate = detailV2PinnedAuthenticate(() => current, () => { checks++; return session; }, identity, session);
  assert.equal(authenticate(), current); assert.equal(checks, 1);
  for (const key of Object.keys(identity)) {
    current = { ...identity, [key]: "other" }; assert.throws(authenticate, { code: "DETAIL_SCOPE_CHANGED", status: 403 });
  }
  current = { ...identity }; session = "logical:two";
  assert.throws(authenticate, { code: "DETAIL_SCOPE_CHANGED" });
  current = Promise.resolve(identity); assert.throws(authenticate, { code: "DETAIL_IDENTITY_INVALID" });
  for (const invalid of [{}, { deviceId: "" }, { principalId: 4 }, { principalId: "user", accountId: "x".repeat(513) }]) {
    assert.throws(() => detailV2PinnedAuthenticate(() => invalid, () => "s", invalid, "s"), { status: 403 });
  }
});
