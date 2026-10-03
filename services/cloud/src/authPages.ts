const AUTH_CSS = `
:root { color-scheme: light dark; font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: Canvas; color: CanvasText; }
main { width: min(100%, 400px); }
h1 { margin: 0 0 8px; font-size: 1.75rem; line-height: 1.2; letter-spacing: -0.02em; }
p { margin: 0 0 24px; color: color-mix(in srgb, CanvasText 70%, Canvas); }
form { display: grid; gap: 16px; }
label { display: grid; gap: 6px; font-weight: 600; }
input { width: 100%; min-height: 44px; padding: 9px 11px; border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); border-radius: 8px; background: Canvas; color: CanvasText; font: inherit; }
input:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }
button { min-height: 44px; border: 0; border-radius: 8px; padding: 10px 16px; background: Highlight; color: HighlightText; font: inherit; font-weight: 700; cursor: pointer; }
button.secondary { border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); background: Canvas; color: CanvasText; }
button:disabled { cursor: wait; opacity: .65; }
.actions { display: grid; gap: 10px; }
.links { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 24px; }
a { color: LinkText; }
.status { min-height: 24px; margin: 0; color: CanvasText; }
.status[data-error="true"] { color: #b42318; }
ul { margin: 0 0 24px; padding-left: 22px; }
@media (prefers-color-scheme: dark) { .status[data-error="true"] { color: #ffb4ab; } }
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
  if (!response.ok) throw new Error(payload.message || "Request failed. Please try again.");
  return payload;
}

async function submit(event) {
  event.preventDefault();
  const submitter = event.submitter;
  const controls = form.querySelectorAll("button");
  controls.forEach((button) => { button.disabled = true; });
  setStatus("Working…");
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
      else setStatus("Signed in. You may return to Corptie.");
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
      setStatus("Account created. Sign in to verify your email and continue.");
    } else if (page === "recover") {
      await post("/api/auth/request-password-reset", {
        email: data.get("email"), redirectTo: window.location.origin + "/auth/reset-password"
      });
      form.reset();
      setStatus("If that account exists, a recovery message has been sent.");
    } else if (page === "reset") {
      await post("/api/auth/reset-password", { newPassword: data.get("password"), token: root.dataset.token });
      form.reset();
      setStatus("Password updated. All devices must sign in again.");
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Request failed. Please try again.", true);
  } finally {
    controls.forEach((button) => { button.disabled = false; });
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
    return page("Sign in", "Continue to Corptie", "sign-in", `
      <form>
        <label>Email<input name="email" type="email" autocomplete="username" required maxlength="320"></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>
        <button type="submit">Sign in</button>
      </form>
      <nav class="links" aria-label="Account help"><a href="/auth/redeem">Use an invitation</a><a href="/auth/recover">Forgot password?</a></nav>
    `, query ? { oauthQuery: query } : {});
  }
  if (url.pathname === "/auth/consent") {
    if (!query || !await dependencies.verifyOAuthPageQuery(query)) return invalidOAuthRequest();
    const scope = url.searchParams.get("scope") ?? "";
    const scopes = scope.split(" ").filter(Boolean);
    const list = scopes.length > 0
      ? `<ul>${scopes.map((value) => `<li>${escapeHtml(scopeLabel(value))}</li>`).join("")}</ul>`
      : "";
    return page("Allow access?", "A Corptie client is asking to access your account.", "consent", `
      ${list}
      <form><div class="actions"><button type="submit" value="allow">Allow</button><button class="secondary" type="submit" value="deny">Deny</button></div></form>
    `, { oauthQuery: query, scope });
  }
  if (url.pathname === "/auth/redeem") {
    return page("Create your account", "An invitation is required.", "redeem", `
      <form>
        <label>Invitation code<input name="code" autocomplete="one-time-code" required minlength="32" maxlength="256"></label>
        <label>Name<input name="name" autocomplete="name" required maxlength="100"></label>
        <label>Email<input name="email" type="email" autocomplete="username" required maxlength="320"></label>
        <label>Password<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label>
        <button type="submit">Create account</button>
      </form>
      <nav class="links" aria-label="Account help"><a href="/auth/sign-in">Back to sign in</a></nav>
    `);
  }
  if (url.pathname === "/auth/recover") {
    return page("Recover your account", "We’ll send a password reset link if the account exists.", "recover", `
      <form><label>Email<input name="email" type="email" autocomplete="username" required maxlength="320"></label><button type="submit">Send recovery link</button></form>
      <nav class="links" aria-label="Account help"><a href="/auth/sign-in">Back to sign in</a></nav>
    `);
  }
  if (url.pathname === "/auth/reset-password") {
    const token = url.searchParams.get("token");
    if (!token) return new Response("Missing password reset token", { status: 400, headers: securityHeaders("text/plain; charset=utf-8") });
    return page("Choose a new password", "All connected devices will need to sign in again.", "reset", `
      <form><label>New password<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label><button type="submit">Update password</button></form>
    `, { token });
  }
  if (url.pathname === "/auth/verified") {
    return page("Email verified", "You can return to Corptie and sign in.", "complete", `<nav class="links"><a href="/auth/sign-in">Sign in</a></nav>`);
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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Corptie</title><link rel="stylesheet" href="/auth/assets/auth.css"><script src="/auth/assets/auth.js" defer></script></head><body><main ${attributes}><h1>${escapeHtml(title)}</h1><p>${escapeHtml(introduction)}</p>${content}<p class="status" data-status role="status" aria-live="polite"></p></main></body></html>`;
  return new Response(html, { headers: securityHeaders("text/html; charset=utf-8") });
}

function invalidOAuthRequest(): Response {
  return new Response("Invalid or expired OAuth request", { status: 400, headers: securityHeaders("text/plain; charset=utf-8") });
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
    openid: "Confirm your identity",
    profile: "Read your profile",
    email: "Read your email address",
    offline_access: "Stay signed in",
    "devices:read": "View your devices",
    "devices:write": "Register devices",
    "devices:manage": "Manage your devices",
    "connections:read": "View connections",
    "connections:write": "Connect your devices"
  };
  return labels[scope] ?? scope;
}
