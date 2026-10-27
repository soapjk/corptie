import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml, renderDocument } from "../src/websiteHtml.js";

test("document metadata and asset revisions escape attributes without inline scripts", async () => {
  const response = renderDocument({ title: '<script>"', description: 'a&b', body: "<main>Safe content</main>", styles: ["/site.css"], scripts: ["/http.js", "/account.js"], assetVersion: 'release"1', noIndex: true });
  const html = await response.text();
  assert.match(html, /&lt;script&gt;&quot;/);
  assert.match(html, /content="a&amp;b"/);
  assert.match(html, /noindex, nofollow/);
  assert.match(html, /http\.js\?v=release%221/);
  assert.ok(html.indexOf("/http.js") < html.indexOf("/account.js"));
  assert.doesNotMatch(html, /<script>/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(escapeHtml("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;");
});
