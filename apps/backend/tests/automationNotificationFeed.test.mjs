import test from "node:test";
import assert from "node:assert/strict";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { readAutomationNotifications } from "../src/store/automationNotificationFeed.mjs";

test("notification feed is transactional, stable, bounded, environment scoped and silently baselines history", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-notifications", manageProcessEnvironment: false });
  await store.initialize({ resolveDataPath: false });
  const now = new Date("2026-10-31T12:00:00Z");
  const task = store.createScheduledSessionTask({ taskId: "auto:test", logicalSessionId: "logical:test", name: "Check",
    message: { text: "private prompt" }, scheduleType: "interval", intervalSeconds: 60, timezone: "UTC",
    missedPolicy: "coalesce_once", creatorType: "session", creatorId: "logical:test", environment: "development",
    expiresAt: "2027-01-01T00:00:00Z" });
  const emit = (type = "ScheduledSessionRunCompleted", payload = {}, createdAt = now.toISOString(), environment = "development") =>
    store.recordScheduledSessionEvent({ taskId: task.taskId, type, payload, environment, createdAt });
  const read = cursor => readAutomationNotifications(store, "development", cursor, now);
  try {
    for (let i = 0; i < 500; i++) emit();
    const baseline = read(null);
    assert.equal(baseline.reset, true);
    assert.equal(baseline.events.length, 0);
    emit("ScheduledSessionTaskUpdated");
    emit("ScheduledSessionRunFailed", { willRetry: true });
    assert.equal(read(baseline.cursor).events.length, 0);
    assert.throws(() => store.runInTransaction(() => { emit(); throw new Error("rollback"); }));
    assert.equal(read(baseline.cursor).events.length, 0);
    const event = emit("ScheduledSessionRunFailed", { willRetry: false });
    let page = read(baseline.cursor);
    assert.equal(page.events[0].eventId, event.eventId);
    assert.equal(page.events[0].kind, "failed");
    assert.doesNotMatch(JSON.stringify(page), /private prompt|payload_json/);
    assert.deepEqual(read(baseline.cursor), page);
    assert.equal(read(page.cursor).events.length, 0);
    const cursor = page.cursor;
    emit("ScheduledSessionRunCompleted", {}, "2026-10-30T12:00:00Z");
    emit("ScheduledSessionRunCompleted", {}, now.toISOString(), "production");
    assert.equal(read(cursor).events.length, 0);
    for (let i = 0; i < 300; i++) emit();
    page = read(cursor);
    assert.equal(page.events.length, 128);
    assert.equal(page.hasMore, true);
    const next = read(page.cursor);
    assert.equal(next.events.length, 128);
    assert.ok(next.events[0].sequence > page.events.at(-1).sequence);
    assert.equal(read(next.cursor).events.length, 44);
    assert.equal(read("unknown-epoch").reset, true);
    store.db.run("DELETE FROM automation_notification_feed");
    emit();
    assert.equal(read(cursor).reset, true);
  } finally { await store.close(); }
});
