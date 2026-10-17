import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../copy-swiftpm-resource-bundles.sh', import.meta.url));
test('packages dependency font bundles with spaces in build and destination paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'corptie-resource-test-'));
  try {
    const build = join(root, 'build directory');
    const destination = join(root, 'App Resources');
    for (const name of ['CorptieMac_CorptieMac.bundle', 'CorptieConversation_CorptieConversation.bundle', 'SwiftMath_SwiftMath.bundle']) {
      mkdirSync(join(build, name), { recursive: true });
      writeFileSync(join(build, name, 'fixture'), name);
    }
    const result = spawnSync('bash', [script, build, destination, 'SwiftMath_SwiftMath.bundle'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(destination, 'SwiftMath_SwiftMath.bundle', 'fixture'), 'utf8'), 'SwiftMath_SwiftMath.bundle');
    assert.ok(existsSync(join(destination, 'CorptieConversation_CorptieConversation.bundle', 'fixture')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing math font resources fail before producing an incomplete package', () => {
  const root = mkdtempSync(join(tmpdir(), 'corptie-resource-test-'));
  try {
    const result = spawnSync('bash', [script, root, join(root, 'output'), 'SwiftMath_SwiftMath.bundle'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Required SwiftPM resource bundle/);
    assert.equal(existsSync(join(root, 'output')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
