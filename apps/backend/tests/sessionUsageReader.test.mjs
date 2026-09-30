import assert from "node:assert/strict";
import test from "node:test";
import { createSessionUsageReader } from "../src/application/sessionUsageReader.mjs";

function fixture() {
  const calls = [];
  const stored = { account: { available: true, model: "model", remaining: 10 }, context: { tokens: 5 } };
  const service = { readAccountUsage: async () => stored.account };
  const reader = createSessionUsageReader({
    store: {
      getSession: (id) => id === "one" ? { external: { provider: "test-provider", currentModel: "model" } } : null,
      getSessionUsageSnapshot: () => stored,
      upsertSessionUsageSnapshot: (value) => { calls.push(["persist", value]); return value; }
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
  assert.deepEqual(f.calls[1], ["publish", "one"]);
});

test("failed account refresh returns stored quota without writing or publishing", async () => {
  const f = fixture();
  f.service.readAccountUsage = async () => { throw new Error("offline"); };
  assert.deepEqual(await f.reader.readSessionUsage("one"), {
    account: f.stored.account, context: f.stored.context, resetForecast: null
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
