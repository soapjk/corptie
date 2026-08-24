import assert from "node:assert/strict";
import test from "node:test";
import {
  createTimelineStreamState,
  initialTimelineSnapshot,
  legacyTimelineSnapshotFrame,
  nextTimelineEvent,
  resumedTimelineStreamState,
  supportsTimelineDelta,
  timelineSnapshotToken
} from "../src/utils/sessionTimelineDelta.mjs";

test("timeline deltas require an explicit versioned client capability", () => {
  assert.equal(supportsTimelineDelta({}), false);
  assert.equal(supportsTimelineDelta({ "x-corptie-timeline-protocol": "0" }), false);
  assert.equal(supportsTimelineDelta({ "x-corptie-timeline-protocol": "1" }), true);
  assert.equal(supportsTimelineDelta({ "x-corptie-timeline-protocol": "2" }), true);
});

test("snapshot resume token is stable for identical content and changes with timeline content", () => {
  const original = session("codex-app-server");
  const token = timelineSnapshotToken(original);
  assert.equal(timelineSnapshotToken(structuredClone(original)), token);
  const changed = structuredClone(original);
  changed.items[0].text = "changed";
  assert.notEqual(timelineSnapshotToken(changed), token);
  const diagnosticOnly = structuredClone(original);
  diagnosticOnly.rawStatus = { idleSeconds: 99 };
  assert.equal(timelineSnapshotToken(diagnosticOnly), token);
  assert.equal(createTimelineStreamState(original, 42).revision, 42);
  assert.equal(initialTimelineSnapshot(original, 42).event.data.snapshotToken, token);
  assert.equal(resumedTimelineStreamState(original, { snapshotToken: token, revision: 42 }).revision, 42);
  assert.equal(resumedTimelineStreamState(changed, { snapshotToken: token, revision: 42 }), null);
});

test("legacy snapshots exclude volatile provider diagnostics", () => {
  const initial = session("claude-sdk");
  const changedDiagnostic = structuredClone(initial);
  changedDiagnostic.rawStatus.idleSeconds = 99;
  assert.equal(
    legacyTimelineSnapshotFrame(initial).signature,
    legacyTimelineSnapshotFrame(changedDiagnostic).signature
  );
  assert.deepEqual(
    JSON.parse(legacyTimelineSnapshotFrame(initial).payload).session.rawStatus,
    initial.rawStatus
  );
});

for (const provider of ["codex-app-server", "claude-sdk"]) {
  test(`${provider} uses the provider-neutral timeline delta contract`, () => {
    const initial = session(provider);
    const first = initialTimelineSnapshot(initial);
    assert.equal(first.event.name, "snapshot");
    assert.equal(first.event.data.protocolVersion, 1);
    assert.equal(first.event.data.revision, 1);
    assert.equal(Object.hasOwn(first.state, "session"), false);

    const appendedSession = structuredClone(initial);
    appendedSession.items.push(item("answer", "agentMessage", "Ready"));
    appendedSession.updatedAt = "2026-08-12T00:00:01.000Z";
    const appended = nextTimelineEvent(first.state, appendedSession);
    assert.equal(appended.event.name, "items.appended");
    assert.equal(appended.event.data.baseRevision, 1);
    assert.deepEqual(appended.event.data.items.map((value) => value.id), ["answer"]);

    const streamingSession = structuredClone(appendedSession);
    streamingSession.items[1].text = "Ready now";
    streamingSession.items[1].turnStatus = "running";
    streamingSession.updatedAt = "2026-08-12T00:00:02.000Z";
    const updated = nextTimelineEvent(appended.state, streamingSession);
    assert.equal(updated.event.name, "item.updated");
    assert.equal(updated.event.data.index, 1);
    assert.equal(updated.event.data.item.text, "Ready now");

    const completedSession = structuredClone(streamingSession);
    completedSession.status = "complete";
    completedSession.activityStatus = null;
    completedSession.updatedAt = "2026-08-12T00:00:03.000Z";
    const metadata = nextTimelineEvent(updated.state, completedSession);
    assert.equal(metadata.event.name, "metadata.updated");
    assert.equal(metadata.event.data.metadata.status, "complete");
    assert.equal(Object.hasOwn(metadata.event.data.metadata, "items"), false);
  });
}

