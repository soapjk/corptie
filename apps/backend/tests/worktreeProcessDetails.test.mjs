import test from 'node:test';
import assert from 'node:assert/strict';
import { worktreeProcessDetails } from '../src/utils/worktreeProcessDetails.mjs';

test('system states distinguish a live reparented process from a zombie and expose executable paths', async () => {
  const execute = async (command, args) => {
    if (command.endsWith('lsof')) return { stdout: 'p10\nn/opt/homebrew/bin/node\n' };
    const pid = Number(args[1]);
    return { stdout: pid === 10 ? '1 S 01:10 node\n' : pid === 11 ? '100 Z 00:05 node\n' : '100 R 00:01 /Applications/Editor.app/Contents/MacOS/Editor\n' };
  };
  const rows = await worktreeProcessDetails([10, 11, 12].map(pid => ({ pid, path: '/work' })), { execute });
  assert.equal(rows[0].state, 'waiting');
  assert.equal(rows[0].orphaned, true);
  assert.equal(rows[0].executablePath, '/opt/homebrew/bin/node');
  assert.equal(rows[1].state, 'zombie');
  assert.equal(rows[1].orphaned, false);
  assert.equal(rows[2].applicationName, 'Editor');
  assert.equal(rows[2].applicationPath, '/Applications/Editor.app');
  assert.equal(rows[2].workingDirectory, '/work');
});

test('missing process details remain explicit and do not fabricate a name or purpose', async () => {
  const [row] = await worktreeProcessDetails([{ pid: 10, path: '/work' }], { execute: async () => { throw new Error('denied'); } });
  assert.equal(row.detailError, 'PROCESS_DETAILS_UNAVAILABLE');
  assert.equal(row.state, 'unknown');
  assert.equal(row.processName, undefined);
  assert.equal(row.purpose, undefined);
});

test('process observations have bounded parallelism and never request arguments or environment', async () => {
  let running = 0, maximum = 0;
  const execute = async (_command, args, options) => {
    assert.ok(options.timeout <= 2000);
    assert.ok(!args.includes('args=') && !args.includes('-E'));
    running++; maximum = Math.max(maximum, running);
    await new Promise(resolve => setImmediate(resolve));
    running--;
    return { stdout: '100 T 00:01 /bin/sleep\n' };
  };
  const rows = await worktreeProcessDetails(Array.from({ length: 20 }, (_, pid) => ({ pid: pid + 10, path: '/work' })), { execute });
  assert.equal(rows.length, 20);
  assert.equal(maximum, 4);
  assert.equal(rows.every(row => row.state === 'stopped'), true);
});
