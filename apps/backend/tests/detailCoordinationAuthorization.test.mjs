import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailBusinessActionPorts } from '../src/application/detailBusinessActionPorts.mjs';
import { projectNativeBusinessDocument } from '../src/application/detailNativeBusinessProjection.mjs';

for (const provider of ['codex-app-server', 'claude-sdk', 'openclacky']) {
  for (const parent of [null, 'task:root', 'task:child']) {
    test(`detail coordination uses bound Task at every depth: ${provider}/${parent}`, async () => {
      let task = { id: 'task:current', parent_task_id: parent, resource_version: 4, revision: 1 };
      let enableChecks = 0, writes = 0;
      const scope = { sessionId: 'logical:current', identity: { kind: 'local_user', principalId: 'owner' } };
      const inspector = {
        scope: () => ({ logicalSessionId: scope.sessionId, task }),
        updateTask() {},
        assertCoordinationCanEnable() { enableChecks++; throw Object.assign(new Error(), { code: 'COORDINATION_ISOLATION_UNSUPPORTED' }); },
        perform(bound, operation, fields) { assert.equal(bound.task.id, task.id); assert.equal(operation, 'task.update'); writes++; return fields; }
      };
      const port = createDetailBusinessActionPorts({ inspector })['task.coordination.update'];
      const doc = projectNativeBusinessDocument({ logicalSessionId: scope.sessionId,
        session: { sessionKind: 'worker', providerId: provider }, task }, {}, 'generation', { editors: true });
      const action = doc.cards.find(c => c.kind === 'taskInfo').actions.find(a => a.operation === 'task.coordination.update');
      assert.ok(action);
      assert.equal(port.authorize(scope, action.target, task), true);
      assert.equal(port.resource(scope, { id: 'task:other' }), null);
      assert.equal(port.authorize(scope, { id: 'task:other' }, task), false);
      assert.throws(() => port.validateFields(scope, action.target, { coordinationEnabled: true }, task), { code: 'COORDINATION_ISOLATION_UNSUPPORTED' });
      assert.equal(port.validateFields(scope, action.target, { coordinationEnabled: false }, task), true);
      assert.equal(enableChecks, 1);
      await port.execute(scope, action.target, { coordinationEnabled: false }, { resource: task });
      assert.equal(writes, 1);
      const old = task;
      task = { ...task, resource_version: 5 };
      assert.throws(() => port.execute(scope, action.target, { coordinationEnabled: false }, { resource: old }), { code: 'DETAIL_REVISION_CONFLICT' });
      for (const state of [{ archived: true }, { deletion_status: 'pending' }]) {
        task = { ...old, ...state };
        assert.equal(port.authorize(scope, action.target, task), false);
        assert.throws(() => port.execute(scope, action.target, { coordinationEnabled: false }, { resource: task }), { code: 'DETAIL_SCOPE_FORBIDDEN' });
      }
      task = { ...old, id: 'task:rebound' };
      assert.throws(() => port.execute(scope, action.target, { coordinationEnabled: false }, { resource: old }), { code: 'DETAIL_REVISION_CONFLICT' });
      assert.equal(writes, 1);
    });
  }
}