test("unsafe historical changes fall back to snapshot", () => {
  const initial = session("codex-app-server");
  initial.items.push(item("answer", "agentMessage", "Ready"));
  const first = initialTimelineSnapshot(initial);

  const deleted = structuredClone(initial);
  deleted.items.pop();
  assert.equal(nextTimelineEvent(first.state, deleted).event.name, "snapshot");

  const reordered = structuredClone(initial);
  reordered.items.reverse();
  assert.equal(nextTimelineEvent(first.state, reordered).event.name, "snapshot");

  const rewritten = structuredClone(initial);
  rewritten.items[0].text = "Changed request";
  rewritten.items[1].text = "Changed response";
  assert.equal(nextTimelineEvent(first.state, rewritten).event.name, "snapshot");
});

test("queued lifecycle and queue order changes produce authoritative frames", () => {
  const queued = session("codex-app-server");
  queued.items = [
    { ...item("work:a", "userMessage", "first"), userMessageStatus: "queued", queuePosition: 1 },
    { ...item("work:b", "userMessage", "second"), userMessageStatus: "queued", queuePosition: 2 }
  ];
  const initial = initialTimelineSnapshot(queued);

  const processing = structuredClone(queued);
  processing.items[0].userMessageStatus = "processing";
  processing.items[0].queuePosition = null;
  processing.items[1].queuePosition = 1;
  const lifecycle = nextTimelineEvent(initial.state, processing);
  assert.equal(lifecycle.event.name, "snapshot");
  assert.equal(lifecycle.event.data.session.items[0].userMessageStatus, "processing");
  assert.equal(lifecycle.event.data.session.items[1].queuePosition, 1);

  const reordered = structuredClone(processing);
  reordered.items.reverse();
  const reorder = nextTimelineEvent(lifecycle.state, reordered);
  assert.equal(reorder.event.name, "snapshot");
  assert.deepEqual(reorder.event.data.session.items.map((entry) => entry.id), ["work:b", "work:a"]);
});

test("raw diagnostics do not emit timeline frames", () => {
  const initial = session("claude-sdk");
  const first = initialTimelineSnapshot(initial);
  const diagnosticOnly = structuredClone(initial);
  diagnosticOnly.rawStatus = { idleSeconds: 9 };
  const next = nextTimelineEvent(first.state, diagnosticOnly);
  assert.equal(next.event, null);
  assert.equal(next.state, first.state);
});

test("unchanged data reuses the compact stream state", () => {
  const initial = session("codex-app-server");
  const first = initialTimelineSnapshot(initial);
  const next = nextTimelineEvent(first.state, structuredClone(initial));
  assert.equal(next.event, null);
  assert.equal(next.state, first.state);
  assert.deepEqual(Object.keys(first.state).sort(), ["itemFingerprints", "metadataFingerprint", "revision"]);
});

test("fast active sampling touches only the tail while exact checks repair historical changes", () => {
  const initial = session("codex-app-server");
  initial.items.push(item("answer", "agentMessage", "R"));
  const first = initialTimelineSnapshot(initial);

  const streaming = structuredClone(initial);
  streaming.items[1].text = "Ready";
  const tail = nextTimelineEvent(first.state, streaming, { fullConsistency: false });
  assert.equal(tail.event.name, "item.updated");
  assert.equal(tail.event.data.index, 1);

  const historical = structuredClone(streaming);
  historical.items[0].text = "Corrected history";
  const fast = nextTimelineEvent(tail.state, historical, { fullConsistency: false });
  assert.equal(fast.event, null);
  const repaired = nextTimelineEvent(fast.state, historical, { fullConsistency: true });
  assert.equal(repaired.event.name, "item.updated");
  assert.equal(repaired.event.data.index, 0);
});

function session(provider) {
  return {
    id: "logical:one",
    title: "Agent",
    status: "running",
    source: provider,
    connectionStatus: "connected",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    activityStatus: "Working",
    turnCount: 1,
    items: [item("request", "userMessage", "Start")],
    rawStatus: { idleSeconds: 0 }
  };
}

function item(id, type, text) {
  return {
    id,
    turnId: "turn-1",
    turnStatus: "completed",
    type,
    title: type === "userMessage" ? "User" : "Agent",
    text,
    status: null,
    presentationRole: type === "agentMessage" ? "final_answer" : null,
    createdAt: "2026-08-12T00:00:00.000Z"
  };
}
