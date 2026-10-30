import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTopicService } from "../src/application/memoryTopicService.mjs";

test("session topics change with conversation while short follow-ups reuse the current classification", async () => {
  let profile = null;
  let calls = 0;
  const store = {
    getSessionMemoryTopics: () => profile ? { profile } : null,
    upsertSessionMemoryTopics: (_id, next) => { profile = next; },
    getTask: () => ({ title: "MarketCow SDK" }),
    getWork: () => ({ name: "MarketCow" })
  };
  const service = new MemoryTopicService({ store, classify: async ({ message }) => {
    calls += 1;
    return message.includes("公猫")
      ? { topics: ["personal"], contexts: ["personal"], keywords: [] }
      : { topics: ["programming"], contexts: ["development"], keywords: ["MarketCow"] };
  } });
  const session = { id: "session:a", sessionKind: "worker", taskId: "task:a", workId: "work:a" };
  const first = await service.update(session, "讨论 MarketCow SDK");
  assert.deepEqual(first.contexts, ["development"]);
  assert.deepEqual((await service.update(session, "继续")).topics, ["programming"]);
  assert.equal(calls, 1);
  const switched = await service.update(session, "我养的公猫需要什么");
  assert.deepEqual(switched.topics, ["personal"]);
  assert.deepEqual(switched.contexts, ["personal"]);
  assert.equal(calls, 2);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function queuedFixture(classify, options = {}) {
  const profiles = new Map();
  const sessions = new Map();
  let version = 1;
  let queued = false;
  const store = {
    getSessionMemoryTopics: id => profiles.has(id) ? { profile: profiles.get(id) } : null,
    upsertSessionMemoryTopics: (id, profile) => profiles.set(id, { ...profile }),
    getSession: id => sessions.get(id), getTask: () => null, getWork: () => null,
    getLogicalSessionByLegacySessionId: () => ({ id: 'logical', activeThreadId: 'thread', routingVersion: version }),
    listQueuedAgentTasksForSession: () => queued ? [{}] : [], getRunningAgentTaskForSession: () => null
  };
  const service = new MemoryTopicService({ store, classify, ...options });
  const session = { id: 'session:a', status: 'complete', sessionKind: 'assistantChat' };
  sessions.set(session.id, session);
  return { service, session, profiles, sessions, store,
    changeBinding: () => { version++; }, setQueued: value => { queued = value; } };
}

test('ordinary topic reads never invoke a classifier; only settlement starts enrichment', async () => {
  let calls = 0, release;
  const f = queuedFixture(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  assert.deepEqual(f.service.profileForMessage(f.session, 'First question'), { topics: [], contexts: [], keywords: [] });
  f.service.requestUpdate(f.session, 'First question');
  await tick();
  assert.equal(calls, 0);
  const finished = f.service.flushPending(f.session.id);
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(f.service.profileForMessage(f.session, 'A different question').contexts, []);
  release({ topics: ['programming'], contexts: ['development'], keywords: [] });
  await finished;
  assert.deepEqual(f.profiles.get(f.session.id).contexts, ['development']);
  f.service.close();
});

test('a newer message supersedes and aborts an older classification without overwriting its topic', async () => {
  const releases = [];
  const signals = [];
  const f = queuedFixture((_input, { signal }) => { signals.push(signal); return new Promise(resolve => releases.push(resolve)); });
  f.service.requestUpdate(f.session, 'Discuss programming');
  void f.service.flushPending(f.session.id);
  await tick();
  f.service.requestUpdate(f.session, 'My pet cat needs care');
  assert.equal(signals[0].aborted, true);
  releases[0]({ topics: ['programming'], contexts: ['development'], keywords: [] });
  await tick(); await tick();
  assert.notDeepEqual(f.profiles.get(f.session.id).contexts, ['development']);
  const newest = f.service.flushPending(f.session.id);
  await tick();
  releases[1]({ topics: ['personal'], contexts: ['personal'], keywords: [] });
  await newest;
  assert.deepEqual(f.profiles.get(f.session.id).contexts, ['personal']);
  assert.equal(f.profiles.get(f.session.id).classificationCount, 2);
  f.service.close();
});

for (const invalidation of ['binding', 'deleted', 'new-run', 'closed']) {
  test(`late optional topic results cannot commit after ${invalidation}`, async () => {
    let release;
    const f = queuedFixture(() => new Promise(resolve => { release = resolve; }));
    f.service.requestUpdate(f.session, 'Programming question');
    const done = f.service.flushPending(f.session.id);
    await tick();
    if (invalidation === 'binding') f.changeBinding();
    if (invalidation === 'deleted') f.sessions.clear();
    if (invalidation === 'new-run') f.session.status = 'running';
    if (invalidation === 'closed') f.service.close();
    release({ topics: ['programming'], contexts: ['development'], keywords: [] });
    await done; await tick();
    assert.deepEqual(f.profiles.get(f.session.id).contexts, []);
    f.service.close();
  });
}

test('queued user work wins, while optional topic work has bounded concurrency and storage', async () => {
  let active = 0, maximum = 0;
  const releases = [];
  const f = queuedFixture(() => { active++; maximum = Math.max(maximum, active);
    return new Promise(resolve => releases.push(() => { active--; resolve(null); })); }, { concurrency: 1, pendingLimit: 3 });
  f.setQueued(true);
  f.service.requestUpdate(f.session, 'Message');
  void f.service.flushPending(f.session.id);
  await tick();
  assert.equal(active, 0);
  f.setQueued(false);
  for (let i = 0; i < 8; i++) {
    const session = { ...f.session, id: `s:${i}` };
    f.sessions.set(session.id, session);
    f.service.requestUpdate(session, 'Message');
    void f.service.flushPending(session.id);
  }
  await tick();
  assert.ok(f.service.pending.size <= 3);
  assert.equal(maximum, 1);
  f.service.close();
  releases.forEach(release => release());
  await tick();
});

test('failed background attempts retain the existing daily limit', async () => {
  let calls = 0;
  const f = queuedFixture(async () => { calls++; throw new Error('offline'); });
  for (let i = 0; i < 10; i++) await f.service.update(f.session, `Different question ${i}`);
  assert.equal(calls, 6);
  assert.equal(f.profiles.get(f.session.id).classificationCount, 6);
  f.service.close();
});

test('retry identity coalesces but an identical new user message still cancels optional work', async () => {
  let release, signal;
  const f = queuedFixture((_input, options) => { signal = options.signal;
    return new Promise(resolve => { release = resolve; }); });
  f.service.requestUpdate(f.session, 'Same message', 'message:one');
  void f.service.flushPending(f.session.id);
  await tick();
  f.service.requestUpdate(f.session, 'Same message', 'message:one');
  assert.equal(signal.aborted, false);
  f.service.requestUpdate(f.session, 'Same message', 'message:two');
  assert.equal(signal.aborted, true);
  release({ topics: ['programming'], contexts: ['development'], keywords: [] });
  await tick(); await tick();
  assert.deepEqual(f.profiles.get(f.session.id).topics, []);
  f.service.close();
});

test('long messages sharing a stored prefix still participate in periodic reclassification', async () => {
  let calls = 0;
  const f = queuedFixture(async () => { calls++; return { topics: ['personal'], contexts: ['personal'], keywords: [] }; });
  const prefix = 'programming source code framework '.repeat(20).slice(0, 500);
  f.profiles.set(f.session.id, { lastMessage: prefix, lastClassifiedMessage: prefix,
    topics: ['programming'], contexts: ['development'], keywords: [], turnsSinceClassification: 11 });
  const longMessage = prefix + ' additional current message text';
  f.service.requestUpdate(f.session, longMessage);
  await f.service.flushPending(f.session.id);
  assert.equal(calls, 1);
  assert.deepEqual(f.profiles.get(f.session.id).contexts, ['personal']);
  f.service.close();
});
