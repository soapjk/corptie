import assert from "node:assert/strict";
import test from "node:test";
import { handleEntityHttpRequest } from "../src/application/entityHttpApi.mjs";

async function request(method, body = {}, available = true) {
  const calls = [];
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const response = {
    headersSent: false,
    writeHead(status) { this.status = status; },
    end(bytes) { this.headersSent = true; finish({ status: this.status, body: JSON.parse(bytes), calls }); }
  };
  const url = new URL("http://localhost/works/work%3Abound/local-state");
  const handled = handleEntityHttpRequest({
    url, response,
    request: { method, headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } },
    workService: { getWork(id) { assert.equal(id, "work:bound"); return { id }; } },
    ...(available ? { workLocalState: async (id, options) => {
      calls.push({ id, ...options });
      return { state: options.repair ? "ready" : "missing", scope: "projectShared" };
    } } : {})
  });
  assert.equal(handled, true);
  return completed;
}

test("Work local-state HTTP diagnosis is read-only and repair binds the exact Work", { timeout: 2000 }, async () => {
  const read = await request("GET");
  assert.equal(read.status, 200);
  assert.equal(read.body.state, "missing");
  assert.deepEqual(read.calls, [{ id: "work:bound", repair: false }]);
  const repair = await request("POST");
  assert.equal(repair.status, 200);
  assert.deepEqual(repair.calls, [{ id: "work:bound", repair: true }]);
});

test("Work local-state HTTP repair rejects path overrides and unavailable hosts", { timeout: 2000 }, async () => {
  const override = await request("POST", { path: "/untrusted" });
  assert.equal(override.status, 400);
  assert.deepEqual(override.calls, []);
  assert.equal((await request("GET", {}, false)).status, 503);
});
