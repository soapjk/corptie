import assert from "node:assert/strict";
import test from "node:test";
import { loadDownloadCatalog } from "../src/downloads.js";
import { createWebsiteHandler } from "../src/websitePages.js";

const options = { baseURL: "https://cloud.example.test", version: "release-1", downloads: loadDownloadCatalog({}), publicRegistration: true, environment: "production" as const };

test("public pages, HEAD and private account shell are isolated from API routing", async () => {
  const handle = createWebsiteHandler(options);
  for (const path of ["/", "/download", "/account", "/assets/site.css", "/assets/web-http.js", "/assets/account.js", "/robots.txt", "/sitemap.xml"]) {
    const get = await handle(new Request(options.baseURL + path));
    const head = await handle(new Request(options.baseURL + path, { method: "HEAD" }));
    assert.equal(get?.status, 200, path); assert.equal(head?.status, 200, path);
    assert.equal(await head!.text(), ""); assert.deepEqual([...head!.headers], [...get!.headers]);
    assert.ok((await get!.text()).length > 0);
    assert.ok((await (await handle(new Request(options.baseURL + path)))!.text()).length > 0, "cached bytes support repeated requests");
  }
  for (const path of ["/api/auth/get-session", "/v1/devices", "/v1/relay", "/unknown"]) assert.equal(await handle(new Request(options.baseURL + path)), null);
  assert.equal(await handle(new Request(options.baseURL, { method: "POST" })), null);
  const page = await handle(new Request(options.baseURL));
  assert.equal(page!.headers.get("cache-control"), "public, max-age=60");
  const account = await handle(new Request(options.baseURL + "/account"));
  assert.equal(account!.headers.get("cache-control"), "no-store");
  const html = await account!.text();
  assert.match(html, /noindex, nofollow/); assert.match(html, /data-profile hidden/);
  assert.doesNotMatch(html, /data-name>[^<]+</);
});

test("release availability, registration switch and metadata accurately describe configured state", async () => {
  const handle = createWebsiteHandler({ ...options, publicRegistration: false });
  const home = await (await handle(new Request(options.baseURL)))!.text();
  assert.doesNotMatch(home, /href="\/auth\/sign-up"/);
  assert.match(home, /rel="canonical" href="https:\/\/cloud.example.test\/"/);
  const download = await (await handle(new Request(options.baseURL + "/download")))!.text();
  assert.match(download, /暂未开放下载/); assert.match(download, /移动端下载入口待发布/);
  assert.doesNotMatch(download, /href="https:\/\/github.com/);
  const published = createWebsiteHandler({ ...options, downloads: loadDownloadCatalog({ CORPTIE_CLOUD_DOWNLOAD_MACOS_VERSION: "1.0", CORPTIE_CLOUD_DOWNLOAD_MACOS_DMG_URL: "https://github.com/soapjk/corptie/releases/download/v1.0/app.dmg" }) });
  assert.match(await (await published(new Request(options.baseURL + "/download")))!.text(), /下载 DMG/);
  const sitemap = await (await handle(new Request(options.baseURL + "/sitemap.xml")))!.text();
  assert.equal((sitemap.match(/<loc>/g) ?? []).length, 2); assert.doesNotMatch(sitemap, /account|auth/);
});

test("public document and browser asset budget stays below 80 KiB without background fetching", async () => {
  const handle = createWebsiteHandler(options); let bytes = 0;
  for (const path of ["/", "/download", "/account", "/assets/site.css", "/assets/web-http.js", "/assets/account.js"]) {
    bytes += (await (await handle(new Request(options.baseURL + path)))!.arrayBuffer()).byteLength;
  }
  assert.ok(bytes < 80 * 1024, `website bytes ${bytes}`);
  const home = await (await handle(new Request(options.baseURL)))!.text();
  assert.doesNotMatch(home, /<script|iframe|video/);
  const dev = createWebsiteHandler({ ...options, environment: "development" });
  assert.equal((await dev(new Request(options.baseURL)))!.headers.get("cache-control"), "no-store");
});
