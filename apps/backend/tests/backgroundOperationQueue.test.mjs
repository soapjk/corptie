import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundOperationQueue } from "../src/application/backgroundOperationQueue.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("interactive pending work runs first without exceeding concurrency", async () => {
  const queue = new BackgroundOperationQueue({ concurrency: 1 });
  const gate = deferred();
  const order = [];
  const first = queue.run(() => gate.promise);
  const low = queue.run(() => { order.push("summary"); });
  const high = queue.run(() => { order.push("draft"); }, { priority: 1 });
  gate.resolve();
  await Promise.all([first, low, high]);
  assert.deepEqual(order, ["draft", "summary"]);
});

test("cancelling pending work never invokes it", async () => {
  const queue = new BackgroundOperationQueue({ concurrency: 1 });
  const gate = deferred();
  const first = queue.run(() => gate.promise);
  const abort = new AbortController();
  const pending = queue.run(() => assert.fail("cancelled work invoked"), { signal: abort.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  abort.abort();
  await rejected;
  gate.resolve();
  await first;
});

test("running cancellation rejects late output and retains its execution slot", async () => {
  const queue = new BackgroundOperationQueue({ concurrency: 1 });
  const gate = deferred();
  const entered = deferred();
  const abort = new AbortController();
  const first = queue.run(() => { entered.resolve(); return gate.promise; }, { signal: abort.signal });
  const rejected = assert.rejects(first, { name: "AbortError" });
  await entered.promise;
  abort.abort();
  assert.equal(queue.running, 1);
  gate.resolve("obsolete result");
  await rejected;
});
