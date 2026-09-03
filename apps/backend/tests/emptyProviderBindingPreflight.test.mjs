import assert from "node:assert/strict";
import test from "node:test";

import { EmptyProviderBindingPreflight } from "../src/application/emptyProviderBindingPreflight.mjs";

function fixture({
  ensureUsable = async () => ({ recovered: true }),
  recoverUnavailable = null,
  isUnavailable = (error) => error?.code === "PROVIDER_SESSION_UNAVAILABLE"
} = {}) {
  const changes = [];
  const preflight = new EmptyProviderBindingPreflight({
    store: {
      listEmptyActiveProviderBindings: (providerId) => providerId === "codex-app-server"
        ? [candidate("empty")]
        : []
    },
    providerId: "codex-app-server",
    ensureUsable,
    recoverUnavailable,
    isUnavailable,
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

test("a proven unavailable zero-Turn binding is replaced and the new route is verified", async () => {
  const probes = [];
  const recoveries = [];
  const f = fixture({
    ensureUsable: async (value) => {
      probes.push(value.bindingId);
      if (value.bindingId === "binding:empty") {
        const error = new Error("no rollout found for thread id");
        error.code = "PROVIDER_SESSION_UNAVAILABLE";
        throw error;
      }
      return { bindingId: value.bindingId };
    },
    recoverUnavailable: async (value, error) => {
      recoveries.push({ value, error });
      return {
        candidate: {
          bindingId: "binding:replacement",
          providerSessionId: "thread:replacement",
          routingVersion: 2
        }
      };
    }
  });
  f.preflight.prepare();

  const result = await f.preflight.recover("logical:empty");

  assert.deepEqual(probes, ["binding:empty", "binding:replacement"]);
  assert.equal(recoveries.length, 1);
  assert.equal(result.status, "ready");
  assert.equal(result.recovered, true);
  assert.equal(result.bindingId, "binding:replacement");
  assert.equal(result.providerSessionId, "thread:replacement");
  assert.equal(f.preflight.readiness("logical:empty"), null);
});

test("an ordinary runtime failure never replaces the Provider binding", async () => {
  let recoveryCalls = 0;
  const error = Object.assign(new Error("transport timed out"), { code: "PROVIDER_TIMEOUT" });
  const f = fixture({
    ensureUsable: async () => { throw error; },
    recoverUnavailable: async () => { recoveryCalls += 1; }
  });
  f.preflight.prepare();

  await assert.rejects(f.preflight.recover("logical:empty"), { code: "PROVIDER_TIMEOUT" });

  assert.equal(recoveryCalls, 0);
  assert.equal(f.preflight.readiness("logical:empty").reasonCode, "PROVIDER_TIMEOUT");
});

test("a replacement that fails authoritative verification remains Not Ready", async () => {
  let probes = 0;
  const f = fixture({
    ensureUsable: async () => {
      probes += 1;
      const error = new Error(probes === 1 ? "source missing" : "replacement missing");
      error.code = "PROVIDER_SESSION_UNAVAILABLE";
      throw error;
    },
    recoverUnavailable: async () => ({ candidate: { bindingId: "binding:replacement" } })
  });
  f.preflight.prepare();

  await assert.rejects(f.preflight.recover("logical:empty"), {
    message: "replacement missing"
  });

  assert.equal(probes, 2);
  assert.equal(f.preflight.readiness("logical:empty").reasonCode, "PROVIDER_SESSION_UNAVAILABLE");
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
