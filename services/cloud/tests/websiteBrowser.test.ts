import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { ACCOUNT_JS, BROWSER_HTTP_JS } from "../src/websiteAssets.js";
import { authPageResponse } from "../src/authPages.js";

// Tests browser control logic with plain objects, not a browser, renderer or
// accessibility automation session. No real account or screen is accessed.
class Element {
  textContent = "";
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  children: Element[] = [];
  listeners = new Map<string, (...args: any[]) => unknown>();
  attributes = new Map<string, string>();
  elements = new Map<string, Element>();
  querySelector(selector: string) { return this.elements.get(selector); }
  querySelectorAll(_selector: string) { return [new Element()]; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, action: (...args: any[]) => unknown) { this.listeners.set(name, action); }
  replaceChildren(...children: Element[]) { this.children = children; }
  append(...children: Element[]) { this.children.push(...children); }
  reset() {}
}

const session = (name = "Example") => ({ user: { id: "account:test", name, email: "example@example.test", emailVerified: true, createdAt: "2026-10-01T00:00:00Z" }, session: { token: "never-render-or-store" } });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(fetcher: (path: string, options: RequestInit) => Promise<Response>) {
  const root = new Element();
  for (const name of ["account-status", "device-status", "profile", "retry", "device-retry", "sign-out", "devices", "name", "email", "verified", "created"]) root.elements.set(`[data-${name}]`, new Element());
  root.elements.get("[data-profile]")!.hidden = true;
  const events = new Map<string, (...args: any[]) => unknown>();
  const navigations: string[] = [];
  const calls: Array<{ path: string; options: RequestInit }> = [];
  const context = {
    URL, AbortController, Error, console,
    window: { location: { origin: "https://cloud.example.test", replace: (path: string) => navigations.push(path), assign: (path: string) => navigations.push(path) }, addEventListener: (name: string, callback: (...args: any[]) => unknown) => events.set(name, callback) },
    document: { querySelector: () => root, createElement: () => new Element() },
    fetch: async (url: string, options: RequestInit) => { const path = new URL(url).pathname; calls.push({ path, options }); return fetcher(path, options); }
  };
  runInNewContext(BROWSER_HTTP_JS + ACCOUNT_JS, context);
  return { root, events, calls, navigations };
}

test("account loads only the current Cookie session, displays escaped text and fetches devices once", async () => {
  const h = harness(async path => Response.json(path.endsWith("get-session") ? session("<script>example</script>") : { devices: [{ displayName: "<img>", kind: "mac", updatedAt: "2026-10-01", revokedAt: null }] }));
  await settle();
  assert.deepEqual(h.calls.map(c => c.path), ["/api/auth/get-session", "/v1/devices"]);
  assert.ok(h.calls.every(c => c.options.credentials === "same-origin" && c.options.cache === "no-store"));
  assert.equal(h.root.elements.get("[data-name]")!.textContent, "<script>example</script>");
  assert.equal(h.root.elements.get("[data-profile]")!.hidden, false);
  assert.equal(h.root.elements.get("[data-devices]")!.children[0]!.children[0]!.textContent, "<img>");
  assert.equal(h.root.attributes.has("aria-busy"), false);
});

test("anonymous account redirects without requesting any device data", async () => {
  const h = harness(async () => Response.json(null)); await settle();
  assert.deepEqual(h.navigations, ["/auth/sign-in"]);
  assert.equal(h.calls.length, 1); assert.equal(h.root.elements.get("[data-profile]")!.hidden, true);
});

test("account errors support retry and device failures do not hide an authenticated profile", async () => {
  let attempts = 0;
  const h = harness(async path => {
    if (path.endsWith("get-session")) return ++attempts === 1 ? Response.json({ message: "private SQL error" }, { status: 503 }) : Response.json(session());
    return Response.json({ message: "private device error" }, { status: 503 });
  }); await settle();
  assert.equal(h.root.elements.get("[data-retry]")!.hidden, false);
  assert.doesNotMatch(h.root.elements.get("[data-account-status]")!.textContent, /private/);
  h.root.elements.get("[data-retry]")!.listeners.get("click")!(); await settle();
  assert.equal(h.root.elements.get("[data-profile]")!.hidden, false);
  assert.equal(h.root.elements.get("[data-device-retry]")!.hidden, false);
});

test("leaving the page aborts loading and ignores a late session response", async () => {
  let deliver!: (value: Response) => void;
  const h = harness(() => new Promise(resolve => { deliver = resolve; }));
  h.events.get("pagehide")!(); deliver(Response.json(session())); await settle();
  assert.equal(h.calls[0]!.options.signal!.aborted, true);
  assert.equal(h.root.elements.get("[data-profile]")!.hidden, true);
  assert.equal(h.calls.length, 1);
});

test("sign out uses the existing browser endpoint and never invokes device revocation", async () => {
  const h = harness(async path => Response.json(path.endsWith("get-session") ? session() : path === "/v1/devices" ? { devices: [] } : { success: true })); await settle();
  h.root.elements.get("[data-sign-out]")!.listeners.get("click")!(); await settle();
  assert.deepEqual(h.navigations, ["/"]);
  assert.equal(h.calls.at(-1)!.path, "/api/auth/sign-out");
  assert.equal(h.calls.at(-1)!.options.method, "POST");
  assert.ok(h.calls.every(c => c.options.method !== "DELETE"));
});

test("website login ignores external destinations while native login preserves signed OAuth context", async () => {
  const script = await (await authPageResponse(new Request("https://cloud.example.test/auth/assets/auth.js"), { verifyOAuthPageQuery: async () => false }))!.text();
  for (const oauth of [false, true]) {
    const root = new Element(); root.dataset = { page: "sign-in", ...(oauth ? { oauthQuery: "client_id=native&sig=valid" } : {}) };
    const form = new Element(), status = new Element(); const navigations: string[] = []; let body: any;
    const context = {
      Error,
      document: { querySelector: (selector: string) => selector === "form" ? form : selector === "[data-status]" ? status : root },
      CorptieWeb: { requestJson: async (_path: string, options: any) => { body = options.body; return { redirect_uri: oauth ? "corptie://oauth/callback?code=test" : "https://evil.example.test" }; } },
      window: { location: { origin: "https://cloud.example.test", assign: (url: string) => navigations.push(url), replace: (url: string) => navigations.push(url) } },
      FormData: class { get(key: string) { return key === "email" ? "test@example.test" : "password"; } }
    };
    runInNewContext(script, context);
    await form.listeners.get("submit")!({ preventDefault() {}, submitter: {} });
    assert.equal(navigations[0], oauth ? "corptie://oauth/callback?code=test" : "/account");
    assert.equal(body.oauth_query, oauth ? "client_id=native&sig=valid" : undefined);
    assert.equal(body.callbackURL, oauth ? undefined : "https://cloud.example.test/account");
    assert.equal(form.attributes.has("aria-busy"), false);
  }
});
