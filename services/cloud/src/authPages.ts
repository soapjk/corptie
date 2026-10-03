const AUTH_CSS = `
:root { color-scheme: light dark; font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: color-mix(in srgb, Canvas 96%, Highlight 4%); color: CanvasText; }
main { width: min(100%, 440px); }
.brand { display: flex; align-items: center; gap: 10px; margin: 0 0 18px; font-weight: 700; letter-spacing: -.01em; }
.brand-mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: Highlight; color: HighlightText; font-size: 14px; }
.panel { padding: 28px; border: 1px solid color-mix(in srgb, CanvasText 12%, Canvas); border-radius: 18px; background: Canvas; box-shadow: 0 16px 50px color-mix(in srgb, CanvasText 10%, transparent); }
h1 { margin: 0 0 8px; font-size: clamp(1.65rem, 5vw, 2rem); line-height: 1.2; letter-spacing: -0.03em; }
p { margin: 0 0 24px; color: color-mix(in srgb, CanvasText 68%, Canvas); overflow-wrap: anywhere; }
form { display: grid; gap: 16px; }
label { display: grid; gap: 7px; font-weight: 600; }
input { width: 100%; min-height: 46px; padding: 10px 12px; border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas); border-radius: 10px; background: Canvas; color: CanvasText; font: inherit; }
input:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }
button { min-height: 46px; border: 0; border-radius: 10px; padding: 10px 16px; background: Highlight; color: HighlightText; font: inherit; font-weight: 700; cursor: pointer; }
button.secondary { border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); background: Canvas; color: CanvasText; }
button:disabled { cursor: wait; opacity: .65; }
.actions { display: grid; gap: 10px; }
.links { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 24px; }
a { color: LinkText; }
.status { min-height: 24px; margin: 18px 0 0; color: CanvasText; }
.status[data-error="true"] { color: #b42318; }
ul { display: grid; gap: 8px; margin: 0 0 24px; padding: 0; list-style: none; }
li { padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, CanvasText 6%, Canvas); }
.footnote { margin: 18px 0 0; font-size: .82rem; text-align: center; }
@media (prefers-color-scheme: dark) { .status[data-error="true"] { color: #ffb4ab; } }
@media (max-width: 480px) { body { padding: 16px; align-items: start; } main { margin-top: 8vh; } .panel { padding: 22px; border-radius: 15px; } }
`;

const AUTH_JS = `
const root = document.querySelector("main[data-page]");
const status = document.querySelector("[data-status]");
const form = document.querySelector("form");

function setStatus(message, isError = false) {
  if (!status) return;
  status.textContent = message;
  status.dataset.error = String(isError);
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "请求未完成，请稍后重试。");
  return payload;
}

async function submit(event) {
  event.preventDefault();
  const submitter = event.submitter;
  const controls = form.querySelectorAll("button");
  controls.forEach((button) => { button.disabled = true; });
  form.setAttribute("aria-busy", "true");
  setStatus("正在处理…");
  try {
    const data = new FormData(form);
    const page = root.dataset.page;
    const oauthQuery = root.dataset.oauthQuery || undefined;
    if (page === "sign-in") {
      const payload = await post("/api/auth/sign-in/email", {
        email: data.get("email"), password: data.get("password"), oauth_query: oauthQuery
      });
      const destination = payload.redirect_uri || payload.url;
      if (destination) window.location.assign(destination);
      else setStatus("登录成功，可以返回 Corptie。");
    } else if (page === "consent") {
      const accepted = submitter?.value !== "deny";
      const payload = await post("/api/auth/oauth2/consent", {
        accept: accepted, scope: root.dataset.scope || undefined, oauth_query: oauthQuery
      });
      window.location.assign(payload.redirect_uri);
    } else if (page === "redeem") {
      await post("/v1/invitations/redeem", {
        code: data.get("code"), email: data.get("email"), name: data.get("name"), password: data.get("password")
      });
      form.reset();
      setStatus("账号已创建。请登录并验证邮箱后继续。");
    } else if (page === "recover") {
      await post("/api/auth/request-password-reset", {
        email: data.get("email"), redirectTo: window.location.origin + "/auth/reset-password"
      });
      form.reset();
      setStatus("如果账号存在，重置邮件已经发送。");
    } else if (page === "reset") {
      await post("/api/auth/reset-password", { newPassword: data.get("password"), token: root.dataset.token });
      form.reset();
      setStatus("密码已更新，所有设备需要重新登录。");
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "请求未完成，请稍后重试。", true);
  } finally {
    controls.forEach((button) => { button.disabled = false; });
    form.removeAttribute("aria-busy");
  }
}

if (form) form.addEventListener("submit", submit);
`;

export interface AuthPageDependencies {
  verifyOAuthPageQuery: (query: string) => Promise<boolean>;
}

