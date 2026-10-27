import assert from "node:assert/strict";
import test from "node:test";
import { loadDownloadCatalog, parseDownloadURL } from "../src/downloads.js";

test("downloads remain unpublished without verified release configuration", () => {
  assert.deepEqual(loadDownloadCatalog({}), { macOS: { version: null, dmgURL: null, pkgURL: null }, iOSURL: null, notesURL: null });
});

test("downloads accept versioned project assets and official mobile distribution", () => {
  const dmg = "https://github.com/soapjk/corptie/releases/download/v1.0/Corptie.dmg";
  const catalog = loadDownloadCatalog({ CORPTIE_CLOUD_DOWNLOAD_MACOS_VERSION: "1.0", CORPTIE_CLOUD_DOWNLOAD_MACOS_DMG_URL: dmg, CORPTIE_CLOUD_DOWNLOAD_IOS_URL: "https://testflight.apple.com/join/example" });
  assert.equal(catalog.macOS.dmgURL, dmg);
  assert.equal(catalog.macOS.version, "1.0");
  assert.equal(catalog.iOSURL, "https://testflight.apple.com/join/example");
  assert.throws(() => loadDownloadCatalog({ CORPTIE_CLOUD_DOWNLOAD_MACOS_DMG_URL: dmg }), /requires its version/);
  assert.throws(() => loadDownloadCatalog({ CORPTIE_CLOUD_DOWNLOAD_MACOS_VERSION: "1", CORPTIE_CLOUD_DOWNLOAD_MACOS_PKG_URL: dmg }), /PKG URL/);
});

test("download links reject credentials, foreign projects, schemes and mutable latest redirects", () => {
  for (const link of ["javascript:alert(1)", "http://github.com/soapjk/corptie/releases/download/v1/a.dmg", "https://github.com.evil.test/soapjk/corptie/releases/download/v1/a.dmg", "https://user:pass@github.com/soapjk/corptie/releases/download/v1/a.dmg", "https://github.com/other/project/releases/download/v1/a.dmg", "https://github.com/soapjk/corptie/releases/latest/download/a.dmg"]) {
    assert.throws(() => parseDownloadURL(link, "macOS"), Error, link);
  }
  assert.throws(() => parseDownloadURL("https://example.test/app", "iOS"));
});
