import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { sendDetailV2Snapshot, DETAIL_SNAPSHOT_LIMIT } from "../src/application/detailSnapshotTransport.mjs";

class Response {
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  end(body) { this.body = body; }
}
test("snapshot compression negotiates gzip, leaves small responses plain, and preserves bytes", async () => {
  const large = { summary: "中文摘要😀".repeat(2000) };
  for (const [header, value, gzip] of [["gzip", large, true], ["gzip", { small: true }, false],
    ["gzip;q=0, *;q=1", large, false], ["br, gzip;q=0.5", large, true], ["br", large, false], ["gzip;q=bogus", large, false]]) {
    const response = new Response();
    await sendDetailV2Snapshot({ headers: { "accept-encoding": header } }, response, value, () => {});
    assert.equal(response.headers["content-encoding"] === "gzip", gzip);
    assert.deepEqual(JSON.parse(gzip ? gunzipSync(response.body) : response.body), value);
    assert.equal(response.headers["content-length"], response.body.length);
    assert.equal(response.headers.vary, "Accept, X-Corptie-Detail-Capabilities, Accept-Encoding");
    if (gzip) assert.ok(response.body.length < Buffer.byteLength(JSON.stringify(value)) / 10);
  }
});
test("large decompressed payloads are rejected and credentials are rechecked after compression", async () => {
  await assert.rejects(sendDetailV2Snapshot({ headers: {} }, new Response(), { text: "x".repeat(DETAIL_SNAPSHOT_LIMIT) }, () => {}), { status: 413 });
  const response = new Response();
  await assert.rejects(sendDetailV2Snapshot({ headers: { "accept-encoding": "gzip" } }, response, { text: "x".repeat(16000) }, () => {
    throw Object.assign(new Error("revoked"), { status: 401 });
  }), { status: 401 });
  assert.equal(response.body, undefined);
});
test("concurrent compression is bounded without a waiting queue", async () => {
  const responses = Array.from({ length: 8 }, () => new Response());
  await Promise.all(responses.map(response => sendDetailV2Snapshot({ headers: { "accept-encoding": "gzip" } }, response,
    { text: "x".repeat(20000) }, () => {})));
  assert.equal(responses.filter(response => response.headers["content-encoding"] === "gzip").length, 2);
});
test("asynchronous authentication must finish before headers or body and rejects revoked access", async () => {
  for (const header of ["identity", "gzip"]) {
    const response = new Response(); let release, started;
    const authorization = new Promise((_, reject) => { release = reject; });
    const authStarted = new Promise(resolve => { started = resolve; });
    const result = sendDetailV2Snapshot({ headers: { "accept-encoding": header } }, response,
      { text: "x".repeat(20000) }, async () => { started(); await authorization; });
    const rejected = assert.rejects(result, { status: 401 });
    await authStarted;
    assert.equal(response.status, undefined); assert.equal(response.body, undefined);
    release(Object.assign(new Error("revoked"), { status: 401 }));
    await rejected;
    assert.equal(response.status, undefined); assert.equal(response.body, undefined);
  }
});
test("zlib faults fall back to authenticated identity and always release compression capacity", async () => {
  const request = { headers: { "accept-encoding": "gzip" } }, value = { text: "x".repeat(20000) };
  for (let index = 0; index < 3; index++) {
    const response = new Response(); let authenticated = false;
    await sendDetailV2Snapshot(request, response, value, async () => { authenticated = true; }, {
      compressor: async () => { throw new Error("synthetic zlib fault"); }
    });
    assert.equal(authenticated, true); assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(response.body), value);
  }
  const response = new Response();
  await sendDetailV2Snapshot(request, response, value, () => {});
  assert.equal(response.headers["content-encoding"], "gzip");
  const revoked = new Response();
  await assert.rejects(sendDetailV2Snapshot(request, revoked, value, async () => { throw Object.assign(new Error("revoked"), { status: 403 }); }, {
    compressor: async () => { throw new Error("synthetic zlib fault"); }
  }), { status: 403 });
  assert.equal(revoked.status, undefined); assert.equal(revoked.body, undefined);
});
test("excluded identity returns 406 when no acceptable encoding can be produced", async () => {
  const value = { text: "x".repeat(20000) };
  for (const header of ["identity;q=0,*;q=0", "*;q=0", "gzip;q=bogus,identity;q=0"]) {
    const response = new Response();
    await assert.rejects(sendDetailV2Snapshot({ headers: { "accept-encoding": header } }, response, value, () => {}), { status: 406 });
    assert.equal(response.body, undefined);
  }
  const request = { headers: { "accept-encoding": "gzip,identity;q=0" } };
  const small = new Response();
  await sendDetailV2Snapshot(request, small, { small: true }, () => {});
  assert.equal(small.headers["content-encoding"], "gzip");
  assert.deepEqual(JSON.parse(gunzipSync(small.body)), { small: true });
  await assert.rejects(sendDetailV2Snapshot(request, new Response(), value, () => {}, {
    compressor: async () => { throw new Error("fault"); }
  }), { status: 406 });
  const explicit = new Response();
  await sendDetailV2Snapshot({ headers: { "accept-encoding": "identity;q=1,*;q=0" } }, explicit, value, () => {});
  assert.deepEqual(JSON.parse(explicit.body), value);
});
test("busy compression never falls back to an excluded identity", async () => {
  const request = { headers: { "accept-encoding": "gzip,identity;q=0" } }, value = { text: "x".repeat(20000) };
  const releases = [];
  const compressor = raw => new Promise(resolve => releases.push(() => resolve(raw)));
  const jobs = [new Response(), new Response()].map(response => sendDetailV2Snapshot(request, response, value, () => {}, { compressor }));
  try {
    const response = new Response();
    await assert.rejects(sendDetailV2Snapshot(request, response, value, () => {}), { status: 406 });
    assert.equal(response.body, undefined);
  } finally {
    for (const release of releases) release(); await Promise.all(jobs);
  }
});

