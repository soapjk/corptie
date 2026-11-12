import test from 'node:test';
import assert from 'node:assert/strict';
import { InitialMessageTitleService } from '../src/application/initialMessageTitleService.mjs';
const envelope = { sessionId: 's', messageId: 'm' };
function fixture(run = async () => ({ text: '修复消息布局' })) {
  let session = { id: 's', title: '新任务_abc123', taskId: 't' };
  let task = { id: 't', title: session.title, auto_title_enabled: 1 };
  const events = [], calls = [];
  const service = new InitialMessageTitleService({
    store: { getSession: () => session, getTask: () => task, listSessions: () => [session],
      getSessionEvent: () => ({ sessionId: 's', type: 'SessionUserMessageCreated', payload: { message: { text: '请修复消息布局' } } }),
      renameSession: (id, title) => (session = { ...session, title }) },
    backgroundAgent: { run: input => { calls.push(input); return run(input); } },
    renameTask: (id, patch) => { task = { ...task, ...patch }; },
    emitEvent: (...args) => events.push(args)
  });
  return { service, calls, events, session: () => session, task: () => task,
    rename: title => { session = { ...session, title }; } };
}
test('title generation is hidden, no-tools and updates matching temporary task and Session titles', async () => {
  const f = fixture();
  await f.service.generate(envelope, f.session());
  assert.equal(f.calls[0].executionPolicy, 'no-tools');
  assert.deepEqual(f.calls[0].allowedRoots, []);
  assert.equal(f.session().title, '修复消息布局');
  assert.equal(f.task().title, f.session().title);
  assert.equal(f.events[0][0], 'SessionRenamed');
});
test('manual rename during generation wins, and a failed Provider has a local fallback', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = f.service.generate(envelope, f.session());
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.rename('用户标题'); release({ text: '模型标题' }); await pending;
  assert.equal(f.session().title, '用户标题'); assert.equal(f.events.length, 0);
  const failed = fixture(async () => { throw new Error('unavailable'); });
  await failed.service.generate(envelope, failed.session());
  assert.equal(failed.session().title, '请修复消息布局');
});
test('acceptance callback does not synchronously read messages or dispatch and coalesces pending deliveries', async () => {
  const f = fixture();
  f.service.onCommittedMessageDelivery(envelope);
  f.service.onCommittedMessageDelivery(envelope);
  assert.equal(f.calls.length, 0); assert.equal(f.service.pending.size, 1);
  while (f.service.pending.size) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 1);
  f.service.onCommittedMessageDelivery(envelope);
  assert.equal(f.service.pending.size, 0);
});
