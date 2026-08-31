import assert from "node:assert/strict";
import test from "node:test";
import { SerializedOperationQueue } from "../src/application/serializedOperationQueue.mjs";

test("serialized operation queue runs independent operations one at a time", async () => {
  const queue = new SerializedOperationQueue();
  const events = [];
  let releaseFirst;
  const first = queue.run(async () => {
    events.push("first:start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push("first:end");
    return "first";
  });
  const second = queue.run(async () => {
    events.push("second:start");
    events.push("second:end");
    return "second";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  assert.equal(queue.pending, 2);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  await queue.tail;
  assert.equal(queue.pending, 0);
});

test("serialized operation queue continues after a rejected operation", async () => {
  const queue = new SerializedOperationQueue();
  const first = queue.run(async () => { throw new Error("creation failed"); });
  const second = queue.run(async () => "recovered");
  await assert.rejects(first, /creation failed/);
  assert.equal(await second, "recovered");
});
