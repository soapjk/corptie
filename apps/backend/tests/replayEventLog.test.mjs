import assert from "node:assert/strict";
import test from "node:test";
import { ReplayEventLog } from "../src/utils/replayEventLog.mjs";

test("global event replay keeps monotonic ids while bounding memory", () => {
  const log = new ReplayEventLog({ capacity: 3 });
  for (const type of ["one", "two", "three", "four", "five"]) {
    log.append({ type });
  }

  assert.equal(log.size, 3);
  assert.deepEqual(log.replayAfter(3).entries.map((event) => [event.id, event.type]), [
    [4, "four"],
    [5, "five"]
  ]);
  assert.equal(log.replayAfter(3).gap, false);
  assert.equal(log.replayAfter(1).gap, true);
});

test("reconnect at the latest cursor is an empty idempotent replay", () => {
  const log = new ReplayEventLog({ capacity: 2 });
  log.append({ type: "one" });
  const latest = log.append({ type: "two" });

  assert.deepEqual(log.replayAfter(latest.id), {
    gap: false,
    oldestId: 1,
    latestId: 2,
    entries: []
  });
});

test("a cursor from a restarted backend requests authoritative recovery", () => {
  const restarted = new ReplayEventLog({ capacity: 2 });

  assert.equal(restarted.replayAfter(42).gap, true);
  assert.equal(restarted.replayAfter(42).latestId, 0);
});
