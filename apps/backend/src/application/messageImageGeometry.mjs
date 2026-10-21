// Bounded header metadata only. Unsupported/truncated formats stay unknown;
// native ImageIO supplies geometry during the existing thumbnail read instead.
export const IMAGE_GEOMETRY_HEADER_LIMIT = 256 * 1024;
export function normalizedImageGeometry(w, h, orientation = 1) {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1
      || w > 1_000_000 || h > 1_000_000 || w * h > 1_000_000_000) return {};
  return orientation >= 5 && orientation <= 8 ? { pixelWidth: h, pixelHeight: w } : { pixelWidth: w, pixelHeight: h };
}
export function messageImageGeometry(input) {
  const b = input.subarray(0, IMAGE_GEOMETRY_HEADER_LIMIT);
  const valid = normalizedImageGeometry;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      && b.toString("ascii", 12, 16) === "IHDR") return valid(b.readUInt32BE(16), b.readUInt32BE(20));
  if (b.length >= 10 && ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))) return valid(b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 16) === "WEBPVP8X") {
    return valid(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  }
  if (b.length < 4 || b[0] !== 255 || b[1] !== 216) return {};
  let offset = 2, orientation = 1;
  while (offset + 4 <= b.length) {
    if (b[offset++] !== 255) return {};
    while (offset < b.length && b[offset] === 255) offset++;
    const marker = b[offset++];
    if (marker === 0xD9 || marker === 0xDA) break;
    if (marker === 0x01 || marker >= 0xD0 && marker <= 0xD7) continue;
    if (offset + 2 > b.length) break;
    const length = b.readUInt16BE(offset);
    if (length < 2 || offset + length > b.length) break;
    const payload = b.subarray(offset + 2, offset + length);
    if (marker === 0xE1) orientation = exifOrientation(payload) ?? orientation;
    if ([0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF].includes(marker) && payload.length >= 5) {
      return valid(payload.readUInt16BE(3), payload.readUInt16BE(1), orientation);
    }
    offset += length;
  }
  return {};
}

function exifOrientation(payload) {
  if (payload.length < 14 || payload.toString("ascii", 0, 6) !== "Exif\0\0") return null;
  const t = payload.subarray(6), little = t.toString("ascii", 0, 2) === "II";
  if (!little && t.toString("ascii", 0, 2) !== "MM") return null;
  const u16 = p => little ? t.readUInt16LE(p) : t.readUInt16BE(p);
  const u32 = p => little ? t.readUInt32LE(p) : t.readUInt32BE(p);
  if (u16(2) !== 42) return null;
  const start = u32(4);
  if (start + 2 > t.length) return null;
  const count = Math.min(64, u16(start));
  for (let i = 0; i < count; i++) {
    const p = start + 2 + i * 12;
    if (p + 12 > t.length) return null;
    if (u16(p) === 0x112 && u16(p + 2) === 3 && u32(p + 4) === 1) {
      const orientation = u16(p + 8);
      return orientation >= 1 && orientation <= 8 ? orientation : null;
    }
  }
  return null;
}
