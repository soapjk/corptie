import assert from "node:assert/strict";
import test from "node:test";
import { encodeTextFrame } from "../src/dsh-adapter/dshWebSocket.mjs";

test("encodeTextFrame 编码短文本帧（<126 字节，FIN+text opcode）", () => {
  const frame = encodeTextFrame("hi");
  assert.equal(frame[0], 0x81); // FIN=1, opcode=0x1 (text)
  assert.equal(frame[1], 2); // 7-bit 长度 = 2
  assert.equal(frame.toString("utf8", 2), "hi");
});

test("encodeTextFrame 编码 126..65535 字节用 126 + 16-bit 长度", () => {
  const text = "x".repeat(200);
  const frame = encodeTextFrame(text);
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 126); // 扩展长度标记
  assert.equal(frame.readUInt16BE(2), 200); // 16-bit 长度
  assert.equal(frame.toString("utf8", 4), text);
});

test("encodeTextFrame 编码 >65535 字节用 127 + 64-bit 长度", () => {
  const text = "y".repeat(70000);
  const frame = encodeTextFrame(text);
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 127); // 64-bit 长度标记
  assert.equal(frame.readBigUInt64BE(2), 70000n);
  assert.equal(frame.toString("utf8", 10), text);
});

test("encodeTextFrame 不 mask（服务端→客户端帧）", () => {
  const frame = encodeTextFrame("abc");
  // mask 位（bit 7 of byte 1）应为 0
  assert.equal(frame[1] & 0x80, 0);
});
