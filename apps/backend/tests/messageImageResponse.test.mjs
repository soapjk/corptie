import test from 'node:test';
import assert from 'node:assert/strict';
import { messageImageResponse } from '../src/application/messageImageResponse.mjs';
const hash = 'a'.repeat(64), destination = `artifact:a?version=1&hash=${hash}`;
const resource = { mimeType: 'image/png', fileName: '图片.png', data: Buffer.from('abcdef') };
test('immutable authenticated image supports exact suffix resume', () => {
  const r = messageImageResponse({ headers: { range: 'bytes=2-', 'if-range': `"${hash}"` } }, resource, destination);
  assert.equal(r.status, 206); assert.equal(r.data.toString(), 'cdef');
  assert.equal(r.headers['content-disposition'], `attachment; filename*=UTF-8''${encodeURIComponent('图片.png')}`);
  assert.equal(r.headers['content-range'], 'bytes 2-5/6'); assert.equal(r.headers['content-length'], 4);
});
test('mismatched version and mutable resources restart instead of splicing', () => {
  for (const path of [destination, '/tmp/a.png']) {
    const r = messageImageResponse({ headers: { range: 'bytes=2-', 'if-range': '"old"' } }, resource, path);
    assert.equal(r.status, 200); assert.equal(r.data.toString(), 'abcdef');
  }
});
test('invalid and unsatisfiable offsets have bounded empty responses', () => {
  for (const range of ['bytes=6-', 'bytes=-1-', 'bytes=1-2,3-4', 'bytes=99999999999999999999-']) {
    const r = messageImageResponse({ headers: { range, 'if-range': `"${hash}"` } }, resource, destination);
    assert.equal(r.status, 416); assert.equal(r.data.length, 0);
  }
});
