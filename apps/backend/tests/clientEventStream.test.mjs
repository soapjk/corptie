import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ClientEventStream, parseRealtimeResumeQuery } from "../src/application/clientEventStream.mjs";

class Response extends EventEmitter {
  frames = []; destroyed = false; writableLength = 0; writable = true;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(frame) { this.frames.push(frame); return this.writable; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}
const identity = { deviceId: "one" };
const data = frame => JSON.parse(frame.split("data: ")[1]);

test("realtime resume queries bound untrusted cursor count, IDs and revisions", () => {
  assert.deepEqual(parseRealtimeResumeQuery(new URLSearchParams()), { timelineRevisions: {}, backgroundTimelineLimit: null, timelineCoalescing: false });
  assert.deepEqual(parseRealtimeResumeQuery(new URLSearchParams({ timelineRevisions: '{"one":4}', backgroundTimelineLimit: "2" })),
    { timelineRevisions: { one: 4 }, backgroundTimelineLimit: 2, timelineCoalescing: false });
  assert.equal(parseRealtimeResumeQuery(new URLSearchParams({ timelineCoalescing: "true" })).timelineCoalescing, true);
  assert.throws(() => parseRealtimeResumeQuery(new URLSearchParams({ timelineCoalescing: "1" })), { code: "INVALID_QUERY" });
  for (const value of ["[]", "null", '{"one":-1}', '{"one":"4"}', "{", JSON.stringify(Object.fromEntries(Array.from({length:49}, (_, i) => [String(i), 1])))]) {
    assert.throws(() => parseRealtimeResumeQuery(new URLSearchParams({ timelineRevisions: value })), { code: "INVALID_QUERY" });
  }
  for (const value of ["-1", "49", "1.5", "NaN"]) {
    assert.throws(() => parseRealtimeResumeQuery(new URLSearchParams({ backgroundTimelineLimit: value })), { code: "INVALID_QUERY" });
  }
});

test("reconnect resumes cached timelines and prioritizes selection with bounded new windows", async () => {
  const reads = [];
  const hub = new ClientEventStream({
    stateSnapshot: async () => ({ revision: 1, sessions: ["new", "selected", "cached", "other"].map(id => ({id})) }),
    timeline: async (_identity, id, after) => {
      reads.push([id, after]);
      return { kind: after ? "delta" : "snapshot", sessionId: id, revision: after + 1, hasMore: false };
    }
  });
  try {
    hub.attachV2(new Response(), () => identity, { sessionId: "selected", timelineRevision: 7,
      timelineRevisions: { cached: 9, removed: 12 }, backgroundTimelineLimit: 1 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, [["selected", 7], ["cached", 9], ["new", 0]]);
  } finally { hub.close(); }
});

test("on-demand clients skip unrelated history and subscribe without reconnecting", async () => {
  const reads = [];
  const hub = new ClientEventStream({
    stateSnapshot: async () => ({ revision: 1, sessions: ["selected", "other"].map(id => ({ id })) }),
    timeline: async (_identity, id, after, options) => {
      reads.push([id, after, options.coalesce]);
      return { kind: after ? "delta" : "snapshot", sessionId: id, revision: after + 1 };
    }
  });
  const response = new Response();
  try {
    hub.attachV2(response, () => identity, { sessionId: "selected", backgroundTimelineLimit: 0, timelineCoalescing: true });
    await new Promise(resolve => setImmediate(resolve));
    hub.publishTimeline("other");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, [["selected", 0, true]]);
    hub.observeTimeline("wrong-device", "other", 7);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, 1);
    hub.observeTimeline(identity.deviceId, "other", 7);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads.at(-1), ["other", 7, true]);
    hub.publishTimeline("other");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads.at(-1), ["other", 8, true]);
    assert.equal(hub.clients.size, 1);
    assert.equal(response.destroyed, false);
  } finally { hub.close(); }
});

