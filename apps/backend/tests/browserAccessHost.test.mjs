import assert from "node:assert/strict";
import test from "node:test";
import { createPublicKey, verify } from "node:crypto";
import { stat } from "node:fs/promises";
import { challenge } from "./fixtures/browserAccessProtocol.mjs";
import { createBrowserAccessHost } from "../src/application/browserAccessHost.mjs";

const context = { logicalSessionId: "logical:real", providerBindingId: "binding:real", turnId: "turn:real" };
const bind = host => host.bindNative({ sessionId: "native-thread", turnId: "native-turn", tool: "js" });

test("browser challenges use the official framing, signed request binding and private socket", async t => {
  let authorizations = 0;
  const host = await createBrowserAccessHost({ authorize: async ({ context: actual }) => {
    assert.deepEqual(actual, context); authorizations++; return true;
  } });
  t.after(() => host.close());
  assert.equal((await stat(host.env.BROWSER_USE_ACCESS_PIPE_PATH)).mode & 0o777, 0o600);
  const finish = host.begin(context); bind(host);
  const { request, response } = await challenge(host.env, {}, true);
  assert.equal(response.error, undefined);
  const { payload, signature } = response.result;
  const key = createPublicKey({ key: Buffer.from(host.env.BROWSER_USE_ACCESS_VERIFYING_IDENTITY, "base64"), type: "spki", format: "der" });
  assert.equal(verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64")), true);
  assert.deepEqual(JSON.parse(payload), { domain: "codex.browserAccess.v1", request, allowed: true });
  assert.equal(verify(null, Buffer.from(payload + " "), key, Buffer.from(signature, "base64")), false);
  assert.ok((await challenge(host.env, { nonce: request.nonce })).response.error);
  finish();
  assert.ok((await challenge(host.env)).response.error);
  assert.equal(authorizations, 1);
});

test("wrong executor, native identities, missing or changed Session never acquire a browser grant", async t => {
  let count = 0;
  const host = await createBrowserAccessHost({ authorize: () => { count++; return true; } });
  t.after(() => host.close());
  assert.throws(() => host.begin({}), { code: "BROWSER_SESSION_REQUIRED" });
  const finish = host.begin(context); bind(host);
  for (const override of [{ executorId: "other" }, { sessionId: "other" }, { turnId: "other" }, { nonce: "wrong" }, { extra: true }]) {
    assert.ok((await challenge(host.env, override)).response.error);
  }
  assert.throws(() => host.bindNative({ sessionId: "other", turnId: "other", tool: "js" }));
  finish();
  for (const field of ["logicalSessionId", "providerBindingId", "turnId"]) {
    assert.throws(() => host.begin({ ...context, [field]: "other" }), { code: "BROWSER_SESSION_STALE" });
  }
  assert.equal(count, 0);
});

test("denied access and an aborted invocation never produce an allowed signed grant", async t => {
  const host = await createBrowserAccessHost({ authorize: () => false });
  t.after(() => host.close());
  const stop = new AbortController();
  const finish = host.begin(context, stop.signal); bind(host);
  const denied = await challenge(host.env);
  assert.equal(JSON.parse(denied.response.result.payload).allowed, false);
  stop.abort();
  assert.ok((await challenge(host.env)).response.error);
  finish();
  const path = host.env.BROWSER_USE_ACCESS_PIPE_PATH;
  await host.close(); await host.close();
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.throws(() => host.begin(context));
});

test("grant approval completing after an invocation ends is signed as denied", async t => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const host = await createBrowserAccessHost({ authorize: () => {
    started(); return new Promise(resolve => { release = resolve; });
  } });
  t.after(() => host.close());
  const finish = host.begin(context); bind(host);
  const pending = challenge(host.env);
  await waiting; finish(); release(true);
  assert.equal(JSON.parse((await pending).response.result.payload).allowed, false);
});