export async function authPageResponse(request: Request, dependencies: AuthPageDependencies): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET") return null;
  if (url.pathname === "/auth/assets/auth.css") return asset(AUTH_CSS, "text/css; charset=utf-8");
  if (url.pathname === "/auth/assets/auth.js") return asset(AUTH_JS, "text/javascript; charset=utf-8");

  const query = url.searchParams.toString();
  if (url.pathname === "/auth/sign-in") {
    if (query && !await dependencies.verifyOAuthPageQuery(query)) return invalidOAuthRequest();
    return page("登录 Corptie", "使用你的 Corptie 账号继续。", "sign-in", `
      <form>
        <label>邮箱<input name="email" type="email" inputmode="email" autocomplete="username" required maxlength="320"></label>
        <label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>
        <button type="submit">登录</button>
      </form>
      <nav class="links" aria-label="账号帮助"><a href="/auth/redeem">使用邀请码注册</a><a href="/auth/recover">忘记密码？</a></nav>
    `, query ? { oauthQuery: query } : {});
  }
  if (url.pathname === "/auth/consent") {
    if (!query || !await dependencies.verifyOAuthPageQuery(query)) return invalidOAuthRequest();
    const scope = url.searchParams.get("scope") ?? "";
    const scopes = scope.split(" ").filter(Boolean);
    const list = scopes.length > 0
      ? `<ul>${scopes.map((value) => `<li>${escapeHtml(scopeLabel(value))}</li>`).join("")}</ul>`
      : "";
    return page("允许此设备访问？", "一个 Corptie 客户端正在请求访问你的账号。", "consent", `
      ${list}
      <form><div class="actions"><button type="submit" value="allow">允许</button><button class="secondary" type="submit" value="deny">拒绝</button></div></form>
    `, { oauthQuery: query, scope });
  }
  if (url.pathname === "/auth/redeem") {
    return page("创建 Corptie 账号", "注册需要有效的邀请码。", "redeem", `
      <form>
        <label>邀请码<input name="code" autocomplete="one-time-code" required minlength="32" maxlength="256"></label>
        <label>姓名<input name="name" autocomplete="name" required maxlength="100"></label>
        <label>邮箱<input name="email" type="email" inputmode="email" autocomplete="username" required maxlength="320"></label>
        <label>密码<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128" aria-describedby="password-hint"></label>
        <span id="password-hint" class="footnote">至少 8 个字符</span>
        <button type="submit">创建账号</button>
      </form>
      <nav class="links" aria-label="账号帮助"><a href="/auth/sign-in">返回登录</a></nav>
    `);
  }
  if (url.pathname === "/auth/recover") {
    return page("找回账号", "如果账号存在，我们会发送密码重置链接。", "recover", `
      <form><label>邮箱<input name="email" type="email" inputmode="email" autocomplete="username" required maxlength="320"></label><button type="submit">发送重置邮件</button></form>
      <nav class="links" aria-label="账号帮助"><a href="/auth/sign-in">返回登录</a></nav>
    `);
  }
  if (url.pathname === "/auth/reset-password") {
    const token = url.searchParams.get("token");
    if (!token) return new Response("缺少密码重置令牌", { status: 400, headers: securityHeaders("text/plain; charset=utf-8") });
    return page("设置新密码", "更新后，所有已连接设备都需要重新登录。", "reset", `
      <form><label>新密码<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label><button type="submit">更新密码</button></form>
    `, { token });
  }
  if (url.pathname === "/auth/verified") {
    return page("邮箱已验证", "现在可以返回 Corptie 登录。", "complete", `<nav class="links"><a href="/auth/sign-in">登录</a></nav>`);
  }
  return null;
}

function page(
  title: string,
  introduction: string,
  pageName: string,
  content: string,
  data: { oauthQuery?: string; scope?: string; token?: string } = {}
): Response {
  const attributes = [
    `data-page="${escapeHtml(pageName)}"`,
    data.oauthQuery ? `data-oauth-query="${escapeHtml(data.oauthQuery)}"` : "",
    data.scope ? `data-scope="${escapeHtml(data.scope)}"` : "",
    data.token ? `data-token="${escapeHtml(data.token)}"` : ""
  ].filter(Boolean).join(" ");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · Corptie</title><link rel="stylesheet" href="/auth/assets/auth.css"><script src="/auth/assets/auth.js" defer></script></head><body><main ${attributes}><div class="brand" aria-label="Corptie"><span class="brand-mark" aria-hidden="true">C</span><span>Corptie</span></div><section class="panel"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(introduction)}</p>${content}<p class="status" data-status role="status" aria-live="polite"></p></section><p class="footnote">安全登录由 Corptie Cloud 提供</p></main></body></html>`;
  return new Response(html, { headers: securityHeaders("text/html; charset=utf-8") });
}

function invalidOAuthRequest(): Response {
  return new Response("登录请求无效或已过期", { status: 400, headers: securityHeaders("text/plain; charset=utf-8") });
}

function asset(body: string, contentType: string): Response {
  return new Response(body, { headers: securityHeaders(contentType, "public, max-age=3600") });
}

function securityHeaders(contentType: string, cacheControl = "no-store"): HeadersInit {
  return {
    "cache-control": cacheControl,
    "content-type": contentType,
    "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}

function scopeLabel(scope: string): string {
  const labels: Record<string, string> = {
    openid: "确认你的身份",
    profile: "读取账号资料",
    email: "读取邮箱地址",
    offline_access: "保持登录状态",
    "devices:read": "查看你的设备",
    "devices:write": "注册新设备",
    "devices:manage": "管理并撤销设备",
    "connections:read": "查看连接状态",
    "connections:write": "连接你的设备"
  };
  return labels[scope] ?? scope;
}
