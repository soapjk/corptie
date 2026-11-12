import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { appcast, httpsURL, keyMatches } from '../macos-update.mjs';

test('update channel rejects insecure or credential-bearing URLs', () => {
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'file:///tmp/feed']) assert.throws(() => httpsURL(value));
});
test('archive signing key must match embedded public key', () => {
  const pair = generateKeyPairSync('ed25519');
  const seed = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64');
  const pub = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  keyMatches(seed, pub);
  assert.throws(() => keyMatches(Buffer.alloc(32).toString('base64'), pub), /does not match/);
});
test('feed preserves signed length and escapes release notes', () => {
  const result = appcast({ version: '1.2.3', build: '42', url: 'https://example.com/app.zip?a=1&b=2', signature: Buffer.alloc(64).toString('base64'), length: 123, notes: '<script>hello & bye</script>' });
  assert.match(result, /length="123"/);
  assert.match(result, /<sparkle:version>42<\/sparkle:version>/);
  assert.match(result, /&lt;script&gt;hello &amp; bye/);
  assert.match(result, /a=1&amp;b=2/);
});
