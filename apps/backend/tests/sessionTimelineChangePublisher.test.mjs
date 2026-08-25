import assert from "node:assert/strict";
import test from "node:test";
import { SessionTimelineChangePublisher } from "../src/application/sessionTimelineChangePublisher.mjs";

test("timeline wake publisher coalesces each Session to its highest durable revision", () => {
  const emitted = [];
  const publisher = new SessionTimelineChangePublisher({
    emit: (change) => emitted.push(change),
    delayMs: 60_000
  });
  try {
    publisher.schedule({ sessionId: "session:a", revision: 2 });
    publisher.schedule({ sessionId: "session:b", revision: 4 });
    publisher.schedule({ sessionId: "session:a", revision: 3 });
    publisher.schedule({ sessionId: "session:a", revision: 1 });
    publisher.flush();

    assert.deepEqual(emitted, [
      { sessionId: "session:a", timelineRevision: 3 },
      { sessionId: "session:b", timelineRevision: 4 }
    ]);
  } finally {
    publisher.close();
  }
});

test("timeline wake publisher ignores invalid cursors and drops pending work on close", () => {
  const emitted = [];
  const publisher = new SessionTimelineChangePublisher({
    emit: (change) => emitted.push(change),
    delayMs: 60_000
  });
  publisher.schedule({ sessionId: "", revision: 1 });
  publisher.schedule({ sessionId: "session:a", revision: 0 });
  publisher.schedule({ sessionId: "session:a", revision: 1.5 });
  publisher.schedule({ sessionId: "session:a", revision: 8 });
  publisher.close();
  publisher.flush();
  assert.deepEqual(emitted, []);
});