test("receipt publication bypasses an in-flight history read", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const hub = new ClientEventStream({ timeline: async () => { await blocked; return null; } });
  const response = new Response();
  try {
    hub.attachV2(response, () => identity, { sessionId: "selected" });
    await new Promise(resolve => setImmediate(resolve));
    hub.publishReceipt(identity.deviceId, { requestId: "message", status: "accepted" });
    assert.equal(data(response.frames.at(-1)).requestId, "message");
    assert.match(response.frames.at(-1), /event: command-receipt/);
  } finally { release(); hub.close(); }
});

test("a selected Session disappearing does not close the global stream", async () => {
  const hub = new ClientEventStream({
    stateSnapshot: async () => ({ revision: 1, sessions: [{ id: "other" }] }),
    timeline: async (_identity, id) => {
      if (id === "deleted") throw Object.assign(new Error("unavailable"), { code: "SESSION_NOT_AVAILABLE", status: 404 });
      return { kind: "snapshot", sessionId: id, revision: 1 };
    }
  });
  const response = new Response();
  try {
    hub.attachV2(response, () => identity, { sessionId: "deleted", backgroundTimelineLimit: 1 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(response.destroyed, false);
    assert.equal(data(response.frames.at(-1)).sessionId, "other");
  } finally { hub.close(); }
});

test("first connect and reconnect always reset; bursts are coalesced with bounded IDs", () => {
  const hub = new ClientEventStream(), response = new Response();
  try {
    hub.attach(response, () => identity);
    assert.match(response.frames[0], /event: reset/);
    for (let i = 0; i < 10000; i++) hub.invalidate({ inventory: true, sessionId: `session:${i}` });
    assert.equal(response.frames.length, 1);
    assert.ok(hub.sessions.size <= 128);
    hub.flush();
    assert.equal(response.frames.length, 2);
    assert.equal(data(response.frames[1]).allSessions, true);
    response.destroy();
    const next = new Response(); hub.attach(next, () => identity);
    assert.match(next.frames[0], /event: reset/);
  } finally { hub.close(); }
  assert.equal(hub.clients.size, 0);
});

test("approved clients receive the full stream while expired authentication and slow clients fail closed", () => {
  const hub = new ClientEventStream();
  try {
    const readonly = new Response(); hub.attach(readonly, () => identity);
    hub.invalidate({ inventory: true, sessionId: "secret-session" }); hub.flush();
    assert.deepEqual(data(readonly.frames.at(-1)).sessions, ["secret-session"]);
    const slow = new Response(); hub.attach(slow, () => identity); slow.writable = false;
    hub.invalidate({ inventory: true }); hub.flush();
    assert.equal(slow.destroyed, true);
    let expired = false;
    const authenticated = new Response(); hub.attach(authenticated, () => { if (expired) throw Error(); return { ...identity, deviceId: "two" }; });
    expired = true; hub.flush(); assert.equal(authenticated.destroyed, true);
  } finally { hub.close(); }
});

test("per-device subscription limit and no work when idle", () => {
  const hub = new ClientEventStream();
  hub.invalidate({ inventory: true }); assert.equal(hub.timer, undefined);
  try {
    hub.attach(new Response(), () => identity); hub.attach(new Response(), () => identity);
    assert.throws(() => hub.attach(new Response(), () => identity), { code: "STREAM_LIMIT" });
  } finally { hub.close(); }
});

test("control and timeline invalidations are delivered consistently to every approved client", () => {
  const hub = new ClientEventStream();
  try {
    const control = new Response();
    hub.attach(control, () => ({ deviceId: "control" }));
    const basic = new Response();
    hub.attach(basic, () => identity);
    assert.equal(data(control.frames[0]).control, true);
    assert.equal(data(control.frames[0]).inventory, true);
    hub.invalidate({ control: true, sessionId: "private-session", inventory: true }); hub.flush();
    assert.equal(data(control.frames.at(-1)).control, true);
    assert.deepEqual(data(control.frames.at(-1)).sessions, ["private-session"]);
    assert.equal(data(basic.frames.at(-1)).control, true);
  } finally { hub.close(); }
});

test("sessionIds batch parameter records all session aliases for device notification", () => {
  const hub = new ClientEventStream();
  try {
    const response = new Response();
    hub.attach(response, () => identity);
    hub.invalidate({ sessionIds: ["codex:123", "logical:456", "123"] });
    hub.flush();
    assert.equal(response.frames.length, 2);
    const payload = data(response.frames[1]);
    assert.deepEqual(payload.sessions.sort(), ["123", "codex:123", "logical:456"].sort());
  } finally { hub.close(); }
});

test("v2 pushes authoritative payloads and receipts without legacy invalidations", async () => {
  let stateRevision = 7, timelineRevision = 3;
  const hub = new ClientEventStream({
    stateSnapshot: async (_identity, after) => ({ schemaVersion: 2, revision: stateRevision, after, works: [], tasks: [], sessions: [] }),
    controlSnapshot: async () => ({ schemaVersion: 2, automations: [], repositories: [], agents: [], skills: [] }),
    timeline: async (_identity, sessionId, after) => ({ schemaVersion: 2, kind: after === 0 ? "snapshot" : "delta",
      sessionId, revision: timelineRevision, baseRevision: after, currentRevision: timelineRevision,
      snapshotRequired: false, hasMore: false, changes: [] })
  });
  const response = new Response();
  try {
    hub.attachV2(response, () => identity,
      { sessionId: "session:one", stateRevision: 6, timelineRevision: 2 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(response.frames.map(frame => frame.match(/event: ([^\n]+)/)?.[1]),
      ["stream-ready", "state-snapshot", "timeline-delta", "control-snapshot"]);
    assert.equal(data(response.frames[1]).after, 0);

    hub.invalidate({ inventory: true, control: true, sessionId: "session:one" });
    hub.flush();
    assert.equal(response.frames.length, 4);

    stateRevision = 8; timelineRevision = 4;
    hub.publishState();
    hub.publishControl();
    hub.publishTimeline(["session:one"]);
    hub.publishReceipt("one", { schemaVersion: 1, requestId: "request:one", status: "completed" });
    await new Promise(resolve => setTimeout(resolve, 40));
    await new Promise(resolve => setImmediate(resolve));
    const events = response.frames.map(frame => frame.match(/event: ([^\n]+)/)?.[1]);
    assert.ok(events.includes("timeline-delta"));
    assert.ok(events.includes("state-snapshot"));
    assert.ok(events.includes("control-snapshot"));
    assert.ok(events.includes("command-receipt"));
    assert.equal(data(response.frames.filter(frame => frame.includes("event: timeline-delta")).at(-1)).baseRevision, 3);
  } finally { hub.close(); }
});

test("v2 pushes changed background timelines and advances revisions per session", async () => {
  const revisions = new Map([["session:selected", 2], ["session:background", 5]]);
  const hub = new ClientEventStream({
    timeline: async (_identity, sessionId, after) => ({
      schemaVersion: 2,
      kind: after === 0 ? "snapshot" : "delta",
      sessionId,
      revision: revisions.get(sessionId),
      baseRevision: after,
      currentRevision: revisions.get(sessionId),
      snapshotRequired: false,
      hasMore: false,
      changes: []
    })
  });
  const response = new Response();
  try {
    hub.attachV2(response, () => identity,
      { sessionId: "session:selected", timelineRevision: 1 });
    await new Promise(resolve => setImmediate(resolve));

    hub.publishTimeline("session:background");
    await new Promise(resolve => setImmediate(resolve));
    const first = response.frames.find(frame => frame.includes("event: timeline-snapshot")
      && data(frame).sessionId === "session:background");
    assert.ok(first, "first background update is an authoritative snapshot");

    revisions.set("session:background", 6);
    hub.publishTimeline("session:background");
    await new Promise(resolve => setImmediate(resolve));
    const backgroundDeltas = response.frames.filter(frame => frame.includes("event: timeline-delta")
      && data(frame).sessionId === "session:background");
    assert.equal(backgroundDeltas.length, 1);
    assert.equal(data(backgroundDeltas[0]).baseRevision, 5);
  } finally { hub.close(); }
});

test("v2 connect and reconnect proactively warm the active resident Timeline set", async () => {
  const timelineReads = [];
  const sessions = ["session:selected", "session:recent-a", "session:recent-b"];
  const hub = new ClientEventStream({
    stateSnapshot: async () => ({ schemaVersion: 2, revision: 4, works: [], tasks: [],
      sessions: sessions.map(id => ({ id })) }),
    timeline: async (_identity, sessionId, after) => {
      timelineReads.push({ sessionId, after });
      return { schemaVersion: 2, kind: "snapshot", sessionId, revision: 9,
        messages: { schemaVersion: 1, sessionId, items: [], hasEarlier: false, nextBefore: null, revision: 9 },
        capabilities: { schemaVersion: 1, sessionId, readMessages: true,
          send: { available: false }, stop: { available: false } }, usage: null, composer: null };
    }
  });
  try {
    for (let connection = 0; connection < 2; connection += 1) {
      const response = new Response();
      hub.attachV2(response, () => identity, { sessionId: "session:selected", timelineRevision: 9 });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(response.frames.filter(frame => frame.includes("event: timeline-snapshot"))
        .map(frame => data(frame).sessionId), sessions);
      response.destroy();
    }
    assert.deepEqual(timelineReads.map(read => read.sessionId), [...sessions, ...sessions]);
    assert.ok(timelineReads.every(read => read.after === (read.sessionId === "session:selected" ? 9 : 0)),
      "reconnect supplies the selected cursor and snapshots uncached background Sessions");
  } finally { hub.close(); }
});

test("v2 bounds background bootstrap residency while preserving newest inventory order", async () => {
  const timelineReads = [];
  const sessions = Array.from({ length: 8 }, (_, index) => `session:${index}`);
  const hub = new ClientEventStream({
    backgroundTimelineLimit: 3,
    backgroundTimelineBatchSize: 3,
    stateSnapshot: async () => ({ schemaVersion: 2, revision: 1, works: [], tasks: [],
      sessions: sessions.map(id => ({ id })) }),
    timeline: async (_identity, sessionId, _after, options) => {
      timelineReads.push({ sessionId, includeDetail: options.includeDetail });
      return { schemaVersion: 2, kind: "snapshot", sessionId, revision: 1,
        messages: { schemaVersion: 1, sessionId, items: [], hasEarlier: false, nextBefore: null, revision: 1 },
        capabilities: { schemaVersion: 1, sessionId, readMessages: true,
          send: { available: false }, stop: { available: false } }, usage: null, composer: null };
    }
  });
  try {
    hub.attachV2(new Response(), () => identity);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(timelineReads, sessions.slice(0, 3).map(sessionId => ({
      sessionId, includeDetail: false
    })));
  } finally { hub.close(); }
});

test("background histories are paced batches; live traffic and control do not wait for all history", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reads = [];
  const response = new Response();
  const hub = new ClientEventStream({
    backgroundTimelineLimit: 5,
    backgroundTimelineBatchDelayMs: 1000,
    stateSnapshot: async () => ({ revision: 1, sessions: ["selected", "a", "b", "c", "d", "e"].map(id => ({ id })) }),
    controlSnapshot: async () => ({ revision: 1 }),
    timeline: async (_identity, id, after) => {
      reads.push([id, after]);
      return { kind: after ? "delta" : "snapshot", sessionId: id, revision: after + 1 };
    }
  });
  try {
    hub.attachV2(response, () => identity, { sessionId: "selected" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, [["selected", 0], ["a", 0], ["b", 0]]);
    assert.ok(response.frames.findIndex(frame => frame.includes("event: control-snapshot"))
      < response.frames.findIndex(frame => frame.includes('"sessionId":"a"')));
    hub.publishReceipt(identity.deviceId, { requestId: "message", status: "accepted" });
    assert.match(response.frames.at(-1), /event: command-receipt/);
    hub.publishTimeline("selected");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads.at(-1), ["selected", 1]);
    t.mock.timers.tick(999);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, 4);
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads.slice(-2), [["c", 0], ["d", 0]]);
    response.destroy();
    t.mock.timers.tick(10000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.some(([id]) => id === "e"), false, "disconnect cancels remaining history");
  } finally { hub.close(); }
});

test("large history batches wait according to serialized bytes and resume cached cursors", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reads = [];
  const hub = new ClientEventStream({
    backgroundTimelineBatchSize: 1,
    backgroundTimelineBatchDelayMs: 10,
    backgroundTimelineBytesPerSecond: 1000,
    stateSnapshot: async () => ({ revision: 1, sessions: [{ id: "a" }, { id: "b" }] }),
    timeline: async (_identity, id, after) => {
      reads.push([id, after]);
      return { kind: "delta", sessionId: id, revision: after + 1, content: "x".repeat(5000) };
    }
  });
  try {
    hub.attachV2(new Response(), () => identity, { timelineRevisions: { a: 7, b: 9 }, backgroundTimelineLimit: 0 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, [["a", 7]]);
    t.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, 1);
    t.mock.timers.tick(10000);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, [["a", 7], ["b", 9]]);
  } finally { hub.close(); }
});

