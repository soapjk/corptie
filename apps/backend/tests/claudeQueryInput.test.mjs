import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeQueryInput } from "../src/adapters/claudeQueryInput.mjs";

test("queued messages and waiting readers retain FIFO order", async () => {
  const queue = new ClaudeQueryInput();
  queue.enqueue("first");
  queue.enqueue("second");
  assert.equal(queue.pendingCount, 2);
  assert.equal(await queue.dequeue(false), "first");
  assert.equal(await queue.dequeue(false), "second");
  const waiting = queue.dequeue(false);
  queue.enqueue("third");
  assert.equal(await waiting, "third");
  assert.equal(queue.pendingCount, 0);
});

test("reset wakes all readers and discards buffered input", async () => {
  const queue = new ClaudeQueryInput();
  const readers = [queue.dequeue(false), queue.dequeue(false)];
  queue.reset();
  assert.deepEqual(await Promise.all(readers), [null, null]);
  queue.enqueue("discard");
  queue.reset();
  assert.equal(queue.pendingCount, 0);
  assert.equal(await queue.dequeue(true), null);
});

test("a closed stream stops and a fresh query can reuse the reset queue", async () => {
  const queue = new ClaudeQueryInput();
  let closed = false;
  const iterator = queue.stream(() => closed)[Symbol.asyncIterator]();
  const waiting = iterator.next();
  closed = true;
  queue.reset();
  assert.equal((await waiting).done, true);
  closed = false;
  queue.enqueue("new-query");
  const next = queue.stream(() => closed)[Symbol.asyncIterator]();
  assert.deepEqual(await next.next(), { done: false, value: "new-query" });
  await next.return();
});
