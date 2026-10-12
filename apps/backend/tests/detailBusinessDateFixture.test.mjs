import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detailBusinessDateFixture } from "./helpers/detailBusinessDateFixture.mjs";
import { applyDetailV2, canonicalDetailV2, validateDetailV2 } from "../src/application/detailSyncV2.mjs";

test("fixed actual business date State regenerates deterministically and strict delta converges", async () => {
  const fixed = JSON.parse(readFileSync(new URL("./fixtures/detail-v2-business-dates.json", import.meta.url)));
  assert.equal(canonicalDetailV2(await detailBusinessDateFixture()), canonicalDetailV2(fixed));
  assert.equal(canonicalDetailV2(await detailBusinessDateFixture()), canonicalDetailV2(fixed));
  const profile = { catalog: fixed.catalog, clientCapabilities: fixed.clientCapabilities };
  validateDetailV2(fixed.snapshot, profile);
  const next = applyDetailV2(fixed.snapshot, fixed.commit, profile);
  assert.equal(next.stateHash, fixed.expectedStateHash);
  assert.equal(fixed.snapshot.manifest.order.length, 10);
  assert.equal(fixed.snapshot.instances["business-schedules"].collections.resources.order.length, 20);
  assert.match(fixed.snapshot.instances["business-schedules"].fields.state, /更多内容尚未接线/);
  assert.equal(fixed.snapshot.instances["business-schedules"].fields.date0, undefined);
  assert.equal(next.instances["business-schedules"].fields.date0, "2026-10-11T04:00:00Z");
  assert.equal(next.instances["business-schedules"].fields.scheduledDate1, undefined);
  assert.equal(fixed.expectedDateInstants["2026-11-01T01:30:00-07:00"], "2026-11-01T08:30:00.000Z");
  assert.equal(fixed.expectedDateInstants["2026-11-01T01:30:00-08:00"], "2026-11-01T09:30:00.000Z");
  assert.equal(fixed.expectedDateInstants["2026-10-11T12:00:00+08:00"], fixed.expectedDateInstants["2026-10-11T04:00:00Z"]);
  assert.doesNotMatch(JSON.stringify(fixed), /do-not-export|fixture-principal|fixture-account|storageKey|locator|"path"/);
  assert.throws(() => validateDetailV2(fixed.snapshot, { ...profile, clientCapabilities: profile.clientCapabilities.filter(c => c !== "detail.dateTime") }));
});
