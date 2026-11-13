import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeliveredMessageImage } from '../src/application/messageImageDelivery.mjs';
import { messageImageBytes } from '../src/application/messageImageBytes.mjs';
import { callArtifactDynamicTool } from '../src/application/artifactDynamicTools.mjs';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const hash = 'a'.repeat(64);
function fixture(destination) {
  const items = new Map([['reply', { type: 'agentMessage', text: `![Screenshot](${destination})`, createdAt: '2026-11-13T06:00:00Z' }],
    ['inspection', { type: 'imageView', images: [{ managedPath: 'owned.png' }] }]]);
  const calls = [];
  const store = { getSessionItem: (session, id) => session === 'session:one' ? items.get(id) : null,
    getSession: () => ({ id: 'session:one', workId: 'work:one' }) };
  return { items, calls, input: { store, reference: { sessionId: 'session:one' }, itemId: 'reply', destination,
    artifacts: { readMessageImage: async input => { calls.push(input); return { data: PNG }; } },
    readImage: async path => { calls.push(path); return { data: PNG }; } } };
}

test('explicit authored Artifact delivery preserves immutable version and hash', async () => {
  const f = fixture(`artifact:picture?version=2&hash=${hash}`);
  assert.deepEqual((await readDeliveredMessageImage(f.input)).data, PNG);
  assert.equal(f.calls[0].version, 2); assert.equal(f.calls[0].contentHash, hash);
  assert.equal(f.calls[0].artifactId, 'artifact:picture');
  assert.equal(f.calls[0].sessionId, 'session:one');
});

test('legacy Artifact references use reply timestamp; unknown or partial version selectors fail', async () => {
  const f = fixture('artifact:picture'); await readDeliveredMessageImage(f.input);
  assert.equal(f.calls[0].version, null);
  assert.equal(f.calls[0].messageCreatedAt, '2026-11-13T06:00:00Z');
  for (const link of ['artifact:picture?version=2', 'artifact:picture?version=2&hash=bad',
    `artifact:picture?version=2&version=3&hash=${hash}`, 'artifact:picture#fragment', 'artifact://host/file']) {
    await assert.rejects(readDeliveredMessageImage(fixture(link).input));
  }
});

test('tool images require explicit reply association and stay within the same Session', async () => {
  const f = fixture('corptie-image:inspection');
  await readDeliveredMessageImage(f.input); assert.deepEqual(f.calls, ['owned.png']);
  f.items.get('reply').text = 'I attached it';
  await assert.rejects(readDeliveredMessageImage(f.input));
  f.items.get('reply').text = '```\n![x](corptie-image:inspection)\n```';
  await assert.rejects(readDeliveredMessageImage(f.input));
  f.items.get('reply').text = '![x](corptie-image:inspection)';
  await assert.rejects(readDeliveredMessageImage({ ...f.input, reference: { sessionId: 'session:other' } }));
  f.items.get('inspection').images.push({ managedPath: 'ambiguous.png' });
  await assert.rejects(readDeliveredMessageImage(f.input));
});

test('screenshot SVG wrapper becomes raster bytes; active or external SVG is never rendered', () => {
  const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><image width="1" height="1" href="data:image/png;base64,${PNG.toString('base64')}"/></svg>`;
  const image = messageImageBytes(Buffer.from(wrapper), 'image/svg+xml');
  assert.deepEqual(image.data, PNG); assert.equal(image.mimeType, 'image/png');
  assert.equal(image.pixelWidth, 1);
  for (const svg of [wrapper.replace('<image', '<script/> <image'), wrapper.replace('data:image/png;base64,', 'https://host/'),
    '<!DOCTYPE svg><svg/>', '<svg><foreignObject/></svg>']) {
    assert.throws(() => messageImageBytes(Buffer.from(svg), 'image/svg+xml'));
  }
  assert.throws(() => messageImageBytes(Buffer.from('<html/>'), 'image/png'));
});

test('all Providers use the shared Artifact tool to preserve binary image bytes', async () => {
  const captures = [];
  const service = { create: async (context, input) => { captures.push([context, input]); return { artifactId: 'artifact:one' }; } };
  for (const provider of ['codex-app-server', 'claude-sdk', 'openclacky']) {
    await callArtifactDynamicTool(service, { metadata: { provider }, tool: 'corptie_artifact_create', arguments: {
      title: 'Screenshot', content: PNG.toString('base64'), content_encoding: 'base64', mime_type: 'image/png' } });
  }
  assert.equal(captures.length, 3);
  for (const [,input] of captures) assert.deepEqual(input.content, PNG);
  await assert.rejects(callArtifactDynamicTool(service, { tool: 'corptie_artifact_create', arguments: {
    title: 'Bad', content: '!!!!', content_encoding: 'base64', mime_type: 'image/png' } }));
});
