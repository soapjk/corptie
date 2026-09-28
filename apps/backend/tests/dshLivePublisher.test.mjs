import assert from "node:assert/strict";
import test from "node:test";
import { createDshLivePublisher } from "../src/dsh-adapter/dshLivePublisher.mjs";

function fixture() {
  const frames = [];
  const statuses = [];
  const publisher = createDshLivePublisher({
    lastSessionEventSequence: () => 10,
    broadcastDshMuxFrame: (frame) => frames.push(frame),
    broadcastDshHostFrame: (frame) => statuses.push(frame)
  });
  return { publisher, frames, statuses };
}

test("prompt starts a live turn once and suppresses its duplicate durable user message", () => {
  const f = fixture();
  f.publisher.publishDshPromptStart("one", "Hello");
  assert.deepEqual(f.frames.map((frame) => frame.event.type), ["turn/start", "user/message", "step/start"]);
  assert.deepEqual(f.frames.map((frame) => frame.event.seq), [11, 12, 13]);
  assert.equal(f.publisher.activeTurnCount, 1);
  f.publisher.publishSessionEvent({ sessionId: "one", type: "user/message", sequence: 11, payload: { text: "Hello" } });
  assert.equal(f.frames.length, 3);
  assert.equal(f.statuses[0].running, true);
});

test("assistant completion closes the live step and advances the next prompt sequence", () => {
  const f = fixture();
  f.publisher.publishDshPromptStart("one", "Hello");
  f.publisher.publishSessionEvent({
    sessionId: "one", type: "assistant/message", sequence: 12,
    payload: { text: "Done" }, createdAt: "2026-01-01T00:00:00Z"
  });
  assert.deepEqual(f.frames.slice(3).map((frame) => frame.event.type), ["assistant/message", "step/end", "turn/end"]);
  assert.deepEqual(f.frames.slice(3).map((frame) => frame.event.seq), [14, 15, 16]);
  assert.equal(f.publisher.activeTurnCount, 0);
  f.publisher.publishDshPromptStart("one", "Next");
  assert.equal(f.frames[6].event.seq, 17);
});

test("prompt failure terminates only the matching session and is idempotent", () => {
  const f = fixture();
  f.publisher.publishDshPromptStart("one", "First");
  f.publisher.publishDshPromptStart("two", "Second");
  f.publisher.publishDshPromptFailure("one", "unavailable");
  assert.equal(f.publisher.activeTurnCount, 1);
  assert.deepEqual(f.frames.at(-1).event.data.reason, { kind: "error", message: "unavailable" });
  assert.deepEqual(f.statuses.at(-1), { type: "host/session-status", sessionId: "one", running: false });
  const length = f.frames.length;
  f.publisher.publishDshPromptFailure("one", "again");
  assert.equal(f.frames.length, length);
});

test("non-live messages retain their durable sequence and work lifecycle controls host status", () => {
  const f = fixture();
  f.publisher.publishSessionEvent({ sessionId: "one", type: "assistant/message", sequence: 42, payload: { text: "Hello" } });
  assert.equal(f.frames[0].event.seq, 42);
  f.publisher.publishSessionEvent({ sessionId: "one", type: "AgentWorkStarted" });
  f.publisher.publishSessionEvent({ sessionId: "one", type: "AgentWorkFailed" });
  assert.deepEqual(f.statuses.map((frame) => frame.running), [true, false]);
  assert.equal(f.frames.length, 1);
});
