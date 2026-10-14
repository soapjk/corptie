import test from "node:test";
import assert from "node:assert/strict";
import { detailMigrationConfiguration } from "../src/application/detailMigrationConfiguration.mjs";
import { DetailDocumentService } from "../src/application/detailDocumentService.mjs";

test("application migration registers read/native editors on both hosts but preview cannot execute writes", () => {
  for (const developmentPreview of [true, false]) {
    const config = detailMigrationConfiguration({ developmentPreview });
    assert.equal(config.richReadEnabled, true);
    assert.equal(config.richNativeEditorsEnabled, true);
    assert.equal(config.richWritesEnabled, !developmentPreview);
    assert.equal(config.detailWritesAllowed, !developmentPreview);
    assert.equal(Object.isFrozen(config), true);
    // No catalog/command is advertised until every real read port exists.
    const service = new DetailDocumentService({}, config);
    assert.deepEqual(service.deliveryCapabilities().catalogs, ["native-v2"]);
    assert.equal(service.deliveryCapabilities().writes, false);
  }
  for (const developmentPreview of [undefined, null, "false", 0]) {
    assert.throws(() => detailMigrationConfiguration({ developmentPreview }), /CONFIGURATION_REQUIRED/);
  }
});
