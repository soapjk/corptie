import test from 'node:test';
import assert from 'node:assert/strict';
import { taskCollaborationEdges } from '../src/application/taskCollaborationEdges.mjs';

test('edges resolve actual logical Session bindings, omit missing and same-Task endpoints', () => {
  const rows = [
    { channel_id: 'valid', session_a_id: 'a', session_b_id: 'b' },
    { channel_id: 'same', session_a_id: 'a', session_b_id: 'c' },
    { channel_id: 'missing', session_a_id: 'a', session_b_id: 'missing' }
  ];
  const store = {
    selectAll(sql) { assert.match(sql, /status='active'/); return rows; },
    getLogicalSession(id) { return id === 'missing' ? null : { legacySessionId: id }; },
    getSession(id) { return { taskId: id === 'b' ? 'task-b' : 'task-a' }; }
  };
  assert.deepEqual(taskCollaborationEdges(store), [{ id: 'valid', sourceTaskId: 'task-a', targetTaskId: 'task-b', sourceSessionId: 'a', targetSessionId: 'b' }]);
});