test("host write guard rejects nonfunctions and async guards without publishing", async () => {
  for (const beforeWrite of [null, true, {}, () => Promise.resolve(),
    () => Promise.reject(new Error("async rejection")), () => ({ then(resolve) { resolve(); } })]) {
    const response = new Response();
    await assert.rejects(sendDetailV2Snapshot({ headers: {} }, response, { small: true }, () => {}, { beforeWrite }),
      { code: "DETAIL_WRITE_GUARD_INVALID", status: 500 });
    assert.equal(response.status, undefined); assert.equal(response.body, undefined);
  }
});

test("guard runs after compression success or fallback and failure cannot be swallowed", async () => {
  for (const fault of [false, true]) {
    const response = new Response(); let authCalls = 0, release;
    const result = sendDetailV2Snapshot({ headers: { "accept-encoding": "gzip" } }, response,
      { text: "x".repeat(20000) }, () => { authCalls++; }, {
        compressor: raw => new Promise((resolve, reject) => { release = () => fault ? reject(new Error("zlib")) : resolve(gzipSync(raw)); }),
        beforeWrite: () => { throw Object.assign(new Error("retired"), { code: "DETAIL_READ_INVALIDATED", status: 409 }); }
      });
    const rejected = assert.rejects(result, { code: "DETAIL_READ_INVALIDATED", status: 409 });
    release(); await rejected;
    assert.equal(authCalls, 0); assert.equal(response.status, undefined); assert.equal(response.body, undefined);
  }
  const response = new Response();
  await sendDetailV2Snapshot({ headers: { "accept-encoding": "gzip" } }, response, { text: "x".repeat(20000) }, () => {});
  assert.equal(response.headers["content-encoding"], "gzip");
});

test("final synchronous guard catches authentication microtask changes before writes", async () => {
  for (const header of ["identity", "gzip"]) {
    const response = new Response(); let valid = true, guardCalls = 0;
    await assert.rejects(sendDetailV2Snapshot({ headers: { "accept-encoding": header } }, response,
      { text: "x".repeat(20000) }, () => { queueMicrotask(() => { valid = false; }); }, {
        beforeWrite: () => { guardCalls++; if (!valid) throw Object.assign(new Error("revoked"), { status: 403 }); }
      }), { status: 403 });
    assert.equal(guardCalls, header === "gzip" ? 2 : 1);
    assert.equal(response.status, undefined); assert.equal(response.body, undefined);
  }
});

test("guard preserves busy, encoding, size and closed response boundaries", async () => {
  const value = { text: "x".repeat(20000) }, releases = [];
  const jobs = [new Response(), new Response()].map(response => sendDetailV2Snapshot(
    { headers: { "accept-encoding": "gzip" } }, response, value, () => {}, {
      compressor: raw => new Promise(resolve => releases.push(() => resolve(gzipSync(raw))))
    }));
  try {
    let calls = 0;
    const identity = new Response();
    await sendDetailV2Snapshot({ headers: { "accept-encoding": "gzip" } }, identity, value, () => {}, { beforeWrite: () => { calls++; } });
    assert.equal(calls, 1); assert.equal(identity.headers["content-encoding"], undefined);
    assert.equal(identity.headers["cache-control"], "no-store");
    assert.equal(identity.headers["x-content-type-options"], "nosniff");
    assert.equal(identity.headers.vary, "Accept, X-Corptie-Detail-Capabilities, Accept-Encoding");
    const excluded = new Response();
    await assert.rejects(sendDetailV2Snapshot({ headers: { "accept-encoding": "gzip,identity;q=0" } }, excluded,
      value, () => {}, { beforeWrite: () => { calls++; } }), { status: 406 });
    assert.equal(calls, 2); assert.equal(excluded.status, undefined);
  } finally { releases.forEach(release => release()); await Promise.all(jobs); }
  let calls = 0;
  await assert.rejects(sendDetailV2Snapshot({ headers: {} }, new Response(), { text: "x".repeat(DETAIL_SNAPSHOT_LIMIT) },
    () => {}, { beforeWrite: () => { calls++; } }), { status: 413 });
  assert.equal(calls, 0);
  const closed = new Response(); closed.destroyed = true;
  await sendDetailV2Snapshot({ headers: { "accept-encoding": "gzip" } }, closed, value, () => {}, { beforeWrite: () => { calls++; } });
  assert.equal(calls, 2); assert.equal(closed.status, undefined); assert.equal(closed.body, undefined);
});
