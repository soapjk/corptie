import assert from "node:assert/strict";
import test from "node:test";
import { SessionTimelinePublishGate } from "../src/utils/sessionTimelinePublishGate.mjs";

test("a provider event arriving during a read is coalesced and replayed immediately", async () => {
  const reads = [];
  const releases = [];
  let settled = 0;
  const gate = new SessionTimelinePublishGate({
    read: (options) => new Promise((resolve) => {
      reads.push(options);
      releases.push(resolve);
    }),
    onSettled: () => { settled += 1; }
  });

  const first = gate.request({ fullConsistency: false });
  await Promise.resolve();
  await gate.request({ fullConsistency: false });
  await gate.request({ fullConsistency: true });
  assert.deepEqual(reads, [{ fullConsistency: false }]);
  releases.shift()();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reads, [
    { fullConsistency: false },
    { fullConsistency: true }
  ]);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, 1);
});

test("closing during a read discards queued refreshes", async () => {
  let release;
  let reads = 0;
  const gate = new SessionTimelinePublishGate({
    read: () => new Promise((resolve) => {
      reads += 1;
      release = resolve;
    })
  });
  const first = gate.request();
  await Promise.resolve();
  await gate.request();
  gate.close();
  release();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
});
