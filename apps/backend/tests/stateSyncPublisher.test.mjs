import assert from "node:assert/strict";
import test from "node:test";
import { createStateSyncPublisher } from "../src/application/stateSyncPublisher.mjs";

function fixture() {
  const timers = [];
  const calls = [];
  let service = {
    changesAfter: (revision) => {
      calls.push(["changes", revision]);
      return { baseRevision: revision, revision: 4, upserts: { sessions: [{ id: "one", status: "idle" }] } };
    },
    snapshot: () => ({ revision: 4, sessions: [] })
  };
  const publisher = createStateSyncPublisher({
    readService: () => service,
    readRevision: () => 4,
    invalidateDevices: () => calls.push(["invalidate"]),
    recordSessionDiagnostic: (...args) => calls.push(["diagnostic", ...args]),
    scheduleTimeout: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancelTimeout: (timer) => calls.push(["cancel", timer]),
    warn: (message) => calls.push(["warn", message])
  });
  function connect(revision) {
    const frames = [];
    const response = { write: (frame) => frames.push(frame) };
    publisher.stateSyncClients.set(response, revision);
    return { frames, response };
  }
  return { publisher, timers, calls, connect, setService: (value) => { service = value; } };
}

test("scheduling coalesces bursts while still invalidating device state on every mutation", () => {
  const f = fixture();
  f.connect(1);
  f.publisher.scheduleStateSyncPublish();
  f.publisher.scheduleStateSyncPublish();
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 20);
  assert.equal(f.calls.filter(([name]) => name === "invalidate").length, 2);
  f.timers[0].callback();
  f.publisher.scheduleStateSyncPublish();
  assert.equal(f.timers.length, 2);
});

test("equal client revisions share one payload read; current clients receive no duplicate", () => {
  const f = fixture();
  const first = f.connect(1);
  const second = f.connect(1);
  const current = f.connect(4);
  f.publisher.publishStateChangesIfNeeded();
  assert.deepEqual(f.calls.filter(([name]) => name === "changes"), [["changes", 1]]);
  assert.deepEqual(first.frames, second.frames);
  assert.match(first.frames[0], /id: 4\nevent: state-change-set\n/);
  assert.deepEqual(current.frames, []);
  assert.equal(f.publisher.stateSyncClients.get(first.response), 4);
});

test("missing replay history publishes a snapshot and advances only to its revision", () => {
  const f = fixture();
  const client = f.connect(1);
  f.setService({
    changesAfter: () => ({ snapshotRequired: true }),
    snapshot: () => ({ revision: 3, sessions: [] })
  });
  f.publisher.publishStateChangesIfNeeded();
  assert.match(client.frames[0], /event: state-snapshot/);
  assert.equal(f.publisher.stateSyncClients.get(client.response), 3);
});

test("failed stable reads preserve the client cursor and schedule a retry", () => {
  const f = fixture();
  const client = f.connect(1);
  f.setService({ changesAfter: () => { throw new Error("unstable snapshot"); } });
  f.publisher.publishStateChangesIfNeeded();
  assert.equal(f.publisher.stateSyncClients.get(client.response), 1);
  assert.deepEqual(client.frames, []);
  assert.equal(f.timers.length, 1);
  assert.equal(f.calls[0][0], "warn");
});

test("cancellation releases the timer without discarding connected clients", () => {
  const f = fixture();
  f.connect(1);
  f.publisher.scheduleStateSyncPublish();
  f.publisher.cancelPendingPublish();
  f.publisher.cancelPendingPublish();
  assert.equal(f.calls.filter(([name]) => name === "cancel").length, 1);
  assert.equal(f.publisher.stateSyncClients.size, 1);
  f.publisher.scheduleStateSyncPublish();
  assert.equal(f.timers.length, 2);
});

test("no client means no timer; an unavailable service produces no frames", () => {
  const f = fixture();
  f.publisher.scheduleStateSyncPublish();
  assert.equal(f.timers.length, 0);
  const client = f.connect(1);
  f.setService(null);
  f.publisher.publishStateChangesIfNeeded();
  assert.deepEqual(client.frames, []);
});
