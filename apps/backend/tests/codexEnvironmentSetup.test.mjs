import test from "node:test";
import assert from "node:assert/strict";
import { createCodexEnvironmentSetup } from "../src/adapters/codexEnvironmentSetup.mjs";

function fixture(options = {}) {
  let profile = { profileId: "native", mode: "native", home: "/native" };
  let fingerprint = "config-v1";
  const calls = [], clients = [];
  const registry = { nativeHome: "/native", get current() { return profile; },
    selection: input => input ?? profile, validate: async input => input,
    descriptor: input => input ?? profile, fingerprint: async () => fingerprint,
    register: async input => { profile = input; } };
  const setup = createCodexEnvironmentSetup({ registry,
    prepare: async input => calls.push(["prepare", input.mode]),
    environment: input => ({ CODEX_HOME: input.home }), runtimeOptions: {},
    importAuthentication: async input => { calls.push(["import", input]); return true; },
    createClient: config => {
      const client = { config, initialize: async () => {}, closed: false,
        request: async (method, params) => {
          calls.push([method, params]);
          if (method === "account/read") return { requiresOpenaiAuth: true, account: { type: "chatgpt" } };
          return { loginId: "login", authUrl: "https://auth.openai.com/test" };
        },
        runEphemeralPrompt: async input => { calls.push(["reply", input]); return { text: "CORPTIE_OK" }; },
        close: async () => { client.closed = true; } };
      clients.push(client); return client;
    }, ...options });
  return { setup, calls, clients, registry, setFingerprint: value => { fingerprint = value; } };
}

test("native probe queries account and proves a no-tools reply without importing secrets", async () => {
  const f = fixture(); const result = await f.setup.probe("codex");
  assert.equal(result.ok, true); assert.equal(result.environment.mode, "native");
  assert.equal(f.clients[0].config.env.CODEX_HOME, "/native");
  assert.ok(!f.calls.some(call => call[0] === "import"));
  const reply = f.calls.find(call => call[0] === "reply")[1];
  assert.equal(reply.executionPolicy, "no-tools");
  assert.equal(f.clients[0].closed, true);
});

test("missing login is actionable; custom model providers do not require ChatGPT login", async () => {
  for (const requiresOpenaiAuth of [true, false]) {
    const f = fixture();
    const original = f.setup.probe;
    // Inject at factory construction, not by accessing actual credentials.
    const setup = createCodexEnvironmentSetup({ registry: f.registry, environment: () => ({}), prepare: async () => {},
      createClient: () => ({ initialize: async () => {}, close: async () => {},
        request: async () => ({ requiresOpenaiAuth, account: null }),
        runEphemeralPrompt: async () => ({ text: "CORPTIE_OK" }) }) });
    if (requiresOpenaiAuth) await assert.rejects(setup.probe("codex"), { code: "PROVIDER_LOGIN_REQUIRED" });
    else assert.equal((await setup.probe("codex")).ok, true);
    assert.ok(original);
  }
});

test("credential import requires isolated mode, explicit confirmation and an idle environment", async () => {
  const f = fixture();
  await assert.rejects(f.setup.authentication({ action: "import", confirmed: true }), /仅可/);
  const isolated = { profileId: "isolated", mode: "isolated", home: "/isolated" };
  await assert.rejects(f.setup.authentication({ action: "import", environment: isolated }), /确认/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.setup.authentication({ action: "import", confirmed: true, environment: isolated }), { state: "imported" });
  assert.equal(f.calls.filter(call => call[0] === "import").length, 1);
  const busy = fixture({ canImport: () => false });
  await assert.rejects(busy.setup.authentication({ action: "import", confirmed: true, environment: isolated }), /正在执行/);
  assert.equal(busy.calls.length, 0);
});

test("login status and cancellation own one bounded App Server without importing credentials", async () => {
  const f = fixture();
  const login = await f.setup.authentication({ action: "login", path: "codex" });
  assert.equal(login.loginId, "login");
  assert.deepEqual(await f.setup.authentication({ action: "status", loginId: "login" }), { state: "pending" });
  f.clients[0].config.onNotification({ method: "account/login/completed", params: { loginId: "login", success: true } });
  assert.deepEqual(await f.setup.authentication({ action: "status", loginId: "login" }), { state: "completed" });
  assert.equal(f.clients[0].closed, true);
  await f.setup.authentication({ action: "login", path: "codex" });
  assert.deepEqual(await f.setup.authentication({ action: "cancel", loginId: "login" }), { state: "cancelled" });
  assert.equal(f.clients[1].closed, true);
  assert.ok(!f.calls.some(call => call[0] === "import"));
});

test("configuration changed during probe is rejected and never selected", async () => {
  const f = fixture();
  const setup = createCodexEnvironmentSetup({ registry: f.registry, environment: () => ({}), prepare: async () => {},
    createClient: () => ({ initialize: async () => {}, close: async () => {}, request: async () => ({}),
      runEphemeralPrompt: async () => { f.setFingerprint("config-v2"); return { text: "CORPTIE_OK" }; } }) });
  await assert.rejects(setup.probe("codex"), { code: "PROVIDER_CONFIGURATION_CHANGED" });
});

test("explicit model reaches the no-tools reply and structured errors retain safe categories", async () => {
  const f = fixture();
  const result = await f.setup.probe("/chosen/codex", { model: "explicit-model" });
  assert.equal(f.calls.find(call => call[0] === "reply")[1].model, "explicit-model");
  assert.equal(result.effectiveModel, "explicit-model");
  for (const [providerErrorInfo, code] of [["Unauthorized", "PROVIDER_LOGIN_REQUIRED"],
    ["UsageLimitExceeded", "PROVIDER_USAGE_LIMIT"], ["BadRequest", "PROVIDER_REQUEST_REJECTED"],
    [{ type: "HttpConnectionFailed", httpStatusCode: 503 }, "PROVIDER_NETWORK_FAILED"]]) {
    const setup = createCodexEnvironmentSetup({ registry: f.registry, environment: () => ({}), prepare: async () => {},
      createClient: () => ({ initialize: async () => {}, close: async () => {}, request: async () => ({}),
        runEphemeralPrompt: async () => { throw Object.assign(new Error("secret diagnostic"), { providerErrorInfo }); } }) });
    await assert.rejects(setup.probe("/chosen/codex"), error => error.code === code && !error.message.includes("secret"));
  }
});
