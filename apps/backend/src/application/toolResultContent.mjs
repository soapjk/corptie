// Normalize only the MCP result envelope. Arbitrary JSON, resource URLs and
// text containing JSON are data, never implicit image sources to fetch or run.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_PIXELS = 32 * 1024 * 1024;

export function normalizeMcpToolResult(value) {
  if (!Array.isArray(value?.content)) {
    return {
      content: [{ type: "text", text: JSON.stringify(value ?? {}) }],
      ...(value && typeof value === "object" ? { structuredContent: value } : {})
    };
  }
  let imageCount = 0;
  let imageBytes = 0;
  const content = value.content.map(block => {
    if (block?.type !== "image") return block;
    if (++imageCount > MAX_IMAGES) throw imageError("Too many images in a tool result.");
    const bytes = validateImage(block);
    imageBytes += bytes;
    if (imageBytes > MAX_TOTAL_IMAGE_BYTES) throw imageError("Tool result images exceed the total size limit.");
    return { type: "image", mimeType: block.mimeType, data: block.data,
      ...(block.annotations ? { annotations: block.annotations } : {}) };
  });
  // MCP structuredContent may duplicate the entire image payload. Keep images
  // exclusively in native content blocks, not JSON text or structured copies.
  const result = { ...value, content };
  if (imageCount) delete result.structuredContent;
  return result;
}

export function codexDynamicToolResult(value) {
  const result = normalizeMcpToolResult(value);
  const hasImages = result.content.some(block => block?.type === "image");
  if (!hasImages) {
    // Preserve existing JSON text semantics for all ordinary business results.
    return { contentItems: [{ type: "inputText", text: JSON.stringify(value ?? null, null, 2) }],
      success: value?.isError !== true };
  }
  const contentItems = result.content.map(block => {
    if (block?.type === "image") {
      return { type: "inputImage", imageUrl: `data:${block.mimeType};base64,${block.data}` };
    }
    if (block?.type === "text") return { type: "inputText", text: block.text };
    // Other MCP content remains descriptive; resource links are never fetched.
    return { type: "inputText", text: JSON.stringify(block) };
  });
  return { contentItems, success: value.isError !== true };
}

function validateImage(block) {
  if (!["image/png", "image/jpeg"].includes(block.mimeType)) {
    throw imageError("Tool images must be PNG or JPEG.");
  }
  const data = block.data;
  if (typeof data !== "string" || !data.length || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw imageError("Tool image is not bounded base64 data.");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== data) {
    throw imageError("Tool image is invalid or exceeds the size limit.");
  }
  const dimensions = block.mimeType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!dimensions || dimensions.some(size => size < 1 || size > 16384)
    || dimensions[0] * dimensions[1] > MAX_PIXELS) {
    throw imageError("Tool image format or dimensions are invalid.");
  }
  return bytes.length;
}

function pngDimensions(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function jpegDimensions(bytes) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return length >= 8 ? [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)] : null;
    }
    offset += length;
  }
  return null;
}

function imageError(message) {
  return Object.assign(new Error(message), { code: "TOOL_IMAGE_INVALID" });
}
