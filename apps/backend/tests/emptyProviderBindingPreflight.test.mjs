import assert from "node:assert/strict";
import test from "node:test";

import { EmptyProviderBindingPreflight } from "../src/application/emptyProviderBindingPreflight.mjs";

function fixture({ ensureUsable = async () => ({ recovered: true }) } = {}) {
  const changes = [];
  const preflight = new EmptyProviderBindingPreflight({
    store: {
      listEmptyActiveProviderBindings: (providerId) => providerId === "codex-app-server"
        ? [candidate("empty")]
        : []
    },
    providerId: "codex-app-server",
    ensureUsable,
    onChanged: (candidate, readiness) => changes.push({ candidate, readiness })
  });
  return { preflight, changes };
}

test("startup preflight marks only zero-Turn active Provider bindings Not Ready", () => {
  const f = fixture();
  assert.deepEqual(f.preflight.prepare(), { candidates: 1 });
  assert.equal(f.preflight.readiness("logical:empty").reasonCode, "BINDING_RUNTIME_VERIFYING");
});

test("successful background repair removes the readiness block and wakes projection", async () => {
  const f = fixture();
  f.preflight.prepare();

  const result = await f.preflight.recover("logical:empty");

  assert.equal(result.status, "ready");
  assert.equal(f.preflight.readiness("logical:empty"), null);
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].readiness, null);
});

test("failed background repair remains explicitly Not Ready", async () => {
  const error = Object.assign(new Error("rollout reconstruction failed"), {
    code: "PROVIDER_SESSION_UNAVAILABLE"
  });
  const f = fixture({ ensureUsable: async () => { throw error; } });
  f.preflight.prepare();

  await assert.rejects(
    f.preflight.recover("logical:empty"),
    { code: "PROVIDER_SESSION_UNAVAILABLE" }
  );

  assert.equal(f.preflight.readiness("logical:empty").reasonCode, "PROVIDER_SESSION_UNAVAILABLE");
  assert.equal(f.changes[0].readiness.message, "rollout reconstruction failed");
});

test("startup discovery is Store-only and the post-listen run proactively repairs candidates", async () => {
  let calls = 0;
  const f = fixture({ ensureUsable: async () => { calls += 1; } });

  assert.deepEqual(f.preflight.prepare(), { candidates: 1 });
  await Promise.resolve();
  assert.equal(calls, 0);

  const summary = await f.preflight.run();
  assert.equal(calls, 1);
  assert.equal(summary.ready, 1);
  assert.equal(summary.failed, 0);
});

test("concurrent preparation coalesces one Session recovery", async () => {
  let release;
  let calls = 0;
  const f = fixture({
    ensureUsable: async () => {
      calls += 1;
      await new Promise((resolve) => { release = resolve; });
    }
  });
  f.preflight.prepare();

  const first = f.preflight.recover("logical:empty");
  const second = f.preflight.recover("logical:empty");
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
});

function candidate(name, providerId = "codex-app-server") {
  return {
    sessionId: `session:${name}`,
    logicalSessionId: `logical:${name}`,
    bindingId: `binding:${name}`,
    providerId,
    providerSessionId: `thread:${name}`
  };
}
