import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { detailBusinessInteractiveFixture } from "./helpers/detailBusinessInteractiveFixture.mjs";
import { canonicalDetailV2 } from "../src/application/detailSyncV2.mjs";
test("actual paged/form producer shares a deterministic strict delta fixture with Swift", async () => {
  const path = new URL("../../../packages/CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures/detail-v2-business-interactive.json", import.meta.url);
  const fixed = JSON.parse(await readFile(path, "utf8"));
  // Producer dictionaries deliberately have null prototypes; JSON wire values
  // do not. Compare the strict canonical wire value, not object prototypes.
  assert.equal(canonicalDetailV2(detailBusinessInteractiveFixture()), canonicalDetailV2(fixed));
  assert.equal(canonicalDetailV2(detailBusinessInteractiveFixture()), canonicalDetailV2(fixed));
  assert.equal(fixed.snapshot.instances["business-references"].collections.resources.nextCursor, "opaque-lease-interactive");
  assert.equal(fixed.snapshot.instances["business-references"].actions.page.available, true);
  assert.equal(fixed.expectedState.instances["business-references"].collections.resources.nextCursor, null);
  assert.equal(fixed.expectedState.instances["memory-editor-interactive"].actions.save.expectedResourceRevision, "revision-2");
});
