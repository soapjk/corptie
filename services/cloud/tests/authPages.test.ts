import assert from "node:assert/strict";
import test from "node:test";
import { authPageResponse } from "../src/authPages.js";

test("account pages are small same-origin pages with strict browser protections", async () => {
  const response = await authPageResponse(new Request("https://cloud.example.test/auth/sign-in"), {
    verifyOAuthPageQuery: async () => false
  });
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /登录 Corptie/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /<script src="\/auth\/assets\/auth\.js" defer><\/script>/);
  assert.doesNotMatch(html, /<script[^>]*>[^<]+<\/script>/);
});

test("OAuth pages reject invalid signed requests before rendering", async () => {
  const observed: string[] = [];
  const dependencies = {
    verifyOAuthPageQuery: async (query: string) => {
      observed.push(query);
      return query.includes("sig=valid");
    }
  };
  const rejected = await authPageResponse(
    new Request("https://cloud.example.test/auth/consent?client_id=native&scope=openid&sig=invalid"),
    dependencies
  );
  assert.equal(rejected?.status, 400);

  const accepted = await authPageResponse(
    new Request("https://cloud.example.test/auth/consent?client_id=native&scope=openid%20devices%3Aread&sig=valid"),
    dependencies
  );
  assert.equal(accepted?.status, 200);
  const html = await accepted?.text();
  assert.match(html ?? "", /确认你的身份/);
  assert.match(html ?? "", /查看你的设备/);
  assert.match(html ?? "", /data-oauth-query="client_id=native&amp;scope=openid\+devices%3Aread&amp;sig=valid"/);
  assert.deepEqual(observed, [
    "client_id=native&scope=openid&sig=invalid",
    "client_id=native&scope=openid+devices%3Aread&sig=valid"
  ]);
});

test("password reset page requires a reset token", async () => {
  const dependencies = { verifyOAuthPageQuery: async () => false };
  const missing = await authPageResponse(new Request("https://cloud.example.test/auth/reset-password"), dependencies);
  assert.equal(missing?.status, 400);
  const present = await authPageResponse(new Request("https://cloud.example.test/auth/reset-password?token=secret-token"), dependencies);
  assert.equal(present?.status, 200);
  assert.match(await present!.text(), /data-token="secret-token"/);
});
