import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ClientEventStream } from "../src/application/clientEventStream.mjs";

class Response extends EventEmitter {
  frames = []; destroyed = false; writableLength = 0; writable = true;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(frame) { this.frames.push(frame); return this.writable; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}
const identity = { deviceId: "one", permissions: ["inventory.read", "messages.read"] };
const data = frame => JSON.parse(frame.split("data: ")[1]);

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

test("permission filtering, expired authentication and slow clients fail closed", () => {
  const hub = new ClientEventStream();
  try {
    const readonly = new Response(); hub.attach(readonly, () => ({ ...identity, permissions: ["inventory.read"] }));
    hub.invalidate({ inventory: true, sessionId: "secret-session" }); hub.flush();
    assert.deepEqual(data(readonly.frames.at(-1)).sessions, []);
    const slow = new Response(); hub.attach(slow, () => identity); slow.writable = false;
    hub.invalidate({ inventory: true }); hub.flush();
    assert.equal(slow.destroyed, true);
    let expired = false;
    const authenticated = new Response(); hub.attach(authenticated, () => { if (expired) throw Error(); return { ...identity, deviceId: "two" }; });
    expired = true; hub.flush(); assert.equal(authenticated.destroyed, true);
    assert.throws(() => hub.attach(new Response(), () => ({ ...identity, permissions: [] })), { code: "DEVICE_PERMISSION_REQUIRED" });
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

test("control invalidations are independently permissioned and reset on reconnect", () => {
  const hub = new ClientEventStream();
  try {
    const control = new Response();
    hub.attach(control, () => ({ deviceId: "control", permissions: ["control.read"] }));
    const basic = new Response();
    hub.attach(basic, () => identity);
    assert.equal(data(control.frames[0]).control, true);
    assert.equal(data(control.frames[0]).inventory, false);
    hub.invalidate({ control: true, sessionId: "private-session", inventory: true }); hub.flush();
    assert.equal(data(control.frames.at(-1)).control, true);
    assert.deepEqual(data(control.frames.at(-1)).sessions, []);
    assert.equal(data(basic.frames.at(-1)).control, false);
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
    hub.attachV2(response, () => ({ ...identity, permissions: [...identity.permissions, "control.read"] }),
      { sessionId: "session:one", stateRevision: 6, timelineRevision: 2 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(response.frames.map(frame => frame.match(/event: ([^\n]+)/)?.[1]),
      ["stream-ready", "state-snapshot", "control-snapshot", "timeline-snapshot"]);
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
    assert.equal(data(response.frames.find(frame => frame.includes("event: timeline-delta"))).baseRevision, 3);
  } finally { hub.close(); }
});
