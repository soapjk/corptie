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
  assert.match(html, /创建账号/);
  assert.doesNotMatch(html, /邀请码/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /<script src="\/auth\/assets\/auth\.js" defer><\/script>/);
  assert.doesNotMatch(html, /<script[^>]*>[^<]+<\/script>/);
});

test("public sign-up is direct, accessible, and can be closed by configuration", async () => {
  const dependencies = { verifyOAuthPageQuery: async () => false, publicRegistration: true };
  const response = await authPageResponse(new Request("https://cloud.example.test/auth/sign-up"), dependencies);
  assert.equal(response?.status, 200);
  const html = await response!.text();
  assert.match(html, /填写以下信息即可注册，无需邀请码/);
  assert.match(html, /data-page="sign-up"/);
  assert.match(html, /autocomplete="new-password"/);
  assert.doesNotMatch(html, /name="code"/);

  const closed = await authPageResponse(new Request("https://cloud.example.test/auth/sign-up"), {
    ...dependencies,
    publicRegistration: false
  });
  assert.equal(closed?.status, 200);
  assert.match(await closed!.text(), /公开注册当前已关闭/);
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

test("email verification has explicit success and error landing pages", async () => {
  const dependencies = { verifyOAuthPageQuery: async () => false };
  const success = await authPageResponse(new Request("https://cloud.example.test/auth/verified"), dependencies);
  assert.equal(success?.status, 200);
  assert.match(await success!.text(), /邮箱已验证/);

  const expired = await authPageResponse(
    new Request("https://cloud.example.test/auth/verified?error=TOKEN_EXPIRED"),
    dependencies
  );
  assert.equal(expired?.status, 200);
  const expiredHtml = await expired!.text();
  assert.match(expiredHtml, /验证链接已过期/);
  assert.match(expiredHtml, /发送新的验证邮件/);

  const invalid = await authPageResponse(
    new Request("https://cloud.example.test/auth/verified?error=INVALID_TOKEN"),
    dependencies
  );
  assert.equal(invalid?.status, 200);
  assert.match(await invalid!.text(), /验证链接无效/);

  const script = await authPageResponse(new Request("https://cloud.example.test/auth/assets/auth.js"), dependencies);
  const javaScript = await script!.text();
  assert.match(javaScript, /callbackURL: window\.location\.origin \+ "\/auth\/verified"/);
  assert.match(javaScript, /\/api\/auth\/send-verification-email/);
});
