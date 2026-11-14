import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverImageVariant, imageVariant } from '../src/application/messageImagePreview.mjs';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
test('variant parsing is strict; legacy original remains compatible', () => {
  assert.equal(imageVariant(new URLSearchParams()), 'original');
  assert.equal(imageVariant(new URLSearchParams('variant=preview')), 'preview');
  for (const value of ['variant=', 'variant=bad', 'variant=preview&variant=original']) assert.throws(() => imageVariant(new URLSearchParams(value)));
});
test('authorized preview is a bounded JPEG; original is unchanged', async () => {
  const original = { data: PNG, mimeType: 'image/png' };
  assert.equal(await deliverImageVariant('original', async () => original), original);
  const preview = await deliverImageVariant('preview', async () => original);
  assert.equal(preview.mimeType, 'image/jpeg');
  assert.ok(preview.byteLength <= 300 * 1024);
  assert.ok(Math.max(preview.pixelWidth, preview.pixelHeight) <= 1024);
  assert.notDeepEqual(preview.data, PNG);
});
test('authorization errors and huge or unknown dimensions never return originals', async () => {
  await assert.rejects(deliverImageVariant('preview', async () => { throw Object.assign(new Error(), {statusCode:403}); }), {statusCode:403});
  const huge = Buffer.from(PNG); huge.writeUInt32BE(100000, 16);
  for (const data of [huge, Buffer.from('unknown')]) await assert.rejects(deliverImageVariant('preview', async () => ({data})), {code:'IMAGE_PREVIEW_UNAVAILABLE'});
});
test('background gate bounds authorized reads before materializing bytes', async () => {
  let active = 0, peak = 0;
  await Promise.all(Array.from({length:6}, () => deliverImageVariant('preview', async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return {data:PNG};
  })));
  assert.ok(peak <= 2);
});
test('animated GIF produces only a static preview frame', async () => {
  const single = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const frame = single.subarray(19, single.length - 1);
  const animated = Buffer.concat([single.subarray(0, single.length - 1), frame, Buffer.from([0x3b])]);
  const preview = await deliverImageVariant('preview', async () => ({data:animated}));
  assert.equal(preview.mimeType, 'image/jpeg');
  assert.equal(preview.data[0], 0xff);
});