test("v2 coalesces per-client timeline bursts and performs one follow-up for an in-flight change", async () => {
  let releaseFirst;
  const firstRead = new Promise(resolve => { releaseFirst = resolve; });
  let reads = 0;
  const hub = new ClientEventStream({
    timeline: async (_identity, sessionId, after) => {
      reads += 1;
      if (reads === 1) await firstRead;
      return { schemaVersion: 2, kind: after === 0 ? "snapshot" : "delta", sessionId,
        revision: reads, baseRevision: after, currentRevision: reads,
        snapshotRequired: false, hasMore: false, changes: [] };
    }
  });
  try {
    hub.attachV2(new Response(), () => identity);
    for (let index = 0; index < 100; index += 1) hub.publishTimeline("session:burst");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1, "queued burst becomes one durable read");
    for (let index = 0; index < 100; index += 1) hub.publishTimeline("session:burst");
    releaseFirst();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 2, "changes during the read become exactly one follow-up");
  } finally { hub.close(); }
});

test("v2 isolates concurrent clients so one slow connection cannot block another", async () => {
  const hub = new ClientEventStream({
    timeline: async (_identity, sessionId) => ({ schemaVersion: 2, kind: "snapshot",
      sessionId, revision: 1,
      messages: { schemaVersion: 1, sessionId, items: [], hasEarlier: false, nextBefore: null, revision: 1 },
      capabilities: { schemaVersion: 1, sessionId, readMessages: true,
        send: { available: false }, stop: { available: false } }, usage: null, composer: null })
  });
  const slow = new Response(), healthy = new Response();
  try {
    hub.attachV2(slow, () => ({ ...identity, deviceId: "slow" }));
    hub.attachV2(healthy, () => ({ ...identity, deviceId: "healthy" }));
    await new Promise(resolve => setImmediate(resolve));
    slow.writableLength = 2 * 1024 * 1024 + 1;

    hub.publishTimeline("session:shared");
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(slow.destroyed, true);
    assert.ok(healthy.frames.some(frame => frame.includes("event: timeline-snapshot")
      && data(frame).sessionId === "session:shared"));
    assert.equal(healthy.destroyed, false);
  } finally { hub.close(); }
});

test("v2 waits for socket drain instead of treating normal backpressure as failure", async () => {
  let reads = 0;
  const hub = new ClientEventStream({
    timeline: async (_identity, sessionId) => {
      reads += 1;
      return { schemaVersion: 2, kind: "snapshot", sessionId, revision: 1,
        messages: { schemaVersion: 1, sessionId, items: [], hasEarlier: false, nextBefore: null, revision: 1 },
        capabilities: { schemaVersion: 1, sessionId, readMessages: true,
          send: { available: false }, stop: { available: false } }, usage: null, composer: null };
    }
  });
  const response = new Response();
  try {
    hub.attachV2(response, () => identity);
    await new Promise(resolve => setImmediate(resolve));
    response.writable = false;
    response.writableNeedDrain = true;
    hub.publishTimeline(["session:first", "session:second"]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.equal(response.destroyed, false);

    response.writable = true;
    response.writableNeedDrain = false;
    response.emit("drain");
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 2);
    assert.equal(response.destroyed, false);
  } finally { hub.close(); }
});
