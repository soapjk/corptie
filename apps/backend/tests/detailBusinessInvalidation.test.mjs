import test from "node:test";
import assert from "node:assert/strict";
import { DetailBusinessInvalidation } from "../src/application/detailBusinessInvalidation.mjs";
import { DetailBusinessReadCache } from "../src/application/detailBusinessReadCache.mjs";

test("durable token changes invalidate session display but not metadata reads; binding/provider changes do", () => {
  let revision = 0, oldest = 1;
  const session = { id: "session", taskId: "task", external: { provider: "provider", currentModel: "model" } };
  const changes = [], received = [];
  const router = new DetailBusinessInvalidation({ stateRevision: () => revision,
    oldestStateChangeRevision: () => oldest, stateChangesAfter: after => changes.filter(row => row.revision > after),
    getSession: () => session }, change => received.push(change));
  router.observe(session);
  const publish = () => { changes.push({ revision: ++revision, entityType: "session", entityId: "session" }); router.publishStateChanges(); };
  session.progress = "token"; publish();
  assert.deepEqual(received, [{ resourceType: "session", sessionId: "session" }]);
  session.external.currentModel = "new"; publish();
  assert.deepEqual(received.at(-2), { resourceType: "sessionMetadata", sessionId: "session" });
  assert.deepEqual(received.at(-1), { resourceType: "task" });
  received.length = 0; router.publishStateChanges(); assert.equal(received.length, 0);
  revision += 100; oldest = revision; router.publishStateChanges(); assert.deepEqual(received, [undefined]);
});
test("Task changes invalidate Work focus lists in other Sessions without touching other Works", async () => {
  const reads = [];
  const cache = new DetailBusinessReadCache({ focus: { dependencies: ["task"], read: scope => { reads.push(scope.work.id); return { title: "task" }; } } });
  const a = { session: { id: "work-chat-a" }, work: { id: "work-a" } }, b = { session: { id: "work-chat-b" }, work: { id: "work-b" } };
  await cache.read(a, "focus", { sessionId: a.session.id }); await cache.read(b, "focus", { sessionId: b.session.id });
  let revision = 0;
  const router = new DetailBusinessInvalidation({ stateRevision: () => revision, getTask: () => ({ work_id: "work-a" }),
    stateChangesAfter: () => [{ revision, entityType: "task", entityId: "task-a" }] }, change => cache.invalidate(change));
  revision++; router.publishStateChanges();
  await cache.read(a, "focus", { sessionId: a.session.id }, { force: false });
  await cache.read(b, "focus", { sessionId: b.session.id }, { force: false });
  assert.deepEqual(reads, ["work-a", "work-b", "work-a"]);
});
test("reading another identity before publication does not erase pending metadata changes", () => {
  let revision = 0; const session = { id: "s", cwd: "/old" }, received = [];
  const router = new DetailBusinessInvalidation({ stateRevision: () => revision,
    stateChangesAfter: () => [{ entityType: "session", entityId: "s", revision }], getSession: () => session }, change => received.push(change));
  router.observe(session); session.cwd = "/new"; router.observe(session); revision++;
  router.publishStateChanges(); assert.equal(received.at(-1).resourceType, "sessionMetadata");
});
test("authorities without complete mutation notifications never return stale cache facts", async () => {
  let calls = 0;
  const cache = new DetailBusinessReadCache({ memory: { cacheable: false, dependencies: ["memory"], read: () => ({ version: ++calls }) } });
  const scope = { session: { id: "s" } }, identity = { sessionId: "s" };
  await cache.read(scope, "memory", identity, { force: false });
  assert.equal((await cache.read(scope, "memory", identity, { force: false })).data.version, 2);
});
test("supplementary resource events route module dependencies while token events do not", () => {
  const received = [], router = new DetailBusinessInvalidation({}, change => received.push(change));
  router.publishEvent("ProviderTokenDelta", {}, null);
  router.publishEvent("SessionTextDelta", {}, "session");
  assert.equal(received.length, 0);
  router.publishEvent("ProviderCapabilitiesChanged", {}, null);
  assert.deepEqual(received.at(-1), { resourceType: "provider" });
  router.publishEvent("ScheduledSessionTaskChanged", {}, "session");
  assert.deepEqual(received.at(-1), { resourceType: "schedule", sessionId: "session" });
  router.publishEvent("MemoryChanged", {}, null);
  assert.deepEqual(received.at(-1), { resourceType: "memory" });
});
test("known session display changes do not evict cached heavy business ports", async () => {
  let calls = 0;
  const cache = new DetailBusinessReadCache({ worktree: { dependencies: ["worktree", "sessionMetadata"], read: () => ({ branch: String(++calls) }) } });
  const scope = { session: { id: "s" }, logicalSessionId: "s" }, identity = { sessionId: "s" };
  await cache.read(scope, "worktree", identity);
  cache.invalidate({ resourceType: "session", sessionId: "s" });
  await cache.read(scope, "worktree", identity, { force: false }); assert.equal(calls, 1);
  cache.invalidate({ resourceType: "sessionMetadata", sessionId: "s" });
  await cache.read(scope, "worktree", identity, { force: false }); assert.equal(calls, 2);
});
