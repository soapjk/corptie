import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageImageGeometry, normalizedImageGeometry } from "../src/application/messageImageGeometry.mjs";
import { normalizeConversationMessage } from "../src/application/conversationMessage.mjs";
import { ChatResourceService } from "../src/application/chatResourceService.mjs";

function png(w, h) {
  const b = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(b);
  b.write("IHDR", 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b;
}
test("header geometry is bounded and unsupported/truncated inputs remain unknown", () => {
  assert.deepEqual(messageImageGeometry(png(900,1600)), { pixelWidth: 900, pixelHeight: 1600 });
  assert.deepEqual(messageImageGeometry(png(0,1600)), {});
  assert.deepEqual(messageImageGeometry(png(1000000,1000000)), {});
  for (let length = 0; length < 100; length++) assert.doesNotThrow(() => messageImageGeometry(Buffer.alloc(length, 255)));
  assert.deepEqual(normalizedImageGeometry(900,1600,6), { pixelWidth: 1600, pixelHeight: 900 });
  for (const bad of [null,0,-1,Infinity,NaN,"900",1.5,1000001]) assert.deepEqual(normalizedImageGeometry(bad,100), {});
  assert.deepEqual(messageImageGeometry(Buffer.from("unsupported format")), {});
});
test("JPEG EXIF rotation is normalized before presentation and malformed IFDs do not throw", () => {
  const app = Buffer.alloc(32); app.write("Exif\0\0"); app.write("II",6);
  app.writeUInt16LE(42,8); app.writeUInt32LE(8,10); app.writeUInt16LE(1,14);
  app.writeUInt16LE(0x112,16); app.writeUInt16LE(3,18); app.writeUInt32LE(1,20); app.writeUInt16LE(6,24);
  const segment = Buffer.alloc(4); segment[0]=255; segment[1]=225; segment.writeUInt16BE(app.length+2,2);
  const sof = Buffer.from([255,192,0,7,8,3,132,6,64]); // 900 high, 1600 wide
  const jpeg = () => Buffer.concat([Buffer.from([255,216]),segment,app,sof]);
  assert.deepEqual(messageImageGeometry(jpeg()), { pixelWidth: 900, pixelHeight: 1600 });
  app.writeUInt32LE(0xffffffff,10);
  assert.doesNotThrow(() => messageImageGeometry(jpeg()));
  assert.deepEqual(messageImageGeometry(jpeg()), { pixelWidth: 1600, pixelHeight: 900 });
});
test("GIF and extended WebP dimensions preserve non-square proportions", () => {
  const gif = Buffer.alloc(10); gif.write("GIF89a"); gif.writeUInt16LE(32,6); gif.writeUInt16LE(96,8);
  assert.deepEqual(messageImageGeometry(gif), { pixelWidth:32, pixelHeight:96 });
  const webp = Buffer.alloc(30); webp.write("RIFF"); webp.write("WEBPVP8X",8);
  webp.writeUIntLE(999,24,3); webp.writeUIntLE(199,27,3);
  assert.deepEqual(messageImageGeometry(webp), { pixelWidth:1000, pixelHeight:200 });
});
test("managed import, resource read, normalization and fork preserve optional geometry without widening authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-geometry-"));
  const service = new ChatResourceService({ environmentRoot: root });
  const source = { sessionId: "source" }, target = { sessionId: "target" };
  const image = await service.importImageData(source, png(900,1600), "portrait.png");
  assert.equal(image.pixelWidth,900); assert.equal(image.pixelHeight,1600);
  const normalized = normalizeConversationMessage({ text:"",images:[image] });
  assert.equal(normalized.images[0].pixelHeight,1600);
  const clone = await service.copyForkMetadata({ images:[image] },source,target);
  assert.equal(clone.images[0].pixelHeight,1600);
  assert.equal((await service.readImage(target,clone.images[0].managedPath)).pixelWidth,900);
  await assert.rejects(service.readImage(target,image.managedPath), { code:"CHAT_IMAGE_FORBIDDEN" });
  const file = join(root,"local.png"); await writeFile(file,png(600,600));
  assert.equal((await service.importImage(source,{sourcePath:file})).pixelHeight,600);
  const legacy = normalizeConversationMessage({text:"",images:[{managedPath:image.managedPath}]});
  assert.equal(legacy.images[0].pixelWidth,undefined);
});
