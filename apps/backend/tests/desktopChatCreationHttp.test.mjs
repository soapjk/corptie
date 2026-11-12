import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDesktopChatCreation } from '../src/application/desktopChatCreationHttp.mjs';
function request(overrides = {}) {
  const calls = [];
  const result = new Promise(resolve => {
    assert.equal(handleDesktopChatCreation({
      request: { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' }, ...overrides },
      response: {}, url: new URL('http://localhost/desktop/chats/create'),
      readJson: async () => ({ requestId: 'stable-id' }),
      api: { createChat: async (identity, body, revalidate) => {
        calls.push({ identity, body }); assert.deepEqual(revalidate(), identity);
        return { status: 'completed', entityResult: { sessionId: 's' } };
      } }, store: { getSession: id => ({ id, title: '新对话' }) },
      sendJson: (_, status, body) => resolve({ status, body })
    }), true);
  });
  return { result, calls };
}
test('desktop bridge uses local principal and returns the receipt and accepted Session', async () => {
  const f = request(); const r = await f.result;
  assert.equal(r.status, 200); assert.equal(r.body.session.id, 's');
  assert.deepEqual(f.calls[0].identity, { kind: 'local_user', principalId: 'local-user' });
});
test('desktop bridge rejects browser, Agent and remote callers before reading or creating', async () => {
  for (const overrides of [{ headers: { origin: 'https://example.com' } }, { headers: { 'x-corptie-agent-id': 'a' } }, { socket: { remoteAddress: '192.0.2.1' } }]) {
    const f = request(overrides); assert.equal((await f.result).status, 403); assert.equal(f.calls.length, 0);
  }
  const f = request({ method: 'GET' }); assert.equal((await f.result).status, 405); assert.equal(f.calls.length, 0);
});
