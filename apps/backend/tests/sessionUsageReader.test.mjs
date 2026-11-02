import assert from "node:assert/strict";
import test from "node:test";
import { createSessionUsageReader } from "../src/application/sessionUsageReader.mjs";

function fixture({ readOnly = false } = {}) {
  const calls = [];
  const stored = { account: { available: true, provider: "test-provider", model: "model", remaining: 10 }, context: { tokens: 5 } };
  const service = { readAccountUsage: async () => stored.account };
  const reader = createSessionUsageReader({
    readOnly,
    store: {
      getSession: (id) => id === "one" ? { external: { provider: "test-provider", currentModel: "model" } } : null,
      getLogicalSessionByLegacySessionId: (id) => id === "one" ? { activeBinding: {
        bindingId: "binding:one", providerId: "test-provider", routingVersion: 3
      } } : null,
      getSessionContextUsage: () => ({ providerId: "test-provider", bindingId: "binding:one", context: stored.context }),
      getProviderModelUsage: () => ({ account: stored.account }),
      upsertProviderModelUsage: (value) => { calls.push(["persist", value]); return value; }
    },
    sessionApplicationService: service,
    publishTimeline: (id) => calls.push(["publish", id]),
    resetForecastForSession: () => null
  });
  return { calls, stored, service, reader };
}

test("account refresh preserves stored context and publishes only a changed account", async () => {
  const f = fixture();
  const unchanged = await f.reader.readSessionUsage("one");
  assert.deepEqual(unchanged.context, { tokens: 5 });
  assert.deepEqual(f.calls.map(([name]) => name), ["persist"]);
  f.calls.length = 0;
  f.service.readAccountUsage = async () => ({ available: true, remaining: 9 });
  await f.reader.readSessionUsage("one");
  assert.deepEqual(f.calls.map(([name]) => name), ["persist", "publish"]);
  assert.equal(f.calls[0][1].providerId, "test-provider");
  assert.equal(f.calls[0][1].model, "model");
  assert.deepEqual(f.calls[1], ["publish", "one"]);
});

test("failed account refresh returns stored quota without writing or publishing", async () => {
  const f = fixture();
  f.service.readAccountUsage = async () => { throw new Error("offline"); };
  assert.deepEqual(await f.reader.readSessionUsage("one"), {
    account: f.stored.account, accountFresh: false, context: f.stored.context, resetForecast: null,
    route: { providerId: "test-provider", model: "model", bindingId: "binding:one", routingVersion: 3 }
  });
  assert.deepEqual(f.calls, []);
  await assert.rejects(
    f.reader.readSessionUsage("one", undefined, { requireFreshAccount: true }),
    { code: "ACCOUNT_USAGE_REFRESH_FAILED" }
  );
});

test("gateway quota reads remain local and missing sessions retain their fallback contract", async () => {
  const f = fixture();
  f.service.readAccountUsage = async () => { throw new Error("must not load"); };
  assert.deepEqual(await f.reader.getGatewayUsage("one"), f.stored.account);
  assert.deepEqual(await f.reader.getGatewayUsage("missing"), { available: false, provider: "unknown", model: null });
  await assert.rejects(f.reader.readSessionUsage("missing"), /Session not found/);
  assert.deepEqual(f.calls, []);
});


test("read-only preview returns cached context and quota without calling a Provider or writing", async () => {
  const f = fixture({ readOnly: true });
  let providerReads = 0;
  f.service.readAccountUsage = async () => { providerReads++; throw new Error("Provider must not start"); };
  const usage = await f.reader.readSessionUsage("one");
  assert.deepEqual(usage.context, f.stored.context);
  assert.deepEqual(usage.account, f.stored.account);
  assert.equal(usage.accountFresh, false);
  assert.equal(providerReads, 0);
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.reader.readSessionUsage("one", undefined, { requireFreshAccount: true }), {
    code: "DEVELOPMENT_PREVIEW_READ_ONLY", status: 403
  });
  assert.equal(providerReads, 0);
  assert.deepEqual(f.calls, []);
});

test("read-only preview without cached quota returns unavailable without contacting a Provider", async () => {
  const f = fixture({ readOnly: true });
  delete f.stored.account;
  let providerReads = 0;
  f.service.readAccountUsage = async () => { providerReads++; return { available: true }; };
  const usage = await f.reader.readSessionUsage("one");
  assert.deepEqual(usage.account, { available: false, provider: "test-provider", model: "model" });
  assert.equal(usage.accountFresh, false);
  assert.equal(providerReads, 0);
  assert.deepEqual(f.calls, []);
});
